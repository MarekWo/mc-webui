"""
DeviceManager — manages MeshCore device connection for mc-webui v2.

Runs the meshcore async event loop in a dedicated background thread.
Flask routes call sync command methods that bridge to the async loop.
Event handlers capture incoming data and write to Database + emit SocketIO.
"""

import asyncio
import json
import logging
import threading
import time
from typing import Optional, Any, Dict, List

logger = logging.getLogger(__name__)


def _to_str(val) -> str:
    """Convert bytes or other types to string. Used for expected_ack, pkt_payload, etc."""
    if val is None:
        return ''
    if isinstance(val, bytes):
        return val.hex()
    return str(val)



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
                    auto_reconnect=self.config.MC_AUTO_RECONNECT,
                )
            else:
                port = self._detect_serial_port()
                logger.info(f"Connecting via serial: {port}")
                self.mc = await MeshCore.create_serial(
                    port=port,
                    auto_reconnect=self.config.MC_AUTO_RECONNECT,
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
        """Load channel secrets from device for pkt_payload computation."""
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
                    if secret and len(secret) == 32:
                        self._channel_secrets[idx] = secret
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
                self.socketio.emit('new_message', {
                    'type': 'channel',
                    'channel_idx': channel_idx,
                    'sender': sender,
                    'content': content,
                    'timestamp': ts,
                    'id': msg_id,
                }, namespace='/chat')

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
                self.socketio.emit('ack', {
                    'expected_ack': ack_code,
                    'dm_id': dm_id,
                    'snr': data.get('snr'),
                    'rssi': data.get('rssi'),
                    'route_type': data.get('route_type', ''),
                }, namespace='/chat')

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
        """Check if manual contact approval is enabled (from persisted settings)."""
        try:
            from pathlib import Path
            settings_path = Path(self.config.MC_CONFIG_DIR) / ".webui_settings.json"
            if settings_path.exists():
                with open(settings_path, 'r', encoding='utf-8') as f:
                    settings = json.load(f)
                    return bool(settings.get('manual_add_contacts', False))
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
                # Manual mode: meshcore puts it in mc.pending_contacts for approval
                logger.info(f"Pending contact (manual mode): {name} ({pubkey[:8]}...)")

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
        """Handle device disconnection."""
        logger.warning("Device disconnected")
        self._connected = False

        if self.socketio:
            self.socketio.emit('device_status', {
                'connected': False,
            }, namespace='/chat')

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

    async def _dm_retry_task(self, dm_id: int, contact, text: str,
                              timestamp: int, initial_ack: str,
                              suggested_timeout: int, max_attempts: int = 3):
        """Background retry with same timestamp for dedup on receiver."""
        from meshcore.events import EventType

        wait_s = max(suggested_timeout / 1000 * 1.2, 5.0)

        # Wait for ACK on initial send
        if initial_ack:
            ack_event = await self.mc.dispatcher.wait_for_event(
                EventType.ACK,
                attribute_filters={"code": initial_ack},
                timeout=wait_s
            )
            if ack_event:
                self._confirm_delivery(dm_id, initial_ack, ack_event)
                return

        # Retry with same timestamp, incrementing attempt
        for attempt in range(1, max_attempts):
            # After 2 failed direct attempts, reset path to flood
            if attempt >= 2:
                try:
                    await self.mc.commands.reset_path(contact)
                    logger.info(f"DM retry {attempt}: reset path to flood")
                except Exception:
                    pass

            try:
                result = await self.mc.commands.send_msg(
                    contact, text, timestamp=timestamp, attempt=attempt
                )
            except Exception as e:
                logger.warning(f"DM retry {attempt}/{max_attempts}: send error: {e}")
                continue

            if result.type == EventType.ERROR:
                logger.warning(f"DM retry {attempt}/{max_attempts}: device error")
                continue

            retry_ack = _to_str(result.payload.get('expected_ack'))
            if retry_ack:
                self._pending_acks[retry_ack] = dm_id
                new_timeout = result.payload.get('suggested_timeout', suggested_timeout)
                wait_s = max(new_timeout / 1000 * 1.2, 5.0)

            if retry_ack:
                ack_event = await self.mc.dispatcher.wait_for_event(
                    EventType.ACK,
                    attribute_filters={"code": retry_ack},
                    timeout=wait_s
                )
                if ack_event:
                    self._confirm_delivery(dm_id, retry_ack, ack_event)
                    return

        logger.warning(f"DM retry exhausted ({max_attempts} attempts) for dm_id={dm_id}")
        # Cleanup stale pending acks for this DM
        stale = [k for k, v in self._pending_acks.items() if v == dm_id]
        for k in stale:
            self._pending_acks.pop(k, None)
        self._retry_tasks.pop(dm_id, None)

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
            self.socketio.emit('ack', {
                'expected_ack': ack_code,
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
            self.db.delete_contact(pubkey)  # soft-delete: sets source='deleted'
            # Also remove from in-memory contacts cache
            if self.mc.contacts and pubkey in self.mc.contacts:
                del self.mc.contacts[pubkey]
            return {'success': True, 'message': 'Contact deleted'}
        except Exception as e:
            logger.error(f"Failed to delete contact: {e}")
            return {'success': False, 'error': str(e)}

    def reset_path(self, pubkey: str) -> Dict:
        """Reset path to a contact."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}

        try:
            self.execute(self.mc.commands.reset_path(pubkey))
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

    def reject_contact(self, pubkey: str) -> Dict:
        """Reject a pending contact (remove from pending list without adding)."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}

        try:
            removed = self.mc.pending_contacts.pop(pubkey, None)
            if removed:
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

    def send_trace(self, tag: int = 0) -> Optional[Dict]:
        """Send a trace packet to discover mesh topology."""
        if not self.is_connected:
            return None

        try:
            event = self.execute(
                self.mc.commands.send_trace(tag=tag),
                timeout=5
            )
            return {'success': True, 'message': f'Trace sent (tag={tag})'}
        except Exception as e:
            logger.error(f"Trace failed: {e}")
            return {'error': str(e)}
