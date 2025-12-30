"""
MeshCore CLI wrapper - executes meshcli commands via HTTP bridge
"""

import logging
import re
import json
import requests
from pathlib import Path
from typing import Tuple, Optional, List, Dict
from app.config import config

logger = logging.getLogger(__name__)

# Command timeout in seconds (reduced to prevent long waits)
DEFAULT_TIMEOUT = 12  # Reduced from 30s - bridge has 10s + 2s buffer
RECV_TIMEOUT = 60  # recv can take longer


class MeshCLIError(Exception):
    """Custom exception for meshcli command failures"""
    pass


def _run_command(args: list, timeout: int = DEFAULT_TIMEOUT) -> Tuple[bool, str, str]:
    """
    Execute meshcli command via HTTP bridge.

    Args:
        args: Command arguments (e.g., ['recv'], ['public', 'Hello'])
        timeout: Command timeout in seconds

    Returns:
        Tuple of (success, stdout, stderr)
    """
    logger.info(f"Executing via bridge: {' '.join(args)}")

    try:
        response = requests.post(
            config.MC_BRIDGE_URL,
            json={
                'args': args,
                'timeout': timeout
            },
            timeout=timeout + 5  # Add 5s buffer for HTTP timeout
        )

        # Handle HTTP errors
        if response.status_code != 200:
            logger.error(f"Bridge HTTP error {response.status_code}: {response.text}")
            return False, '', f'Bridge HTTP error: {response.status_code}'

        data = response.json()

        success = data.get('success', False)
        stdout = data.get('stdout', '').strip()
        stderr = data.get('stderr', '').strip()

        if not success:
            logger.warning(f"Command failed: {stderr or stdout}")

        return success, stdout, stderr

    except requests.exceptions.Timeout:
        logger.error(f"Bridge request timeout after {timeout}s")
        return False, '', f'Bridge timeout after {timeout} seconds'

    except requests.exceptions.ConnectionError as e:
        logger.error(f"Cannot connect to meshcore-bridge: {e}")
        return False, '', 'Cannot connect to meshcore-bridge service'

    except Exception as e:
        logger.error(f"Bridge communication error: {e}")
        return False, '', str(e)


def recv_messages() -> Tuple[bool, str]:
    """
    Fetch new messages from the device.

    Returns:
        Tuple of (success, message)
    """
    success, stdout, stderr = _run_command(['recv'], timeout=RECV_TIMEOUT)
    return success, stdout or stderr


def send_message(text: str, reply_to: Optional[str] = None, channel_index: int = 0) -> Tuple[bool, str]:
    """
    Send a message to a specific channel.

    Args:
        text: Message content
        reply_to: Optional username to reply to (will format as @[username])
        channel_index: Channel to send to (default: 0 = Public)

    Returns:
        Tuple of (success, message)
    """
    if reply_to:
        message = f"@[{reply_to}] {text}"
    else:
        message = text

    # Use 'chan' command for all channels (including Public/0) for consistent quoting behavior
    # Note: 'public' command treats quotes literally, while 'chan' properly parses them as delimiters
    success, stdout, stderr = _run_command(['chan', str(channel_index), message])

    return success, stdout or stderr


def get_contacts() -> Tuple[bool, str]:
    """
    Get list of contacts from the device.

    Returns:
        Tuple of (success, output)
    """
    success, stdout, stderr = _run_command(['contacts'])
    return success, stdout or stderr


def parse_contacts(output: str, filter_types: Optional[List[str]] = None) -> List[str]:
    """
    Parse meshcli contacts output to extract contact names.

    Expected format from meshcli contacts:
    ContactName                    CLI   pubkey_prefix  path
    ContactName 🔫                 CLI   pubkey_prefix  path

    Contact name is separated from type column (CLI/REP/ROOM/SENS) by multiple spaces.

    Args:
        output: Raw output from meshcli contacts command
        filter_types: Optional list of contact types to include (e.g., ['CLI'])
                     If None, all types are included.

    Returns:
        List of contact names (unique)
    """
    contacts = []

    for line in output.split('\n'):
        line_stripped = line.strip()

        # Skip empty lines, headers, and INFO lines
        if not line_stripped or line_stripped.startswith('---') or \
           line.lower().startswith('contact') or line.startswith('INFO:'):
            continue

        # Split by 2+ consecutive spaces (columns separator in meshcli output)
        # Format: "ContactName         CLI   pubkey  path"
        parts = re.split(r'\s{2,}', line)

        if len(parts) >= 2:
            # First part is the contact name (may include emoji and spaces)
            contact_name = parts[0].strip()

            # Second part should be type (CLI, REP, ROOM, SENS)
            contact_type = parts[1].strip()

            # Validate that second column looks like a type
            if contact_type in ['CLI', 'REP', 'ROOM', 'SENS'] and contact_name:
                # Apply type filter if specified
                if filter_types is None or contact_type in filter_types:
                    if contact_name not in contacts:
                        contacts.append(contact_name)

    return contacts


