"""Observer — publish captured mesh packets to MQTT brokers.

mc-webui equivalent of the standalone meshcore-packet-capture project
(github.com/agessaman/meshcore-packet-capture): every packet the device
overhears (RX_LOG_DATA) is formatted in the exact same JSON shape and
published to all user-configured MQTT brokers, so letsmesh-style
analyzers and other existing consumers work unchanged.

Threading model:
- DeviceManager's asyncio thread calls handle_raw_packet(): pure CPU
  (header parse + SHA-256 + json.dumps) plus paho's non-blocking
  publish() enqueue. No await, no network, no DB, no locks on this path.
- Each broker gets its own paho client with its own network thread
  (loop_start), auto-reconnecting with backoff. QoS 0 everywhere, so a
  dead broker never accumulates queued messages.
- Lifecycle (start/stop/reload) runs on Flask request threads or a
  dedicated daemon thread, serialized by _lifecycle_lock. The client
  list is swapped as a whole (atomic reference assignment), so the hot
  path can read it lock-free.

The packet parsing/formatting functions below are ports of the upstream
implementation (src/meshcore_packet_capture/packet_capture.py) including
its quirks — e.g. packets with an unknown payload version still get
published, with default route "U" / packet_type "0" — because downstream
consumers may rely on them.
"""

import hashlib
import json
import logging
import re
import threading
import time
from datetime import datetime, timezone

from app.version import VERSION_STRING

logger = logging.getLogger(__name__)

# Wire route_type (header & 0x03): TRANSPORT_FLOOD, FLOOD, DIRECT, TRANSPORT_DIRECT
_ROUTE_LETTERS = {0x00: "F", 0x01: "F", 0x02: "D", 0x03: "T"}
_TRANSPORT_ROUTES = (0x00, 0x03)  # carry a 4-byte transport code after the header
_EMPTY_HASH = "0000000000000000"


def _decode_packed_path_length(path_len_byte: int, max_path_size: int = 64) -> tuple:
    """Decode the packed path_len byte per MeshCore firmware.

    Low 6 bits = hop count, high 2 bits = bytes-per-hop minus 1.
    Returns (path_byte_len, bytes_per_hop). Keeps upstream's two legacy
    fallbacks (reserved 4-bytes/hop mode, oversized path) so decoded
    output matches meshcore-packet-capture exactly.
    """
    hop_count = path_len_byte & 0x3F
    bytes_per_hop = (path_len_byte >> 6) + 1
    if bytes_per_hop == 4:  # reserved mode -> legacy one-byte interpretation
        return path_len_byte, 1
    path_byte_len = hop_count * bytes_per_hop
    if path_byte_len > max_path_size:  # invalid packed value -> legacy
        return path_len_byte, 1
    return path_byte_len, bytes_per_hop


def _split_path_hops(path_bytes: bytes, bytes_per_hop: int) -> list:
    """Split path bytes into per-hop hex tokens (1-3 bytes per hop)."""
    path_hex = path_bytes.hex()
    hop_hex_chars = max(bytes_per_hop, 1) * 2
    nodes = [path_hex[i:i + hop_hex_chars] for i in range(0, len(path_hex), hop_hex_chars)]
    if (len(path_hex) % hop_hex_chars) != 0:
        nodes = [path_hex[i:i + 2] for i in range(0, len(path_hex), 2)]
    return nodes


def decode_packet(raw_hex: str):
    """Decode packet header/path — port of upstream decode_and_publish_message().

    Returns None for truncated packets and unknown payload versions
    (those still get published, with default route/type). ADVERT payload
    contents are not parsed: upstream never publishes them in the
    packets payload.
    """
    try:
        byte_data = bytes.fromhex(raw_hex)
    except ValueError:
        return None
    if len(byte_data) < 2:
        return None
    header = byte_data[0]
    route_type = header & 0x03
    has_transport = route_type in _TRANSPORT_ROUTES
    offset = 1
    if has_transport:
        offset += 4
    if len(byte_data) <= offset:
        return None
    path_len_byte = byte_data[offset]
    offset += 1
    path_byte_len, bytes_per_hop = _decode_packed_path_length(path_len_byte)
    if len(byte_data) < offset + path_byte_len:
        return None
    path_bytes = byte_data[offset:offset + path_byte_len]
    if (header >> 6) & 0x03 != 0:  # only payload version VER_1 (0) is understood
        return None
    return {
        'route_type': route_type,
        'payload_type': (header >> 2) & 0x0F,
        'path': _split_path_hops(path_bytes, bytes_per_hop),
        'path_byte_len': path_byte_len,
        'has_transport': has_transport,
    }


