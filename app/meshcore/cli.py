"""
MeshCore CLI wrapper — v2: delegates to DeviceManager (no bridge).

Function signatures preserved for backward compatibility with api.py.
"""

import logging
import json
from pathlib import Path
from typing import Tuple, Optional, List, Dict
from app.config import config

logger = logging.getLogger(__name__)


class MeshCLIError(Exception):
    """Custom exception for meshcli command failures"""
    pass


def _get_dm():
    """Get the DeviceManager instance — try Flask app context first, then module global."""
    try:
        from flask import current_app
        dm = getattr(current_app, 'device_manager', None)
        if dm is not None:
            return dm
    except RuntimeError:
        pass  # Outside of Flask request context

    from app.main import device_manager
    if device_manager is None:
        raise MeshCLIError("DeviceManager not initialized")
    return device_manager


# =============================================================================
# Messages
# =============================================================================

def recv_messages() -> Tuple[bool, str]:
    """
    In v2, messages arrive via events (auto-fetching).
    This is a no-op — kept for backward compatibility.
    """
    return True, "Messages are received automatically via events"


def send_message(text: str, reply_to: Optional[str] = None, channel_index: int = 0) -> Tuple[bool, str]:
    """Send a message to a channel."""
    if reply_to:
        text = f"@[{reply_to}] {text}"

    try:
        dm = _get_dm()
        result = dm.send_channel_message(channel_index, text)
        if result['success']:
            return True, result.get('message', 'Message sent')
        return False, result.get('error', 'Failed to send message')
    except Exception as e:
        logger.error(f"send_message error: {e}")
        return False, str(e)


# =============================================================================
# Contacts
# =============================================================================

def get_contacts() -> Tuple[bool, str]:
    """Get contacts list as formatted text."""
    try:
        dm = _get_dm()
        contacts = dm.get_contacts_from_device()
        if not contacts:
            return True, "No contacts"
        lines = []
        for c in contacts:
            name = c.get('name', '?')
            pk = c.get('public_key', '')[:12]
            lines.append(f"{name}  {pk}")
        return True, "\n".join(lines)
    except Exception as e:
        logger.error(f"get_contacts error: {e}")
        return False, str(e)


def parse_contacts(output: str, filter_types: Optional[List[str]] = None) -> List[str]:
    """Parse contacts output to extract names. In v2, reads from DB."""
    try:
        dm = _get_dm()
        contacts = dm.db.get_contacts()
        return [c['name'] for c in contacts if c.get('name')]
    except Exception:
        return []


def get_contacts_list() -> Tuple[bool, List[str], str]:
    """Get parsed list of contact names."""
    try:
        dm = _get_dm()
        contacts = dm.db.get_contacts()
        names = [c['name'] for c in contacts if c.get('name')]
        return True, names, ""
    except Exception as e:
        return False, [], str(e)


def get_all_contacts_detailed() -> Tuple[bool, List[Dict], int, str]:
    """Get detailed list of all contacts from DB."""
    try:
        dm = _get_dm()
        contacts = dm.db.get_contacts()
        result = []
        for c in contacts:
            pk = c.get('public_key', '')
            result.append({
                'name': c.get('name', ''),
                'public_key_prefix': pk[:12] if len(pk) >= 12 else pk,
                'type_label': {0: 'CLI', 1: 'CLI', 2: 'REP', 3: 'ROOM', 4: 'SENS'}.get(c.get('type', 1), 'UNKNOWN'),
                'path_or_mode': c.get('out_path', '') or 'Flood',
                'raw_line': '',
            })
        return True, result, len(result), ""
    except Exception as e:
        return False, [], 0, str(e)


def get_contacts_with_last_seen() -> Tuple[bool, Dict[str, Dict], str]:
    """Get contacts with last_advert timestamps from DB."""
    try:
        dm = _get_dm()
        contacts = dm.db.get_contacts()
        contacts_dict = {}
        for c in contacts:
            pk = c.get('public_key', '')
            contacts_dict[pk] = {
                'public_key': pk,
                'type': c.get('type', 1),
                'flags': c.get('flags', 0),
                'out_path_len': c.get('out_path_len', -1),
                'out_path': c.get('out_path', ''),
                'adv_name': c.get('name', ''),
                'last_advert': c.get('last_advert', ''),
                'adv_lat': c.get('adv_lat', 0.0),
                'adv_lon': c.get('adv_lon', 0.0),
                'lastmod': c.get('lastmod', ''),
            }
        return True, contacts_dict, ""
    except Exception as e:
        return False, {}, str(e)


