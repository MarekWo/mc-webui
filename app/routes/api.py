"""
REST API endpoints for mc-webui
"""

import hashlib
import hmac as hmac_mod
import logging
import json
import re
import base64
import struct
import time
import requests
from Crypto.Cipher import AES
from datetime import datetime
from io import BytesIO
from pathlib import Path
from flask import Blueprint, jsonify, request, send_file, current_app
from app.meshcore import cli, parser
from app.config import config, runtime_config
from app.archiver import manager as archive_manager
from app.contacts_cache import get_all_names, get_all_contacts

logger = logging.getLogger(__name__)


def _get_db():
    """Get Database instance from app context."""
    return getattr(current_app, 'db', None)


def _get_dm():
    """Get DeviceManager instance from app context."""
    return getattr(current_app, 'device_manager', None)

api_bp = Blueprint('api', __name__, url_prefix='/api')

# Simple cache for get_channels() to reduce USB/meshcli calls
# Channels don't change frequently, so caching for 30s is safe
_channels_cache = None
_channels_cache_timestamp = 0
CHANNELS_CACHE_TTL = 30  # seconds

# Cache for contacts/detailed to reduce USB calls (4 calls per request!)
# Contacts change infrequently, 60s cache is safe
_contacts_detailed_cache = None
_contacts_detailed_cache_timestamp = 0
CONTACTS_DETAILED_CACHE_TTL = 60  # seconds


ANALYZER_BASE_URL = 'https://analyzer.letsmesh.net/packets?packet_hash='
GRP_TXT_TYPE_BYTE = 0x05


def compute_analyzer_url(pkt_payload):
    """Compute MeshCore Analyzer URL from a hex-encoded pkt_payload."""
    try:
        raw = bytes([GRP_TXT_TYPE_BYTE]) + bytes.fromhex(pkt_payload)
        packet_hash = hashlib.sha256(raw).hexdigest()[:16].upper()
        return f"{ANALYZER_BASE_URL}{packet_hash}"
    except (ValueError, TypeError):
        return None


def compute_pkt_payload(channel_secret_hex, sender_timestamp, txt_type, text, attempt=0):
    """Compute pkt_payload from message data + channel secret.

    Reconstructs the encrypted GRP_TXT payload:
      channel_hash(1) + HMAC-MAC(2) + AES-128-ECB(plaintext)
    where plaintext = timestamp(4 LE) + flags(1) + text(UTF-8) + null + zero-pad.
    """
    secret = bytes.fromhex(channel_secret_hex)
    flags = ((txt_type & 0x3F) << 2) | (attempt & 0x03)
    plaintext = struct.pack('<I', sender_timestamp) + bytes([flags]) + text.encode('utf-8') + b'\x00'
    # Pad to AES block boundary (16 bytes)
    pad_len = (16 - len(plaintext) % 16) % 16
    plaintext += b'\x00' * pad_len
    # AES-128-ECB encrypt
    cipher = AES.new(secret[:16], AES.MODE_ECB)
    ciphertext = cipher.encrypt(plaintext)
    # HMAC-SHA256 truncated to 2 bytes
    mac = hmac_mod.new(secret, ciphertext, hashlib.sha256).digest()[:2]
    # Channel hash: first byte of SHA256(secret)
    chan_hash = hashlib.sha256(secret).digest()[0:1]
    return (chan_hash + mac + ciphertext).hex()


def get_channels_cached(force_refresh=False):
    """
    Get channels with caching to reduce USB/meshcli calls.

    Args:
        force_refresh: If True, bypass cache and fetch fresh data

    Returns:
        Tuple of (success, channels_list)
    """
    global _channels_cache, _channels_cache_timestamp

    current_time = time.time()

    # Return cached data if valid and not forcing refresh
    if (not force_refresh and
        _channels_cache is not None and
        (current_time - _channels_cache_timestamp) < CHANNELS_CACHE_TTL):
        logger.debug(f"Returning cached channels (age: {current_time - _channels_cache_timestamp:.1f}s)")
        return True, _channels_cache

    # Fetch fresh data
    logger.debug("Fetching fresh channels from meshcli")
    success, channels = cli.get_channels()

    if success:
        _channels_cache = channels
        _channels_cache_timestamp = current_time
        logger.debug(f"Channels cached ({len(channels)} channels)")

    return success, channels


def invalidate_channels_cache():
    """Invalidate channels cache (call after add/remove channel)"""
    global _channels_cache, _channels_cache_timestamp
    _channels_cache = None
    _channels_cache_timestamp = 0
    logger.debug("Channels cache invalidated")


def get_contacts_detailed_cached(force_refresh=False):
    """
    Get detailed contacts with caching to reduce USB/meshcli calls.
    This endpoint makes 4 USB calls (one per contact type), so caching is critical.

    Args:
        force_refresh: If True, bypass cache and fetch fresh data

    Returns:
        Tuple of (success, contacts_dict, error_message)
    """
    global _contacts_detailed_cache, _contacts_detailed_cache_timestamp

    current_time = time.time()

    # Return cached data if valid and not forcing refresh
    if (not force_refresh and
        _contacts_detailed_cache is not None and
        (current_time - _contacts_detailed_cache_timestamp) < CONTACTS_DETAILED_CACHE_TTL):
        logger.debug(f"Returning cached contacts (age: {current_time - _contacts_detailed_cache_timestamp:.1f}s)")
        return True, _contacts_detailed_cache, None

    # Fetch fresh data (this makes 4 USB calls!)
    logger.debug("Fetching fresh contacts from meshcli (4 USB calls)")
    success, contacts, error = cli.get_contacts_with_last_seen()

    if success:
        _contacts_detailed_cache = contacts
        _contacts_detailed_cache_timestamp = current_time
        logger.debug(f"Contacts cached ({len(contacts)} contacts)")

    return success, contacts, error


def invalidate_contacts_cache():
    """Invalidate contacts cache (call after contact changes)"""
    global _contacts_detailed_cache, _contacts_detailed_cache_timestamp
    _contacts_detailed_cache = None
    _contacts_detailed_cache_timestamp = 0
    logger.debug("Contacts cache invalidated")


# =============================================================================
# Protected Contacts Management
# =============================================================================

def get_protected_contacts() -> list:
    """
    Get list of protected contact public keys from settings.

    Returns:
        List of public_key strings (64 hex chars, lowercase)
    """
    from pathlib import Path
    settings_path = Path(config.MC_CONFIG_DIR) / ".webui_settings.json"

    try:
        if not settings_path.exists():
            return []

        with open(settings_path, 'r', encoding='utf-8') as f:
            settings = json.load(f)
            # Return lowercase keys for consistent comparison
            return [pk.lower() for pk in settings.get('protected_contacts', [])]
    except Exception as e:
        logger.error(f"Failed to read protected contacts: {e}")
        return []


def save_protected_contacts(protected_list: list) -> bool:
    """
    Save protected contacts list to settings file (atomic write).

    Args:
        protected_list: List of public_key strings

    Returns:
        True if successful, False otherwise
    """
    from pathlib import Path
    settings_path = Path(config.MC_CONFIG_DIR) / ".webui_settings.json"

    try:
        # Read existing settings
        settings = {}
        if settings_path.exists():
            with open(settings_path, 'r', encoding='utf-8') as f:
                settings = json.load(f)

        # Update protected contacts (store lowercase)
        settings['protected_contacts'] = [pk.lower() for pk in protected_list]

        # Write back atomically
        temp_file = settings_path.with_suffix('.tmp')
        with open(temp_file, 'w', encoding='utf-8') as f:
            json.dump(settings, f, indent=2, ensure_ascii=False)
        temp_file.replace(settings_path)

        return True
    except Exception as e:
        logger.error(f"Failed to save protected contacts: {e}")
        return False


# =============================================================================
# Cleanup Settings Management
# =============================================================================

def get_cleanup_settings() -> dict:
    """
    Get auto-cleanup settings from .webui_settings.json.

    Returns:
        Dict with cleanup settings:
        {
            'enabled': bool,
            'types': list[int],
            'date_field': str,
            'days': int,
            'name_filter': str,
            'hour': int (0-23, UTC)
        }
    """
    from pathlib import Path
    defaults = {
        'enabled': False,
        'types': [1, 2, 3, 4],
        'date_field': 'last_advert',
        'days': 30,
        'name_filter': '',
        'hour': 1
    }

    settings_path = Path(config.MC_CONFIG_DIR) / ".webui_settings.json"

    try:
        if not settings_path.exists():
            return defaults

        with open(settings_path, 'r', encoding='utf-8') as f:
            settings = json.load(f)
            cleanup = settings.get('cleanup_settings', {})
            # Merge with defaults to ensure all fields exist
            return {**defaults, **cleanup}
    except Exception as e:
        logger.error(f"Failed to read cleanup settings: {e}")
        return defaults


def save_cleanup_settings(cleanup_settings: dict) -> bool:
    """
    Save auto-cleanup settings to .webui_settings.json (atomic write).

    Args:
        cleanup_settings: Dict with cleanup configuration

    Returns:
        True if successful, False otherwise
    """
    from pathlib import Path
    settings_path = Path(config.MC_CONFIG_DIR) / ".webui_settings.json"

    try:
        # Read existing settings
        settings = {}
        if settings_path.exists():
            with open(settings_path, 'r', encoding='utf-8') as f:
                settings = json.load(f)

        # Update cleanup settings
        settings['cleanup_settings'] = cleanup_settings

        # Write back atomically
        temp_file = settings_path.with_suffix('.tmp')
        with open(temp_file, 'w', encoding='utf-8') as f:
            json.dump(settings, f, indent=2, ensure_ascii=False)
        temp_file.replace(settings_path)

        return True
    except Exception as e:
        logger.error(f"Failed to save cleanup settings: {e}")
        return False


