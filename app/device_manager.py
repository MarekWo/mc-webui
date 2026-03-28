"""
DeviceManager — manages MeshCore device connection for mc-webui v2.

Runs the meshcore async event loop in a dedicated background thread.
Flask routes call sync command methods that bridge to the async loop.
Event handlers capture incoming data and write to Database + emit SocketIO.
"""

import asyncio
import hashlib
import json
import logging
import threading
import time
from typing import Optional, Any, Dict, List, Tuple
from urllib.parse import urlparse, parse_qs

ANALYZER_BASE_URL = 'https://analyzer.letsmesh.net/packets?packet_hash='
GRP_TXT_TYPE_BYTE = 0x05

logger = logging.getLogger(__name__)
logger.setLevel(logging.DEBUG)


def _to_str(val) -> str:
    """Convert bytes or other types to string. Used for expected_ack, pkt_payload, etc."""
    if val is None:
        return ''
    if isinstance(val, bytes):
        return val.hex()
    return str(val)


def parse_meshcore_uri(uri: str) -> Optional[Dict]:
    """Parse meshcore://contact/add?name=...&public_key=...&type=... URI.

    Returns dict with 'name', 'public_key', 'type' keys, or None if not a valid mobile-app URI.
    """
    if not uri or not uri.startswith('meshcore://'):
        return None

    try:
        # urlparse needs a scheme it recognizes; meshcore:// works fine
        parsed = urlparse(uri)
        if parsed.netloc != 'contact' or parsed.path != '/add':
            return None

        params = parse_qs(parsed.query)
        public_key = params.get('public_key', [None])[0]
        name = params.get('name', [None])[0]

        if not public_key or not name:
            return None

        # Validate public_key: 64 hex characters
        public_key = public_key.strip().lower()
        if len(public_key) != 64:
            return None
        bytes.fromhex(public_key)  # validate hex

        contact_type = int(params.get('type', ['1'])[0])
        if contact_type not in (1, 2, 3, 4):
            contact_type = 1

        return {
            'name': name.strip(),
            'public_key': public_key,
            'type': contact_type,
        }
    except (ValueError, IndexError, KeyError):
        return None