def get_contacts_json() -> Tuple[bool, Dict[str, Dict], str]:
    """Get all contacts as JSON dict (keyed by public_key)."""
    try:
        dm = _get_dm()
        contacts = dm.db.get_contacts()
        contacts_dict = {}
        for c in contacts:
            pk = c.get('public_key', '')
            contacts_dict[pk] = {
                'public_key': pk,
                'type': c.get('type', 0),
                'adv_name': c.get('name', ''),
                'flags': c.get('flags', 0),
                'out_path_len': c.get('out_path_len', -1),
                'out_path': c.get('out_path', ''),
                'last_advert': c.get('last_advert', ''),
                'adv_lat': c.get('adv_lat'),
                'adv_lon': c.get('adv_lon'),
                'lastmod': c.get('lastmod', ''),
            }
        return True, contacts_dict, ""
    except Exception as e:
        return False, {}, str(e)


def delete_contact(selector: str) -> Tuple[bool, str]:
    """Delete a contact by public key or name."""
    if not selector or not selector.strip():
        return False, "Contact selector is required"

    selector = selector.strip()

    try:
        dm = _get_dm()
        # Try as public key first
        contact = dm.db.get_contact(selector)
        if contact:
            result = dm.delete_contact(selector)
            return result['success'], result.get('message', result.get('error', ''))

        # Try to find by name
        contacts = dm.db.get_contacts()
        for c in contacts:
            if c.get('name', '').strip() == selector or c.get('public_key', '').startswith(selector):
                result = dm.delete_contact(c['public_key'])
                return result['success'], result.get('message', result.get('error', ''))

        return False, f"Contact not found: {selector}"
    except Exception as e:
        return False, str(e)


def clean_inactive_contacts(hours: int = 48) -> Tuple[bool, str]:
    """Remove contacts inactive for specified hours. Simplified in v2."""
    # TODO: implement time-based cleanup via database query
    return False, "Contact cleanup not yet implemented in v2"


def get_pending_contacts() -> Tuple[bool, List[Dict], str]:
    """Get list of contacts awaiting manual approval."""
    try:
        dm = _get_dm()
        pending = dm.get_pending_contacts()
        return True, pending, ""
    except Exception as e:
        return False, [], str(e)


def approve_pending_contact(public_key: str) -> Tuple[bool, str]:
    """Approve a pending contact."""
    try:
        dm = _get_dm()
        result = dm.approve_contact(public_key)
        return result['success'], result.get('message', result.get('error', ''))
    except Exception as e:
        return False, str(e)


# =============================================================================
# Device Info
# =============================================================================

def get_device_info() -> Tuple[bool, str]:
    """Get device information."""
    try:
        dm = _get_dm()
        info = dm.get_device_info()
        if info:
            lines = [f"{k}: {v}" for k, v in info.items()]
            return True, "\n".join(lines)
        return False, "No device info available"
    except Exception as e:
        return False, str(e)


def check_connection() -> bool:
    """Check if device is connected."""
    try:
        dm = _get_dm()
        return dm.is_connected
    except Exception:
        return False


# =============================================================================
# Channels
# =============================================================================

def get_channels() -> Tuple[bool, List[Dict]]:
    """Get list of configured channels."""
    try:
        dm = _get_dm()
        channels = []
        for idx in range(8):
            info = dm.get_channel_info(idx)
            if info and info.get('name'):
                channels.append({
                    'index': idx,
                    'name': info.get('name', ''),
                    'key': info.get('secret', info.get('key', '')),
                })
        return True, channels
    except Exception as e:
        logger.error(f"get_channels error: {e}")
        return False, []


def add_channel(name: str) -> Tuple[bool, str, Optional[str]]:
    """Add a new channel."""
    try:
        dm = _get_dm()
        # Find first free slot (1-7, slot 0 is Public)
        for idx in range(1, 8):
            info = dm.get_channel_info(idx)
            if not info or not info.get('name'):
                result = dm.set_channel(idx, name)
                if result['success']:
                    return True, f"Channel '{name}' created at slot {idx}", None
                return False, result.get('error', 'Failed'), None
        return False, "No free channel slots available", None
    except Exception as e:
        return False, str(e), None


def set_channel(index: int, name: str, key: Optional[str] = None) -> Tuple[bool, str]:
    """Set/join a channel."""
    try:
        dm = _get_dm()
        secret = bytes.fromhex(key) if key else None
        result = dm.set_channel(index, name, secret)
        return result['success'], result.get('message', result.get('error', ''))
    except Exception as e:
        return False, str(e)