def get_contacts_list() -> Tuple[bool, List[str], str]:
    """
    Get parsed list of contact names from the device.
    Only returns CLI (client) contacts, excluding REP, ROOM, and SENS.

    Returns:
        Tuple of (success, contact_names_list, error_message)
    """
    success, output = get_contacts()

    if not success:
        return False, [], output

    # Filter only CLI (client) contacts - no repeaters, rooms, or sensors
    contacts = parse_contacts(output, filter_types=['CLI'])
    return True, contacts, ""


def clean_inactive_contacts(hours: int = 48) -> Tuple[bool, str]:
    """
    Remove contacts inactive for specified hours.

    Args:
        hours: Inactivity threshold in hours

    Returns:
        Tuple of (success, message)
    """
    # Command format: apply_to u<48h,t=1 remove_contact
    # u<48h = updated less than 48h ago (inactive)
    # t=1 = type client (not router/repeater)
    filter_cmd = f"u<{hours}h,t=1"
    success, stdout, stderr = _run_command(['apply_to', filter_cmd, 'remove_contact'])
    return success, stdout or stderr


def get_device_info() -> Tuple[bool, str]:
    """
    Get device information.

    Returns:
        Tuple of (success, info)
    """
    success, stdout, stderr = _run_command(['infos'])
    return success, stdout or stderr


def check_connection() -> bool:
    """
    Quick check if device is accessible.

    Returns:
        True if device responds, False otherwise
    """
    success, _, _ = _run_command(['infos'], timeout=5)
    return success


def get_channels() -> Tuple[bool, List[Dict]]:
    """
    Get list of configured channels.

    Returns:
        Tuple of (success, list of channel dicts)
        Each dict: {
            'index': int,
            'name': str,
            'key': str
        }
    """
    success, stdout, stderr = _run_command(['get_channels'])

    if not success:
        return False, []

    channels = []
    for line in stdout.split('\n'):
        line = line.strip()
        if not line:
            continue

        # Parse: "0: Public [8b3387e9c5cdea6ac9e5edbaa115cd72]"
        match = re.match(r'^(\d+):\s+(.+?)\s+\[([a-f0-9]{32})\]$', line)
        if match:
            channels.append({
                'index': int(match.group(1)),
                'name': match.group(2),
                'key': match.group(3)
            })

    return True, channels


def add_channel(name: str) -> Tuple[bool, str, Optional[str]]:
    """
    Add a new channel with auto-generated key.

    Args:
        name: Channel name

    Returns:
        Tuple of (success, message, key_or_none)
        key_or_none: The generated key if successful, None otherwise
    """
    success, stdout, stderr = _run_command(['add_channel', name])

    if not success:
        return False, stderr or stdout, None

    # Get channels to find the newly created one
    success_ch, channels = get_channels()
    if success_ch:
        for ch in channels:
            if ch['name'] == name:
                return True, f"Channel '{name}' created", ch['key']

    return True, stdout or stderr, None


def set_channel(index: int, name: str, key: Optional[str] = None) -> Tuple[bool, str]:
    """
    Set/join a channel at specific index with name and optional key.

    Args:
        index: Channel slot number
        name: Channel name
        key: 32-char hex key (optional for channels starting with #)

    Returns:
        Tuple of (success, message)
    """
    # Build command arguments
    cmd_args = ['set_channel', str(index), name]

    # Add key if provided
    if key:
        # Validate key format
        if not re.match(r'^[a-f0-9]{32}$', key.lower()):
            return False, "Invalid key format (must be 32 hex characters)"
        cmd_args.append(key.lower())

    success, stdout, stderr = _run_command(cmd_args)

    return success, stdout or stderr


def remove_channel(index: int) -> Tuple[bool, str]:
    """
    Remove a channel.

    Args:
        index: Channel number to remove

    Returns:
        Tuple of (success, message)
    """
    if index == 0:
        return False, "Cannot remove Public channel (channel 0)"

    success, stdout, stderr = _run_command(['remove_channel', str(index)])
    return success, stdout or stderr