def calculate_packet_hash(raw_hex: str) -> str:
    """Packet identity hash — port of firmware Packet::calculatePacketHash().

    SHA256(payload_type byte || [packed path_len as uint16 LE, TRACE only]
    || payload bytes), first 16 hex chars uppercase.
    """
    try:
        byte_data = bytes.fromhex(raw_hex)
        header = byte_data[0]
        payload_type = (header >> 2) & 0x0F
        offset = 1
        if (header & 0x03) in _TRANSPORT_ROUTES:
            offset += 4
        if len(byte_data) <= offset:
            return _EMPTY_HASH
        path_len_byte = byte_data[offset]
        offset += 1
        path_byte_len, _ = _decode_packed_path_length(path_len_byte)
        payload_start = offset + path_byte_len
        if payload_start > len(byte_data):
            return _EMPTY_HASH
        hash_obj = hashlib.sha256()
        hash_obj.update(bytes([payload_type]))
        if payload_type == 9:  # TRACE: firmware hashes the path_len as uint16 too
            hash_obj.update(path_len_byte.to_bytes(2, byteorder='little'))
        hash_obj.update(byte_data[payload_start:])
        return hash_obj.hexdigest()[:16].upper()
    except Exception:
        return _EMPTY_HASH


def format_packet_data(raw_hex: str, origin: str, origin_id: str,
                       snr=None, rssi=None, payload_length=None) -> dict:
    """Build the letsmesh-compatible packet JSON — port of upstream (all values strings)."""
    now = datetime.now(timezone.utc)
    decoded = decode_packet(raw_hex)
    packet_len = len(raw_hex) // 2
    route = "U"
    packet_type = "0"
    payload_len = "0"
    if decoded:
        route = _ROUTE_LETTERS.get(decoded['route_type'], "U")
        packet_type = str(decoded['payload_type'])
        if payload_length is not None:
            payload_len = str(payload_length)
        else:
            transport_bytes = 4 if decoded['has_transport'] else 0
            payload_len = str(max(0, packet_len - 1 - transport_bytes - 1 - decoded['path_byte_len']))
    packet = {
        "origin": origin,
        "origin_id": (origin_id or '').upper(),
        "timestamp": now.isoformat(),
        "type": "PACKET",
        "direction": "rx",
        "time": now.strftime("%H:%M:%S"),
        "date": now.strftime("%d/%m/%Y"),
        "len": str(packet_len),
        "packet_type": packet_type,
        "route": route,
        "payload_len": payload_len,
        "raw": raw_hex.upper(),
        "SNR": str(snr) if snr is not None else "Unknown",
        "RSSI": str(rssi) if rssi is not None else "Unknown",
        "hash": calculate_packet_hash(raw_hex),
    }
    if route == "D" and decoded:
        packet["path"] = ",".join(decoded['path'])
    return packet