def remove_channel(index: int) -> Tuple[bool, str]:
    """Remove a channel."""
    if index == 0:
        return False, "Cannot remove Public channel (channel 0)"

    try:
        dm = _get_dm()
        result = dm.remove_channel(index)
        return result['success'], result.get('message', result.get('error', ''))
    except Exception as e:
        return False, str(e)


# =============================================================================
# Advertisement
# =============================================================================

def advert() -> Tuple[bool, str]:
    """Send a single advertisement."""
    try:
        dm = _get_dm()
        result = dm.send_advert(flood=False)
        return result['success'], result.get('message', result.get('error', ''))
    except Exception as e:
        return False, str(e)


def floodadv() -> Tuple[bool, str]:
    """Send flood advertisement."""
    try:
        dm = _get_dm()
        result = dm.send_advert(flood=True)
        return result['success'], result.get('message', result.get('error', ''))
    except Exception as e:
        return False, str(e)


# =============================================================================
# Direct Messages
# =============================================================================

def send_dm(recipient: str, text: str) -> Tuple[bool, str]:
    """Send a direct message."""
    if not recipient or not recipient.strip():
        return False, "Recipient is required"
    if not text or not text.strip():
        return False, "Message text is required"

    try:
        dm = _get_dm()
        # Try to find contact by name first
        contact = None
        if dm.mc:
            contact = dm.mc.get_contact_by_name(recipient.strip())

        if contact:
            pubkey = contact.get('public_key', recipient)
        else:
            pubkey = recipient.strip()

        result = dm.send_dm(pubkey, text.strip())
        return result['success'], result.get('message', result.get('error', ''))
    except Exception as e:
        return False, str(e)


def check_dm_delivery(ack_codes: list) -> Tuple[bool, Dict, str]:
    """Check delivery status for DMs by ACK codes."""
    try:
        dm = _get_dm()
        ack_status = {}
        for code in ack_codes:
            ack = dm.db.get_ack_for_dm(code)
            ack_status[code] = ack
        return True, ack_status, ""
    except Exception as e:
        return False, {}, str(e)


def get_retry_ack_codes() -> set:
    """Get retry ACK codes. Simplified in v2."""
    return set()


def get_auto_retry_config() -> Tuple[bool, Dict]:
    """Get auto-retry config. Using meshcore library's built-in retry."""
    return True, {
        'enabled': True,
        'max_attempts': 3,
        'max_flood': 2,
        'note': 'v2 uses meshcore library built-in retry (send_msg_with_retry)'
    }


def set_auto_retry_config(enabled=None, max_attempts=None, max_flood=None) -> Tuple[bool, Dict]:
    """Set auto-retry config. Stub in v2."""
    return get_auto_retry_config()


# =============================================================================
# Device Settings
# =============================================================================

def get_device_settings() -> Tuple[bool, Dict]:
    """Get persistent device settings."""
    settings_path = Path(config.MC_CONFIG_DIR) / ".webui_settings.json"
    try:
        if not settings_path.exists():
            return True, {'manual_add_contacts': False}
        with open(settings_path, 'r', encoding='utf-8') as f:
            settings = json.load(f)
            if 'manual_add_contacts' not in settings:
                settings['manual_add_contacts'] = False
            return True, settings
    except Exception as e:
        logger.error(f"Failed to read device settings: {e}")
        return False, {'manual_add_contacts': False}


def set_manual_add_contacts(enabled: bool) -> Tuple[bool, str]:
    """Enable/disable manual contact approval."""
    try:
        dm_inst = _get_dm()
        result = dm_inst.set_manual_add_contacts(enabled)
        if result['success']:
            # Persist to settings file
            settings_path = Path(config.MC_CONFIG_DIR) / ".webui_settings.json"
            try:
                settings = {}
                if settings_path.exists():
                    with open(settings_path, 'r') as f:
                        settings = json.load(f)
                settings['manual_add_contacts'] = enabled
                settings_path.parent.mkdir(parents=True, exist_ok=True)
                with open(settings_path, 'w') as f:
                    json.dump(settings, f)
            except Exception as e:
                logger.warning(f"Failed to persist settings: {e}")
        return result['success'], result.get('message', result.get('error', ''))
    except Exception as e:
        return False, str(e)


def fetch_device_name_from_bridge(max_retries: int = 3, retry_delay: float = 2.0) -> Tuple[Optional[str], str]:
    """
    v2: Get device name from DeviceManager instead of bridge.
    Kept for backward compatibility with any code that still calls this.
    """
    try:
        dm = _get_dm()
        if dm.is_connected:
            return dm.device_name, "device"
    except Exception:
        pass
    return config.MC_DEVICE_NAME, "fallback"