# =============================================================================
# Special Commands (Network Advertisement)
# =============================================================================

def advert() -> Tuple[bool, str]:
    """
    Send a single advertisement frame to the mesh network.

    This is the recommended way to announce node presence.
    Uses minimal airtime and follows normal routing rules.

    Returns:
        Tuple of (success, message)
    """
    success, stdout, stderr = _run_command(['advert'])
    return success, stdout or stderr


def floodadv() -> Tuple[bool, str]:
    """
    Send advertisement in flooding mode (broadcast storm).

    WARNING: This should be used sparingly! It causes high airtime usage
    and can destabilize larger networks. Use only for:
    - Initial network bootstrap
    - After device reset/firmware change
    - When routing is broken
    - Debug/testing purposes

    Returns:
        Tuple of (success, message)
    """
    success, stdout, stderr = _run_command(['floodadv'])
    return success, stdout or stderr


# =============================================================================
# Direct Messages (DM)
# =============================================================================

def send_dm(recipient: str, text: str) -> Tuple[bool, str]:
    """
    Send a direct/private message to a contact.

    Uses meshcli 'msg' command: msg <name> <message>

    Args:
        recipient: Contact name to send to
        text: Message content

    Returns:
        Tuple of (success, message)
    """
    if not recipient or not recipient.strip():
        return False, "Recipient name is required"

    if not text or not text.strip():
        return False, "Message text is required"

    success, stdout, stderr = _run_command(['msg', recipient.strip(), text.strip()])
    return success, stdout or stderr


# =============================================================================
# Contact Management (Existing & Pending Contacts)
# =============================================================================

def get_all_contacts_detailed() -> Tuple[bool, List[Dict], int, str]:
    """
    Get detailed list of ALL existing contacts on the device (CLI, REP, ROOM, SENS).

    Returns:
        Tuple of (success, contacts_list, total_count, error_message)
        Each contact dict: {
            'name': str,
            'public_key_prefix': str (12 hex chars),
            'type_label': str (CLI|REP|ROOM|SENS|UNKNOWN),
            'path_or_mode': str (Flood or hex path),
            'raw_line': str (for debugging)
        }
    """
    try:
        success, stdout, stderr = _run_command(['contacts'])

        if not success:
            return False, [], 0, stderr or 'Failed to get contacts list'

        # Parse the output
        contacts = []
        total_count = 0

        lines = stdout.strip().split('\n')

        for line in lines:
            # Skip prompt lines and empty lines
            if line.startswith('MarWoj|*') or not line.strip():
                continue

            # Check for final count line: "> 263 contacts in device"
            if line.strip().startswith('>') and 'contacts in device' in line:
                try:
                    total_count = int(re.search(r'> (\d+) contacts', line).group(1))
                except:
                    pass
                continue

            # Parse contact line
            # Format: NAME  TYPE  PUBKEY_PREFIX  PATH_OR_MODE
            # Example: "TK Zalesie Test 🦜              REP   df2027d3f2ef  Flood"

            # Strategy: work backwards from the end
            # Last column is either "Flood" or hex path (variable length)
            # Before that: 12-char hex public key prefix
            # Before that: TYPE (REP, CLI, ROOM, SENS) - 4 chars with padding
            # Everything else is the name

            stripped = line.rstrip()
            if not stripped:
                continue

            # Split by whitespace, but we need to be smart about it
            parts = stripped.split()
            if len(parts) < 4:
                # Malformed line, skip
                continue

            # The last part is path_or_mode
            path_or_mode = parts[-1]

            # The second-to-last part is public_key_prefix (should be 12 hex chars)
            public_key_prefix = parts[-2]

            # The third-to-last part is type (should be REP, CLI, ROOM, SENS)
            type_label = parts[-3].strip()

            # Everything before that is the name
            # We need to reconstruct it by finding where it ends in the original line
            # Find the position of type_label in the line (searching from right)
            # This is tricky because type_label might appear in the name too

            # Better approach: use the public_key_prefix as anchor (it's unique hex)
            pubkey_pos = stripped.rfind(public_key_prefix)
            if pubkey_pos == -1:
                continue

            # Everything before the public key (minus the type and spacing) is the name
            before_pubkey = stripped[:pubkey_pos].rstrip()

            # The type should be the last word in before_pubkey
            type_pos = before_pubkey.rfind(type_label)
            if type_pos == -1:
                # Type not found, try extracting it differently
                # Just take the last token before pubkey_prefix
                tokens = before_pubkey.split()
                if len(tokens) >= 1:
                    type_label = tokens[-1]
                    name = ' '.join(tokens[:-1]).strip()
                else:
                    continue
            else:
                name = before_pubkey[:type_pos].strip()

            # Validate type_label
            if type_label not in ['CLI', 'REP', 'ROOM', 'SENS']:
                type_label = 'UNKNOWN'

            # Validate public_key_prefix (should be 12 hex chars)
            if not re.match(r'^[a-fA-F0-9]{12}$', public_key_prefix):
                # Invalid format, skip
                continue

            contact = {
                'name': name,
                'public_key_prefix': public_key_prefix.lower(),
                'type_label': type_label,
                'path_or_mode': path_or_mode,
                'raw_line': line
            }

            contacts.append(contact)

        # If total_count wasn't found in output, use length of contacts list
        if total_count == 0:
            total_count = len(contacts)

        return True, contacts, total_count, ""

    except Exception as e:
        logger.error(f"Error parsing contacts list: {e}")
        return False, [], 0, str(e)