@api_bp.route('/messages', methods=['GET'])
def get_messages():
    """
    Get list of messages from specific channel or archive.

    Query parameters:
        limit (int): Maximum number of messages to return
        offset (int): Number of messages to skip from the end
        archive_date (str): View archive for specific date (YYYY-MM-DD format)
        days (int): Show only messages from last N days (live view only)
        channel_idx (int): Filter by channel index (optional)

    Returns:
        JSON with messages list
    """
    try:
        limit = request.args.get('limit', type=int)
        offset = request.args.get('offset', default=0, type=int)
        archive_date = request.args.get('archive_date', type=str)
        days = request.args.get('days', type=int)
        channel_idx = request.args.get('channel_idx', type=int)

        # Validate archive_date format if provided
        if archive_date:
            try:
                datetime.strptime(archive_date, '%Y-%m-%d')
            except ValueError:
                return jsonify({
                    'success': False,
                    'error': f'Invalid date format: {archive_date}. Expected YYYY-MM-DD'
                }), 400

        # v2: Read messages from Database
        db = _get_db()
        if db:
            if archive_date:
                # Archive view: query by specific date
                db_messages = db.get_channel_messages_by_date(
                    date_str=archive_date,
                    channel_idx=channel_idx,
                )
            else:
                # Live view: query with limit/offset/days
                ch = channel_idx if channel_idx is not None else 0
                db_messages = db.get_channel_messages(
                    channel_idx=ch,
                    limit=limit or 50,
                    offset=offset,
                    days=days,
                )

            # Convert DB rows to frontend-compatible format
            messages = []
            for row in db_messages:
                pkt_payload = row.get('pkt_payload')
                msg = {
                    'sender': row.get('sender', ''),
                    'content': row.get('content', ''),
                    'timestamp': row.get('timestamp', 0),
                    'datetime': datetime.fromtimestamp(row['timestamp']).isoformat() if row.get('timestamp') else None,
                    'is_own': bool(row.get('is_own', 0)),
                    'snr': row.get('snr'),
                    'path_len': row.get('path_len'),
                    'channel_idx': row.get('channel_idx', 0),
                    'sender_timestamp': row.get('sender_timestamp'),
                    'txt_type': row.get('txt_type', 0),
                    'raw_text': row.get('content', ''),
                    'pkt_payload': pkt_payload,
                }

                # Enrich own messages with echo data and analyzer URL
                if msg['is_own'] and pkt_payload:
                    echoes = db.get_echoes_for_message(pkt_payload)
                    msg['echo_count'] = len(echoes)
                    msg['echo_paths'] = [e.get('path', '') for e in echoes]
                    msg['analyzer_url'] = compute_analyzer_url(pkt_payload)

                messages.append(msg)
        else:
            # Fallback to parser for file-based reads
            messages = parser.read_messages(
                limit=limit,
                offset=offset,
                archive_date=archive_date,
                days=days,
                channel_idx=channel_idx
            )

        return jsonify({
            'success': True,
            'count': len(messages),
            'messages': messages,
            'archive_date': archive_date if archive_date else None,
            'channel_idx': channel_idx
        }), 200

    except Exception as e:
        logger.error(f"Error fetching messages: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@api_bp.route('/messages', methods=['POST'])
def send_message():
    """
    Send a message to a specific channel.

    JSON body:
        text (str): Message content (required)
        reply_to (str): Username to reply to (optional)
        channel_idx (int): Channel to send to (optional, default: 0)

    Returns:
        JSON with success status
    """
    try:
        data = request.get_json()

        if not data or 'text' not in data:
            return jsonify({
                'success': False,
                'error': 'Missing required field: text'
            }), 400

        text = data['text'].strip()
        if not text:
            return jsonify({
                'success': False,
                'error': 'Message text cannot be empty'
            }), 400

        # MeshCore message length limit (~180-200 bytes for LoRa)
        # Count UTF-8 bytes, not Unicode characters
        byte_length = len(text.encode('utf-8'))
        if byte_length > 200:
            return jsonify({
                'success': False,
                'error': f'Message too long ({byte_length} bytes). Maximum 200 bytes allowed due to LoRa constraints.'
            }), 400

        reply_to = data.get('reply_to')
        channel_idx = data.get('channel_idx', 0)

        # Send message via meshcli
        success, message = cli.send_message(text, reply_to=reply_to, channel_index=channel_idx)

        if success:
            # v2: Echo tracking is handled automatically by DeviceManager events

            return jsonify({
                'success': True,
                'message': 'Message sent successfully',
                'channel_idx': channel_idx
            }), 200
        else:
            return jsonify({
                'success': False,
                'error': message
            }), 500

    except Exception as e:
        logger.error(f"Error sending message: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@api_bp.route('/status', methods=['GET'])
def get_status():
    """
    Get device connection status and basic info.

    Returns:
        JSON with status information
    """
    try:
        # Check if device is accessible
        connected = cli.check_connection()

        # v2: Get message count from Database
        db = _get_db()
        message_count = 0
        latest_timestamp = None
        if db:
            stats = db.get_stats()
            message_count = stats.get('channel_messages', 0) + stats.get('direct_messages', 0)
            # Get latest channel message timestamp
            recent = db.get_channel_messages(limit=1)
            if recent:
                latest_timestamp = recent[0].get('timestamp')
        else:
            message_count = parser.count_messages()
            latest = parser.get_latest_message()
            latest_timestamp = latest['timestamp'] if latest else None

        return jsonify({
            'success': True,
            'connected': connected,
            'device_name': runtime_config.get_device_name(),
            'device_name_source': runtime_config.get_device_name_source(),
            'serial_port': config.MC_SERIAL_PORT,
            'message_count': message_count,
            'latest_message_timestamp': latest_timestamp
        }), 200

    except Exception as e:
        logger.error(f"Error getting status: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@api_bp.route('/contacts', methods=['GET'])
def get_contacts():
    """
    Get list of contacts from the device.

    Returns:
        JSON with list of contact names
    """
    try:
        success, contacts, error = cli.get_contacts_list()

        if success:
            return jsonify({
                'success': True,
                'contacts': contacts,
                'count': len(contacts)
            }), 200
        else:
            return jsonify({
                'success': False,
                'error': error or 'Failed to get contacts',
                'contacts': []
            }), 500

    except Exception as e:
        logger.error(f"Error getting contacts: {e}")
        return jsonify({
            'success': False,
            'error': str(e),
            'contacts': []
        }), 500


@api_bp.route('/contacts/cached', methods=['GET'])
def get_cached_contacts():
    """
    Get all known contacts from persistent cache (superset of device contacts).
    Includes contacts seen via adverts even after removal from device.

    Query params:
        ?format=names  - Return just name strings for @mentions (default)
        ?format=full   - Return full cache entries with public_key, timestamps, etc.
    """
    try:
        fmt = request.args.get('format', 'names')

        # v2: Read from Database (fallback to contacts_cache)
        db = _get_db()
        if db:
            db_contacts = db.get_contacts()
            if fmt == 'full':
                contacts = []
                for c in db_contacts:
                    pk = c.get('public_key', '')
                    contacts.append({
                        'public_key': pk,
                        'public_key_prefix': pk[:12],
                        'name': c.get('name', ''),
                        'first_seen': c.get('first_seen', ''),
                        'last_seen': c.get('last_seen', ''),
                        'source': c.get('source', ''),
                        'adv_lat': c.get('adv_lat'),
                        'adv_lon': c.get('adv_lon'),
                        'type_label': {0: 'CLI', 1: 'CLI', 2: 'REP', 3: 'ROOM', 4: 'SENS'}.get(c.get('type', 1), 'UNKNOWN'),
                    })
                return jsonify({
                    'success': True,
                    'contacts': contacts,
                    'count': len(contacts)
                }), 200
            else:
                names = sorted(set(c.get('name', '') for c in db_contacts if c.get('name')))
                return jsonify({
                    'success': True,
                    'contacts': names,
                    'count': len(names)
                }), 200
        else:
            # Fallback to contacts_cache
            if fmt == 'full':
                contacts = get_all_contacts()
                for c in contacts:
                    c['public_key_prefix'] = c.get('public_key', '')[:12]
                return jsonify({
                    'success': True,
                    'contacts': contacts,
                    'count': len(contacts)
                }), 200
            else:
                names = get_all_names()
                return jsonify({
                    'success': True,
                    'contacts': names,
                    'count': len(names)
                }), 200

    except Exception as e:
        logger.error(f"Error getting cached contacts: {e}")
        return jsonify({
            'success': False,
            'error': str(e),
            'contacts': []
        }), 500


def _filter_contacts_by_criteria(contacts: list, criteria: dict) -> list:
    """
    Filter contacts based on cleanup criteria.

    Args:
        contacts: List of contact dicts from /api/contacts/detailed
        criteria: Filter criteria:
            - name_filter (str): Partial name match (empty = ignore)
            - types (list[int]): Contact types to include [1,2,3,4]
            - date_field (str): "last_advert" or "lastmod"
            - days (int): Days of inactivity (0 = ignore)

    Returns:
        List of contacts matching criteria (excludes protected contacts)
    """
    name_filter = criteria.get('name_filter', '').strip().lower()
    selected_types = criteria.get('types', [1, 2, 3, 4])
    date_field = criteria.get('date_field', 'last_advert')
    days = criteria.get('days', 0)

    # Calculate timestamp threshold for days filter
    current_time = int(time.time())
    days_threshold = days * 86400  # Convert days to seconds

    # Get protected contacts list (exclude from cleanup)
    protected_contacts = get_protected_contacts()

    filtered = []
    for contact in contacts:
        # Skip protected contacts
        if contact.get('public_key', '').lower() in protected_contacts:
            continue

        # Filter by type
        if contact.get('type') not in selected_types:
            continue

        # Filter by name (partial match, case-insensitive)
        if name_filter:
            contact_name = contact.get('name', '').lower()
            if name_filter not in contact_name:
                continue

        # Filter by date (days of inactivity)
        if days > 0:
            timestamp = contact.get(date_field, 0)
            if timestamp == 0:
                # No timestamp - consider as inactive
                pass
            else:
                # Check if inactive for more than specified days
                age_seconds = current_time - timestamp
                if age_seconds <= days_threshold:
                    # Still active within threshold
                    continue

        # Contact matches all criteria
        filtered.append(contact)

    return filtered


@api_bp.route('/contacts/preview-cleanup', methods=['POST'])
def preview_cleanup_contacts():
    """
    Preview contacts that will be deleted based on filter criteria.

    JSON body:
        {
            "name_filter": "",              # Partial name match (empty = ignore)
            "types": [1, 2, 3, 4],          # Contact types (1=CLI, 2=REP, 3=ROOM, 4=SENS)
            "date_field": "last_advert",    # "last_advert" or "lastmod"
            "days": 2                       # Days of inactivity (0 = ignore)
        }

    Returns:
        JSON with preview of contacts to be deleted:
        {
            "success": true,
            "contacts": [...],
            "count": 15
        }
    """
    try:
        data = request.get_json() or {}

        # Validate criteria
        criteria = {
            'name_filter': data.get('name_filter', ''),
            'types': data.get('types', [1, 2, 3, 4]),
            'date_field': data.get('date_field', 'last_advert'),
            'days': data.get('days', 0)
        }

        # Validate types
        if not isinstance(criteria['types'], list) or not all(t in [1, 2, 3, 4] for t in criteria['types']):
            return jsonify({
                'success': False,
                'error': 'Invalid types (must be list of 1, 2, 3, 4)'
            }), 400

        # Validate date_field
        if criteria['date_field'] not in ['last_advert', 'lastmod']:
            return jsonify({
                'success': False,
                'error': 'Invalid date_field (must be "last_advert" or "lastmod")'
            }), 400

        # Validate numeric fields
        if not isinstance(criteria['days'], int) or criteria['days'] < 0:
            return jsonify({
                'success': False,
                'error': 'Invalid days (must be non-negative integer)'
            }), 400

        # Get all contacts
        success_detailed, contacts_detailed, error_detailed = cli.get_contacts_with_last_seen()
        if not success_detailed:
            return jsonify({
                'success': False,
                'error': error_detailed or 'Failed to get contacts'
            }), 500

        # Convert to list format (same as /api/contacts/detailed)
        type_labels = {1: 'CLI', 2: 'REP', 3: 'ROOM', 4: 'SENS'}
        contacts = []
        for public_key, details in contacts_detailed.items():
            out_path_len = details.get('out_path_len', -1)
            contacts.append({
                'public_key': public_key,
                'name': details.get('adv_name', ''),
                'type': details.get('type'),
                'type_label': type_labels.get(details.get('type'), 'UNKNOWN'),
                'last_advert': details.get('last_advert'),
                'lastmod': details.get('lastmod'),
                'out_path_len': out_path_len,
                'out_path': details.get('out_path', ''),
                'adv_lat': details.get('adv_lat'),
                'adv_lon': details.get('adv_lon')
            })

        # Filter contacts
        filtered_contacts = _filter_contacts_by_criteria(contacts, criteria)

        return jsonify({
            'success': True,
            'contacts': filtered_contacts,
            'count': len(filtered_contacts)
        }), 200

    except Exception as e:
        logger.error(f"Error previewing cleanup: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@api_bp.route('/contacts/cleanup', methods=['POST'])
def cleanup_contacts():
    """
    Clean up contacts based on filter criteria.

    JSON body:
        {
            "name_filter": "",              # Partial name match (empty = ignore)
            "types": [1, 2, 3, 4],          # Contact types (1=CLI, 2=REP, 3=ROOM, 4=SENS)
            "date_field": "last_advert",    # "last_advert" or "lastmod"
            "days": 2                       # Days of inactivity (0 = ignore)
        }

    Returns:
        JSON with cleanup result:
        {
            "success": true,
            "deleted_count": 15,
            "failed_count": 2,
            "failures": [
                {"name": "Contact1", "error": "..."},
                ...
            ]
        }
    """
    try:
        data = request.get_json() or {}

        # Validate criteria (same as preview)
        criteria = {
            'name_filter': data.get('name_filter', ''),
            'types': data.get('types', [1, 2, 3, 4]),
            'date_field': data.get('date_field', 'last_advert'),
            'days': data.get('days', 0)
        }

        # Validate types
        if not isinstance(criteria['types'], list) or not all(t in [1, 2, 3, 4] for t in criteria['types']):
            return jsonify({
                'success': False,
                'error': 'Invalid types (must be list of 1, 2, 3, 4)'
            }), 400

        # Validate date_field
        if criteria['date_field'] not in ['last_advert', 'lastmod']:
            return jsonify({
                'success': False,
                'error': 'Invalid date_field (must be "last_advert" or "lastmod")'
            }), 400

        # Validate numeric fields
        if not isinstance(criteria['days'], int) or criteria['days'] < 0:
            return jsonify({
                'success': False,
                'error': 'Invalid days (must be non-negative integer)'
            }), 400

        # Get all contacts
        success_detailed, contacts_detailed, error_detailed = cli.get_contacts_with_last_seen()
        if not success_detailed:
            return jsonify({
                'success': False,
                'error': error_detailed or 'Failed to get contacts'
            }), 500

        # Convert to list format
        type_labels = {1: 'CLI', 2: 'REP', 3: 'ROOM', 4: 'SENS'}
        contacts = []
        for public_key, details in contacts_detailed.items():
            out_path_len = details.get('out_path_len', -1)
            contacts.append({
                'public_key': public_key,
                'name': details.get('adv_name', ''),
                'type': details.get('type'),
                'type_label': type_labels.get(details.get('type'), 'UNKNOWN'),
                'last_advert': details.get('last_advert'),
                'lastmod': details.get('lastmod'),
                'out_path_len': out_path_len
            })

        # Filter contacts to delete
        filtered_contacts = _filter_contacts_by_criteria(contacts, criteria)

        if len(filtered_contacts) == 0:
            return jsonify({
                'success': True,
                'message': 'No contacts matched the criteria',
                'deleted_count': 0,
                'failed_count': 0,
                'failures': []
            }), 200

        # Delete contacts one by one, track failures
        deleted_count = 0
        failed_count = 0
        failures = []

        for contact in filtered_contacts:
            contact_name = contact['name']
            success, message = cli.delete_contact(contact_name)

            if success:
                deleted_count += 1
            else:
                failed_count += 1
                failures.append({
                    'name': contact_name,
                    'error': message
                })

        # Invalidate contacts cache after deletions
        if deleted_count > 0:
            invalidate_contacts_cache()

        return jsonify({
            'success': True,
            'message': f'Cleanup completed: {deleted_count} deleted, {failed_count} failed',
            'deleted_count': deleted_count,
            'failed_count': failed_count,
            'failures': failures
        }), 200

    except Exception as e:
        logger.error(f"Error cleaning contacts: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@api_bp.route('/device/info', methods=['GET'])
def get_device_info():
    """
    Get detailed device information.

    Returns:
        JSON with device info
    """
    try:
        success, info = cli.get_device_info()

        if success:
            return jsonify({
                'success': True,
                'info': info
            }), 200
        else:
            return jsonify({
                'success': False,
                'error': info
            }), 500

    except Exception as e:
        logger.error(f"Error getting device info: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


# =============================================================================
# Special Commands
# =============================================================================

# Registry of available special commands
SPECIAL_COMMANDS = {
    'advert': {
        'function': cli.advert,
        'description': 'Send single advertisement (recommended)',
    },
    'floodadv': {
        'function': cli.floodadv,
        'description': 'Flood advertisement (use sparingly!)',
    },
}


@api_bp.route('/device/command', methods=['POST'])
def execute_special_command():
    """
    Execute a special device command.

    JSON body:
        command (str): Command name (required) - one of: advert, floodadv, node_discover

    Returns:
        JSON with command result
    """
    try:
        data = request.get_json()

        if not data or 'command' not in data:
            return jsonify({
                'success': False,
                'error': 'Missing required field: command'
            }), 400

        command = data['command'].strip().lower()

        if command not in SPECIAL_COMMANDS:
            return jsonify({
                'success': False,
                'error': f'Unknown command: {command}. Available commands: {", ".join(SPECIAL_COMMANDS.keys())}'
            }), 400

        # Execute the command
        cmd_info = SPECIAL_COMMANDS[command]
        success, message = cmd_info['function']()

        if success:
            # Clean up advert message
            if command == 'advert':
                clean_message = "Advert sent"
            else:
                clean_message = message or f'{command} executed successfully'

            return jsonify({
                'success': True,
                'command': command,
                'message': clean_message
            }), 200
        else:
            return jsonify({
                'success': False,
                'command': command,
                'error': message
            }), 500

    except Exception as e:
        logger.error(f"Error executing special command: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@api_bp.route('/device/commands', methods=['GET'])
def list_special_commands():
    """
    List available special commands.

    Returns:
        JSON with list of available commands
    """
    commands = [
        {'name': name, 'description': info['description']}
        for name, info in SPECIAL_COMMANDS.items()
    ]
    return jsonify({
        'success': True,
        'commands': commands
    }), 200


@api_bp.route('/sync', methods=['POST'])
def sync_messages():
    """
    Trigger message sync from device.

    Returns:
        JSON with sync result
    """
    try:
        success, message = cli.recv_messages()

        if success:
            return jsonify({
                'success': True,
                'message': 'Messages synced successfully'
            }), 200
        else:
            return jsonify({
                'success': False,
                'error': message
            }), 500

    except Exception as e:
        logger.error(f"Error syncing messages: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@api_bp.route('/archives', methods=['GET'])
def get_archives():
    """
    Get list of available message archives (dates with messages).

    Returns:
        JSON with list of archives, each with:
        - date (str): Date in YYYY-MM-DD format
        - message_count (int): Number of messages on that date
    """
    try:
        # v2: Query distinct dates from SQLite
        db = _get_db()
        if db:
            dates = db.get_message_dates()
            # Exclude today (that's "Live")
            from datetime import date as date_cls
            today = date_cls.today().isoformat()
            archives = [d for d in dates if d['date'] != today]
            return jsonify({
                'success': True,
                'archives': archives,
                'count': len(archives)
            }), 200

        # Fallback to file-based archives
        archives = archive_manager.list_archives()

        return jsonify({
            'success': True,
            'archives': archives,
            'count': len(archives)
        }), 200

    except Exception as e:
        logger.error(f"Error listing archives: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@api_bp.route('/archive/trigger', methods=['POST'])
def trigger_archive():
    """
    Manually trigger message archiving.

    JSON body:
        date (str): Date to archive in YYYY-MM-DD format (optional, defaults to yesterday)

    Returns:
        JSON with archive operation result
    """
    try:
        data = request.get_json() or {}
        archive_date = data.get('date')

        # Validate date format if provided
        if archive_date:
            try:
                datetime.strptime(archive_date, '%Y-%m-%d')
            except ValueError:
                return jsonify({
                    'success': False,
                    'error': f'Invalid date format: {archive_date}. Expected YYYY-MM-DD'
                }), 400

        # Trigger archiving
        result = archive_manager.archive_messages(archive_date)

        if result['success']:
            return jsonify(result), 200
        else:
            return jsonify(result), 500

    except Exception as e:
        logger.error(f"Error triggering archive: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@api_bp.route('/channels', methods=['GET'])
def get_channels():
    """
    Get list of configured channels (cached for 30s).

    Returns:
        JSON with channels list
    """
    try:
        success, channels = get_channels_cached()

        if success:
            return jsonify({
                'success': True,
                'channels': channels,
                'count': len(channels)
            }), 200
        else:
            return jsonify({
                'success': False,
                'error': 'Failed to retrieve channels'
            }), 500

    except Exception as e:
        logger.error(f"Error getting channels: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@api_bp.route('/channels', methods=['POST'])
def create_channel():
    """
    Create a new channel with auto-generated key.

    JSON body:
        name (str): Channel name (required)

    Returns:
        JSON with created channel info
    """
    try:
        data = request.get_json()

        if not data or 'name' not in data:
            return jsonify({
                'success': False,
                'error': 'Missing required field: name'
            }), 400

        name = data['name'].strip()
        if not name:
            return jsonify({
                'success': False,
                'error': 'Channel name cannot be empty'
            }), 400

        # Validate name (no special chars that could break CLI)
        if not re.match(r'^[a-zA-Z0-9_\-]+$', name):
            return jsonify({
                'success': False,
                'error': 'Channel name can only contain letters, numbers, _ and -'
            }), 400

        success, message, key = cli.add_channel(name)

        if success:
            invalidate_channels_cache()  # Clear cache to force refresh

            # Build response
            response = {
                'success': True,
                'message': message,
                'channel': {
                    'name': name,
                    'key': key
                }
            }

            # Check channel count for soft limit warning
            success_ch, channels = get_channels_cached()
            if success_ch and len(channels) > 7:
                response['warning'] = (
                    f'You now have {len(channels)} channels. '
                    'Some devices may only support up to 8 channels. '
                    'Check your device specifications if you experience issues.'
                )

            return jsonify(response), 201
        else:
            return jsonify({
                'success': False,
                'error': message
            }), 500

    except Exception as e:
        logger.error(f"Error creating channel: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@api_bp.route('/channels/join', methods=['POST'])
def join_channel():
    """
    Join an existing channel by setting name and key.

    JSON body:
        name (str): Channel name (required)
        key (str): 32-char hex key (optional for channels starting with #)
        index (int): Channel slot (optional, auto-detect if not provided)

    Returns:
        JSON with result
    """
    try:
        data = request.get_json()

        if not data or 'name' not in data:
            return jsonify({
                'success': False,
                'error': 'Missing required field: name'
            }), 400

        name = data['name'].strip()
        key = data.get('key', '').strip().lower() if 'key' in data else None

        # Validate: key is optional for channels starting with #
        if not name.startswith('#') and not key:
            return jsonify({
                'success': False,
                'error': 'Key is required for channels not starting with #'
            }), 400

        # Auto-detect free slot if not provided
        if 'index' in data:
            index = int(data['index'])
        else:
            # Find first free slot (1-40, skip 0 which is Public)
            # Hard limit: 40 channels (most LoRa devices support up to 40)
            # Soft limit: 7 channels (some devices may have lower limits)
            success_ch, channels = get_channels_cached()
            if not success_ch:
                return jsonify({
                    'success': False,
                    'error': 'Failed to get current channels'
                }), 500

            used_indices = {ch['index'] for ch in channels}
            index = None
            for i in range(1, 41):  # Max 40 channels (hard limit)
                if i not in used_indices:
                    index = i
                    break

            if index is None:
                return jsonify({
                    'success': False,
                    'error': 'No free channel slots available (max 40 channels)'
                }), 400

        success, message = cli.set_channel(index, name, key)

        if success:
            invalidate_channels_cache()  # Clear cache to force refresh

            # Build response
            response = {
                'success': True,
                'message': f'Joined channel "{name}" at slot {index}',
                'channel': {
                    'index': index,
                    'name': name,
                    'key': key if key else 'auto-generated'
                }
            }

            # Add warning if exceeding soft limit (7 channels)
            # Some older/smaller devices may only support 8 channels total
            channel_count = len(used_indices) + 1  # +1 for newly added channel
            if channel_count > 7:
                response['warning'] = (
                    f'You now have {channel_count} channels. '
                    'Some devices may only support up to 8 channels. '
                    'Check your device specifications if you experience issues.'
                )

            return jsonify(response), 200
        else:
            return jsonify({
                'success': False,
                'error': message
            }), 500

    except Exception as e:
        logger.error(f"Error joining channel: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@api_bp.route('/channels/<int:index>', methods=['DELETE'])
def delete_channel(index):
    """
    Remove a channel and delete all its messages.

    Args:
        index: Channel index to remove

    Returns:
        JSON with result
    """
    try:
        # First, delete all messages for this channel
        db = _get_db()
        if db:
            db.delete_channel_messages(index)
        else:
            messages_deleted = parser.delete_channel_messages(index)
            if not messages_deleted:
                logger.warning(f"Failed to delete messages for channel {index}, continuing with channel removal")

        # Then remove the channel itself
        success, message = cli.remove_channel(index)

        if success:
            invalidate_channels_cache()  # Clear cache to force refresh
            return jsonify({
                'success': True,
                'message': f'Channel {index} removed and messages deleted'
            }), 200
        else:
            return jsonify({
                'success': False,
                'error': message
            }), 500

    except Exception as e:
        logger.error(f"Error removing channel: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@api_bp.route('/channels/<int:index>/qr', methods=['GET'])
def get_channel_qr(index):
    """
    Generate QR code for channel sharing.

    Args:
        index: Channel index

    Query params:
        format: 'json' (default) or 'png'

    Returns:
        JSON with QR data or PNG image
    """
    try:
        import qrcode

        # Get channel info
        success, channels = cli.get_channels()
        if not success:
            return jsonify({
                'success': False,
                'error': 'Failed to get channels'
            }), 500

        channel = next((ch for ch in channels if ch['index'] == index), None)
        if not channel:
            return jsonify({
                'success': False,
                'error': f'Channel {index} not found'
            }), 404

        # Create QR data
        qr_data = {
            'type': 'meshcore_channel',
            'name': channel['name'],
            'key': channel['key']
        }
        qr_json = json.dumps(qr_data)

        format_type = request.args.get('format', 'json')

        if format_type == 'png':
            # Generate PNG QR code
            qr = qrcode.QRCode(
                version=1,
                error_correction=qrcode.constants.ERROR_CORRECT_L,
                box_size=10,
                border=4,
            )
            qr.add_data(qr_json)
            qr.make(fit=True)

            img = qr.make_image(fill_color="black", back_color="white")

            # Convert to PNG bytes
            buf = BytesIO()
            img.save(buf, format='PNG')
            buf.seek(0)

            return send_file(buf, mimetype='image/png')

        else:  # JSON format
            # Generate base64 data URL for inline display
            qr = qrcode.QRCode(version=1, box_size=10, border=4)
            qr.add_data(qr_json)
            qr.make(fit=True)

            img = qr.make_image(fill_color="black", back_color="white")
            buf = BytesIO()
            img.save(buf, format='PNG')
            buf.seek(0)

            img_base64 = base64.b64encode(buf.read()).decode()
            data_url = f"data:image/png;base64,{img_base64}"

            return jsonify({
                'success': True,
                'qr_data': qr_data,
                'qr_image': data_url,
                'qr_text': qr_json
            }), 200

    except ImportError:
        return jsonify({
            'success': False,
            'error': 'QR code library not available'
        }), 500

    except Exception as e:
        logger.error(f"Error generating QR code: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@api_bp.route('/messages/updates', methods=['GET'])
def get_messages_updates():
    """
    Check for new messages across all channels without fetching full message content.
    Used for intelligent refresh mechanism and unread notifications.

    OPTIMIZED: Reads messages file only ONCE and computes stats for all channels.
    Previously read the file N*2 times (once per channel, twice if updates).

    Query parameters:
        last_seen (str): JSON object with last seen timestamps per channel
                        Format: {"0": 1234567890, "1": 1234567891, ...}

    Returns:
        JSON with update information per channel:
        {
            "success": true,
            "channels": [
                {
                    "index": 0,
                    "name": "Public",
                    "has_updates": true,
                    "latest_timestamp": 1234567900,
                    "unread_count": 5
                },
                ...
            ],
            "total_unread": 10
        }
    """
    try:
        # Parse last_seen timestamps from query param
        last_seen_str = request.args.get('last_seen', '{}')
        try:
            last_seen = json.loads(last_seen_str)
            # Convert keys to integers and values to floats
            last_seen = {int(k): float(v) for k, v in last_seen.items()}
        except (json.JSONDecodeError, ValueError):
            last_seen = {}

        # Get list of channels (cached)
        success_ch, channels = get_channels_cached()
        if not success_ch:
            return jsonify({
                'success': False,
                'error': 'Failed to get channels'
            }), 500

        # OPTIMIZATION: Read ALL messages ONCE (no channel filter)
        # Then compute per-channel statistics in memory
        db = _get_db()
        if db:
            all_messages = db.get_channel_messages(limit=None, days=7)
        else:
            all_messages = parser.read_messages(limit=None, days=7)

        # Group messages by channel and compute stats
        channel_stats = {}  # channel_idx -> {latest_ts, messages_after_last_seen}
        for msg in all_messages:
            ch_idx = msg.get('channel_idx', 0)
            ts = msg.get('timestamp', 0)

            if ch_idx not in channel_stats:
                channel_stats[ch_idx] = {
                    'latest_timestamp': 0,
                    'unread_count': 0
                }

            # Track latest timestamp per channel
            if ts > channel_stats[ch_idx]['latest_timestamp']:
                channel_stats[ch_idx]['latest_timestamp'] = ts

            # Count unread messages (newer than last_seen)
            last_seen_ts = last_seen.get(ch_idx, 0)
            if ts > last_seen_ts:
                channel_stats[ch_idx]['unread_count'] += 1

        # Get muted channels to exclude from total
        from app import read_status as rs
        muted_channels = set(rs.get_muted_channels())

        # Build response
        updates = []
        total_unread = 0

        for channel in channels:
            channel_idx = channel['index']
            stats = channel_stats.get(channel_idx, {'latest_timestamp': 0, 'unread_count': 0})

            last_seen_ts = last_seen.get(channel_idx, 0)
            has_updates = stats['latest_timestamp'] > last_seen_ts
            unread_count = stats['unread_count'] if has_updates else 0

            # Only count unmuted channels toward total
            if channel_idx not in muted_channels:
                total_unread += unread_count

            updates.append({
                'index': channel_idx,
                'name': channel['name'],
                'has_updates': has_updates,
                'latest_timestamp': stats['latest_timestamp'],
                'unread_count': unread_count
            })

        return jsonify({
            'success': True,
            'channels': updates,
            'total_unread': total_unread,
            'muted_channels': list(muted_channels)
        }), 200

    except Exception as e:
        logger.error(f"Error checking message updates: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


# =============================================================================
# Direct Messages (DM) Endpoints
# =============================================================================

@api_bp.route('/dm/conversations', methods=['GET'])
def get_dm_conversations():
    """
    Get list of DM conversations.

    Query params:
        days (int): Filter to last N days (default: 7)

    Returns:
        JSON with conversations list:
        {
            "success": true,
            "conversations": [
                {
                    "conversation_id": "pk_4563b1621b58",
                    "display_name": "daniel5120",
                    "pubkey_prefix": "4563b1621b58",
                    "last_message_timestamp": 1766491173,
                    "last_message_preview": "Hello there...",
                    "unread_count": 0,
                    "message_count": 15
                }
            ],
            "count": 5
        }
    """
    try:
        days = request.args.get('days', default=7, type=int)

        # v2: Read from Database
        db = _get_db()
        if db:
            convos = db.get_dm_conversations()
            # Convert to frontend-compatible format
            conversations = []
            for c in convos:
                pk = c.get('contact_pubkey', '')
                conversations.append({
                    'conversation_id': f"pk_{pk}" if pk else 'unknown',
                    'display_name': c.get('display_name', pk[:8] + '...' if pk else 'Unknown'),
                    'pubkey_prefix': pk[:12] if pk else '',
                    'last_message_timestamp': c.get('last_message_timestamp', 0),
                    'last_message_preview': (c.get('last_message_preview', '') or '')[:50],
                    'unread_count': 0,
                    'message_count': c.get('message_count', 0),
                })
        else:
            conversations = parser.get_dm_conversations(days=days)

        return jsonify({
            'success': True,
            'conversations': conversations,
            'count': len(conversations)
        }), 200

    except Exception as e:
        logger.error(f"Error getting DM conversations: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@api_bp.route('/dm/messages', methods=['GET'])
def get_dm_messages():
    """
    Get DM messages for a specific conversation.

    Query params:
        conversation_id (str): Required - conversation identifier (pk_xxx or name_xxx)
        limit (int): Max messages to return (default: 100)
        days (int): Filter to last N days (default: 7)

    Returns:
        JSON with messages list:
        {
            "success": true,
            "conversation_id": "pk_4563b1621b58",
            "display_name": "daniel5120",
            "messages": [...],
            "count": 25
        }
    """
    try:
        conversation_id = request.args.get('conversation_id', type=str)
        if not conversation_id:
            return jsonify({
                'success': False,
                'error': 'Missing required parameter: conversation_id'
            }), 400

        limit = request.args.get('limit', default=100, type=int)
        days = request.args.get('days', default=7, type=int)

        # v2: Read from Database
        db = _get_db()
        pubkey_to_name = {}

        # Extract pubkey from conversation_id
        contact_pubkey = ''
        if conversation_id.startswith('pk_'):
            contact_pubkey = conversation_id[3:]
        elif conversation_id.startswith('name_'):
            # Look up pubkey by name
            contact_name = conversation_id[5:]
            if db:
                contacts = db.get_contacts()
                for c in contacts:
                    if c.get('name', '').strip() == contact_name:
                        contact_pubkey = c['public_key']
                        break

        if db and contact_pubkey:
            db_msgs = db.get_dm_messages(contact_pubkey, limit=limit)
            messages = []
            for row in db_msgs:
                messages.append({
                    'type': 'dm',
                    'direction': 'incoming' if row['direction'] == 'in' else 'outgoing',
                    'sender': row.get('contact_pubkey', ''),
                    'content': row.get('content', ''),
                    'timestamp': row.get('timestamp', 0),
                    'datetime': datetime.fromtimestamp(row['timestamp']).isoformat() if row.get('timestamp') else None,
                    'is_own': row['direction'] == 'out',
                    'snr': row.get('snr'),
                    'path_len': row.get('path_len'),
                    'expected_ack': row.get('expected_ack'),
                    'conversation_id': conversation_id,
                })
        else:
            messages, pubkey_to_name = parser.read_dm_messages(
                limit=limit,
                conversation_id=conversation_id,
                days=days
            )
            messages = parser.dedup_retry_messages(messages)

        # Determine display name
        display_name = 'Unknown'
        if conversation_id.startswith('pk_'):
            pk = conversation_id[3:]
            # Try DB first
            if db:
                contact = db.get_contact(pk)
                if contact:
                    display_name = contact.get('name', pk[:8] + '...')
                else:
                    display_name = pubkey_to_name.get(pk, pk[:8] + '...')
            else:
                display_name = pubkey_to_name.get(pk, pk[:8] + '...')
        elif conversation_id.startswith('name_'):
            display_name = conversation_id[5:]

        # Also check messages for better name
        for msg in messages:
            if msg['direction'] == 'incoming' and msg.get('sender'):
                display_name = msg['sender']
                break
            elif msg['direction'] == 'outgoing' and msg.get('recipient'):
                display_name = msg['recipient']

        # Merge delivery status from ACK tracking
        ack_codes = [msg['expected_ack'] for msg in messages
                     if msg.get('direction') == 'outgoing' and msg.get('expected_ack')]
        if ack_codes:
            try:
                success_ack, acks, _ = cli.check_dm_delivery(ack_codes)
                if success_ack:
                    for msg in messages:
                        ack_code = msg.get('expected_ack')
                        if ack_code and acks.get(ack_code):
                            ack_info = acks[ack_code]
                            msg['status'] = 'delivered'
                            msg['delivery_snr'] = ack_info.get('snr')
                            msg['delivery_route'] = ack_info.get('route')
            except Exception as e:
                logger.debug(f"ACK status fetch failed (non-critical): {e}")

        return jsonify({
            'success': True,
            'conversation_id': conversation_id,
            'display_name': display_name,
            'messages': messages,
            'count': len(messages)
        }), 200

    except Exception as e:
        logger.error(f"Error getting DM messages: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@api_bp.route('/dm/messages', methods=['POST'])
def send_dm_message():
    """
    Send a direct message.

    JSON body:
        recipient (str): Contact name (required)
        text (str): Message content (required)

    Returns:
        JSON with send result:
        {
            "success": true,
            "message": "DM sent",
            "recipient": "daniel5120",
            "status": "pending"
        }
    """
    try:
        data = request.get_json()

        if not data:
            return jsonify({
                'success': False,
                'error': 'Missing JSON body'
            }), 400

        recipient = data.get('recipient', '').strip()
        text = data.get('text', '').strip()

        if not recipient:
            return jsonify({
                'success': False,
                'error': 'Missing required field: recipient'
            }), 400

        if not text:
            return jsonify({
                'success': False,
                'error': 'Missing required field: text'
            }), 400

        # MeshCore message length limit
        byte_length = len(text.encode('utf-8'))
        if byte_length > 200:
            return jsonify({
                'success': False,
                'error': f'Message too long ({byte_length} bytes). Maximum 200 bytes allowed.'
            }), 400

        # Send via CLI
        success, message = cli.send_dm(recipient, text)

        if success:
            return jsonify({
                'success': True,
                'message': 'DM sent',
                'recipient': recipient,
                'status': 'pending'
            }), 200
        else:
            return jsonify({
                'success': False,
                'error': message
            }), 500

    except Exception as e:
        logger.error(f"Error sending DM: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@api_bp.route('/dm/auto_retry', methods=['GET'])
def get_auto_retry_config():
    """Get auto-retry configuration."""
    try:
        success, data = cli.get_auto_retry_config()
        if success:
            return jsonify(data), 200
        return jsonify({'success': False, 'error': 'Failed to get config'}), 500
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@api_bp.route('/dm/auto_retry', methods=['POST'])
def set_auto_retry_config():
    """Update auto-retry configuration."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': 'Missing JSON body'}), 400

        success, result = cli.set_auto_retry_config(
            enabled=data.get('enabled'),
            max_attempts=data.get('max_attempts'),
            max_flood=data.get('max_flood')
        )
        if success:
            return jsonify(result), 200
        return jsonify({'success': False, 'error': 'Failed to update config'}), 500
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@api_bp.route('/dm/updates', methods=['GET'])
def get_dm_updates():
    """
    Check for new DMs across all conversations.
    Used for notification badge updates.

    Query params:
        last_seen (str): JSON object with last seen timestamps per conversation
                        Format: {"pk_xxx": 1234567890, "name_yyy": 1234567891, ...}

    Returns:
        JSON with update information:
        {
            "success": true,
            "total_unread": 5,
            "conversations": [
                {
                    "conversation_id": "pk_4563b1621b58",
                    "display_name": "daniel5120",
                    "unread_count": 3,
                    "latest_timestamp": 1766491173
                }
            ]
        }
    """
    try:
        # Parse last_seen timestamps
        last_seen_str = request.args.get('last_seen', '{}')
        try:
            last_seen = json.loads(last_seen_str)
        except json.JSONDecodeError:
            last_seen = {}

        # v2: Read from Database
        db = _get_db()

        updates = []
        total_unread = 0

        if db:
            convos = db.get_dm_conversations()
            for c in convos:
                pk = c.get('contact_pubkey', '')
                conv_id = f"pk_{pk}" if pk else 'unknown'
                display_name = c.get('display_name', pk[:8] + '...' if pk else 'Unknown')
                last_msg_ts = c.get('last_message_timestamp', 0)
                last_seen_ts = last_seen.get(conv_id, 0)

                if last_msg_ts > last_seen_ts and pk:
                    db_msgs = db.get_dm_messages(pk, limit=200)
                    unread_count = sum(1 for m in db_msgs if m.get('timestamp', 0) > last_seen_ts)
                else:
                    unread_count = 0

                total_unread += unread_count

                if unread_count > 0:
                    updates.append({
                        'conversation_id': conv_id,
                        'display_name': display_name,
                        'unread_count': unread_count,
                        'latest_timestamp': last_msg_ts
                    })
        else:
            # Fallback to parser
            conversations = parser.get_dm_conversations(days=7)
            for conv in conversations:
                conv_id = conv['conversation_id']
                last_seen_ts = last_seen.get(conv_id, 0)
                if conv['last_message_timestamp'] > last_seen_ts:
                    messages, _ = parser.read_dm_messages(conversation_id=conv_id, days=7)
                    messages = parser.dedup_retry_messages(messages)
                    unread_count = sum(1 for m in messages if m['timestamp'] > last_seen_ts)
                else:
                    unread_count = 0
                total_unread += unread_count
                if unread_count > 0:
                    updates.append({
                        'conversation_id': conv_id,
                        'display_name': conv['display_name'],
                        'unread_count': unread_count,
                        'latest_timestamp': conv['last_message_timestamp']
                    })

        return jsonify({
            'success': True,
            'total_unread': total_unread,
            'conversations': updates
        }), 200

    except Exception as e:
        logger.error(f"Error checking DM updates: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


# =============================================================================
# Contact Management (Existing, Pending Contacts & Settings)
# =============================================================================

@api_bp.route('/contacts/detailed', methods=['GET'])
def get_contacts_detailed_api():
    """
    Get detailed list of ALL existing contacts on the device (CLI, REP, ROOM, SENS).

    Returns full contact_info data from meshcli including GPS coordinates, paths, etc.

    Returns:
        JSON with contacts list:
        {
            "success": true,
            "count": 263,
            "limit": 350,
            "contacts": [
                {
                    "name": "TK Zalesie Test 🦜",              // adv_name
                    "public_key": "df2027d3f2ef...",           // Full public key (64 chars)
                    "public_key_prefix": "df2027d3f2ef",       // First 12 chars
                    "type": 2,                                  // 1=CLI, 2=REP, 3=ROOM, 4=SENS
                    "type_label": "REP",                        // Human-readable type
                    "flags": 0,
                    "out_path_len": -1,                         // -1 = Flood mode
                    "out_path": "",                             // Path string
                    "last_advert": 1735429453,                  // Unix timestamp
                    "adv_lat": 50.866005,                       // GPS latitude
                    "adv_lon": 20.669308,                       // GPS longitude
                    "lastmod": 1715973527                       // Last modification timestamp
                },
                ...
            ]
        }
    """
    try:
        # Get detailed contact info from cache (reduces 4 USB calls to 0 on cache hit)
        force_refresh = request.args.get('refresh', 'false').lower() == 'true'
        success_detailed, contacts_detailed, error_detailed = get_contacts_detailed_cached(force_refresh)

        if not success_detailed:
            return jsonify({
                'success': False,
                'error': error_detailed or 'Failed to get contact details',
                'contacts': [],
                'count': 0,
                'limit': 350
            }), 500

        # Convert dict to list and add computed fields
        type_labels = {1: 'CLI', 2: 'REP', 3: 'ROOM', 4: 'SENS'}
        contacts = []

        # Get protected contacts for is_protected field
        protected_contacts = get_protected_contacts()

        for public_key, details in contacts_detailed.items():
            # Compute path display string
            out_path_len = details.get('out_path_len', -1)
            out_path = details.get('out_path', '')
            if out_path_len == -1:
                path_or_mode = 'Flood'
            elif out_path:
                path_or_mode = out_path
            else:
                path_or_mode = f'Path len: {out_path_len}'

            contact = {
                # All original fields from contact_info
                'public_key': public_key,
                'type': details.get('type'),
                'flags': details.get('flags'),
                'out_path_len': out_path_len,
                'out_path': out_path,
                'last_advert': details.get('last_advert'),
                'adv_lat': details.get('adv_lat'),
                'adv_lon': details.get('adv_lon'),
                'lastmod': details.get('lastmod'),
                # Computed/convenience fields
                'name': details.get('adv_name', ''),  # Map adv_name to name for compatibility
                'public_key_prefix': public_key[:12] if len(public_key) >= 12 else public_key,
                'type_label': type_labels.get(details.get('type'), 'UNKNOWN'),
                'path_or_mode': path_or_mode,  # For UI display
                'last_seen': details.get('last_advert'),  # Alias for compatibility
                'is_protected': public_key.lower() in protected_contacts,  # Protection status
            }
            contacts.append(contact)

        return jsonify({
            'success': True,
            'contacts': contacts,
            'count': len(contacts),
            'limit': 350  # MeshCore device limit
        }), 200

    except Exception as e:
        logger.error(f"Error getting detailed contacts list: {e}")
        return jsonify({
            'success': False,
            'error': str(e),
            'contacts': [],
            'count': 0,
            'limit': 350
        }), 500


@api_bp.route('/contacts/delete', methods=['POST'])
def delete_contact_api():
    """
    Delete a contact from the device.

    JSON body:
        {
            "selector": "<public_key_prefix_or_name>"
        }

    Using public_key_prefix is recommended for reliability.

    Returns:
        JSON with deletion result:
        {
            "success": true,
            "message": "Contact removed successfully"
        }
    """
    try:
        data = request.get_json()

        if not data or 'selector' not in data:
            return jsonify({
                'success': False,
                'error': 'Missing required field: selector'
            }), 400

        selector = data['selector']

        if not isinstance(selector, str) or not selector.strip():
            return jsonify({
                'success': False,
                'error': 'selector must be a non-empty string'
            }), 400

        success, message = cli.delete_contact(selector)

        if success:
            # Invalidate contacts cache after deletion
            invalidate_contacts_cache()
            return jsonify({
                'success': True,
                'message': message
            }), 200
        else:
            return jsonify({
                'success': False,
                'error': message
            }), 500

    except Exception as e:
        logger.error(f"Error deleting contact: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@api_bp.route('/contacts/protected', methods=['GET'])
def get_protected_contacts_api():
    """
    Get list of all protected contact public keys.

    Returns:
        JSON with protected contacts:
        {
            "success": true,
            "protected_contacts": ["public_key1", "public_key2", ...],
            "count": 2
        }
    """
    try:
        protected = get_protected_contacts()
        return jsonify({
            'success': True,
            'protected_contacts': protected,
            'count': len(protected)
        }), 200
    except Exception as e:
        logger.error(f"Error getting protected contacts: {e}")
        return jsonify({
            'success': False,
            'error': str(e),
            'protected_contacts': [],
            'count': 0
        }), 500


@api_bp.route('/contacts/<public_key>/protect', methods=['POST'])
def toggle_contact_protection(public_key):
    """
    Toggle protection status for a contact.

    Args:
        public_key: Full public key (64 hex chars) or prefix (12+ chars)

    JSON body (optional):
        {
            "protected": true/false  # If not provided, toggles current state
        }

    Returns:
        JSON with result:
        {
            "success": true,
            "public_key": "full_public_key",
            "protected": true,
            "message": "Contact protected"
        }
    """
    try:
        # Validate public_key format (at least 12 hex chars)
        if not public_key or not re.match(r'^[a-fA-F0-9]{12,64}$', public_key):
            return jsonify({
                'success': False,
                'error': 'Invalid public_key format (must be 12-64 hex characters)'
            }), 400

        public_key = public_key.lower()

        # Get current protected list
        protected_contacts = get_protected_contacts()

        # Find matching full public_key if prefix provided
        if len(public_key) < 64:
            # Fetch contacts to resolve prefix to full key
            success, contacts_dict, error = cli.get_contacts_with_last_seen()
            if not success:
                return jsonify({
                    'success': False,
                    'error': error or 'Failed to get contacts'
                }), 500

            # Find matching contact
            full_key = None
            for pk in contacts_dict.keys():
                if pk.lower().startswith(public_key):
                    full_key = pk.lower()
                    break

            if not full_key:
                return jsonify({
                    'success': False,
                    'error': f'Contact not found with public_key prefix: {public_key}'
                }), 404

            public_key = full_key

        # Check if explicit protected value provided
        data = request.get_json() or {}
        if 'protected' in data:
            should_protect = data['protected']
        else:
            # Toggle current state
            should_protect = public_key not in protected_contacts

        # Update protected list
        if should_protect:
            if public_key not in protected_contacts:
                protected_contacts.append(public_key)
        else:
            if public_key in protected_contacts:
                protected_contacts.remove(public_key)

        # Save updated list
        if not save_protected_contacts(protected_contacts):
            return jsonify({
                'success': False,
                'error': 'Failed to save protected contacts'
            }), 500

        return jsonify({
            'success': True,
            'public_key': public_key,
            'protected': should_protect,
            'message': 'Contact protected' if should_protect else 'Contact unprotected'
        }), 200

    except Exception as e:
        logger.error(f"Error toggling contact protection: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@api_bp.route('/contacts/cleanup-settings', methods=['GET'])
def get_cleanup_settings_api():
    """
    Get auto-cleanup settings.

    Returns:
        JSON with cleanup settings:
        {
            "success": true,
            "settings": {
                "enabled": false,
                "types": [1, 2, 3, 4],
                "date_field": "last_advert",
                "days": 30,
                "name_filter": "",
                "hour": 1
            },
            "timezone": "Europe/Warsaw"
        }
    """
    try:
        from app.archiver.manager import get_local_timezone_name

        settings = get_cleanup_settings()
        timezone = get_local_timezone_name()

        return jsonify({
            'success': True,
            'settings': settings,
            'timezone': timezone
        }), 200
    except Exception as e:
        logger.error(f"Error getting cleanup settings: {e}")
        return jsonify({
            'success': False,
            'error': str(e),
            'settings': {
                'enabled': False,
                'types': [1, 2, 3, 4],
                'date_field': 'last_advert',
                'days': 30,
                'name_filter': '',
                'hour': 1
            },
            'timezone': 'local'
        }), 500


@api_bp.route('/contacts/cleanup-settings', methods=['POST'])
def update_cleanup_settings_api():
    """
    Update auto-cleanup settings.

    JSON body:
        {
            "enabled": true,
            "types": [1, 2],
            "date_field": "last_advert",
            "days": 30,
            "name_filter": "",
            "hour": 1
        }

    Returns:
        JSON with update result:
        {
            "success": true,
            "message": "Cleanup settings updated",
            "settings": {...}
        }
    """
    try:
        data = request.get_json() or {}

        # Validate fields
        if 'types' in data:
            if not isinstance(data['types'], list) or not all(t in [1, 2, 3, 4] for t in data['types']):
                return jsonify({
                    'success': False,
                    'error': 'Invalid types (must be list of 1, 2, 3, 4)'
                }), 400

        if 'date_field' in data:
            if data['date_field'] not in ['last_advert', 'lastmod']:
                return jsonify({
                    'success': False,
                    'error': 'Invalid date_field (must be "last_advert" or "lastmod")'
                }), 400

        if 'days' in data:
            if not isinstance(data['days'], int) or data['days'] < 0:
                return jsonify({
                    'success': False,
                    'error': 'Invalid days (must be non-negative integer)'
                }), 400

        if 'enabled' in data:
            if not isinstance(data['enabled'], bool):
                return jsonify({
                    'success': False,
                    'error': 'Invalid enabled (must be boolean)'
                }), 400

        if 'hour' in data:
            if not isinstance(data['hour'], int) or data['hour'] < 0 or data['hour'] > 23:
                return jsonify({
                    'success': False,
                    'error': 'Invalid hour (must be integer 0-23)'
                }), 400

        # Get current settings and merge with new values
        current = get_cleanup_settings()
        updated = {**current, **data}

        # Save settings
        if not save_cleanup_settings(updated):
            return jsonify({
                'success': False,
                'error': 'Failed to save cleanup settings'
            }), 500

        # Update scheduler based on enabled state and hour
        from app.archiver.manager import schedule_cleanup, get_local_timezone_name
        schedule_cleanup(enabled=updated.get('enabled', False), hour=updated.get('hour', 1))

        return jsonify({
            'success': True,
            'message': 'Cleanup settings updated',
            'settings': updated,
            'timezone': get_local_timezone_name()
        }), 200

    except Exception as e:
        logger.error(f"Error updating cleanup settings: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


# =============================================================================
# Contact Management (Pending Contacts & Settings)
# =============================================================================

@api_bp.route('/contacts/pending', methods=['GET'])
def get_pending_contacts_api():
    """
    Get list of contacts awaiting manual approval.

    Query parameters:
        types (list[int]): Filter by contact types (optional)
                          Example: ?types=1&types=2 (CLI and REP only)
                          Valid values: 1 (CLI), 2 (REP), 3 (ROOM), 4 (SENS)
                          If not provided, returns all pending contacts

    Returns:
        JSON with pending contacts list with enriched contact data:
        {
            "success": true,
            "pending": [
                {
                    "name": "KRK - WD 🔌",
                    "public_key": "2d86b4a747b6565ad1...",
                    "public_key_prefix": "2d86b4a747b6",
                    "type": 2,
                    "type_label": "REP",
                    "adv_lat": 50.02377,
                    "adv_lon": 19.96038,
                    "last_advert": 1715889153,
                    "lastmod": 1716372319,
                    "out_path_len": -1,
                    "out_path": "",
                    "path_or_mode": "Flood"
                },
                ...
            ],
            "count": 2
        }
    """
    try:
        # Get type filter from query params
        types_param = request.args.getlist('types', type=int)

        # Validate types (must be 1-4)
        if types_param:
            invalid_types = [t for t in types_param if t not in [1, 2, 3, 4]]
            if invalid_types:
                return jsonify({
                    'success': False,
                    'error': f'Invalid types: {invalid_types}. Valid types: 1 (CLI), 2 (REP), 3 (ROOM), 4 (SENS)',
                    'pending': []
                }), 400

        success, pending, error = cli.get_pending_contacts()

        if success:
            # Filter by types if specified
            if types_param:
                pending = [contact for contact in pending if contact.get('type') in types_param]

            return jsonify({
                'success': True,
                'pending': pending,
                'count': len(pending)
            }), 200
        else:
            return jsonify({
                'success': False,
                'error': error or 'Failed to get pending contacts',
                'pending': []
            }), 500

    except Exception as e:
        logger.error(f"Error getting pending contacts: {e}")
        return jsonify({
            'success': False,
            'error': str(e),
            'pending': []
        }), 500


@api_bp.route('/contacts/pending/approve', methods=['POST'])
def approve_pending_contact_api():
    """
    Approve and add a pending contact.

    JSON body:
        {
            "public_key": "<full_public_key>"
        }

    IMPORTANT: Always send the full public_key (not name or prefix).
    Full public key works for all contact types (CLI, ROOM, REP, SENS).

    Returns:
        JSON with approval result:
        {
            "success": true,
            "message": "Contact approved successfully"
        }
    """
    try:
        data = request.get_json()

        if not data or 'public_key' not in data:
            return jsonify({
                'success': False,
                'error': 'Missing required field: public_key'
            }), 400

        public_key = data['public_key']

        if not isinstance(public_key, str) or not public_key.strip():
            return jsonify({
                'success': False,
                'error': 'public_key must be a non-empty string'
            }), 400

        success, message = cli.approve_pending_contact(public_key)

        if success:
            # Invalidate contacts cache after adding new contact
            invalidate_contacts_cache()
            return jsonify({
                'success': True,
                'message': message or 'Contact approved successfully'
            }), 200
        else:
            return jsonify({
                'success': False,
                'error': message
            }), 500

    except Exception as e:
        logger.error(f"Error approving pending contact: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@api_bp.route('/device/settings', methods=['GET'])
def get_device_settings_api():
    """
    Get persistent device settings.

    Returns:
        JSON with settings:
        {
            "success": true,
            "settings": {
                "manual_add_contacts": false
            }
        }
    """
    try:
        success, settings = cli.get_device_settings()

        if success:
            return jsonify({
                'success': True,
                'settings': settings
            }), 200
        else:
            return jsonify({
                'success': False,
                'error': 'Failed to get device settings',
                'settings': {'manual_add_contacts': False}
            }), 500

    except Exception as e:
        logger.error(f"Error getting device settings: {e}")
        return jsonify({
            'success': False,
            'error': str(e),
            'settings': {'manual_add_contacts': False}
        }), 500


@api_bp.route('/device/settings', methods=['POST'])
def update_device_settings_api():
    """
    Update persistent device settings.

    JSON body:
        {
            "manual_add_contacts": true/false
        }

    This setting is:
    1. Saved to .webui_settings.json for persistence across container restarts
    2. Applied immediately to the running meshcli session

    Returns:
        JSON with update result:
        {
            "success": true,
            "message": "manual_add_contacts set to on"
        }
    """
    try:
        data = request.get_json()

        if not data or 'manual_add_contacts' not in data:
            return jsonify({
                'success': False,
                'error': 'Missing required field: manual_add_contacts'
            }), 400

        manual_add_contacts = data['manual_add_contacts']

        if not isinstance(manual_add_contacts, bool):
            return jsonify({
                'success': False,
                'error': 'manual_add_contacts must be a boolean'
            }), 400

        success, message = cli.set_manual_add_contacts(manual_add_contacts)

        if success:
            return jsonify({
                'success': True,
                'message': message,
                'settings': {'manual_add_contacts': manual_add_contacts}
            }), 200
        else:
            return jsonify({
                'success': False,
                'error': message
            }), 500

    except Exception as e:
        logger.error(f"Error updating device settings: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


# =============================================================================
# Read Status (Server-side message read tracking)
# =============================================================================

@api_bp.route('/read_status', methods=['GET'])
def get_read_status_api():
    """
    Get server-side read status for all channels and DM conversations.

    This replaces localStorage-based tracking to enable cross-device synchronization.

    Returns:
        JSON with read status:
        {
            "success": true,
            "channels": {
                "0": 1735900000,
                "1": 1735900100
            },
            "dm": {
                "name_User1": 1735900200,
                "pk_abc123": 1735900300
            }
        }
    """
    try:
        from app import read_status

        status = read_status.load_read_status()

        return jsonify({
            'success': True,
            'channels': status['channels'],
            'dm': status['dm'],
            'muted_channels': status.get('muted_channels', [])
        }), 200

    except Exception as e:
        logger.error(f"Error getting read status: {e}")
        return jsonify({
            'success': False,
            'error': str(e),
            'channels': {},
            'dm': {},
            'muted_channels': []
        }), 500


@api_bp.route('/version', methods=['GET'])
def get_version():
    """
    Get application version.

    Returns:
        JSON with version info:
        {
            "success": true,
            "version": "2025.01.18+576c8ca9",
            "docker_tag": "2025.01.18-576c8ca9",
            "branch": "dev"
        }
    """
    from app.version import VERSION_STRING, DOCKER_TAG, GIT_BRANCH
    return jsonify({
        'success': True,
        'version': VERSION_STRING,
        'docker_tag': DOCKER_TAG,
        'branch': GIT_BRANCH
    }), 200


# GitHub repository for update checks
GITHUB_REPO = "MarekWo/mc-webui"


@api_bp.route('/check-update', methods=['GET'])
def check_update():
    """
    Check if a newer version is available on GitHub.

    Compares current commit hash with latest commit on GitHub.
    Uses the branch from frozen version (dev/main) automatically.

    Query parameters:
        branch (str): Branch to check (default: from frozen version)

    Returns:
        JSON with update status:
        {
            "success": true,
            "update_available": true,
            "current_version": "2026.01.18+abc1234",
            "current_commit": "abc1234",
            "current_branch": "dev",
            "latest_commit": "def5678",
            "latest_date": "2026.01.20",
            "latest_message": "feat: New feature",
            "github_url": "https://github.com/MarekWo/mc-webui/commits/dev"
        }
    """
    from app.version import VERSION_STRING, GIT_BRANCH

    try:
        # Use branch from frozen version, or allow override via query param
        branch = request.args.get('branch', GIT_BRANCH)

        # Extract current commit hash from VERSION_STRING (format: YYYY.MM.DD+hash or YYYY.MM.DD+hash+dirty)
        current_commit = None
        if '+' in VERSION_STRING:
            parts = VERSION_STRING.split('+')
            if len(parts) >= 2:
                current_commit = parts[1]  # Get hash part (skip date, ignore +dirty)

        if not current_commit or current_commit == 'unknown':
            return jsonify({
                'success': False,
                'error': 'Cannot determine current version. Run version freeze first.'
            }), 400

        # Fetch latest commit from GitHub API
        github_api_url = f"https://api.github.com/repos/{GITHUB_REPO}/commits/{branch}"
        headers = {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'mc-webui-update-checker'
        }

        response = requests.get(github_api_url, headers=headers, timeout=10)

        if response.status_code == 403:
            return jsonify({
                'success': False,
                'error': 'GitHub API rate limit exceeded. Try again later.'
            }), 429

        if response.status_code != 200:
            return jsonify({
                'success': False,
                'error': f'GitHub API error: {response.status_code}'
            }), 502

        data = response.json()
        latest_full_sha = data.get('sha', '')
        latest_commit = latest_full_sha[:7]  # Short hash (7 chars like git default)

        # Get commit details
        commit_info = data.get('commit', {})
        latest_message = commit_info.get('message', '').split('\n')[0]  # First line only
        commit_date = commit_info.get('committer', {}).get('date', '')

        # Parse date to YYYY.MM.DD format
        latest_date = ''
        if commit_date:
            try:
                dt = datetime.fromisoformat(commit_date.replace('Z', '+00:00'))
                latest_date = dt.strftime('%Y.%m.%d')
            except ValueError:
                latest_date = commit_date[:10]

        # Compare commits (case-insensitive, compare first 7 chars)
        update_available = current_commit.lower()[:7] != latest_commit.lower()[:7]

        return jsonify({
            'success': True,
            'update_available': update_available,
            'current_version': VERSION_STRING,
            'current_commit': current_commit[:7],
            'current_branch': branch,
            'latest_commit': latest_commit,
            'latest_date': latest_date,
            'latest_message': latest_message,
            'github_url': f"https://github.com/{GITHUB_REPO}/commits/{branch}"
        }), 200

    except requests.Timeout:
        return jsonify({
            'success': False,
            'error': 'GitHub API request timed out'
        }), 504

    except requests.RequestException as e:
        logger.error(f"Error checking for updates: {e}")
        return jsonify({
            'success': False,
            'error': f'Network error: {str(e)}'
        }), 502

    except Exception as e:
        logger.error(f"Error checking for updates: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


# =============================================================================
# Remote Update (via host webhook)
# =============================================================================

# Updater webhook URL - tries multiple addresses for Docker compatibility
UPDATER_URLS = [
    'http://host.docker.internal:5050',  # Docker Desktop (Mac/Windows)
    'http://172.17.0.1:5050',             # Docker default bridge gateway (Linux)
    'http://127.0.0.1:5050',              # Localhost fallback
]


def get_updater_url():
    """Find working updater webhook URL."""
    for url in UPDATER_URLS:
        try:
            response = requests.get(f"{url}/health", timeout=2)
            if response.status_code == 200:
                return url
        except requests.RequestException:
            continue
    return None


@api_bp.route('/updater/status', methods=['GET'])
def updater_status():
    """
    Check if the update webhook is available on the host.

    Returns:
        JSON with updater status:
        {
            "success": true,
            "available": true,
            "url": "http://172.17.0.1:5050",
            "update_in_progress": false
        }
    """
    try:
        url = get_updater_url()

        if not url:
            return jsonify({
                'success': True,
                'available': False,
                'message': 'Update webhook not installed or not running'
            }), 200

        # Get detailed status from webhook
        response = requests.get(f"{url}/health", timeout=5)
        data = response.json()

        return jsonify({
            'success': True,
            'available': True,
            'url': url,
            'update_in_progress': data.get('update_in_progress', False),
            'mcwebui_dir': data.get('mcwebui_dir', '')
        }), 200

    except Exception as e:
        logger.error(f"Error checking updater status: {e}")
        return jsonify({
            'success': False,
            'available': False,
            'error': str(e)
        }), 200


@api_bp.route('/updater/trigger', methods=['POST'])
def updater_trigger():
    """
    Trigger remote update via host webhook.

    This will:
    1. Call the webhook to start update.sh
    2. The server will restart (containers rebuilt)
    3. Frontend should poll /api/version to detect completion

    Returns:
        JSON with result:
        {
            "success": true,
            "message": "Update started"
        }
    """
    try:
        url = get_updater_url()

        if not url:
            return jsonify({
                'success': False,
                'error': 'Update webhook not available. Install it first.'
            }), 503

        # Trigger update
        response = requests.post(f"{url}/update", timeout=10)
        data = response.json()

        if response.status_code == 200 and data.get('success'):
            return jsonify({
                'success': True,
                'message': 'Update started. Server will restart shortly.'
            }), 200
        else:
            return jsonify({
                'success': False,
                'error': data.get('error', 'Unknown error')
            }), response.status_code

    except requests.Timeout:
        # Timeout might mean the update started and server is restarting
        return jsonify({
            'success': True,
            'message': 'Update may have started (request timed out)'
        }), 200

    except Exception as e:
        logger.error(f"Error triggering update: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@api_bp.route('/read_status/mark_read', methods=['POST'])
def mark_read_api():
    """
    Mark a channel or DM conversation as read.

    JSON body (one of the following):
        {"type": "channel", "channel_idx": 0, "timestamp": 1735900000}
        {"type": "dm", "conversation_id": "name_User1", "timestamp": 1735900200}

    Returns:
        JSON with result:
        {
            "success": true,
            "message": "Channel marked as read"
        }
    """
    try:
        from app import read_status

        data = request.get_json()

        if not data:
            return jsonify({
                'success': False,
                'error': 'Missing JSON body'
            }), 400

        msg_type = data.get('type')
        timestamp = data.get('timestamp')

        if not msg_type or not timestamp:
            return jsonify({
                'success': False,
                'error': 'Missing required fields: type and timestamp'
            }), 400

        if msg_type == 'channel':
            channel_idx = data.get('channel_idx')
            if channel_idx is None:
                return jsonify({
                    'success': False,
                    'error': 'Missing required field: channel_idx'
                }), 400

            success = read_status.mark_channel_read(channel_idx, timestamp)

            if success:
                return jsonify({
                    'success': True,
                    'message': f'Channel {channel_idx} marked as read'
                }), 200
            else:
                return jsonify({
                    'success': False,
                    'error': 'Failed to save read status'
                }), 500

        elif msg_type == 'dm':
            conversation_id = data.get('conversation_id')
            if not conversation_id:
                return jsonify({
                    'success': False,
                    'error': 'Missing required field: conversation_id'
                }), 400

            success = read_status.mark_dm_read(conversation_id, timestamp)

            if success:
                return jsonify({
                    'success': True,
                    'message': f'DM conversation {conversation_id} marked as read'
                }), 200
            else:
                return jsonify({
                    'success': False,
                    'error': 'Failed to save read status'
                }), 500

        else:
            return jsonify({
                'success': False,
                'error': f'Invalid type: {msg_type}. Must be "channel" or "dm"'
            }), 400

    except Exception as e:
        logger.error(f"Error marking as read: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@api_bp.route('/read_status/mark_all_read', methods=['POST'])
def mark_all_read_api():
    """Mark all channels as read in bulk."""
    try:
        from app import read_status

        data = request.get_json()
        if not data or 'channels' not in data:
            return jsonify({'success': False, 'error': 'Missing channels timestamps'}), 400

        success = read_status.mark_all_channels_read(data['channels'])

        if success:
            return jsonify({'success': True, 'message': 'All channels marked as read'}), 200
        else:
            return jsonify({'success': False, 'error': 'Failed to save'}), 500

    except Exception as e:
        logger.error(f"Error marking all as read: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@api_bp.route('/channels/muted', methods=['GET'])
def get_muted_channels_api():
    """Get list of muted channel indices."""
    try:
        from app import read_status
        muted = read_status.get_muted_channels()
        return jsonify({'success': True, 'muted_channels': muted}), 200
    except Exception as e:
        logger.error(f"Error getting muted channels: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@api_bp.route('/channels/<int:index>/mute', methods=['POST'])
def set_channel_muted_api(index):
    """Set mute state for a channel."""
    try:
        from app import read_status

        data = request.get_json()
        if data is None or 'muted' not in data:
            return jsonify({'success': False, 'error': 'Missing muted field'}), 400

        success = read_status.set_channel_muted(index, data['muted'])

        if success:
            return jsonify({
                'success': True,
                'message': f'Channel {index} {"muted" if data["muted"] else "unmuted"}'
            }), 200
        else:
            return jsonify({'success': False, 'error': 'Failed to save'}), 500

    except Exception as e:
        logger.error(f"Error setting channel mute: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


# ============================================================
# Console History API
# ============================================================

CONSOLE_HISTORY_FILE = 'console_history.json'
CONSOLE_HISTORY_MAX_SIZE = 50


def _get_console_history_path():
    """Get path to console history file"""
    return Path(config.MC_CONFIG_DIR) / CONSOLE_HISTORY_FILE


def _load_console_history():
    """Load console history from file"""
    history_path = _get_console_history_path()
    try:
        if history_path.exists():
            with open(history_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                return data.get('commands', [])
    except Exception as e:
        logger.error(f"Error loading console history: {e}")
    return []


def _save_console_history(commands):
    """Save console history to file"""
    history_path = _get_console_history_path()
    try:
        # Ensure directory exists
        history_path.parent.mkdir(parents=True, exist_ok=True)
        with open(history_path, 'w', encoding='utf-8') as f:
            json.dump({'commands': commands}, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        logger.error(f"Error saving console history: {e}")
        return False


@api_bp.route('/console/history', methods=['GET'])
def get_console_history():
    """Get console command history"""
    try:
        commands = _load_console_history()
        return jsonify({
            'success': True,
            'commands': commands
        }), 200
    except Exception as e:
        logger.error(f"Error getting console history: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@api_bp.route('/console/history', methods=['POST'])
def add_console_history():
    """Add command to console history"""
    try:
        data = request.get_json()
        if not data or 'command' not in data:
            return jsonify({
                'success': False,
                'error': 'Missing command field'
            }), 400

        command = data['command'].strip()
        if not command:
            return jsonify({
                'success': False,
                'error': 'Empty command'
            }), 400

        # Load existing history
        commands = _load_console_history()

        # Remove command if already exists (will be moved to end)
        if command in commands:
            commands.remove(command)

        # Add to end
        commands.append(command)

        # Limit size
        if len(commands) > CONSOLE_HISTORY_MAX_SIZE:
            commands = commands[-CONSOLE_HISTORY_MAX_SIZE:]

        # Save
        if _save_console_history(commands):
            return jsonify({
                'success': True,
                'commands': commands
            }), 200
        else:
            return jsonify({
                'success': False,
                'error': 'Failed to save history'
            }), 500

    except Exception as e:
        logger.error(f"Error adding console history: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@api_bp.route('/advertisements', methods=['GET'])
def get_advertisements():
    """Get advertisement history, optionally filtered by public key."""
    db = _get_db()
    if not db:
        return jsonify({'success': False, 'error': 'Database not available'}), 503

    try:
        limit = request.args.get('limit', 100, type=int)
        public_key = request.args.get('pubkey', None)

        limit = max(1, min(limit, 1000))

        adverts = db.get_advertisements(limit=limit, public_key=public_key)

        # Enrich with contact name lookup
        names = get_all_names()
        for adv in adverts:
            pk = adv.get('public_key', '')
            adv['contact_name'] = names.get(pk, adv.get('name', ''))

        return jsonify({
            'success': True,
            'advertisements': adverts,
            'count': len(adverts)
        })
    except Exception as e:
        logger.error(f"Error fetching advertisements: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@api_bp.route('/console/history', methods=['DELETE'])
def clear_console_history():
    """Clear console command history"""
    try:
        if _save_console_history([]):
            return jsonify({
                'success': True,
                'message': 'History cleared'
            }), 200
        else:
            return jsonify({
                'success': False,
                'error': 'Failed to clear history'
            }), 500
    except Exception as e:
        logger.error(f"Error clearing console history: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500