class DeviceManager:
    """
    Manages MeshCore device connection.

    Usage:
        dm = DeviceManager(config, db, socketio)
        dm.start()  # spawns background thread, connects to device
        ...
        dm.stop()   # disconnect and stop background thread
    """

    def __init__(self, config, db, socketio=None):
        self.config = config
        self.db = db
        self.socketio = socketio
        self.mc = None              # meshcore.MeshCore instance
        self._loop = None           # asyncio event loop (in background thread)
        self._thread = None         # background thread
        self._connected = False
        self._device_name = None
        self._self_info = None
        self._subscriptions = []    # active event subscriptions
        self._channel_secrets = {}  # {channel_idx: secret_hex} for pkt_payload
        self._max_channels = 8     # updated from device_info at connect
        self._pending_echo = None   # {'timestamp': float, 'channel_idx': int, 'msg_id': int, 'pkt_payload': str|None}
        self._echo_lock = threading.Lock()
        self._pending_acks = {}     # {ack_code_hex: dm_id} — maps retry acks to DM
        self._retry_tasks = {}      # {dm_id: asyncio.Task} — active retry coroutines
        self._retry_context = {}    # {dm_id: {attempt, max_attempts, path}} — for _on_ack

    @property
    def is_connected(self) -> bool:
        return self._connected and self.mc is not None

    @property
    def device_name(self) -> str:
        return self._device_name or self.config.MC_DEVICE_NAME

    @property
    def self_info(self) -> Optional[dict]:
        return self._self_info

    # ================================================================
    # Lifecycle
    # ================================================================

    def start(self):
        """Start the device manager background thread and connect."""
        if self._thread and self._thread.is_alive():
            logger.warning("DeviceManager already running")
            return

        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._run_loop, daemon=True, name="device-manager"
        )
        self._thread.start()
        logger.info("DeviceManager background thread started")

    def _run_loop(self):
        """Run the async event loop in the background thread."""
        asyncio.set_event_loop(self._loop)
        self._loop.run_until_complete(self._connect_with_retry())
        self._loop.run_forever()

    async def _connect_with_retry(self, max_retries: int = 10, base_delay: float = 5.0):
        """Try to connect to device, retrying on failure."""
        for attempt in range(1, max_retries + 1):
            try:
                await self._connect()
                if self._connected:
                    return  # success
            except Exception as e:
                logger.error(f"Connection attempt {attempt}/{max_retries} failed: {e}")

            if attempt < max_retries:
                delay = min(base_delay * attempt, 30.0)
                logger.info(f"Retrying in {delay:.0f}s...")
                await asyncio.sleep(delay)

        logger.error(f"Failed to connect after {max_retries} attempts")

    def _detect_serial_port(self) -> str:
        """Auto-detect serial port when configured as 'auto'."""
        port = self.config.MC_SERIAL_PORT
        if port.lower() != 'auto':
            return port

        from pathlib import Path
        by_id = Path('/dev/serial/by-id')
        if by_id.exists():
            devices = list(by_id.iterdir())
            if len(devices) == 1:
                resolved = str(devices[0].resolve())
                logger.info(f"Auto-detected serial port: {resolved}")
                return resolved
            elif len(devices) > 1:
                logger.warning(f"Multiple serial devices found: {[d.name for d in devices]}")
            else:
                logger.warning("No serial devices found in /dev/serial/by-id")

        # Fallback: try common paths
        for candidate in ['/dev/ttyUSB0', '/dev/ttyACM0', '/dev/ttyUSB1', '/dev/ttyACM1']:
            if Path(candidate).exists():
                logger.info(f"Auto-detected serial port (fallback): {candidate}")
                return candidate

        raise RuntimeError("No serial port detected. Set MC_SERIAL_PORT explicitly.")

    async def _connect(self):
        """Connect to device via serial or TCP and subscribe to events."""
        from meshcore import MeshCore

        try:
            if self.config.use_tcp:
                logger.info(f"Connecting via TCP: {self.config.MC_TCP_HOST}:{self.config.MC_TCP_PORT}")
                self.mc = await MeshCore.create_tcp(
                    host=self.config.MC_TCP_HOST,
                    port=self.config.MC_TCP_PORT,
                    # Disable library auto-reconnect — it has a bug where old
                    # connection's close callback triggers infinite reconnect loop.
                    # We handle reconnection ourselves in _on_disconnected().
                    auto_reconnect=False,
                )
            else:
                port = self._detect_serial_port()
                logger.info(f"Connecting via serial: {port}")
                self.mc = await MeshCore.create_serial(
                    port=port,
                    # Disable library auto-reconnect — same bug as TCP.
                    # We handle reconnection ourselves in _on_disconnected().
                    auto_reconnect=False,
                )

            # Read device info
            self._self_info = getattr(self.mc, 'self_info', None)
            if not self._self_info:
                logger.error("Device connected but self_info is empty — device may not be responding")
                self.mc = None
                return
            self._device_name = self._self_info.get('name', self.config.MC_DEVICE_NAME)
            self._connected = True

            # Store device info in database
            self.db.set_device_info(
                public_key=self._self_info.get('public_key', ''),
                name=self._device_name,
                self_info=json.dumps(self._self_info, default=str)
            )

            # Fetch device_info for max_channels
            try:
                dev_info_event = await self.mc.commands.send_device_query()
                if dev_info_event and hasattr(dev_info_event, 'payload'):
                    dev_info = dev_info_event.payload or {}
                    self._max_channels = dev_info.get('max_channels', 8)
                    logger.info(f"Device max_channels: {self._max_channels}")
            except Exception as e:
                logger.warning(f"Could not fetch device_info: {e}")

            # Workaround: meshcore lib 2.2.21 has a bug where list.extend()
            # return value (None) corrupts reader.channels for idx >= 20.
            # Pre-allocate the channels list to max_channels to avoid this.
            reader = getattr(self.mc, '_reader', None)
            if reader and hasattr(reader, 'channels'):
                current = reader.channels or []
                if len(current) < self._max_channels:
                    reader.channels = current + [{} for _ in range(self._max_channels - len(current))]
                    logger.debug(f"Pre-allocated reader.channels to {len(reader.channels)} slots")

            logger.info(f"Connected to device: {self._device_name} "
                        f"(key: {self._self_info.get('public_key', '?')[:8]}...)")

            # Subscribe to events
            await self._subscribe_events()

            # Enable auto-refresh of contacts on adverts/path updates
            # Keep auto_update_contacts OFF to avoid serial blocking on every
            # ADVERTISEMENT event (324 contacts = several seconds of serial I/O).
            # We sync contacts at startup and handle NEW_CONTACT events individually.
            self.mc.auto_update_contacts = False

            # Fetch initial contacts from device
            await self.mc.ensure_contacts()
            self._sync_contacts_to_db()

            # Cache channel secrets for pkt_payload computation
            await self._load_channel_secrets()

            # Start auto message fetching (events fire on new messages)
            await self.mc.start_auto_message_fetching()

        except Exception as e:
            logger.error(f"Device connection failed: {e}")
            self._connected = False

    async def _load_channel_secrets(self):
        """Load channel secrets from device for pkt_payload computation and persist to DB."""
        consecutive_empty = 0
        try:
            for idx in range(self._max_channels):
                try:
                    event = await self.mc.commands.get_channel(idx)
                except Exception:
                    consecutive_empty += 1
                    if consecutive_empty >= 3:
                        break  # likely past last configured channel
                    continue
                if event:
                    data = getattr(event, 'payload', None) or {}
                    secret = data.get('channel_secret', data.get('secret', b''))
                    if isinstance(secret, bytes):
                        secret = secret.hex()
                    name = data.get('channel_name', data.get('name', ''))
                    if isinstance(name, str):
                        name = name.strip('\x00').strip()
                    if secret and len(secret) == 32:
                        self._channel_secrets[idx] = secret
                        # Persist to DB so API endpoints can read without device calls
                        self.db.upsert_channel(idx, name or f'Channel {idx}', secret)
                        consecutive_empty = 0
                    elif name:
                        # Channel exists but has no secret (e.g. Public)
                        self.db.upsert_channel(idx, name, None)
                        consecutive_empty = 0
                    else:
                        consecutive_empty += 1
                else:
                    consecutive_empty += 1
                if consecutive_empty >= 3:
                    break  # stop after 3 consecutive empty channels
            logger.info(f"Cached {len(self._channel_secrets)} channel secrets")
        except Exception as e:
            logger.error(f"Failed to load channel secrets: {e}")

    async def _subscribe_events(self):
        """Subscribe to all relevant device events."""
        from meshcore.events import EventType

        handlers = [
            (EventType.CHANNEL_MSG_RECV, self._on_channel_message),
            (EventType.CONTACT_MSG_RECV, self._on_dm_received),
            (EventType.MSG_SENT, self._on_msg_sent),
            (EventType.ACK, self._on_ack),
            (EventType.ADVERTISEMENT, self._on_advertisement),
            (EventType.PATH_UPDATE, self._on_path_update),
            (EventType.NEW_CONTACT, self._on_new_contact),
            (EventType.RX_LOG_DATA, self._on_rx_log_data),
            (EventType.DISCONNECTED, self._on_disconnected),
        ]

        for event_type, handler in handlers:
            sub = self.mc.subscribe(event_type, handler)
            self._subscriptions.append(sub)
            logger.debug(f"Subscribed to {event_type.value}")

    def _sync_contacts_to_db(self):
        """Sync device contacts to database (bidirectional).

        - Upserts device contacts with source='device'
        - Downgrades DB contacts marked 'device' that are no longer on device to 'advert'
        """
        if not self.mc or not self.mc.contacts:
            return

        device_keys = set()
        for pubkey, contact in self.mc.contacts.items():
            # last_advert from meshcore is Unix timestamp (int) or None
            last_adv = contact.get('last_advert')
            last_advert_val = str(int(last_adv)) if last_adv and isinstance(last_adv, (int, float)) and last_adv > 0 else None

            self.db.upsert_contact(
                public_key=pubkey,
                name=contact.get('adv_name', ''),
                type=contact.get('type', 0),
                flags=contact.get('flags', 0),
                out_path=contact.get('out_path', ''),
                out_path_len=contact.get('out_path_len', 0),
                last_advert=last_advert_val,
                adv_lat=contact.get('adv_lat'),
                adv_lon=contact.get('adv_lon'),
                source='device',
            )
            device_keys.add(pubkey.lower())

        # Downgrade stale 'device' contacts to 'advert' (cache-only)
        stale = self.db.downgrade_stale_device_contacts(device_keys)
        if stale:
            logger.info(f"Downgraded {stale} stale device contacts to cache")
        logger.info(f"Synced {len(device_keys)} contacts from device to database")

    def execute(self, coro, timeout: float = 30) -> Any:
        """
        Execute an async coroutine from sync Flask context.
        Blocks until the coroutine completes and returns the result.
        """
        if not self._loop or not self._loop.is_running():
            raise RuntimeError("DeviceManager event loop not running")
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result(timeout=timeout)

    def stop(self):
        """Disconnect from device and stop the background thread."""
        logger.info("Stopping DeviceManager...")

        if self.mc and self._loop and self._loop.is_running():
            try:
                future = asyncio.run_coroutine_threadsafe(
                    self.mc.disconnect(), self._loop
                )
                future.result(timeout=5)
            except Exception as e:
                logger.warning(f"Error during disconnect: {e}")

        if self._loop and self._loop.is_running():
            self._loop.call_soon_threadsafe(self._loop.stop)

        if self._thread:
            self._thread.join(timeout=5)

        self._connected = False
        self.mc = None
        self._subscriptions.clear()
        logger.info("DeviceManager stopped")

    # ================================================================
    # Event Handlers (async — run in device manager thread)
    # ================================================================

    async def _on_channel_message(self, event):
        """Handle incoming channel message."""
        try:
            data = getattr(event, 'payload', {})
            ts = data.get('timestamp', int(time.time()))
            raw_text = data.get('text', '')
            channel_idx = data.get('channel_idx', 0)

            # Parse sender from "SenderName: message" format
            if ':' in raw_text:
                sender, content = raw_text.split(':', 1)
                sender = sender.strip()
                content = content.strip()
            else:
                sender = 'Unknown'
                content = raw_text

            # Check if sender is blocked (store but don't emit)
            blocked_names = self.db.get_blocked_contact_names()
            is_blocked = sender in blocked_names

            msg_id = self.db.insert_channel_message(
                channel_idx=channel_idx,
                sender=sender,
                content=content,
                timestamp=ts,
                sender_timestamp=data.get('sender_timestamp'),
                snr=data.get('SNR', data.get('snr')),
                path_len=data.get('path_len'),
                pkt_payload=data.get('pkt_payload'),
                raw_json=json.dumps(data, default=str),
            )

            logger.info(f"Channel msg #{msg_id} from {sender} on ch{channel_idx}")

            if is_blocked:
                logger.debug(f"Blocked channel msg from {sender}, stored but not emitted")
                return

            if self.socketio:
                snr = data.get('SNR', data.get('snr'))
                path_len = data.get('path_len')
                pkt_payload = data.get('pkt_payload')

                # Compute analyzer URL from pkt_payload
                analyzer_url = None
                if pkt_payload:
                    try:
                        raw = bytes([GRP_TXT_TYPE_BYTE]) + bytes.fromhex(pkt_payload)
                        packet_hash = hashlib.sha256(raw).hexdigest()[:16].upper()
                        analyzer_url = f"{ANALYZER_BASE_URL}{packet_hash}"
                    except (ValueError, TypeError):
                        pass

                self.socketio.emit('new_message', {
                    'type': 'channel',
                    'channel_idx': channel_idx,
                    'sender': sender,
                    'content': content,
                    'timestamp': ts,
                    'id': msg_id,
                    'snr': snr,
                    'path_len': path_len,
                    'pkt_payload': pkt_payload,
                    'analyzer_url': analyzer_url,
                }, namespace='/chat')
                logger.debug(f"SocketIO emitted new_message for ch{channel_idx} msg #{msg_id}")

        except Exception as e:
            logger.error(f"Error handling channel message: {e}")

    async def _on_dm_received(self, event):
        """Handle incoming direct message."""
        try:
            data = getattr(event, 'payload', {})
            ts = data.get('timestamp', int(time.time()))
            content = data.get('text', '')
            sender_key = data.get('public_key', data.get('pubkey_prefix', ''))

            # Look up sender from contacts — resolve prefix to full public key
            sender_name = ''
            if sender_key and self.mc:
                contact = self.mc.get_contact_by_key_prefix(sender_key)
                if contact:
                    sender_name = contact.get('name', '')
                    full_key = contact.get('public_key', '')
                    if full_key:
                        sender_key = full_key
                elif len(sender_key) < 64:
                    # Prefix not resolved from in-memory contacts — try DB
                    db_contact = self.db.get_contact_by_prefix(sender_key)
                    if db_contact and len(db_contact['public_key']) == 64:
                        sender_key = db_contact['public_key']
                        sender_name = db_contact.get('name', '')

            # Receiver-side dedup: skip duplicate retries
            sender_ts = data.get('sender_timestamp')
            if sender_key and content:
                if sender_ts:
                    existing = self.db.find_dm_duplicate(sender_key, content,
                                                         sender_timestamp=sender_ts)
                else:
                    existing = self.db.find_dm_duplicate(sender_key, content,
                                                         window_seconds=300)
                if existing:
                    logger.info(f"DM dedup: skipping retry from {sender_key[:8]}...")
                    return

            # Check if sender is blocked
            is_blocked = sender_key and self.db.is_contact_blocked(sender_key)

            if sender_key:
                # Only upsert with name if we have a real name (not just a prefix)
                self.db.upsert_contact(
                    public_key=sender_key,
                    name=sender_name,  # empty string won't overwrite existing name
                    source='message',
                )

            dm_id = self.db.insert_direct_message(
                contact_pubkey=sender_key,
                direction='in',
                content=content,
                timestamp=ts,
                sender_timestamp=data.get('sender_timestamp'),
                snr=data.get('SNR', data.get('snr')),
                path_len=data.get('path_len'),
                pkt_payload=data.get('pkt_payload'),
                raw_json=json.dumps(data, default=str),
            )

            logger.info(f"DM #{dm_id} from {sender_name or sender_key[:12]}")

            if is_blocked:
                logger.debug(f"Blocked DM from {sender_key[:12]}, stored but not emitted")
                return

            if self.socketio:
                self.socketio.emit('new_message', {
                    'type': 'dm',
                    'contact_pubkey': sender_key,
                    'sender': sender_name or sender_key[:12],
                    'content': content,
                    'timestamp': ts,
                    'id': dm_id,
                }, namespace='/chat')

        except Exception as e:
            logger.error(f"Error handling DM: {e}")

    async def _on_msg_sent(self, event):
        """Handle confirmation that our message was sent."""
        try:
            data = getattr(event, 'payload', {})
            expected_ack = _to_str(data.get('expected_ack'))
            msg_type = data.get('txt_type', 0)

            # txt_type 0 = DM, 1 = channel
            if msg_type == 0 and expected_ack:
                # DM sent confirmation — store expected_ack for delivery tracking
                logger.debug(f"DM sent, expected_ack={expected_ack}")

        except Exception as e:
            logger.error(f"Error handling msg_sent: {e}")

    async def _on_ack(self, event):
        """Handle ACK (delivery confirmation for DM)."""
        try:
            data = getattr(event, 'payload', {})
            # FIX: ACK event payload uses 'code', not 'expected_ack'
            ack_code = _to_str(data.get('code', data.get('expected_ack')))

            if not ack_code:
                return

            # Check if this ACK belongs to a pending DM retry
            dm_id = self._pending_acks.get(ack_code)

            # Only store if not already stored (retry task may have handled it)
            existing = self.db.get_ack_for_dm(ack_code)
            if existing:
                return

            self.db.insert_ack(
                expected_ack=ack_code,
                snr=data.get('snr'),
                rssi=data.get('rssi'),
                route_type=data.get('route_type', ''),
                dm_id=dm_id,
            )

            logger.info(f"ACK received: {ack_code}" +
                         (f" (dm_id={dm_id})" if dm_id else ""))

            if self.socketio:
                # Emit the ORIGINAL expected_ack (from DB) so frontend can match
                # the DOM element. Retry sends generate new ack codes, but the
                # DOM still has the original expected_ack from the first send.
                original_ack = ack_code
                if dm_id:
                    dm = self.db.get_dm_by_id(dm_id)
                    if dm and dm.get('expected_ack'):
                        original_ack = dm['expected_ack']
                self.socketio.emit('ack', {
                    'expected_ack': original_ack,
                    'dm_id': dm_id,
                    'snr': data.get('snr'),
                    'rssi': data.get('rssi'),
                    'route_type': data.get('route_type', ''),
                }, namespace='/chat')

            # Store delivery info and cancel retry task
            if dm_id:
                # Store delivery info from retry context (before cancel races)
                ctx = self._retry_context.pop(dm_id, None)
                if ctx:
                    self.db.update_dm_delivery_info(
                        dm_id, ctx['attempt'], ctx['max_attempts'], ctx['path'])
                    if self.socketio:
                        self.socketio.emit('dm_delivered_info', {
                            'dm_id': dm_id,
                            'attempt': ctx['attempt'],
                            'max_attempts': ctx['max_attempts'],
                            'path': ctx['path'],
                        }, namespace='/chat')

                task = self._retry_tasks.get(dm_id)
                if task and not task.done():
                    task.cancel()
                    logger.info(f"Cancelled retry task for dm_id={dm_id} (ACK received)")
                # Cleanup all pending acks for this DM
                stale = [k for k, v in self._pending_acks.items() if v == dm_id]
                for k in stale:
                    self._pending_acks.pop(k, None)
                self._retry_tasks.pop(dm_id, None)

        except Exception as e:
            logger.error(f"Error handling ACK: {e}")

    async def _on_advertisement(self, event):
        """Handle received advertisement from another node.

        ADVERTISEMENT payload only contains {'public_key': '...'}.
        Full contact details (name, type, lat/lon) must be looked up
        from mc.contacts which is synced at startup.
        If the contact is unknown (new auto-add by firmware), refresh contacts.
        """
        try:
            data = getattr(event, 'payload', {})
            pubkey = data.get('public_key', '')

            if not pubkey:
                return

            # Look up full contact details from meshcore's contact list
            contact = (self.mc.contacts or {}).get(pubkey, {})
            name = contact.get('adv_name', contact.get('name', ''))

            # Also check pending contacts (manual approval mode)
            if not name:
                pending = (self.mc.pending_contacts or {}).get(pubkey, {})
                if pending:
                    name = pending.get('adv_name', pending.get('name', ''))
                    if not contact:
                        contact = pending

            # If contact is still unknown, firmware may have just auto-added it.
            if not name and pubkey not in (self.mc.contacts or {}):
                logger.info(f"Unknown advert from {pubkey[:8]}..., refreshing contacts")
                await self.mc.ensure_contacts(follow=True)
                contact = (self.mc.contacts or {}).get(pubkey, {})
                name = contact.get('adv_name', contact.get('name', ''))

            adv_type = contact.get('type', data.get('adv_type', 0))
            adv_lat = contact.get('adv_lat', data.get('adv_lat'))
            adv_lon = contact.get('adv_lon', data.get('adv_lon'))

            self.db.insert_advertisement(
                public_key=pubkey,
                name=name,
                type=adv_type,
                lat=adv_lat,
                lon=adv_lon,
                timestamp=int(time.time()),
                snr=data.get('snr'),
            )

            # Upsert to contacts with last_advert timestamp
            self.db.upsert_contact(
                public_key=pubkey,
                name=name,
                type=adv_type,
                adv_lat=adv_lat,
                adv_lon=adv_lon,
                last_advert=str(int(time.time())),
                source='advert',
            )

            # If manual mode: add cache-only contacts to pending list
            # (meshcore may fire ADVERTISEMENT instead of NEW_CONTACT for
            # contacts already in mc.pending_contacts or after restart)
            if (self._is_manual_approval_enabled()
                    and pubkey not in (self.mc.contacts or {})
                    and pubkey not in (self.mc.pending_contacts or {})
                    and not self.db.is_contact_ignored(pubkey)
                    and not self.db.is_contact_blocked(pubkey)):
                # Add to pending_contacts so it shows in pending list
                if self.mc.pending_contacts is None:
                    self.mc.pending_contacts = {}
                self.mc.pending_contacts[pubkey] = {
                    'public_key': pubkey,
                    'adv_name': name,
                    'name': name,
                    'type': adv_type,
                    'adv_lat': adv_lat,
                    'adv_lon': adv_lon,
                    'last_advert': int(time.time()),
                }
                logger.info(f"Cache contact added to pending (advert): {name} ({pubkey[:8]}...)")
                if self.socketio:
                    self.socketio.emit('pending_contact', {
                        'public_key': pubkey,
                        'name': name,
                        'type': adv_type,
                    }, namespace='/chat')

            logger.info(f"Advert from '{name}' ({pubkey[:8]}...) type={adv_type}")

        except Exception as e:
            logger.error(f"Error handling advertisement: {e}")

    async def _on_path_update(self, event):
        """Handle path update for a contact.

        Also serves as backup delivery confirmation: when firmware sends
        piggybacked ACK via flood, it fires both ACK and PATH_UPDATE events.
        If the ACK event was missed, PATH_UPDATE can confirm delivery.
        """
        try:
            data = getattr(event, 'payload', {})
            pubkey = data.get('public_key', '')

            if not pubkey:
                return

            # Store path record (existing behavior)
            self.db.insert_path(
                contact_pubkey=pubkey,
                path=data.get('path', ''),
                snr=data.get('snr'),
                path_len=data.get('path_len'),
            )
            logger.debug(f"Path update for {pubkey[:8]}...")

            # Invalidate contacts cache so UI gets fresh path data
            try:
                from app.routes.api import invalidate_contacts_cache
                invalidate_contacts_cache()
            except ImportError:
                pass

            # Notify UI about path change
            if self.socketio:
                self.socketio.emit('path_changed', {
                    'public_key': pubkey,
                }, namespace='/chat')

            # Backup: check for pending DM to this contact
            for ack_code, dm_id in list(self._pending_acks.items()):
                dm = self.db.get_dm_by_id(dm_id)
                if dm and dm.get('contact_pubkey') == pubkey and dm.get('direction') == 'out':
                    existing_ack = self.db.get_ack_for_dm(ack_code)
                    if not existing_ack:
                        self.db.insert_ack(
                            expected_ack=ack_code,
                            route_type='PATH_FLOOD',
                            dm_id=dm_id,
                        )
                        logger.info(f"PATH delivery confirmed for dm_id={dm_id}")
                        if self.socketio:
                            self.socketio.emit('ack', {
                                'expected_ack': ack_code,
                                'dm_id': dm_id,
                                'route_type': 'PATH_FLOOD',
                            }, namespace='/chat')
                        # Store delivery info from retry context
                        ctx = self._retry_context.pop(dm_id, None)
                        if ctx:
                            self.db.update_dm_delivery_info(
                                dm_id, ctx['attempt'], ctx['max_attempts'], ctx['path'])
                            if self.socketio:
                                self.socketio.emit('dm_delivered_info', {
                                    'dm_id': dm_id,
                                    'attempt': ctx['attempt'],
                                    'max_attempts': ctx['max_attempts'],
                                    'path': ctx['path'],
                                }, namespace='/chat')
                        # Cancel retry task — delivery already confirmed
                        task = self._retry_tasks.get(dm_id)
                        if task and not task.done():
                            task.cancel()
                            logger.info(f"Cancelled retry task for dm_id={dm_id} (PATH confirmed)")
                        stale_acks = [k for k, v in self._pending_acks.items() if v == dm_id]
                        for k in stale_acks:
                            self._pending_acks.pop(k, None)
                        self._retry_tasks.pop(dm_id, None)
                    break  # Only confirm the most recent pending DM to this contact

        except Exception as e:
            logger.error(f"Error handling path update: {e}")

    async def _on_rx_log_data(self, event):
        """Handle RX_LOG_DATA — RF log containing echoed/repeated packets.

        Firmware sends LOG_DATA (0x88) packets for every repeated radio frame.
        Payload format: header(1) [transport_code(4)] path_len(1) path(N) pkt_payload(rest)
        We only process GRP_TXT (payload_type=0x05) for channel message echoes.
        """
        try:
            import io
            data = getattr(event, 'payload', {})
            payload_hex = data.get('payload', '')
            logger.debug(f"RX_LOG_DATA received: {len(payload_hex)//2} bytes, snr={data.get('snr')}")
            if not payload_hex:
                return

            pkt = bytes.fromhex(payload_hex)
            pbuf = io.BytesIO(pkt)

            header = pbuf.read(1)[0]
            route_type = header & 0x03
            payload_type = (header & 0x3C) >> 2

            # Skip transport code for route_type 0 (flood) and 3
            if route_type == 0x00 or route_type == 0x03:
                pbuf.read(4)  # discard transport code

            path_len = pbuf.read(1)[0]
            path = pbuf.read(path_len).hex()
            pkt_payload = pbuf.read().hex()

            # Only process GRP_TXT channel message echoes
            if payload_type != 0x05:
                return

            if not pkt_payload:
                return

            snr = data.get('snr')
            self._process_echo(pkt_payload, path, snr)

        except Exception as e:
            logger.error(f"Error handling RX_LOG_DATA: {e}")

    def _get_channel_hash(self, channel_idx: int) -> str:
        """Get the expected channel hash byte (hex) for a channel index."""
        import hashlib
        secret_hex = self._channel_secrets.get(channel_idx)
        if not secret_hex:
            return None
        return hashlib.sha256(bytes.fromhex(secret_hex)).digest()[0:1].hex()

    def _process_echo(self, pkt_payload: str, path: str, snr: float = None):
        """Classify and store an echo: sent echo or incoming echo.

        For sent messages: correlate with pending echo to get pkt_payload.
        For incoming: store as echo keyed by pkt_payload for route display.
        """
        with self._echo_lock:
            current_time = time.time()
            direction = 'incoming'

            # Check if this matches a pending sent message
            if self._pending_echo:
                pe = self._pending_echo
                age = current_time - pe['timestamp']

                # Expire stale pending echo
                if age > 60:
                    self._pending_echo = None
                elif pe['pkt_payload'] is None:
                    # Validate channel hash before correlating — the first byte
                    # of pkt_payload is sha256(channel_secret)[0], must match
                    # the channel we sent on to avoid cross-channel mismatches
                    expected_hash = self._get_channel_hash(pe['channel_idx'])
                    echo_hash = pkt_payload[:2] if pkt_payload else None
                    if expected_hash and echo_hash and expected_hash == echo_hash:
                        # First echo after send — correlate pkt_payload with sent message
                        pe['pkt_payload'] = pkt_payload
                        direction = 'sent'
                        self.db.update_message_pkt_payload(pe['msg_id'], pkt_payload)
                        logger.info(f"Echo: correlated pkt_payload with sent msg #{pe['msg_id']}, path={path}")
                    elif expected_hash and echo_hash and expected_hash != echo_hash:
                        logger.debug(f"Echo: channel hash mismatch (expected {expected_hash}, got {echo_hash}) — not our sent msg")
                elif pe['pkt_payload'] == pkt_payload:
                    # Additional echo for same sent message
                    direction = 'sent'

            # Store echo in DB
            self.db.insert_echo(
                pkt_payload=pkt_payload,
                path=path,
                snr=snr,
                direction=direction,
            )

            logger.debug(f"Echo ({direction}): path={path} snr={snr} pkt={pkt_payload[:16]}...")

            # Emit SocketIO event for real-time UI update
            if self.socketio:
                self.socketio.emit('echo', {
                    'pkt_payload': pkt_payload,
                    'path': path,
                    'snr': snr,
                    'direction': direction,
                }, namespace='/chat')

    def _is_manual_approval_enabled(self) -> bool:
        """Check if manual contact approval is enabled (from database)."""
        try:
            return bool(self.db.get_setting_json('manual_add_contacts', False))
        except Exception:
            pass
        return False

    async def _on_new_contact(self, event):
        """Handle new contact discovered.

        When manual approval is enabled, contacts go to pending list only.
        When manual approval is off, contacts are auto-added to DB.
        """
        try:
            data = getattr(event, 'payload', {})
            pubkey = data.get('public_key', '')
            name = data.get('adv_name', data.get('name', ''))

            if not pubkey:
                return

            # Ignored/blocked: still update cache but don't add to pending or device
            if self.db.is_contact_ignored(pubkey) or self.db.is_contact_blocked(pubkey):
                last_adv = data.get('last_advert')
                last_advert_val = (
                    str(int(last_adv))
                    if last_adv and isinstance(last_adv, (int, float)) and last_adv > 0
                    else str(int(time.time()))
                )
                self.db.upsert_contact(
                    public_key=pubkey,
                    name=name,
                    type=data.get('type', data.get('adv_type', 0)),
                    adv_lat=data.get('adv_lat'),
                    adv_lon=data.get('adv_lon'),
                    last_advert=last_advert_val,
                    source='advert',
                )
                logger.info(f"Ignored/blocked contact advert: {name} ({pubkey[:8]}...)")
                return

            if self._is_manual_approval_enabled():
                # Check if contact already exists on the device (firmware edge case:
                # firmware may fire NEW_CONTACT for a contact that was previously
                # on the device but got removed by firmware-level cleanup)
                if pubkey in (self.mc.contacts or {}):
                    logger.warning(
                        f"NEW_CONTACT fired for contact already on device: {name} ({pubkey[:8]}...) "
                        f"— skipping pending, updating DB cache only"
                    )
                    # Just update cache, don't add to pending
                    last_adv = data.get('last_advert')
                    last_advert_val = (
                        str(int(last_adv))
                        if last_adv and isinstance(last_adv, (int, float)) and last_adv > 0
                        else str(int(time.time()))
                    )
                    self.db.upsert_contact(
                        public_key=pubkey,
                        name=name,
                        type=data.get('type', data.get('adv_type', 0)),
                        adv_lat=data.get('adv_lat'),
                        adv_lon=data.get('adv_lon'),
                        last_advert=last_advert_val,
                        source='device',
                    )
                    return

                # Check if contact was previously known (in DB cache)
                existing = self.db.get_contact(pubkey)
                if existing:
                    logger.info(
                        f"Pending contact (manual mode): {name} ({pubkey[:8]}...) "
                        f"— previously known (source={existing['source']}, "
                        f"protected={existing['is_protected']})"
                    )
                else:
                    logger.info(f"Pending contact (manual mode): {name} ({pubkey[:8]}...) — first time seen")

                # Manual mode: meshcore puts it in mc.pending_contacts for approval

                # Also add to DB cache for @mentions and Cache filter
                last_adv = data.get('last_advert')
                last_advert_val = (
                    str(int(last_adv))
                    if last_adv and isinstance(last_adv, (int, float)) and last_adv > 0
                    else str(int(time.time()))
                )
                self.db.upsert_contact(
                    public_key=pubkey,
                    name=name,
                    type=data.get('type', data.get('adv_type', 0)),
                    adv_lat=data.get('adv_lat'),
                    adv_lon=data.get('adv_lon'),
                    last_advert=last_advert_val,
                    source='advert',  # cache-only until approved
                )

                if self.socketio:
                    self.socketio.emit('pending_contact', {
                        'public_key': pubkey,
                        'name': name,
                        'type': data.get('type', data.get('adv_type', 0)),
                    }, namespace='/chat')
                return

            # Auto mode: add to DB immediately
            last_adv = data.get('last_advert')
            last_advert_val = (
                str(int(last_adv))
                if last_adv and isinstance(last_adv, (int, float)) and last_adv > 0
                else str(int(time.time()))
            )
            self.db.upsert_contact(
                public_key=pubkey,
                name=name,
                type=data.get('type', data.get('adv_type', 0)),
                adv_lat=data.get('adv_lat'),
                adv_lon=data.get('adv_lon'),
                last_advert=last_advert_val,
                source='device',
            )
            logger.info(f"New contact (auto-add): {name} ({pubkey[:8]}...)")

        except Exception as e:
            logger.error(f"Error handling new contact: {e}")

    async def _on_disconnected(self, event):
        """Handle device disconnection with auto-reconnect."""
        logger.warning("Device disconnected")
        self._connected = False

        if self.socketio:
            self.socketio.emit('device_status', {
                'connected': False,
            }, namespace='/chat')

        # Auto-reconnect with backoff
        for attempt in range(1, 4):
            delay = 5 * attempt
            logger.info(f"Reconnecting in {delay}s (attempt {attempt}/3)...")
            await asyncio.sleep(delay)
            try:
                await self._connect()
                if self._connected:
                    logger.info("Reconnected successfully")
                    if self.socketio:
                        self.socketio.emit('device_status', {
                            'connected': True,
                        }, namespace='/chat')
                    return
            except Exception as e:
                logger.error(f"Reconnect attempt {attempt} failed: {e}")

        logger.error("Failed to reconnect after 3 attempts")

    # ================================================================
    # Command Methods (sync — called from Flask routes)
    # ================================================================

    def send_channel_message(self, channel_idx: int, text: str) -> Dict:
        """Send a message to a channel. Returns result dict."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}

        try:
            event = self.execute(self.mc.commands.send_chan_msg(channel_idx, text))

            # Store the sent message in database
            ts = int(time.time())
            msg_id = self.db.insert_channel_message(
                channel_idx=channel_idx,
                sender=self.device_name,
                content=text,
                timestamp=ts,
                is_own=True,
                pkt_payload=getattr(event, 'data', {}).get('pkt_payload') if event else None,
            )

            # Register for echo correlation — first RX_LOG_DATA echo will
            # provide the actual pkt_payload for this sent message
            with self._echo_lock:
                self._pending_echo = {
                    'timestamp': time.time(),
                    'channel_idx': channel_idx,
                    'msg_id': msg_id,
                    'pkt_payload': None,
                }

            # Emit SocketIO event so sender's UI updates immediately
            if self.socketio:
                self.socketio.emit('new_message', {
                    'type': 'channel',
                    'channel_idx': channel_idx,
                    'sender': self.device_name,
                    'content': text,
                    'timestamp': ts,
                    'is_own': True,
                    'id': msg_id,
                }, namespace='/chat')

            return {'success': True, 'message': 'Message sent', 'id': msg_id}

        except Exception as e:
            logger.error(f"Failed to send channel message: {e}")
            return {'success': False, 'error': str(e)}

    def send_dm(self, recipient_pubkey: str, text: str) -> Dict:
        """Send a direct message with background retry. Returns result dict."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}

        try:
            # Find contact in device's contact table
            contact = self.mc.contacts.get(recipient_pubkey)
            if not contact:
                contact = self.mc.get_contact_by_key_prefix(recipient_pubkey)
            if not contact:
                # Contact must exist on device to send DM
                return {'success': False,
                        'error': f'Contact not on device. '
                                 f'Re-add {recipient_pubkey[:12]}... via Contacts page.'}

            # Generate timestamp once — same for all retries (enables receiver dedup)
            timestamp = int(time.time())

            event = self.execute(
                self.mc.commands.send_msg(contact, text,
                                          timestamp=timestamp, attempt=0)
            )

            from meshcore.events import EventType
            event_data = getattr(event, 'payload', {})

            if event.type == EventType.ERROR:
                err_detail = event_data.get('error', event_data.get('message', ''))
                logger.warning(f"Device error sending DM to {recipient_pubkey[:12]}: "
                               f"payload={event_data}, contact_type={type(contact).__name__}")
                return {'success': False, 'error': f'Device error sending DM: {err_detail}'}

            ack = _to_str(event_data.get('expected_ack'))
            suggested_timeout = event_data.get('suggested_timeout', 15000)

            # Store sent DM in database (single record, not per-retry)
            dm_id = self.db.insert_direct_message(
                contact_pubkey=recipient_pubkey.lower(),
                direction='out',
                content=text,
                timestamp=timestamp,
                expected_ack=ack or None,
                pkt_payload=_to_str(event_data.get('pkt_payload')) or None,
            )

            # Register ack → dm_id mapping for _on_ack handler
            if ack:
                self._pending_acks[ack] = dm_id

            # Launch background retry task
            task = asyncio.run_coroutine_threadsafe(
                self._dm_retry_task(
                    dm_id, contact, text, timestamp,
                    ack, suggested_timeout
                ),
                self._loop
            )
            self._retry_tasks[dm_id] = task

            return {
                'success': True,
                'message': 'DM sent',
                'id': dm_id,
                'expected_ack': ack,
            }

        except Exception as e:
            logger.error(f"Failed to send DM: {e}")
            return {'success': False, 'error': str(e)}

    async def _change_path_async(self, contact, path_hex: str, hash_size: int = 1):
        """Change contact path on device with proper hash_size encoding."""
        path_hash_mode = hash_size - 1  # 0=1B, 1=2B, 2=3B
        await self.mc.commands.change_contact_path(contact, path_hex, path_hash_mode=path_hash_mode)
        # Invalidate contacts cache so UI gets fresh path data
        try:
            from app.routes.api import invalidate_contacts_cache
            invalidate_contacts_cache()
        except ImportError:
            pass

    async def _restore_primary_path(self, contact, contact_pubkey: str):
        """Restore the primary configured path on the device after retry exhaustion."""
        try:
            primary = self.db.get_primary_contact_path(contact_pubkey)
            if primary:
                await self._change_path_async(contact, primary['path_hex'], primary['hash_size'])
                logger.info(f"Restored primary path for {contact_pubkey[:12]}")
            else:
                logger.debug(f"No primary path to restore for {contact_pubkey[:12]}")
        except Exception as e:
            logger.warning(f"Failed to restore primary path for {contact_pubkey[:12]}: {e}")

    async def _dm_retry_send_and_wait(self, contact, text, timestamp, attempt,
                                       dm_id, suggested_timeout, min_wait):
        """Send a DM retry attempt and wait for ACK. Returns True if delivered."""
        from meshcore.events import EventType

        logger.debug(f"DM retry attempt #{attempt}: sending dm_id={dm_id}")

        try:
            result = await self.mc.commands.send_msg(
                contact, text, timestamp=timestamp, attempt=attempt
            )
        except Exception as e:
            logger.warning(f"DM retry #{attempt}: send error: {e}")
            return False

        if result.type == EventType.ERROR:
            logger.warning(f"DM retry #{attempt}: device error")
            return False

        retry_ack = _to_str(result.payload.get('expected_ack'))
        if retry_ack:
            self._pending_acks[retry_ack] = dm_id
            new_timeout = result.payload.get('suggested_timeout', suggested_timeout)
            wait_s = max(new_timeout / 1000 * 1.2, min_wait)

            logger.debug(f"DM retry #{attempt}: waiting {wait_s:.0f}s for ACK {retry_ack[:8]}...")

            ack_event = await self.mc.dispatcher.wait_for_event(
                EventType.ACK,
                attribute_filters={"code": retry_ack},
                timeout=wait_s
            )
            if ack_event:
                self._confirm_delivery(dm_id, retry_ack, ack_event)
                return True

            logger.debug(f"DM retry #{attempt}: no ACK received (timeout)")

        return False

    def _emit_retry_status(self, dm_id: int, expected_ack: str,
                            attempt: int, max_attempts: int):
        """Notify frontend about retry progress."""
        if self.socketio:
            self.socketio.emit('dm_retry_status', {
                'dm_id': dm_id,
                'expected_ack': expected_ack,
                'attempt': attempt,
                'max_attempts': max_attempts,
            }, namespace='/chat')

    def _emit_retry_failed(self, dm_id: int, expected_ack: str):
        """Notify frontend that all retry attempts were exhausted."""
        if self.socketio:
            self.socketio.emit('dm_retry_failed', {
                'dm_id': dm_id,
                'expected_ack': expected_ack,
            }, namespace='/chat')

    @staticmethod
    def _paths_match(contact_out_path: str, contact_out_path_len: int,
                     configured_path: dict) -> bool:
        """Check if device's current path matches a configured path."""
        if contact_out_path_len <= 0:
            return False
        cfg_hash_size = configured_path['hash_size']
        device_hash_size = (contact_out_path_len >> 6) + 1
        if device_hash_size != cfg_hash_size:
            return False
        hop_count = contact_out_path_len & 0x3F
        meaningful_len = hop_count * device_hash_size * 2
        return (contact_out_path.lower()[:meaningful_len] ==
                configured_path['path_hex'].lower()[:meaningful_len])

    async def _dm_retry_task(self, dm_id: int, contact, text: str,
                              timestamp: int, initial_ack: str,
                              suggested_timeout: int):
        """Background retry with same timestamp for dedup on receiver.

        4-scenario matrix based on (has_path × has_configured_paths):
        - Scenario 1: No path, no configured paths → FLOOD only
        - Scenario 2: Has path, no configured paths → DIRECT + optional FLOOD
        - Scenario 3: No path, has configured paths → FLOOD first, then configured path rotation
        - Scenario 4: Has path, has configured paths → DIRECT on current path, configured path rotation, optional FLOOD

        The no_auto_flood per-contact flag prevents automatic DIRECT→FLOOD reset
        in Scenarios 2 and 4.  Ignored in Scenarios 1 and 3.
        Settings loaded from app_settings DB table (key: dm_retry_settings).
        """
        from meshcore.events import EventType

        # ── Load configurable retry settings from DB ──
        _defaults = {
            'direct_max_retries': 3, 'direct_flood_retries': 1,
            'flood_max_retries': 3, 'direct_interval': 30,
            'flood_interval': 60, 'grace_period': 60,
        }
        saved = self.db.get_setting_json('dm_retry_settings', {})
        cfg = {**_defaults, **(saved or {})}

        contact_pubkey = contact.get('public_key', '').lower()
        has_path = contact.get('out_path_len', -1) > 0

        # Capture original device path for dedup (contact dict may mutate)
        original_out_path = contact.get('out_path', '').lower()
        original_out_path_len = contact.get('out_path_len', -1)

        # Load user-configured paths and no_auto_flood flag
        configured_paths = self.db.get_contact_paths(contact_pubkey) if contact_pubkey else []
        no_auto_flood = self.db.get_contact_no_auto_flood(contact_pubkey) if contact_pubkey else False
        has_configured_paths = bool(configured_paths)

        min_wait = float(cfg['direct_interval']) if has_path else float(cfg['flood_interval'])
        wait_s = max(suggested_timeout / 1000 * 1.2, min_wait)

        # Determine scenario for logging
        if has_path and has_configured_paths:
            scenario = "S4_DIRECT_SD_FLOOD"
        elif has_path:
            scenario = "S2_DIRECT_FLOOD"
        elif has_configured_paths:
            scenario = "S3_FLOOD_SD"
        else:
            scenario = "S1_FLOOD"

        # ── Pre-compute path split and max_attempts ──
        def _split_primary_and_others(paths):
            primary = None
            others = []
            for p in paths:
                if p.get('is_primary') and primary is None:
                    primary = p
                else:
                    others.append(p)
            return primary, others

        primary_path = None
        other_paths = []
        rotation_order = []
        if has_configured_paths:
            primary_path, other_paths = _split_primary_and_others(configured_paths)
            rotation_order = ([primary_path] if primary_path else []) + other_paths

        retries_per_path = max(1, cfg['direct_max_retries'])

        if scenario == "S1_FLOOD":
            max_attempts = 1 + cfg['flood_max_retries']
        elif scenario == "S2_DIRECT_FLOOD":
            max_attempts = 1 + cfg['direct_max_retries']
            if not no_auto_flood:
                max_attempts += cfg['direct_flood_retries']
        elif scenario == "S3_FLOOD_SD":
            max_attempts = (1 + cfg['flood_max_retries']
                            + len(rotation_order) * retries_per_path)
        else:  # S4
            deduped = sum(1 for p in rotation_order
                          if self._paths_match(original_out_path, original_out_path_len, p))
            effective_sd = len(rotation_order) - deduped
            max_attempts = 1 + cfg['direct_max_retries'] + effective_sd * retries_per_path
            if not no_auto_flood:
                max_attempts += cfg['flood_max_retries']

        # Track current path hex for delivery info (actual route, not label)
        def _extract_path_hex(out_path, out_path_len):
            """Extract meaningful hex portion from device path."""
            if out_path_len <= 0 or not out_path:
                return ''
            hop_count = out_path_len & 0x3F
            hash_size = (out_path_len >> 6) + 1
            meaningful_len = hop_count * hash_size * 2
            return out_path[:meaningful_len].lower() if meaningful_len > 0 else ''

        path_desc = _extract_path_hex(original_out_path, original_out_path_len) if has_path else ''

        logger.info(f"DM retry task started: dm_id={dm_id}, scenario={scenario}, "
                     f"configured_paths={len(configured_paths)}, no_auto_flood={no_auto_flood}, "
                     f"max_attempts={max_attempts}, wait={wait_s:.0f}s")

        # ── Local helper: update context, emit status, send ──
        # Delivery info is stored by _on_ack() using _retry_context (avoids cancel race)
        async def _retry(attempt_num, min_wait_s):
            display = attempt_num + 1  # attempt 0 = initial send = display 1
            self._retry_context[dm_id] = {
                'attempt': display, 'max_attempts': max_attempts, 'path': path_desc,
            }
            self._emit_retry_status(dm_id, initial_ack, display, max_attempts)
            return await self._dm_retry_send_and_wait(
                contact, text, timestamp, attempt_num, dm_id,
                suggested_timeout, min_wait_s
            )

        # ── Wait for initial ACK (attempt 1) ──
        # Delivery info stored by _on_ack() via _retry_context (avoids cancel race)
        self._retry_context[dm_id] = {
            'attempt': 1, 'max_attempts': max_attempts, 'path': path_desc,
        }
        self._emit_retry_status(dm_id, initial_ack, 1, max_attempts)
        if initial_ack:
            logger.debug(f"DM retry: waiting {wait_s:.0f}s for initial ACK {initial_ack[:8]}...")
            ack_event = await self.mc.dispatcher.wait_for_event(
                EventType.ACK,
                attribute_filters={"code": initial_ack},
                timeout=wait_s
            )
            if ack_event:
                self._confirm_delivery(dm_id, initial_ack, ack_event)
                return
            logger.debug(f"DM retry: initial ACK not received (timeout)")

        attempt = 0  # Global attempt counter (0 = initial send already done)

        # ════════════════════════════════════════════════════════════
        # Scenario 1: No path, no configured paths → FLOOD only
        # ════════════════════════════════════════════════════════════
        if not has_path and not has_configured_paths:
            for _ in range(cfg['flood_max_retries']):
                attempt += 1
                if await _retry(attempt, float(cfg['flood_interval'])):
                    return

        # ════════════════════════════════════════════════════════════
        # Scenario 2: Has path, no configured paths → DIRECT + optional FLOOD
        # ════════════════════════════════════════════════════════════
        elif has_path and not has_configured_paths:
            # Phase 1: Direct retries on current path
            for _ in range(cfg['direct_max_retries']):
                attempt += 1
                if await _retry(attempt, float(cfg['direct_interval'])):
                    return

            # Phase 2: Optional FLOOD fallback (controlled by no_auto_flood)
            if not no_auto_flood:
                try:
                    await self.mc.commands.reset_path(contact)
                    logger.info("DM retry: direct exhausted, resetting to FLOOD")
                except Exception:
                    pass
                path_desc = ''
                for _ in range(cfg['direct_flood_retries']):
                    attempt += 1
                    if await _retry(attempt, float(cfg['flood_interval'])):
                        return

        # ════════════════════════════════════════════════════════════
        # Scenario 3: No path, has configured paths → FLOOD first, then configured path rotation
        # ════════════════════════════════════════════════════════════
        elif not has_path and has_configured_paths:
            # Phase 1: FLOOD retries per NoPath settings (discover new path)
            logger.info("DM retry: FLOOD first to discover new path")
            for _ in range(cfg['flood_max_retries']):
                attempt += 1
                if await _retry(attempt, float(cfg['flood_interval'])):
                    return  # Firmware sets discovered path automatically

            # Phase 2: Configured path rotation (primary first, then others by sort_order)
            logger.info("DM retry: FLOOD exhausted, rotating through configured paths")
            direct_interval = float(cfg['direct_interval'])

            for path_info in rotation_order:
                try:
                    await self._change_path_async(contact, path_info['path_hex'], path_info['hash_size'])
                    label = path_info.get('label', '')
                    path_desc = path_info['path_hex']
                    logger.info(f"DM retry: switched to path '{label}' ({path_info['path_hex']})")
                except Exception as e:
                    logger.warning(f"DM retry: failed to switch path: {e}")
                    continue

                for _ in range(retries_per_path):
                    attempt += 1
                    if await _retry(attempt, direct_interval):
                        await self._restore_primary_path(contact, contact_pubkey)
                        return

            # Restore primary path regardless of outcome
            await self._restore_primary_path(contact, contact_pubkey)

        # ════════════════════════════════════════════════════════════
        # Scenario 4: Has path + has configured paths → DIRECT on current path, configured path rotation, optional FLOOD
        # ════════════════════════════════════════════════════════════
        else:  # has_path and has_configured_paths
            # Phase 1: Direct retries on current path
            for _ in range(cfg['direct_max_retries']):
                attempt += 1
                if await _retry(attempt, float(cfg['direct_interval'])):
                    return  # Delivered on current path, no change needed

            # Phase 2: Configured path rotation with dedup
            logger.info("DM retry: direct retries exhausted, rotating through configured paths")
            direct_interval = float(cfg['direct_interval'])

            for path_info in rotation_order:
                # Dedup: skip if this configured path matches original device path
                if self._paths_match(original_out_path, original_out_path_len, path_info):
                    logger.debug(f"DM retry: skipping path '{path_info.get('label', '')}' "
                                 f"({path_info['path_hex']}) — matches current device path")
                    continue

                try:
                    await self._change_path_async(contact, path_info['path_hex'], path_info['hash_size'])
                    label = path_info.get('label', '')
                    path_desc = path_info['path_hex']
                    logger.info(f"DM retry: switched to path '{label}' ({path_info['path_hex']})")
                except Exception as e:
                    logger.warning(f"DM retry: failed to switch path: {e}")
                    continue

                for _ in range(retries_per_path):
                    attempt += 1
                    if await _retry(attempt, direct_interval):
                        await self._restore_primary_path(contact, contact_pubkey)
                        return

            # Phase 3: Optional FLOOD fallback (controlled by no_auto_flood)
            if not no_auto_flood:
                try:
                    await self.mc.commands.reset_path(contact)
                    logger.info("DM retry: all paths exhausted, falling back to FLOOD")
                except Exception:
                    pass
                path_desc = ''
                for _ in range(cfg['flood_max_retries']):
                    attempt += 1
                    if await _retry(attempt, float(cfg['flood_interval'])):
                        await self._restore_primary_path(contact, contact_pubkey)
                        return

            # Restore primary path regardless of outcome
            await self._restore_primary_path(contact, contact_pubkey)

        # ── Common epilogue: mark failed, grace period for late ACKs ──
        self.db.update_dm_delivery_info(dm_id, attempt + 1, max_attempts, '')
        self.db.update_dm_delivery_status(dm_id, 'failed')
        self._emit_retry_failed(dm_id, initial_ack)
        logger.warning(f"DM retry exhausted ({attempt + 1} total attempts, scenario={scenario}) "
                       f"for dm_id={dm_id}")
        self._retry_tasks.pop(dm_id, None)
        self._retry_context.pop(dm_id, None)
        await asyncio.sleep(cfg['grace_period'])
        stale = [k for k, v in self._pending_acks.items() if v == dm_id]
        if stale:
            for k in stale:
                self._pending_acks.pop(k, None)
            logger.debug(f"Grace period expired, cleaned {len(stale)} pending acks for dm_id={dm_id}")

    def _confirm_delivery(self, dm_id: int, ack_code: str, ack_event):
        """Store ACK and notify frontend."""
        data = getattr(ack_event, 'payload', {})

        # Only store if not already stored by _on_ack handler
        existing = self.db.get_ack_for_dm(ack_code)
        if not existing:
            self.db.insert_ack(
                expected_ack=ack_code,
                snr=data.get('snr'),
                rssi=data.get('rssi'),
                route_type=data.get('route_type', ''),
                dm_id=dm_id,
            )

        logger.info(f"DM delivery confirmed: dm_id={dm_id}, ack={ack_code}")

        if self.socketio:
            # Emit original expected_ack so frontend can match the DOM element
            original_ack = ack_code
            dm = self.db.get_dm_by_id(dm_id)
            if dm and dm.get('expected_ack'):
                original_ack = dm['expected_ack']
            self.socketio.emit('ack', {
                'expected_ack': original_ack,
                'dm_id': dm_id,
                'snr': data.get('snr'),
            }, namespace='/chat')

        # Cleanup pending acks for this DM
        stale = [k for k, v in self._pending_acks.items() if v == dm_id]
        for k in stale:
            self._pending_acks.pop(k, None)
        self._retry_tasks.pop(dm_id, None)

    def get_contacts_from_device(self) -> List[Dict]:
        """Refresh contacts from device and return the list."""
        if not self.is_connected:
            return []

        try:
            self.execute(self.mc.ensure_contacts(follow=True))
            self._sync_contacts_to_db()
            return self.db.get_contacts()
        except Exception as e:
            logger.error(f"Failed to get contacts: {e}")
            return self.db.get_contacts()  # return cached

    def delete_contact(self, pubkey: str) -> Dict:
        """Delete a contact from device and soft-delete in database."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}

        try:
            self.execute(self.mc.commands.remove_contact(pubkey))
            self.db.delete_contact(pubkey)  # soft-delete: sets source='advert'
            # Also remove from in-memory contacts cache
            if self.mc.contacts and pubkey in self.mc.contacts:
                del self.mc.contacts[pubkey]
            return {'success': True, 'message': 'Contact deleted'}
        except Exception as e:
            logger.error(f"Failed to delete contact: {e}")
            return {'success': False, 'error': str(e)}

    def delete_cached_contact(self, pubkey: str) -> Dict:
        """Hard-delete a cache-only contact from the database."""
        try:
            # Don't delete if contact is on device
            if self.mc and self.mc.contacts and pubkey in self.mc.contacts:
                return {'success': False, 'error': 'Contact is on device, use delete_contact instead'}
            deleted = self.db.hard_delete_contact(pubkey)
            if deleted:
                return {'success': True, 'message': 'Cache contact deleted'}
            return {'success': False, 'error': 'Contact not found in cache'}
        except Exception as e:
            logger.error(f"Failed to delete cached contact: {e}")
            return {'success': False, 'error': str(e)}

    def push_to_device(self, pubkey: str) -> Dict:
        """Push a cache-only contact to the device."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}

        # Already on device?
        if self.mc.contacts and pubkey in self.mc.contacts:
            return {'success': False, 'error': 'Contact is already on device'}

        db_contact = self.db.get_contact(pubkey)
        if not db_contact:
            return {'success': False, 'error': 'Contact not found in cache'}

        name = db_contact.get('name', '')
        contact_type = db_contact.get('type', 1)
        if contact_type == 0:
            contact_type = 1  # NONE → COM

        return self.add_contact_manual(
            name=name,
            public_key=pubkey,
            contact_type=contact_type,
        )

    def move_to_cache(self, pubkey: str) -> Dict:
        """Move a device contact to cache (remove from device, keep in DB)."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}

        if not self.mc.contacts or pubkey not in self.mc.contacts:
            return {'success': False, 'error': 'Contact not on device'}

        contact = self.mc.contacts[pubkey]
        name = contact.get('adv_name', contact.get('name', ''))

        try:
            self.execute(self.mc.commands.remove_contact(pubkey))
            self.db.delete_contact(pubkey)  # soft-delete: sets source='advert'
            if self.mc.contacts and pubkey in self.mc.contacts:
                del self.mc.contacts[pubkey]
            logger.info(f"Moved to cache: {name} ({pubkey[:12]}...)")
            return {'success': True, 'message': f'{name} moved to cache'}
        except Exception as e:
            logger.error(f"Failed to move contact to cache: {e}")
            return {'success': False, 'error': str(e)}

    def reset_path(self, pubkey: str) -> Dict:
        """Reset path to a contact."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}

        try:
            logger.info(f"Executing reset_path for {pubkey[:12]}...")
            result = self.execute(self.mc.commands.reset_path(pubkey))
            logger.info(f"reset_path result: {result}")
            return {'success': True, 'message': 'Path reset'}
        except Exception as e:
            logger.error(f"Failed to reset path: {e}")
            return {'success': False, 'error': str(e)}

    def get_device_info(self) -> Dict:
        """Get device info. Returns info dict or empty dict."""
        if self._self_info:
            return dict(self._self_info)

        if not self.is_connected:
            return {}

        try:
            event = self.execute(self.mc.commands.send_appstart())
            if event and hasattr(event, 'data'):
                self._self_info = getattr(event, 'payload', {})
                return dict(self._self_info)
        except Exception as e:
            logger.error(f"Failed to get device info: {e}")
        return {}

    def get_channel_info(self, idx: int) -> Optional[Dict]:
        """Get info for a specific channel."""
        if not self.is_connected:
            return None

        try:
            event = self.execute(self.mc.commands.get_channel(idx))
            if event:
                data = getattr(event, 'payload', None) or getattr(event, 'data', None)
                if data and isinstance(data, dict):
                    # Normalize keys: channel_name -> name, channel_secret -> secret
                    secret = data.get('channel_secret', data.get('secret', ''))
                    if isinstance(secret, bytes):
                        secret = secret.hex()
                    name = data.get('channel_name', data.get('name', ''))
                    if isinstance(name, str):
                        name = name.strip('\x00').strip()
                    return {
                        'name': name,
                        'secret': secret,
                        'channel_idx': data.get('channel_idx', idx),
                    }
        except Exception as e:
            logger.error(f"Failed to get channel {idx}: {e}")
        return None

    def set_channel(self, idx: int, name: str, secret: bytes = None) -> Dict:
        """Set/create a channel on the device."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}

        try:
            self.execute(self.mc.commands.set_channel(idx, name, secret))
            self.db.upsert_channel(idx, name, secret.hex() if secret else None)
            return {'success': True, 'message': f'Channel {idx} set'}
        except Exception as e:
            logger.error(f"Failed to set channel: {e}")
            return {'success': False, 'error': str(e)}

    def remove_channel(self, idx: int) -> Dict:
        """Remove a channel from the device."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}

        try:
            # Set channel with empty name removes it
            self.execute(self.mc.commands.set_channel(idx, '', None))
            self.db.delete_channel(idx)
            return {'success': True, 'message': f'Channel {idx} removed'}
        except Exception as e:
            logger.error(f"Failed to remove channel: {e}")
            return {'success': False, 'error': str(e)}

    def send_advert(self, flood: bool = False) -> Dict:
        """Send advertisement."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}

        try:
            self.execute(self.mc.commands.send_advert(flood=flood))
            return {'success': True, 'message': 'Advert sent'}
        except Exception as e:
            logger.error(f"Failed to send advert: {e}")
            return {'success': False, 'error': str(e)}

    def check_connection(self) -> bool:
        """Check if device is connected and responsive."""
        if not self.is_connected:
            return False
        try:
            self.execute(self.mc.commands.send_appstart(), timeout=5)
            return True
        except Exception:
            return False

    def set_manual_add_contacts(self, enabled: bool) -> Dict:
        """Enable/disable manual contact approval mode."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}

        try:
            self.execute(self.mc.commands.set_manual_add_contacts(enabled))
            return {'success': True, 'message': f'Manual add contacts: {enabled}'}
        except KeyError as e:
            # Firmware may not support all fields needed by meshcore lib
            logger.warning(f"set_manual_add_contacts unsupported by firmware: {e}")
            return {'success': False, 'error': f'Firmware does not support this setting: {e}'}
        except Exception as e:
            logger.error(f"Failed to set manual_add_contacts: {e}")
            return {'success': False, 'error': str(e)}

    def get_pending_contacts(self) -> List[Dict]:
        """Get contacts pending manual approval."""
        if not self.is_connected:
            return []

        try:
            pending = self.mc.pending_contacts or {}
            return [
                {
                    'public_key': pk,
                    'name': c.get('adv_name', c.get('name', '')),
                    'type': c.get('type', c.get('adv_type', 0)),
                    'adv_lat': c.get('adv_lat'),
                    'adv_lon': c.get('adv_lon'),
                    'last_advert': c.get('last_advert'),
                }
                for pk, c in pending.items()
            ]
        except Exception as e:
            logger.error(f"Failed to get pending contacts: {e}")
            return []

    def approve_contact(self, pubkey: str) -> Dict:
        """Approve a pending contact."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}

        try:
            contact = (self.mc.pending_contacts or {}).get(pubkey)
            # Also check DB cache for contacts not in meshcore's pending list
            if not contact:
                db_contact = self.db.get_contact(pubkey)
                if db_contact and db_contact.get('source') == 'advert':
                    contact = {
                        'public_key': pubkey,
                        'name': db_contact.get('name', ''),
                        'adv_name': db_contact.get('name', ''),
                        'type': db_contact.get('type', 0),
                        'adv_lat': db_contact.get('adv_lat'),
                        'adv_lon': db_contact.get('adv_lon'),
                        'last_advert': db_contact.get('last_advert'),
                    }
            if not contact:
                return {'success': False, 'error': 'Contact not in pending list'}

            self.execute(self.mc.commands.add_contact(contact))

            # Refresh mc.contacts so send_dm can find the new contact
            self.execute(self.mc.ensure_contacts(follow=True))

            # Fallback: if ensure_contacts didn't pick up the new contact,
            # add it manually to mc.contacts (firmware may need time)
            if pubkey not in (self.mc.contacts or {}):
                if self.mc.contacts is None:
                    self.mc.contacts = {}
                self.mc.contacts[pubkey] = contact
                logger.info(f"Manually added {pubkey[:12]}... to mc.contacts")

            last_adv = contact.get('last_advert')
            last_advert_val = (
                str(int(last_adv))
                if last_adv and isinstance(last_adv, (int, float)) and last_adv > 0
                else str(int(time.time()))
            )
            self.db.upsert_contact(
                public_key=pubkey,
                name=contact.get('adv_name', contact.get('name', '')),
                type=contact.get('type', contact.get('adv_type', 0)),
                adv_lat=contact.get('adv_lat'),
                adv_lon=contact.get('adv_lon'),
                last_advert=last_advert_val,
                source='device',
            )
            # Re-link orphaned DMs (from previous ON DELETE SET NULL)
            contact_name = contact.get('adv_name', contact.get('name', ''))
            self.db.relink_orphaned_dms(pubkey, name=contact_name)

            # Remove from pending list after successful approval
            self.mc.pending_contacts.pop(pubkey, None)
            return {'success': True, 'message': 'Contact approved'}
        except Exception as e:
            logger.error(f"Failed to approve contact: {e}")
            return {'success': False, 'error': str(e)}

    def add_contact_manual(self, name: str, public_key: str, contact_type: int = 1) -> Dict:
        """Add a contact manually from name, public_key and type.

        This bypasses the pending/advert mechanism entirely — uses CMD_ADD_UPDATE_CONTACT
        (same as the MeshCore mobile app's QR code / URI sharing).
        """
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}

        # Validate inputs
        public_key = public_key.strip().lower()
        name = name.strip()
        if not name:
            return {'success': False, 'error': 'Name is required'}
        if len(public_key) != 64:
            return {'success': False, 'error': 'Public key must be 64 hex characters'}
        try:
            bytes.fromhex(public_key)
        except ValueError:
            return {'success': False, 'error': 'Public key must be valid hex'}
        if contact_type not in (1, 2, 3, 4):
            return {'success': False, 'error': 'Type must be 1 (COM), 2 (REP), 3 (ROOM), or 4 (SENS)'}

        try:
            contact = {
                'public_key': public_key,
                'type': contact_type,
                'flags': 0,
                'out_path_len': -1,
                'out_path': '',
                'out_path_hash_mode': 0,
                'adv_name': name,
                'last_advert': 0,
                'adv_lat': 0.0,
                'adv_lon': 0.0,
            }

            self.execute(self.mc.commands.add_contact(contact))

            # Refresh mc.contacts from device
            self.execute(self.mc.ensure_contacts(follow=True))

            # Fallback: add to in-memory contacts if firmware needs time
            if public_key not in (self.mc.contacts or {}):
                if self.mc.contacts is None:
                    self.mc.contacts = {}
                self.mc.contacts[public_key] = contact
                logger.info(f"Manually added {public_key[:12]}... to mc.contacts")

            self.db.upsert_contact(
                public_key=public_key,
                name=name,
                type=contact_type,
                adv_lat=0.0,
                adv_lon=0.0,
                last_advert=str(int(time.time())),
                source='device',
            )
            # Re-link orphaned DMs
            self.db.relink_orphaned_dms(public_key, name=name)

            logger.info(f"Manual add contact: {name} ({public_key[:12]}...) type={contact_type}")
            return {'success': True, 'message': f'Contact {name} added to device'}
        except Exception as e:
            logger.error(f"Failed to add contact manually: {e}")
            return {'success': False, 'error': str(e)}

    def reject_contact(self, pubkey: str) -> Dict:
        """Reject a pending contact (remove from pending list without adding)."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}

        try:
            removed = self.mc.pending_contacts.pop(pubkey, None)
            if removed:
                return {'success': True, 'message': 'Contact rejected'}
            # Also check DB cache - remove cache-only contacts on reject
            db_contact = self.db.get_contact(pubkey)
            if db_contact and db_contact.get('source') == 'advert':
                self.db.hard_delete_contact(pubkey)
                return {'success': True, 'message': 'Contact rejected'}
            return {'success': False, 'error': 'Contact not in pending list'}
        except Exception as e:
            logger.error(f"Failed to reject contact: {e}")
            return {'success': False, 'error': str(e)}

    def clear_pending_contacts(self) -> Dict:
        """Clear all pending contacts."""
        try:
            count = len(self.mc.pending_contacts) if self.mc and self.mc.pending_contacts else 0
            if self.mc and self.mc.pending_contacts is not None:
                self.mc.pending_contacts.clear()
            return {'success': True, 'message': f'Cleared {count} pending contacts'}
        except Exception as e:
            logger.error(f"Failed to clear pending contacts: {e}")
            return {'success': False, 'error': str(e)}

    def get_battery(self) -> Optional[Dict]:
        """Get battery status."""
        if not self.is_connected:
            return None

        try:
            event = self.execute(self.mc.commands.get_bat(), timeout=5)
            if event and hasattr(event, 'data'):
                return getattr(event, 'payload', {})
        except Exception as e:
            logger.error(f"Failed to get battery: {e}")
        return None

    def get_device_stats(self) -> Dict:
        """Get combined device statistics (core + radio + packets)."""
        if not self.is_connected:
            return {}

        stats = {}
        try:
            event = self.execute(self.mc.commands.get_stats_core(), timeout=5)
            if event and hasattr(event, 'payload'):
                stats['core'] = event.payload
        except Exception as e:
            logger.debug(f"get_stats_core failed: {e}")

        try:
            event = self.execute(self.mc.commands.get_stats_radio(), timeout=5)
            if event and hasattr(event, 'payload'):
                stats['radio'] = event.payload
        except Exception as e:
            logger.debug(f"get_stats_radio failed: {e}")

        try:
            event = self.execute(self.mc.commands.get_stats_packets(), timeout=5)
            if event and hasattr(event, 'payload'):
                stats['packets'] = event.payload
        except Exception as e:
            logger.debug(f"get_stats_packets failed: {e}")

        return stats

    def request_telemetry(self, contact_name: str) -> Optional[Dict]:
        """Request telemetry data from a remote sensor node."""
        if not self.is_connected:
            return None

        contact = self.mc.get_contact_by_name(contact_name)
        if not contact:
            return {'error': f"Contact '{contact_name}' not found"}

        try:
            event = self.execute(
                self.mc.commands.req_telemetry_sync(contact),
                timeout=30
            )
            if event and hasattr(event, 'payload'):
                return event.payload
            return {'error': 'No telemetry response (timeout)'}
        except Exception as e:
            logger.error(f"Telemetry request failed: {e}")
            return {'error': str(e)}

    def request_neighbors(self, contact_name: str) -> Optional[Dict]:
        """Request neighbor list from a remote node."""
        if not self.is_connected:
            return None

        contact = self.mc.get_contact_by_name(contact_name)
        if not contact:
            return {'error': f"Contact '{contact_name}' not found"}

        try:
            event = self.execute(
                self.mc.commands.req_neighbours_sync(contact),
                timeout=30
            )
            if event and hasattr(event, 'payload'):
                return event.payload
            return {'error': 'No neighbors response (timeout)'}
        except Exception as e:
            logger.error(f"Neighbors request failed: {e}")
            return {'error': str(e)}

    def send_trace(self, path: str) -> Dict:
        """Send a trace packet and wait for trace data response."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}

        try:
            async def _trace():
                from meshcore.events import EventType
                res = await self.mc.commands.send_trace(path=path)
                if res is None or res.type == EventType.ERROR:
                    return None
                tag = int.from_bytes(res.payload['expected_ack'], byteorder="little")
                timeout = res.payload["suggested_timeout"] / 1000 * 1.2
                ev = await self.mc.wait_for_event(
                    EventType.TRACE_DATA,
                    attribute_filters={"tag": tag},
                    timeout=timeout
                )
                if ev is None or ev.type == EventType.ERROR:
                    return None
                return ev.payload

            result = self.execute(_trace(), timeout=120)
            if result is not None:
                return {'success': True, 'data': result}
            return {'success': False, 'error': f'Timeout waiting trace for path {path}'}
        except Exception as e:
            logger.error(f"Trace failed: {e}")
            return {'success': False, 'error': str(e)}

    def resolve_contact(self, name_or_key: str) -> Optional[Dict]:
        """Resolve a contact by name or public key prefix."""
        if not self.is_connected or not self.mc:
            return None
        contact = self.mc.get_contact_by_name(name_or_key)
        if not contact:
            contact = self.mc.get_contact_by_key_prefix(name_or_key)
        return contact

    # ── Repeater Management ──────────────────────────────────────────

    def repeater_login(self, name_or_key: str, password: str) -> Dict:
        """Log into a repeater with given password."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        contact = self.resolve_contact(name_or_key)
        if not contact:
            return {'success': False, 'error': f"Contact not found: {name_or_key}"}
        try:
            from meshcore.events import EventType
            res = self.execute(
                self.mc.commands.send_login(contact, password),
                timeout=10
            )
            # Wait for LOGIN_SUCCESS or LOGIN_FAILED
            timeout = 30
            if res and hasattr(res, 'payload') and 'suggested_timeout' in res.payload:
                timeout = res.payload['suggested_timeout'] / 800
            timeout = max(timeout, contact.get('timeout', 0) or 30)
            event = self.execute(
                self.mc.wait_for_event(EventType.LOGIN_SUCCESS, timeout=timeout),
                timeout=timeout + 5
            )
            if event and hasattr(event, 'type') and event.type == EventType.LOGIN_SUCCESS:
                return {'success': True, 'message': f'Logged into {contact.get("adv_name", name_or_key)}'}
            return {'success': False, 'error': 'Login failed (timeout)'}
        except Exception as e:
            err = str(e)
            if 'LOGIN_FAILED' in err or 'login' in err.lower():
                return {'success': False, 'error': 'Login failed (wrong password?)'}
            logger.error(f"Repeater login failed: {e}")
            return {'success': False, 'error': err}

    def repeater_logout(self, name_or_key: str) -> Dict:
        """Log out of a repeater."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        contact = self.resolve_contact(name_or_key)
        if not contact:
            return {'success': False, 'error': f"Contact not found: {name_or_key}"}
        try:
            self.execute(self.mc.commands.send_logout(contact), timeout=10)
            return {'success': True, 'message': f'Logged out of {contact.get("adv_name", name_or_key)}'}
        except Exception as e:
            logger.error(f"Repeater logout failed: {e}")
            return {'success': False, 'error': str(e)}

    def repeater_cmd(self, name_or_key: str, cmd: str) -> Dict:
        """Send a command to a repeater."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        contact = self.resolve_contact(name_or_key)
        if not contact:
            return {'success': False, 'error': f"Contact not found: {name_or_key}"}
        try:
            res = self.execute(self.mc.commands.send_cmd(contact, cmd), timeout=10)
            msg = f'Command sent to {contact.get("adv_name", name_or_key)}: {cmd}'
            return {'success': True, 'message': msg}
        except Exception as e:
            logger.error(f"Repeater cmd failed: {e}")
            return {'success': False, 'error': str(e)}

    def repeater_req_status(self, name_or_key: str) -> Dict:
        """Request status from a repeater."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        contact = self.resolve_contact(name_or_key)
        if not contact:
            return {'success': False, 'error': f"Contact not found: {name_or_key}"}
        try:
            contact_timeout = contact.get('timeout', 0) or 0
            result = self.execute(
                self.mc.commands.req_status_sync(contact, contact_timeout, min_timeout=15),
                timeout=120
            )
            if result is not None:
                return {'success': True, 'data': result}
            return {'success': False, 'error': 'No status response (timeout)'}
        except Exception as e:
            logger.error(f"req_status failed: {e}")
            return {'success': False, 'error': str(e)}

    def repeater_req_regions(self, name_or_key: str) -> Dict:
        """Request regions from a repeater."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        contact = self.resolve_contact(name_or_key)
        if not contact:
            return {'success': False, 'error': f"Contact not found: {name_or_key}"}
        try:
            contact_timeout = contact.get('timeout', 0) or 0
            result = self.execute(
                self.mc.commands.req_regions_sync(contact, contact_timeout),
                timeout=120
            )
            if result is not None:
                return {'success': True, 'data': result}
            return {'success': False, 'error': 'No regions response (timeout)'}
        except Exception as e:
            logger.error(f"req_regions failed: {e}")
            return {'success': False, 'error': str(e)}

    def repeater_req_owner(self, name_or_key: str) -> Dict:
        """Request owner info from a repeater."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        contact = self.resolve_contact(name_or_key)
        if not contact:
            return {'success': False, 'error': f"Contact not found: {name_or_key}"}
        try:
            contact_timeout = contact.get('timeout', 0) or 0
            result = self.execute(
                self.mc.commands.req_owner_sync(contact, contact_timeout),
                timeout=120
            )
            if result is not None:
                return {'success': True, 'data': result}
            return {'success': False, 'error': 'No owner response (timeout)'}
        except Exception as e:
            logger.error(f"req_owner failed: {e}")
            return {'success': False, 'error': str(e)}

    def repeater_req_acl(self, name_or_key: str) -> Dict:
        """Request access control list from a repeater."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        contact = self.resolve_contact(name_or_key)
        if not contact:
            return {'success': False, 'error': f"Contact not found: {name_or_key}"}
        try:
            contact_timeout = contact.get('timeout', 0) or 0
            result = self.execute(
                self.mc.commands.req_acl_sync(contact, contact_timeout, min_timeout=15),
                timeout=120
            )
            if result is not None:
                return {'success': True, 'data': result}
            return {'success': False, 'error': 'No ACL response (timeout)'}
        except Exception as e:
            logger.error(f"req_acl failed: {e}")
            return {'success': False, 'error': str(e)}

    def repeater_req_clock(self, name_or_key: str) -> Dict:
        """Request clock/basic info from a repeater."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        contact = self.resolve_contact(name_or_key)
        if not contact:
            return {'success': False, 'error': f"Contact not found: {name_or_key}"}
        try:
            contact_timeout = contact.get('timeout', 0) or 0
            result = self.execute(
                self.mc.commands.req_basic_sync(contact, contact_timeout),
                timeout=120
            )
            if result is not None:
                return {'success': True, 'data': result}
            return {'success': False, 'error': 'No clock response (timeout)'}
        except Exception as e:
            logger.error(f"req_clock failed: {e}")
            return {'success': False, 'error': str(e)}

    def repeater_req_mma(self, name_or_key: str, from_secs: int, to_secs: int) -> Dict:
        """Request min/max/avg sensor data from a repeater."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        contact = self.resolve_contact(name_or_key)
        if not contact:
            return {'success': False, 'error': f"Contact not found: {name_or_key}"}
        try:
            contact_timeout = contact.get('timeout', 0) or 0
            result = self.execute(
                self.mc.commands.req_mma_sync(contact, from_secs, to_secs, contact_timeout, min_timeout=15),
                timeout=120
            )
            if result is not None:
                return {'success': True, 'data': result}
            return {'success': False, 'error': 'No MMA response (timeout)'}
        except Exception as e:
            logger.error(f"req_mma failed: {e}")
            return {'success': False, 'error': str(e)}

    def repeater_req_neighbours(self, name_or_key: str) -> Dict:
        """Request neighbours from a repeater."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        contact = self.resolve_contact(name_or_key)
        if not contact:
            return {'success': False, 'error': f"Contact not found: {name_or_key}"}
        try:
            contact_timeout = contact.get('timeout', 0) or 0
            result = self.execute(
                self.mc.commands.fetch_all_neighbours(contact, timeout=contact_timeout, min_timeout=15),
                timeout=120
            )
            if result is not None:
                return {'success': True, 'data': result}
            return {'success': False, 'error': 'No neighbours response (timeout)'}
        except Exception as e:
            logger.error(f"req_neighbours failed: {e}")
            return {'success': False, 'error': str(e)}

    def resolve_contact_name(self, pubkey_prefix: str) -> str:
        """Resolve a contact name from pubkey prefix using device memory and DB cache."""
        if self.mc:
            contact = self.mc.get_contact_by_key_prefix(pubkey_prefix)
            if contact:
                return contact.get('adv_name', '') or contact.get('name', '')
        db_contact = self.db.get_contact_by_prefix(pubkey_prefix)
        if db_contact:
            return db_contact.get('name', '')
        return ''

    # ── Contact Management (extended) ────────────────────────────

    def contact_info(self, name_or_key: str) -> Dict:
        """Get full info for a contact."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        contact = self.resolve_contact(name_or_key)
        if not contact:
            return {'success': False, 'error': f"Contact not found: {name_or_key}"}
        return {'success': True, 'data': dict(contact)}

    def contact_path(self, name_or_key: str) -> Dict:
        """Get path info for a contact."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        contact = self.resolve_contact(name_or_key)
        if not contact:
            return {'success': False, 'error': f"Contact not found: {name_or_key}"}
        return {'success': True, 'data': {
            'out_path': contact.get('out_path', ''),
            'out_path_len': contact.get('out_path_len', -1),
            'out_path_hash_len': contact.get('out_path_hash_len', 0),
        }}

    def discover_path(self, name_or_key: str) -> Dict:
        """Discover a new path to a contact."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        contact = self.resolve_contact(name_or_key)
        if not contact:
            return {'success': False, 'error': f"Contact not found: {name_or_key}"}
        try:
            from meshcore.events import EventType
            res = self.execute(
                self.mc.commands.send_path_discovery(contact),
                timeout=10
            )
            timeout = 30
            if res and hasattr(res, 'payload') and 'suggested_timeout' in res.payload:
                timeout = res.payload['suggested_timeout'] / 600
            timeout = max(timeout, contact.get('timeout', 0) or 30)
            event = self.execute(
                self.mc.wait_for_event(EventType.PATH_RESPONSE, timeout=timeout),
                timeout=timeout + 5
            )
            if event and hasattr(event, 'payload'):
                return {'success': True, 'data': event.payload}
            return {'success': False, 'error': 'No path response (timeout)'}
        except Exception as e:
            logger.error(f"discover_path failed: {e}")
            return {'success': False, 'error': str(e)}

    def change_path(self, name_or_key: str, path: str) -> Dict:
        """Change the path to a contact."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        contact = self.resolve_contact(name_or_key)
        if not contact:
            return {'success': False, 'error': f"Contact not found: {name_or_key}"}
        try:
            self.execute(self.mc.commands.change_contact_path(contact, path), timeout=10)
            return {'success': True, 'message': f'Path changed for {contact.get("adv_name", name_or_key)}'}
        except Exception as e:
            logger.error(f"change_path failed: {e}")
            return {'success': False, 'error': str(e)}

    def advert_path(self, name_or_key: str) -> Dict:
        """Get advertisement path for a contact."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        contact = self.resolve_contact(name_or_key)
        if not contact:
            return {'success': False, 'error': f"Contact not found: {name_or_key}"}
        try:
            event = self.execute(self.mc.commands.get_advert_path(contact), timeout=10)
            if event and hasattr(event, 'payload'):
                return {'success': True, 'data': event.payload}
            return {'success': False, 'error': 'No advert path response'}
        except Exception as e:
            logger.error(f"advert_path failed: {e}")
            return {'success': False, 'error': str(e)}

    def share_contact(self, name_or_key: str) -> Dict:
        """Share a contact with others on the mesh."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        contact = self.resolve_contact(name_or_key)
        if not contact:
            return {'success': False, 'error': f"Contact not found: {name_or_key}"}
        try:
            self.execute(self.mc.commands.share_contact(contact), timeout=10)
            return {'success': True, 'message': f'Contact shared: {contact.get("adv_name", name_or_key)}'}
        except Exception as e:
            logger.error(f"share_contact failed: {e}")
            return {'success': False, 'error': str(e)}

    def export_contact(self, name_or_key: str) -> Dict:
        """Export a contact as URI."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        contact = self.resolve_contact(name_or_key)
        if not contact:
            return {'success': False, 'error': f"Contact not found: {name_or_key}"}
        try:
            event = self.execute(self.mc.commands.export_contact(contact), timeout=10)
            if event and hasattr(event, 'payload'):
                uri = event.payload.get('uri', '')
                if isinstance(uri, bytes):
                    uri = 'meshcore://' + uri.hex()
                return {'success': True, 'data': {'uri': uri}}
            return {'success': False, 'error': 'No export response'}
        except Exception as e:
            logger.error(f"export_contact failed: {e}")
            return {'success': False, 'error': str(e)}

    def import_contact_uri(self, uri: str) -> Dict:
        """Import a contact from meshcore:// URI.

        Supports two formats:
        - Mobile app URI: meshcore://contact/add?name=...&public_key=...&type=...
        - Hex blob URI:   meshcore://<hex_data> (signed advert blob)
        """
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}

        # Try mobile app URI format first
        parsed = parse_meshcore_uri(uri)
        if parsed:
            return self.add_contact_manual(parsed['name'], parsed['public_key'], parsed['type'])

        # Fallback: hex blob (signed advert) format
        try:
            if uri.startswith('meshcore://'):
                hex_data = uri[11:]
            else:
                hex_data = uri
            contact_bytes = bytes.fromhex(hex_data)
            self.execute(self.mc.commands.import_contact(contact_bytes), timeout=10)
            # Refresh contacts
            self.execute(self.mc.commands.get_contacts(), timeout=10)
            return {'success': True, 'message': 'Contact imported'}
        except ValueError:
            return {'success': False, 'error': 'Invalid URI format (expected mobile app URI or hex data)'}
        except Exception as e:
            logger.error(f"import_contact failed: {e}")
            return {'success': False, 'error': str(e)}

    def change_contact_flags(self, name_or_key: str, flags: int) -> Dict:
        """Change flags for a contact."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        contact = self.resolve_contact(name_or_key)
        if not contact:
            return {'success': False, 'error': f"Contact not found: {name_or_key}"}
        try:
            self.execute(self.mc.commands.change_contact_flags(contact, flags), timeout=10)
            return {'success': True, 'message': f'Flags changed for {contact.get("adv_name", name_or_key)}'}
        except Exception as e:
            logger.error(f"change_flags failed: {e}")
            return {'success': False, 'error': str(e)}

    # ── Device Management ────────────────────────────────────────

    def query_device(self) -> Dict:
        """Query device for firmware version and hardware info."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        try:
            event = self.execute(self.mc.commands.send_device_query(), timeout=5)
            if event and hasattr(event, 'payload'):
                return {'success': True, 'data': event.payload}
            return {'success': False, 'error': 'No device query response'}
        except Exception as e:
            logger.error(f"query_device failed: {e}")
            return {'success': False, 'error': str(e)}

    def get_clock(self) -> Dict:
        """Get device clock time."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        try:
            event = self.execute(self.mc.commands.get_time(), timeout=5)
            if event and hasattr(event, 'payload'):
                return {'success': True, 'data': event.payload}
            return {'success': False, 'error': 'No time response'}
        except Exception as e:
            logger.error(f"get_clock failed: {e}")
            return {'success': False, 'error': str(e)}

    def set_clock(self, epoch: int) -> Dict:
        """Set device clock to given epoch timestamp."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        try:
            self.execute(self.mc.commands.set_time(epoch), timeout=5)
            return {'success': True, 'message': f'Clock set to {epoch}'}
        except Exception as e:
            logger.error(f"set_clock failed: {e}")
            return {'success': False, 'error': str(e)}

    def reboot_device(self) -> Dict:
        """Reboot the device."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        try:
            self.execute(self.mc.commands.reboot(), timeout=5)
            return {'success': True, 'message': 'Device rebooting...'}
        except Exception as e:
            logger.error(f"reboot failed: {e}")
            return {'success': False, 'error': str(e)}

    def set_flood_scope(self, scope: str) -> Dict:
        """Set flood message scope."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        try:
            self.execute(self.mc.commands.set_flood_scope(scope), timeout=5)
            return {'success': True, 'message': f'Scope set to: {scope}'}
        except Exception as e:
            logger.error(f"set_flood_scope failed: {e}")
            return {'success': False, 'error': str(e)}

    def get_self_telemetry(self) -> Dict:
        """Get own telemetry data."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        try:
            event = self.execute(self.mc.commands.get_self_telemetry(), timeout=5)
            if event and hasattr(event, 'payload'):
                return {'success': True, 'data': event.payload}
            return {'success': False, 'error': 'No telemetry response'}
        except Exception as e:
            logger.error(f"get_self_telemetry failed: {e}")
            return {'success': False, 'error': str(e)}

    def get_param(self, param: str) -> Dict:
        """Get a device parameter."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        try:
            info = self.get_device_info()
            if param == 'name':
                return {'success': True, 'data': {'name': info.get('name', info.get('adv_name', '?'))}}
            elif param == 'tx':
                return {'success': True, 'data': {'tx': info.get('tx_power', '?')}}
            elif param in ('coords', 'lat', 'lon'):
                return {'success': True, 'data': {'lat': info.get('lat', 0), 'lon': info.get('lon', 0)}}
            elif param == 'bat':
                bat = self.get_battery()
                return {'success': True, 'data': bat or {}}
            elif param == 'radio':
                return {'success': True, 'data': {
                    'freq': info.get('freq', '?'),
                    'bw': info.get('bw', '?'),
                    'sf': info.get('sf', '?'),
                    'cr': info.get('cr', '?'),
                }}
            elif param == 'stats':
                stats = self.get_device_stats()
                return {'success': True, 'data': stats}
            elif param == 'custom':
                event = self.execute(self.mc.commands.get_custom_vars(), timeout=5)
                if event and hasattr(event, 'payload'):
                    return {'success': True, 'data': event.payload}
                return {'success': False, 'error': 'No custom vars response'}
            elif param == 'path_hash_mode':
                # get_path_hash_mode() returns int, not Event
                value = self.execute(self.mc.commands.get_path_hash_mode(), timeout=5)
                return {'success': True, 'data': {'path_hash_mode': value}}
            elif param == 'help':
                return {'success': True, 'help': 'get'}
            else:
                return {'success': False, 'error': f"Unknown param: {param}. Type 'get help' for list."}
        except Exception as e:
            logger.error(f"get_param failed: {e}")
            return {'success': False, 'error': str(e)}

    def set_param(self, param: str, value: str) -> Dict:
        """Set a device parameter."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        try:
            if param == 'name':
                self.execute(self.mc.commands.set_name(value), timeout=5)
                return {'success': True, 'message': f'Name set to: {value}'}
            elif param == 'tx':
                self.execute(self.mc.commands.set_tx_power(value), timeout=5)
                return {'success': True, 'message': f'TX power set to: {value}'}
            elif param == 'coords':
                parts = value.split(',')
                if len(parts) != 2:
                    return {'success': False, 'error': 'Format: set coords <lat>,<lon>'}
                lat, lon = float(parts[0].strip()), float(parts[1].strip())
                self.execute(self.mc.commands.set_coords(lat, lon), timeout=5)
                return {'success': True, 'message': f'Coords set to: {lat}, {lon}'}
            elif param == 'lat':
                info = self.get_device_info()
                lon = info.get('lon', 0)
                self.execute(self.mc.commands.set_coords(float(value), lon), timeout=5)
                return {'success': True, 'message': f'Lat set to: {value}'}
            elif param == 'lon':
                info = self.get_device_info()
                lat = info.get('lat', 0)
                self.execute(self.mc.commands.set_coords(lat, float(value)), timeout=5)
                return {'success': True, 'message': f'Lon set to: {value}'}
            elif param == 'pin':
                self.execute(self.mc.commands.set_devicepin(value), timeout=5)
                return {'success': True, 'message': 'PIN set'}
            elif param == 'telemetry_mode_base':
                self.execute(self.mc.commands.set_telemetry_mode_base(int(value)), timeout=5)
                return {'success': True, 'message': f'Telemetry mode base set to: {value}'}
            elif param == 'telemetry_mode_loc':
                self.execute(self.mc.commands.set_telemetry_mode_loc(int(value)), timeout=5)
                return {'success': True, 'message': f'Telemetry mode loc set to: {value}'}
            elif param == 'telemetry_mode_env':
                self.execute(self.mc.commands.set_telemetry_mode_env(int(value)), timeout=5)
                return {'success': True, 'message': f'Telemetry mode env set to: {value}'}
            elif param == 'advert_loc_policy':
                self.execute(self.mc.commands.set_advert_loc_policy(int(value)), timeout=5)
                return {'success': True, 'message': f'Advert loc policy set to: {value}'}
            elif param == 'manual_add_contacts':
                enabled = value.lower() in ('true', '1', 'yes', 'on')
                self.execute(self.mc.commands.set_manual_add_contacts(enabled), timeout=5)
                return {'success': True, 'message': f'Manual add contacts: {enabled}'}
            elif param == 'multi_acks':
                enabled = value.lower() in ('true', '1', 'yes', 'on')
                self.execute(self.mc.commands.set_multi_acks(enabled), timeout=5)
                return {'success': True, 'message': f'Multi acks: {enabled}'}
            elif param == 'path_hash_mode':
                self.execute(self.mc.commands.set_path_hash_mode(int(value)), timeout=5)
                return {'success': True, 'message': f'Path hash mode set to: {value}'}
            elif param == 'help':
                return {'success': True, 'help': 'set'}
            else:
                # Try as custom variable
                self.execute(self.mc.commands.set_custom_var(param, value), timeout=5)
                return {'success': True, 'message': f'Custom var {param} set to: {value}'}
        except Exception as e:
            logger.error(f"set_param failed: {e}")
            return {'success': False, 'error': str(e)}

    def node_discover(self, type_filter: str = None) -> Dict:
        """Discover nodes on the mesh."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}
        try:
            from meshcore.events import EventType
            types = 0xFF  # all types
            if type_filter:
                type_map = {'com': 1, 'rep': 2, 'room': 3, 'sensor': 4, 'sens': 4}
                t = type_map.get(type_filter.lower())
                if t:
                    types = t
            res = self.execute(
                self.mc.commands.send_node_discover_req(types),
                timeout=10
            )
            # Collect responses with timeout
            results = []
            try:
                while True:
                    ev = self.execute(
                        self.mc.wait_for_event(EventType.DISCOVER_RESPONSE, timeout=5),
                        timeout=10
                    )
                    if ev and hasattr(ev, 'payload'):
                        results.append(ev.payload)
                    else:
                        break
            except Exception:
                pass  # timeout = no more responses
            return {'success': True, 'data': results}
        except Exception as e:
            logger.error(f"node_discover failed: {e}")
            return {'success': False, 'error': str(e)}