class ObserverManager:
    """Owns MQTT clients and the packet fan-out for the Observer feature."""

    SETTINGS_KEY = 'observer_settings'
    LAST_ADVERT_KEY = 'observer_last_advert_at'
    DEFAULT_SETTINGS = {'enabled': False, 'iata': '', 'advert_interval_hours': 0}
    STATUS_EMIT_MIN_INTERVAL = 2.0  # seconds between observer_status socket emits
    ADVERT_CHECK_INTERVAL_SEC = 600  # how often the advert loop re-checks the schedule

    def __init__(self, db, socketio=None):
        self.db = db
        self.socketio = socketio
        self.device_manager = None  # set by main.py once DeviceManager exists
        self._lifecycle_lock = threading.Lock()
        self._clients = []          # per-broker dicts; list ref swapped atomically
        self._started = False
        self._enabled = False
        self._iata = ''
        self._origin = None
        self._origin_id = None      # uppercase device public key
        self._status_extras = {'model': 'unknown', 'firmware_version': 'unknown',
                               'radio': 'unknown'}
        self._packets_seen = 0
        self._packets_published = 0
        self._last_status_emit = 0.0
        self._advert_thread = None
        self._advert_stop = None

    # ---------------- settings ----------------

    def get_settings(self) -> dict:
        settings = dict(self.DEFAULT_SETTINGS)
        stored = self.db.get_setting_json(self.SETTINGS_KEY, {}) or {}
        for key in settings:
            if key in stored:
                settings[key] = stored[key]
        return settings

    # ---------------- identity (from DeviceManager) ----------------

    def set_identity(self, name, public_key, self_info=None, device_info=None):
        """Record device identity; called from DeviceManager after connect."""
        new_origin_id = (public_key or '').upper()
        identity_changed = self._started and new_origin_id != self._origin_id
        self._origin = name or 'MeshCore Device'
        self._origin_id = new_origin_id
        if self_info:
            self._status_extras['radio'] = ",".join(
                str(self_info.get(key, 0))
                for key in ('radio_freq', 'radio_bw', 'radio_sf', 'radio_cr'))
        if device_info:
            # Mirrors upstream get_firmware_info(): fw ver >= 3 carries strings
            fw_ver = device_info.get('fw ver', 0) or 0
            if fw_ver >= 3:
                version = str(device_info.get('ver', 'Unknown'))
                if version.startswith('v'):
                    version = version[1:]
                self._status_extras['model'] = device_info.get('model', 'Unknown')
                self._status_extras['firmware_version'] = (
                    f"v{version} (Build: {device_info.get('fw_build', 'Unknown')})")
            else:
                self._status_extras['firmware_version'] = f"v{fw_ver}"
        if identity_changed:
            logger.info("Observer: device identity changed, reloading MQTT clients")
            self.reload()

    # ---------------- lifecycle ----------------

    def ensure_started(self):
        """Start clients if enabled and not yet running (device just connected)."""
        if self._started:
            return
        self.reload()

    def reload(self):
        """Re-read config and rebuild MQTT clients on a daemon thread.

        loop_stop() joins paho's network thread and can take seconds when a
        client is mid-reconnect, so this must never run on a Flask worker
        or the DeviceManager loop.
        """
        threading.Thread(target=self._reload_sync, name='observer-reload',
                         daemon=True).start()

    def stop(self, publish_offline=True):
        with self._lifecycle_lock:
            clients = self._clients
            self._clients = []
            self._started = False
            self._stop_clients(clients, publish_offline=publish_offline)

    def _reload_sync(self):
        with self._lifecycle_lock:
            try:
                settings = self.get_settings()
                self._enabled = bool(settings.get('enabled'))
                self._iata = str(settings.get('iata') or '').strip()
                old_clients = self._clients
                self._clients = []
                self._started = False
                self._stop_clients(old_clients, publish_offline=True)
                if not self._enabled:
                    return
                if not self._origin_id:
                    logger.info("Observer enabled, waiting for device connection "
                                "(identity unknown yet)")
                    return
                new_clients = []
                for row in self.db.list_observer_brokers():
                    if row.get('is_disabled'):
                        continue
                    try:
                        new_clients.append(self._build_client(row))
                    except Exception as e:
                        logger.error(f"Observer: failed to set up MQTT client for "
                                     f"broker '{row.get('name')}': {e}")
                self._clients = new_clients
                self._started = bool(new_clients)
                if new_clients:
                    logger.info(f"Observer running with {len(new_clients)} MQTT client(s), "
                                f"packets topic: {self._topic('packets')}")
                else:
                    logger.info("Observer enabled but no active brokers configured")
            except Exception as e:
                logger.error(f"Observer reload failed: {e}", exc_info=True)
            finally:
                self._emit_status(force=True)

    def _stop_clients(self, clients, publish_offline=True):
        for ci in clients:
            client = ci['client']
            ci['stopping'] = True  # silence the disconnect callback for this teardown
            try:
                if publish_offline and client.is_connected():
                    msg = client.publish(ci['status_topic'],
                                         json.dumps(self._status_payload('offline')),
                                         qos=0, retain=True)
                    try:
                        msg.wait_for_publish(timeout=2)
                    except Exception:
                        pass
                client.disconnect()
                client.loop_stop()
            except Exception as e:
                logger.debug(f"Observer: error stopping MQTT client "
                             f"'{ci.get('name')}': {e}")

    def _build_client(self, row) -> dict:
        # Lazy import: a missing paho package must not break app startup —
        # the observer just stays inert and reports the error.
        import paho.mqtt.client as mqtt

        status_topic = self._topic('status')
        base = re.sub(r"[^a-zA-Z0-9_-]", "",
                      f"meshcore_client_{(self._origin_id or 'unknown')[:8]}")[:23]
        ci = {
            'broker_id': row['id'],
            'name': row['name'],
            'host': row['host'],
            'port': int(row['port'] or 1883),
            'status_topic': status_topic,
            'packets_topic': self._topic('packets'),
            'connected': False,
            'last_error': None,
        }
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                             client_id=f"{base}_{row['id']}",
                             clean_session=True)
        ci['client'] = client
        client.user_data_set(ci)
        client.reconnect_delay_set(min_delay=1, max_delay=120)
        if row.get('username'):
            client.username_pw_set(row['username'], row.get('password') or None)
        # LWT must be set before connect: retained offline status is the
        # authoritative "observer gone" signal (the app has no graceful
        # shutdown path — Docker SIGTERM just kills the process).
        client.will_set(status_topic, json.dumps(self._lwt_payload()),
                        qos=0, retain=True)
        if row.get('use_tls'):
            import ssl
            if row.get('tls_verify', 1):
                client.tls_set(cert_reqs=ssl.CERT_REQUIRED)
            else:
                client.tls_set(cert_reqs=ssl.CERT_NONE)
                client.tls_insecure_set(True)
        client.on_connect = self._on_connect_cb
        client.on_disconnect = self._on_disconnect_cb
        client.on_connect_fail = self._on_connect_fail_cb
        client.connect_async(ci['host'], ci['port'], keepalive=60)
        client.loop_start()
        return ci

    # ---------------- topics & payloads ----------------

    def _topic(self, kind: str) -> str:
        if self._iata:
            return f"meshcore/{self._iata.upper()}/{self._origin_id}/{kind}"
        return f"meshcore/{kind}"  # upstream classic fallback when IATA unset

    def _status_payload(self, status: str) -> dict:
        return {
            'status': status,
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'origin': self._origin or 'MeshCore Device',
            'origin_id': self._origin_id or 'DEVICE',
            'model': self._status_extras.get('model', 'unknown'),
            'firmware_version': self._status_extras.get('firmware_version', 'unknown'),
            'radio': self._status_extras.get('radio', 'unknown'),
            'client_version': f"mc-webui/{VERSION_STRING}",
        }

    def _lwt_payload(self) -> dict:
        # Upstream's LWT is the minimal 4-field variant
        return {
            'status': 'offline',
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'origin': self._origin or 'MeshCore Device',
            'origin_id': self._origin_id or 'DEVICE',
        }

    # ---------------- hot path (DeviceManager asyncio thread) ----------------

    def handle_raw_packet(self, raw_hex, snr=None, rssi=None, payload_length=None):
        """Format one overheard packet and publish it to all connected brokers."""
        if not self._started:
            return
        clients = self._clients  # atomic ref read; never mutated in place
        if not clients:
            return
        self._packets_seen += 1
        try:
            payload = json.dumps(format_packet_data(
                raw_hex, self._origin, self._origin_id,
                snr=snr, rssi=rssi, payload_length=payload_length))
        except Exception as e:
            logger.debug(f"Observer: packet formatting failed: {e}")
            return
        published = False
        for ci in clients:
            try:
                if ci['client'].is_connected():
                    result = ci['client'].publish(ci['packets_topic'], payload,
                                                  qos=0, retain=False)
                    if result.rc == 0:  # mqtt.MQTT_ERR_SUCCESS
                        published = True
            except Exception as e:
                logger.debug(f"Observer: publish to '{ci['name']}' failed: {e}")
        if published:
            self._packets_published += 1
        self._emit_status()

    # ---------------- MQTT callbacks (paho network threads) ----------------

    def _on_connect_cb(self, client, userdata, flags, reason_code, properties=None):
        failed = getattr(reason_code, 'is_failure', None)
        if failed is None:  # MQTTv3 int fallback
            failed = reason_code != 0
        if failed:
            userdata['connected'] = False
            userdata['last_error'] = str(reason_code)
            logger.warning(f"Observer: MQTT broker '{userdata['name']}' refused "
                           f"connection: {reason_code}")
        else:
            userdata['connected'] = True
            userdata['last_error'] = None
            logger.info(f"Observer: connected to MQTT broker '{userdata['name']}' "
                        f"({userdata['host']}:{userdata['port']})")
            try:
                # Retained online status; re-published on every auto-reconnect
                client.publish(userdata['status_topic'],
                               json.dumps(self._status_payload('online')),
                               qos=0, retain=True)
            except Exception as e:
                logger.debug(f"Observer: online status publish failed: {e}")
        self._emit_status(force=True)

    def _on_disconnect_cb(self, client, userdata, disconnect_flags, reason_code,
                          properties=None):
        userdata['connected'] = False
        if userdata.get('stopping'):
            return  # deliberate teardown (reload/stop), not a lost connection
        reason = str(reason_code)
        if reason not in ('Success', '0'):
            userdata['last_error'] = reason
            logger.info(f"Observer: lost connection to MQTT broker "
                        f"'{userdata['name']}' ({reason}), auto-reconnecting")
        self._emit_status(force=True)

    def _on_connect_fail_cb(self, client, userdata):
        userdata['connected'] = False
        if not userdata.get('last_error'):
            userdata['last_error'] = 'connection failed'
        self._emit_status()  # throttled: fires on every paho retry

    # ---------------- status for UI ----------------

    def _status_reason(self):
        if not self._enabled:
            return 'disabled'
        if not self._origin_id:
            return 'waiting for device connection'
        if not self._clients:
            return 'no active brokers configured'
        return None

    def _live_status(self) -> dict:
        """Status snapshot without DB access — safe for socket emits."""
        return {
            'enabled': self._enabled,
            'running': self._started,
            'reason': self._status_reason(),
            'origin': self._origin,
            'origin_id': self._origin_id,
            'iata': self._iata,
            'packets_seen': self._packets_seen,
            'packets_published': self._packets_published,
            'brokers': [{'id': ci['broker_id'], 'name': ci['name'],
                         'connected': ci['connected'],
                         'last_error': ci['last_error']} for ci in self._clients],
        }

    def get_status(self) -> dict:
        """Full status for the API: settings + DB broker rows merged with live state."""
        status = self._live_status()
        status['settings'] = self.get_settings()
        live_by_id = {b['id']: b for b in status.pop('brokers')}
        brokers = []
        for row in self.db.list_observer_brokers():
            live = live_by_id.get(row['id'], {})
            brokers.append({
                'id': row['id'],
                'name': row['name'],
                'host': row['host'],
                'port': row['port'],
                'username': row.get('username', ''),
                'has_password': bool(row.get('password')),
                'use_tls': bool(row.get('use_tls')),
                'tls_verify': bool(row.get('tls_verify', 1)),
                'is_disabled': bool(row.get('is_disabled')),
                'connected': live.get('connected', False),
                'last_error': live.get('last_error'),
            })
        status['brokers'] = brokers
        try:
            status['last_advert_at'] = int(float(
                self.db.get_setting(self.LAST_ADVERT_KEY) or 0)) or None
        except (TypeError, ValueError):
            status['last_advert_at'] = None
        return status

    def _emit_status(self, force=False):
        if not self.socketio:
            return
        now = time.time()
        if not force and (now - self._last_status_emit) < self.STATUS_EMIT_MIN_INTERVAL:
            return
        self._last_status_emit = now
        try:
            self.socketio.emit('observer_status', self._live_status(),
                               namespace='/chat')
        except Exception as e:
            logger.debug(f"Observer: status emit failed: {e}")

    # ---------------- advert scheduler ----------------

    def start_advert_scheduler(self):
        """Start the periodic advert check thread (idempotent).

        The thread always runs; maybe_send_advert() gates on the observer
        being enabled and advert_interval_hours > 0, so settings changes
        take effect on the next check without thread management.
        """
        if self._advert_thread and self._advert_thread.is_alive():
            return
        self._advert_stop = threading.Event()
        self._advert_thread = threading.Thread(
            target=self._advert_loop, name='observer-advert', daemon=True)
        self._advert_thread.start()

    def _advert_loop(self):
        while not self._advert_stop.wait(self.ADVERT_CHECK_INTERVAL_SEC):
            self.maybe_send_advert()

    def maybe_send_advert(self):
        """Send a flood advert when the configured interval has elapsed.

        The last-advert timestamp persists in app_settings so restarts
        don't re-advertise early.
        """
        try:
            settings = self.get_settings()
            if not settings.get('enabled'):
                return
            interval_hours = int(settings.get('advert_interval_hours') or 0)
            if interval_hours <= 0:
                return
            dm = self.device_manager
            if not dm or not getattr(dm, 'is_connected', False):
                return
            last = float(self.db.get_setting(self.LAST_ADVERT_KEY) or 0)
            now = time.time()
            if now - last < interval_hours * 3600:
                return
            result = dm.send_advert(flood=True)
            if result and result.get('success'):
                self.db.set_setting(self.LAST_ADVERT_KEY, str(int(now)))
                logger.info(f"Observer: sent scheduled flood advert "
                            f"(interval {interval_hours}h)")
                self._emit_status(force=True)
            else:
                logger.warning(f"Observer: scheduled flood advert failed: {result}")
        except Exception as e:
            logger.error(f"Observer: advert scheduler error: {e}")
