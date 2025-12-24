"""
Message parser - reads and parses .msgs file (JSON Lines format)
"""

import json
import logging
from pathlib import Path
from typing import List, Dict, Optional
from datetime import datetime, timedelta
from app.config import config

logger = logging.getLogger(__name__)


def parse_message(line: Dict, allowed_channels: Optional[List[int]] = None) -> Optional[Dict]:
    """
    Parse a single message line from .msgs file.

    Args:
        line: Raw JSON object from .msgs file
        allowed_channels: List of channel indices to include (None = all channels)

    Returns:
        Parsed message dict or None if not a valid chat message
    """
    msg_type = line.get('type')
    channel_idx = line.get('channel_idx', 0)

    # Filter by allowed channels
    if allowed_channels is not None and channel_idx not in allowed_channels:
        return None

    # Only process CHAN (received) and SENT_CHAN (sent) messages
    if msg_type not in ['CHAN', 'SENT_CHAN']:
        return None

    timestamp = line.get('timestamp', 0)
    text = line.get('text', '').strip()

    if not text:
        return None

    # Determine if message is sent or received
    is_own = msg_type == 'SENT_CHAN'

    # Extract sender name
    if is_own:
        # For sent messages, use device name from config or 'name' field
        sender = line.get('name', config.MC_DEVICE_NAME)
        content = text
    else:
        # For received messages, extract sender from "SenderName: message" format
        if ':' in text:
            sender, content = text.split(':', 1)
            sender = sender.strip()
            content = content.strip()
        else:
            # Fallback if format is unexpected
            sender = "Unknown"
            content = text

    return {
        'sender': sender,
        'content': content,
        'timestamp': timestamp,
        'datetime': datetime.fromtimestamp(timestamp).isoformat() if timestamp > 0 else None,
        'is_own': is_own,
        'snr': line.get('SNR'),
        'path_len': line.get('path_len'),
        'channel_idx': channel_idx
    }


def read_messages(limit: Optional[int] = None, offset: int = 0, archive_date: Optional[str] = None, days: Optional[int] = None, channel_idx: Optional[int] = None) -> List[Dict]:
    """
    Read and parse messages from .msgs file or archive file.

    Args:
        limit: Maximum number of messages to return (None = all)
        offset: Number of messages to skip from the end
        archive_date: If provided, read from archive file for this date (YYYY-MM-DD)
        days: If provided, filter messages from the last N days (only for live .msgs)
        channel_idx: Filter messages by channel (None = all channels)

    Returns:
        List of parsed message dictionaries, sorted by timestamp (oldest first)
    """
    # If archive_date is provided, read from archive
    if archive_date:
        return read_archive_messages(archive_date, limit, offset, channel_idx)

    msgs_file = config.msgs_file_path

    if not msgs_file.exists():
        logger.warning(f"Messages file not found: {msgs_file}")
        return []

    # Determine allowed channels
    allowed_channels = [channel_idx] if channel_idx is not None else None

    messages = []

    try:
        with open(msgs_file, 'r', encoding='utf-8') as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue

                try:
                    data = json.loads(line)
                    parsed = parse_message(data, allowed_channels=allowed_channels)
                    if parsed:
                        messages.append(parsed)
                except json.JSONDecodeError as e:
                    logger.warning(f"Invalid JSON at line {line_num}: {e}")
                    continue
                except Exception as e:
                    logger.error(f"Error parsing line {line_num}: {e}")
                    continue

    except FileNotFoundError:
        logger.error(f"Messages file not found: {msgs_file}")
        return []
    except Exception as e:
        logger.error(f"Error reading messages file: {e}")
        return []

    # Sort by timestamp (oldest first)
    messages.sort(key=lambda m: m['timestamp'])

    # Filter by days if specified
    if days is not None and days > 0:
        messages = filter_messages_by_days(messages, days)

    # Apply offset and limit
    if offset > 0:
        messages = messages[:-offset] if offset < len(messages) else []

    if limit is not None and limit > 0:
        messages = messages[-limit:]

    logger.info(f"Loaded {len(messages)} messages from {msgs_file}")
    return messages


