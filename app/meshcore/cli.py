"""
MeshCore CLI wrapper - executes meshcli commands via subprocess
"""

import subprocess
import logging
import re
from typing import Tuple, Optional, List, Dict
from app.config import config

logger = logging.getLogger(__name__)

# Command timeout in seconds
DEFAULT_TIMEOUT = 30
RECV_TIMEOUT = 60  # recv can take longer


class MeshCLIError(Exception):
    """Custom exception for meshcli command failures"""
    pass


def _run_command(args: list, timeout: int = DEFAULT_TIMEOUT) -> Tuple[bool, str, str]:
    """
    Execute a meshcli command and return result.

    Args:
        args: Command arguments (will be prepended with meshcli -s <port>)
        timeout: Command timeout in seconds

    Returns:
        Tuple of (success, stdout, stderr)
    """
    cmd = config.meshcli_command + args
    logger.info(f"Executing: {' '.join(cmd)}")

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False
        )

        success = result.returncode == 0
        stdout = result.stdout.strip()
        stderr = result.stderr.strip()

        if not success:
            logger.warning(f"Command failed: {stderr or stdout}")

        return success, stdout, stderr

    except subprocess.TimeoutExpired:
        logger.error(f"Command timeout after {timeout}s: {' '.join(cmd)}")
        return False, "", f"Command timeout after {timeout}s"

    except FileNotFoundError:
        logger.error("meshcli command not found")
        return False, "", "meshcli not found - is meshcore-cli installed?"

    except Exception as e:
        logger.error(f"Unexpected error: {e}")
        return False, "", str(e)


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

    if channel_index == 0:
        # Public channel - backward compatibility
        success, stdout, stderr = _run_command(['public', message])
    else:
        # Other channels - use 'chan' command
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


def set_channel(index: int, name: str, key: str) -> Tuple[bool, str]:
    """
    Set/join a channel at specific index with name and key.

    Args:
        index: Channel slot number
        name: Channel name
        key: 32-char hex key

    Returns:
        Tuple of (success, message)
    """
    # Validate key format
    if not re.match(r'^[a-f0-9]{32}$', key.lower()):
        return False, "Invalid key format (must be 32 hex characters)"

    success, stdout, stderr = _run_command([
        'set_channel',
        str(index),
        name,
        key.lower()
    ])

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