def get_contacts_with_last_seen() -> Tuple[bool, Dict[str, Dict], str]:
    """
    Get detailed contact information including last_advert timestamps.

    Uses 'apply_to t=1,t=2,t=3,t=4 contact_info' command to fetch metadata
    for all contact types (CLI, REP, ROOM, SENS).

    Returns:
        Tuple of (success, contacts_dict, error_message)
        contacts_dict maps public_key -> contact_details where each detail dict contains:
        {
            'public_key': str (full key),
            'type': int (1=CLI, 2=REP, 3=ROOM, 4=SENS),
            'flags': int,
            'out_path_len': int,
            'out_path': str,
            'adv_name': str (name with emoji),
            'last_advert': int (Unix timestamp),
            'adv_lat': float,
            'adv_lon': float,
            'lastmod': int (Unix timestamp)
        }
    """
    try:
        # Execute command to get all contact types
        # Call separately for each type since commas might not work through bridge
        # t=1 (CLI), t=2 (REP), t=3 (ROOM), t=4 (SENS)

        contacts_dict = {}

        for contact_type in ['t=1', 't=2', 't=3', 't=4']:
            success, stdout, stderr = _run_command(['apply_to', contact_type, 'contact_info'])

            if not success:
                logger.warning(f"apply_to {contact_type} contact_info failed: {stderr}")
                continue  # Skip this type, try next

            # Parse prettified JSON output
            # Output contains multiple JSON objects separated by newlines
            # Use brace-matching to extract each complete object
            try:
                # Find all complete JSON objects (balanced braces)
                json_objects = []
                depth = 0
                start_idx = None

                for i, char in enumerate(stdout):
                    if char == '{':
                        if depth == 0:
                            start_idx = i
                        depth += 1
                    elif char == '}':
                        depth -= 1
                        if depth == 0 and start_idx is not None:
                            # Found complete JSON object
                            json_str = stdout[start_idx:i+1]
                            try:
                                contact = json.loads(json_str)
                                if 'public_key' in contact:
                                    json_objects.append(contact)
                            except json.JSONDecodeError:
                                # Skip malformed JSON
                                pass
                            start_idx = None

                # Add to contacts dict
                for contact in json_objects:
                    contacts_dict[contact['public_key']] = contact

                logger.info(f"Parsed {len(json_objects)} contacts from {contact_type}")

            except Exception as e:
                logger.error(f"Error parsing {contact_type} output: {e}")
                continue

        if len(contacts_dict) == 0:
            logger.error(f"No contacts parsed from any type")
            return False, {}, 'No contacts found in contact_info output'

        logger.info(f"Total contacts collected: {len(contacts_dict)}")
        return True, contacts_dict, ""

    except Exception as e:
        logger.error(f"Error getting contact details: {e}")
        return False, {}, str(e)


def delete_contact(selector: str) -> Tuple[bool, str]:
    """
    Delete a contact from the device.

    Args:
        selector: Contact selector (name, public_key_prefix, or full public key)
                 Using public_key_prefix is recommended for reliability.

    Returns:
        Tuple of (success, message)
    """
    if not selector or not selector.strip():
        return False, "Contact selector is required"

    try:
        success, stdout, stderr = _run_command(['remove_contact', selector.strip()])

        if success:
            message = stdout.strip() if stdout.strip() else f"Contact {selector} removed successfully"
            return True, message
        else:
            error = stderr.strip() if stderr.strip() else "Failed to remove contact"
            return False, error

    except Exception as e:
        logger.error(f"Error deleting contact: {e}")
        return False, str(e)


