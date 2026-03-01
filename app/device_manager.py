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

            logger.info(f"Connected to device: {self._device_name} "
                        f"(key: {self._self_info.get('public_key', '?')[:8]}...)")

            # Subscribe to events
            await self._subscribe_events()

            # Enable auto-refresh of contacts on adverts/path updates
            self.mc.auto_update_contacts = True

            # Fetch initial contacts from device
            await self.mc.ensure_contacts()
            self._sync_contacts_to_db()

            # Start auto message fetching (events fire on new messages)
            await self.mc.start_auto_message_fetching()

        except Exception as e:
            logger.error(f"Device connection failed: {e}")
            self._connected = False

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
            (EventType.DISCONNECTED, self._on_disconnected),
        ]

        for event_type, handler in handlers:
            sub = self.mc.subscribe(event_type, handler)
            self._subscriptions.append(sub)
            logger.debug(f"Subscribed to {event_type.value}")

    def _sync_contacts_to_db(self):
        """Sync device contacts to database."""
        if not self.mc or not self.mc.contacts:
            return

        count = 0
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
            count += 1
        logger.info(f"Synced {count} contacts from device to database")

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
                    # Use the full public key from contacts (not the short prefix)
                    full_key = contact.get('public_key', '')
                    if full_key:
                        sender_key = full_key
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
            expected_ack = _to_str(data.get('expected_ack'))

            if expected_ack:
                self.db.insert_ack(
                    expected_ack=expected_ack,
                    snr=data.get('snr'),
                    rssi=data.get('rssi'),
                    route_type=data.get('route_type', ''),
                )

                logger.info(f"ACK received: {expected_ack}")

                if self.socketio:
                    self.socketio.emit('ack', {
                        'expected_ack': expected_ack,
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
        from mc.contacts which meshcore auto-refreshes after adverts.
        """
        try:
            data = getattr(event, 'payload', {})
            pubkey = data.get('public_key', '')

            if not pubkey:
                return

            # Look up full contact details from meshcore's contact list
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

            logger.debug(f"Advert from '{name}' ({pubkey[:8]}...)")

        except Exception as e:
            logger.error(f"Error handling advertisement: {e}")

    async def _on_path_update(self, event):
        """Handle path update for a contact."""
        try:
            data = getattr(event, 'payload', {})
            pubkey = data.get('public_key', '')

            if pubkey:
                self.db.insert_path(
                    contact_pubkey=pubkey,
                    path=data.get('path', ''),
                    snr=data.get('snr'),
                    path_len=data.get('path_len'),
                )
                logger.debug(f"Path update for {pubkey[:8]}...")

        except Exception as e:
            logger.error(f"Error handling path update: {e}")

    async def _on_new_contact(self, event):
        """Handle new contact discovered."""
        try:
            data = getattr(event, 'payload', {})
            pubkey = data.get('public_key', '')
            name = data.get('adv_name', data.get('name', ''))

            if pubkey:
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
                logger.info(f"New contact: {name} ({pubkey[:8]}...)")

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

            return {'success': True, 'message': 'Message sent', 'id': msg_id}

        except Exception as e:
            logger.error(f"Failed to send channel message: {e}")
            return {'success': False, 'error': str(e)}

    def send_dm(self, recipient_pubkey: str, text: str) -> Dict:
        """Send a direct message. Returns result dict."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}

        try:
            # Find contact by pubkey
            contact = self.mc.contacts.get(recipient_pubkey)
            if not contact:
                # Try prefix match
                contact = self.mc.get_contact_by_key_prefix(recipient_pubkey)
            if not contact:
                return {'success': False, 'error': f'Contact not found: {recipient_pubkey}'}

            event = self.execute(self.mc.commands.send_msg(contact, text))

            # Store sent DM in database
            ts = int(time.time())
            event_data = getattr(event, 'payload', {})
            ack = _to_str(event_data.get('expected_ack'))
            dm_id = self.db.insert_direct_message(
                contact_pubkey=recipient_pubkey.lower(),
                direction='out',
                content=text,
                timestamp=ts,
                expected_ack=ack or None,
                pkt_payload=_to_str(event_data.get('pkt_payload')) or None,
            )

            return {
                'success': True,
                'message': 'DM sent',
                'id': dm_id,
                'expected_ack': ack,
            }

        except Exception as e:
            logger.error(f"Failed to send DM: {e}")
            return {'success': False, 'error': str(e)}

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
        """Delete a contact from device and database."""
        if not self.is_connected:
            return {'success': False, 'error': 'Device not connected'}

        try:
            self.execute(self.mc.commands.remove_contact(pubkey))
            self.db.delete_contact(pubkey)
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
                    'type': c.get('adv_type', 0),
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
            self.db.upsert_contact(
                public_key=pubkey,
                name=contact.get('adv_name', ''),
                source='device',
            )
            return {'success': True, 'message': 'Contact approved'}
        except Exception as e:
            logger.error(f"Failed to approve contact: {e}")
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