def get_latest_message() -> Optional[Dict]:
    """
    Get the most recent message.

    Returns:
        Latest message dict or None if no messages
    """
    messages = read_messages(limit=1)
    return messages[0] if messages else None


def count_messages() -> int:
    """
    Count total number of messages in the file.

    Returns:
        Message count
    """
    return len(read_messages())


def read_archive_messages(archive_date: str, limit: Optional[int] = None, offset: int = 0, channel_idx: Optional[int] = None) -> List[Dict]:
    """
    Read messages from an archive file.

    Args:
        archive_date: Archive date in YYYY-MM-DD format
        limit: Maximum number of messages to return (None = all)
        offset: Number of messages to skip from the end
        channel_idx: Filter messages by channel (None = all channels)

    Returns:
        List of parsed message dictionaries, sorted by timestamp (oldest first)
    """
    from app.archiver.manager import get_archive_path

    archive_file = get_archive_path(archive_date)

    if not archive_file.exists():
        logger.warning(f"Archive file not found: {archive_file}")
        return []

    # Determine allowed channels
    allowed_channels = [channel_idx] if channel_idx is not None else None

    messages = []

    try:
        with open(archive_file, 'r', encoding='utf-8') as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue

                try:
                    data = json.loads(line)
                    parsed = parse_message(data, allowed_channels=allowed_channels)
                    if parsed:
                        messages.append(parsed)
                except json.JSONDecodeError as e:
                    logger.warning(f"Invalid JSON at line {line_num} in archive: {e}")
                    continue
                except Exception as e:
                    logger.error(f"Error parsing line {line_num} in archive: {e}")
                    continue

    except FileNotFoundError:
        logger.error(f"Archive file not found: {archive_file}")
        return []
    except Exception as e:
        logger.error(f"Error reading archive file: {e}")
        return []

    # Sort by timestamp (oldest first)
    messages.sort(key=lambda m: m['timestamp'])

    # Apply offset and limit
    if offset > 0:
        messages = messages[:-offset] if offset < len(messages) else []

    if limit is not None and limit > 0:
        messages = messages[-limit:]

    logger.info(f"Loaded {len(messages)} messages from archive {archive_date}")
    return messages


def filter_messages_by_days(messages: List[Dict], days: int) -> List[Dict]:
    """
    Filter messages to include only those from the last N days.

    Args:
        messages: List of message dicts
        days: Number of days to include (from now)

    Returns:
        Filtered list of messages
    """
    if not messages:
        return []

    # Calculate cutoff timestamp
    cutoff_date = datetime.now() - timedelta(days=days)
    cutoff_timestamp = cutoff_date.timestamp()

    # Filter messages
    filtered = [msg for msg in messages if msg['timestamp'] >= cutoff_timestamp]

    logger.info(f"Filtered {len(filtered)} messages from last {days} days (out of {len(messages)} total)")
    return filtered


def delete_channel_messages(channel_idx: int) -> bool:
    """
    Delete all messages for a specific channel from the .msgs file.

    Args:
        channel_idx: Channel index to delete messages from

    Returns:
        True if successful, False otherwise
    """
    msgs_file = config.msgs_file_path

    if not msgs_file.exists():
        logger.warning(f"Messages file not found: {msgs_file}")
        return True  # No messages to delete

    try:
        # Read all lines
        lines_to_keep = []
        deleted_count = 0

        with open(msgs_file, 'r', encoding='utf-8') as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue

                try:
                    data = json.loads(line)
                    # Keep messages from other channels
                    if data.get('channel_idx', 0) != channel_idx:
                        lines_to_keep.append(line)
                    else:
                        deleted_count += 1
                except json.JSONDecodeError as e:
                    # Keep malformed lines (don't delete them)
                    logger.warning(f"Invalid JSON at line {line_num}, keeping: {e}")
                    lines_to_keep.append(line)

        # Write back the filtered lines
        with open(msgs_file, 'w', encoding='utf-8') as f:
            for line in lines_to_keep:
                f.write(line + '\n')

        logger.info(f"Deleted {deleted_count} messages from channel {channel_idx}")
        return True

    except Exception as e:
        logger.error(f"Error deleting channel messages: {e}")
        return False