def get_pending_contacts() -> Tuple[bool, List[Dict], str]:
    """
    Get list of contacts awaiting manual approval.

    Returns:
        Tuple of (success, pending_contacts_list, error_message)
        Each contact dict: {
            'name': str,
            'public_key': str
        }
    """
    try:
        response = requests.get(
            f"{config.MC_BRIDGE_URL.replace('/cli', '/pending_contacts')}",
            timeout=DEFAULT_TIMEOUT + 5
        )

        if response.status_code != 200:
            return False, [], f'Bridge HTTP error: {response.status_code}'

        data = response.json()

        if not data.get('success', False):
            error = data.get('error', 'Failed to get pending contacts')
            return False, [], error

        pending = data.get('pending', [])
        return True, pending, ""

    except requests.exceptions.Timeout:
        return False, [], 'Bridge timeout'
    except requests.exceptions.ConnectionError:
        return False, [], 'Cannot connect to meshcore-bridge service'
    except Exception as e:
        return False, [], str(e)


def approve_pending_contact(public_key: str) -> Tuple[bool, str]:
    """
    Approve and add a pending contact by public key.

    Args:
        public_key: Full public key of the contact to approve (REQUIRED - full key works for all contact types)

    Returns:
        Tuple of (success, message)
    """
    if not public_key or not public_key.strip():
        return False, "Public key is required"

    try:
        response = requests.post(
            f"{config.MC_BRIDGE_URL.replace('/cli', '/add_pending')}",
            json={'selector': public_key.strip()},
            timeout=DEFAULT_TIMEOUT + 5
        )

        if response.status_code != 200:
            return False, f'Bridge HTTP error: {response.status_code}'

        data = response.json()

        if not data.get('success', False):
            error = data.get('stderr', 'Failed to approve contact')
            return False, error

        stdout = data.get('stdout', 'Contact approved successfully')
        return True, stdout

    except requests.exceptions.Timeout:
        return False, 'Bridge timeout'
    except requests.exceptions.ConnectionError:
        return False, 'Cannot connect to meshcore-bridge service'
    except Exception as e:
        return False, str(e)


# =============================================================================
# Device Settings (Persistent Configuration)
# =============================================================================

def get_device_settings() -> Tuple[bool, Dict]:
    """
    Get persistent device settings from .webui_settings.json.

    Returns:
        Tuple of (success, settings_dict)
        Settings dict currently contains:
        {
            'manual_add_contacts': bool
        }
    """
    settings_path = Path(config.MC_CONFIG_DIR) / ".webui_settings.json"

    try:
        if not settings_path.exists():
            # Return defaults if file doesn't exist
            return True, {'manual_add_contacts': False}

        with open(settings_path, 'r', encoding='utf-8') as f:
            settings = json.load(f)
            # Ensure manual_add_contacts exists
            if 'manual_add_contacts' not in settings:
                settings['manual_add_contacts'] = False
            return True, settings

    except Exception as e:
        logger.error(f"Failed to read device settings: {e}")
        return False, {'manual_add_contacts': False}


def set_manual_add_contacts(enabled: bool) -> Tuple[bool, str]:
    """
    Enable or disable manual contact approval mode.

    This setting is:
    1. Saved to .webui_settings.json for persistence across container restarts
    2. Applied immediately to the running meshcli session via bridge

    Args:
        enabled: True to enable manual approval, False for automatic

    Returns:
        Tuple of (success, message)
    """
    try:
        response = requests.post(
            f"{config.MC_BRIDGE_URL.replace('/cli', '/set_manual_add_contacts')}",
            json={'enabled': enabled},
            timeout=DEFAULT_TIMEOUT + 5
        )

        if response.status_code != 200:
            return False, f'Bridge HTTP error: {response.status_code}'

        data = response.json()

        if not data.get('success', False):
            error = data.get('error', 'Failed to set manual_add_contacts')
            return False, error

        message = data.get('message', f"manual_add_contacts set to {'on' if enabled else 'off'}")
        return True, message

    except requests.exceptions.Timeout:
        return False, 'Bridge timeout'
    except requests.exceptions.ConnectionError:
        return False, 'Cannot connect to meshcore-bridge service'
    except Exception as e:
        return False, str(e)
