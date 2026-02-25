"""
Message parser - reads and parses .msgs file (JSON Lines format)
Supports channel messages (CHAN, SENT_CHAN) and direct messages (PRIV, SENT_MSG)
"""

import json
import logging
import time
from pathlib import Path
from typing import List, Dict, Optional, Tuple
from datetime import datetime, timedelta
from app.config import config, runtime_config

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
    raw_text = line.get('text', '')
    text = raw_text.strip()

    if not text:
        return None

    # Determine if message is sent or received
    is_own = msg_type == 'SENT_CHAN'

    # Extract sender name
    if is_own:
        # For sent messages, use 'sender' field (meshcore-cli 1.3.12+)
        sender = line.get('sender', runtime_config.get_device_name())
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
        'channel_idx': channel_idx,
        'sender_timestamp': line.get('sender_timestamp'),
        'txt_type': line.get('txt_type', 0),
        'raw_text': raw_text
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

    msgs_file = runtime_config.get_msgs_file_path()

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
    msgs_file = runtime_config.get_msgs_file_path()

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


# =============================================================================
# Direct Messages (DM) Parsing
# =============================================================================
#
# Requires meshcore-cli >= 1.3.12 for correct SENT_MSG format with recipient field.
#
# Message types:
# - PRIV: Incoming private messages (from others to us)
# - SENT_MSG: Outgoing private messages (from us to others) - txt_type=0 for DM
# =============================================================================

# Global flag to track if cleanup has been performed
_dm_cleanup_done = False


def _cleanup_old_dm_sent_log() -> None:
    """
    Clean up the old _dm_sent.jsonl file that was used as a workaround
    for meshcore-cli 1.3.11 bug. This file is no longer needed with 1.3.12+.

    This function is called once at the first read_dm_messages() invocation.
    """
    global _dm_cleanup_done

    if _dm_cleanup_done:
        return

    try:
        dm_log_file = Path(config.MC_CONFIG_DIR) / f"{runtime_config.get_device_name()}_dm_sent.jsonl"
        if dm_log_file.exists():
            dm_log_file.unlink()
            logger.info(f"Cleaned up old DM sent log: {dm_log_file}")
    except Exception as e:
        logger.warning(f"Could not clean up old DM sent log: {e}")
    finally:
        _dm_cleanup_done = True


def _parse_priv_message(line: Dict) -> Optional[Dict]:
    """
    Parse incoming private message (PRIV type).

    Args:
        line: Raw JSON object from .msgs file with type='PRIV'

    Returns:
        Parsed DM dict or None if invalid
    """
    text = line.get('text', '').strip()
    if not text:
        return None

    timestamp = line.get('timestamp', 0)
    pubkey_prefix = line.get('pubkey_prefix', '')
    sender = line.get('name', 'Unknown')
    sender_timestamp = line.get('sender_timestamp', 0)

    # Generate conversation ID - prefer pubkey_prefix if available
    if pubkey_prefix:
        conversation_id = f"pk_{pubkey_prefix}"
    else:
        conversation_id = f"name_{sender}"

    # Generate deduplication key
    text_hash = hash(text[:50]) & 0xFFFFFFFF  # 32-bit positive hash
    dedup_key = f"priv_{pubkey_prefix}_{sender_timestamp}_{text_hash}"

    return {
        'type': 'dm',
        'direction': 'incoming',
        'sender': sender,
        'content': text,
        'timestamp': timestamp,
        'sender_timestamp': sender_timestamp,
        'datetime': datetime.fromtimestamp(timestamp).isoformat() if timestamp > 0 else None,
        'is_own': False,
        'snr': line.get('SNR'),
        'path_len': line.get('path_len'),
        'pubkey_prefix': pubkey_prefix,
        'txt_type': line.get('txt_type', 0),
        'conversation_id': conversation_id,
        'dedup_key': dedup_key
    }


def _parse_sent_msg(line: Dict) -> Optional[Dict]:
    """
    Parse outgoing private message (SENT_MSG type) from meshcore-cli 1.3.12+.

    This function parses SENT_MSG entries from the .msgs file. As of meshcore-cli 1.3.12,
    these entries now correctly include both 'recipient' and 'sender' fields.

    Args:
        line: Raw JSON object from .msgs file with type='SENT_MSG'

    Returns:
        Parsed DM dict or None if invalid or not a private message
    """
    text = line.get('text', '').strip()
    if not text:
        return None

    # Check txt_type - only process private messages (0), not channel messages (1)
    txt_type = line.get('txt_type', 0)
    if txt_type != 0:
        return None

    timestamp = line.get('timestamp', 0)
    # Use 'recipient' field (added in meshcore-cli 1.3.12), fallback to 'name'
    recipient = line.get('recipient', line.get('name', 'Unknown'))
    sender = line.get('sender', runtime_config.get_device_name())

    # Generate conversation ID from recipient name
    conversation_id = f"name_{recipient}"

    # Deduplication key
    text_hash = hash(text[:50]) & 0xFFFFFFFF
    dedup_key = f"sent_{timestamp}_{text_hash}"

    return {
        'type': 'dm',
        'direction': 'outgoing',
        'recipient': recipient,
        'sender': sender,
        'content': text,
        'timestamp': timestamp,
        'datetime': datetime.fromtimestamp(timestamp).isoformat() if timestamp > 0 else None,
        'is_own': True,
        'txt_type': txt_type,
        'conversation_id': conversation_id,
        'dedup_key': dedup_key,
        'expected_ack': line.get('expected_ack'),
    }


def read_dm_messages(
    limit: Optional[int] = None,
    conversation_id: Optional[str] = None,
    days: Optional[int] = 7
) -> Tuple[List[Dict], Dict[str, str]]:
    """
    Read and parse DM messages from .msgs file (both incoming PRIV and outgoing SENT_MSG).

    Requires meshcore-cli >= 1.3.12 for correct SENT_MSG format with recipient field.

    Args:
        limit: Maximum messages to return (None = all)
        conversation_id: Filter by specific conversation (None = all)
        days: Filter to last N days (None = no filter)

    Returns:
        Tuple of (messages_list, pubkey_to_name_mapping)
        The mapping helps correlate outgoing messages (name only) with incoming (pubkey)
    """
    messages = []
    seen_dedup_keys = set()
    pubkey_to_name = {}  # Map pubkey_prefix -> most recent name

    # Clean up old DM sent log file (once per session)
    _cleanup_old_dm_sent_log()

    # --- Read DM messages from .msgs file ---
    msgs_file = runtime_config.get_msgs_file_path()
    if msgs_file.exists():
        try:
            with open(msgs_file, 'r', encoding='utf-8') as f:
                for line_num, line in enumerate(f, 1):
                    line = line.strip()
                    if not line:
                        continue

                    try:
                        data = json.loads(line)
                        msg_type = data.get('type')

                        # Process PRIV (incoming) and SENT_MSG (outgoing) messages
                        if msg_type == 'PRIV':
                            parsed = _parse_priv_message(data)
                        elif msg_type == 'SENT_MSG':
                            parsed = _parse_sent_msg(data)
                        else:
                            continue  # Ignore other message types

                        if not parsed:
                            continue

                        # Update pubkey->name mapping (only for PRIV messages)
                        if msg_type == 'PRIV' and parsed.get('pubkey_prefix'):
                            pubkey_to_name[parsed['pubkey_prefix']] = parsed['sender']

                        # Deduplicate
                        if parsed['dedup_key'] in seen_dedup_keys:
                            continue
                        seen_dedup_keys.add(parsed['dedup_key'])

                        messages.append(parsed)

                    except json.JSONDecodeError as e:
                        logger.warning(f"Invalid JSON at line {line_num}: {e}")
                        continue
                    except Exception as e:
                        logger.error(f"Error parsing message at line {line_num}: {e}")
                        continue

        except Exception as e:
            logger.error(f"Error reading messages file: {e}")

    # --- Filter by conversation if specified ---
    if conversation_id:
        filtered_messages = []
        for msg in messages:
            if msg['conversation_id'] == conversation_id:
                filtered_messages.append(msg)
            else:
                # Check if it matches via pubkey->name mapping
                if conversation_id.startswith('pk_'):
                    pk = conversation_id[3:]
                    name = pubkey_to_name.get(pk)
                    if name and msg['conversation_id'] == f"name_{name}":
                        filtered_messages.append(msg)
                elif conversation_id.startswith('name_'):
                    name = conversation_id[5:]
                    # Check if any pubkey maps to this name
                    for pk, n in pubkey_to_name.items():
                        if n == name and msg['conversation_id'] == f"pk_{pk}":
                            filtered_messages.append(msg)
                            break
        messages = filtered_messages

    # Sort by timestamp (oldest first)
    messages.sort(key=lambda m: m['timestamp'])

    # Filter by days if specified
    if days is not None and days > 0:
        cutoff_timestamp = (datetime.now() - timedelta(days=days)).timestamp()
        messages = [m for m in messages if m['timestamp'] >= cutoff_timestamp]

    # Apply limit (return most recent)
    if limit is not None and limit > 0:
        messages = messages[-limit:]

    logger.info(f"Loaded {len(messages)} DM messages")
    return messages, pubkey_to_name


def dedup_retry_messages(messages: List[Dict], window_seconds: int = 300) -> List[Dict]:
    """Collapse outgoing messages with same text+recipient within a time window.

    Auto-retry sends multiple SENT_MSG entries for the same message.
    This keeps only the first occurrence and drops duplicates within the window.
    """
    deduped = []
    seen_outgoing = {}  # (recipient, text) -> earliest timestamp
    for msg in messages:
        if msg.get('direction') == 'outgoing':
            key = (msg.get('recipient', ''), msg.get('content', ''))
            ts = msg.get('timestamp', 0)
            prev_ts = seen_outgoing.get(key)
            if prev_ts is not None and abs(ts - prev_ts) <= window_seconds:
                continue
            seen_outgoing[key] = ts
        deduped.append(msg)
    return deduped


def get_dm_conversations(days: Optional[int] = 7) -> List[Dict]:
    """
    Get list of DM conversations with metadata.

    Args:
        days: Filter to last N days (None = no filter)

    Returns:
        List of conversation dicts sorted by most recent activity:
        [
            {
                'conversation_id': str,
                'display_name': str,
                'pubkey_prefix': str or None,
                'last_message_timestamp': int,
                'last_message_preview': str,
                'unread_count': int,  # Always 0 here, frontend tracks unread
                'message_count': int
            }
        ]
    """
    messages, pubkey_to_name = read_dm_messages(days=days)

    messages = dedup_retry_messages(messages)

    # Build reverse mapping: name -> pubkey_prefix
    name_to_pubkey = {name: pk for pk, name in pubkey_to_name.items()}

    # Group messages by conversation
    # Use canonical conversation_id: prefer pk_ if we know the pubkey for this name
    conversations = {}

    def get_canonical_conv_id(msg):
        """Get canonical conversation ID, preferring pubkey-based IDs."""
        conv_id = msg['conversation_id']

        if conv_id.startswith('pk_'):
            return conv_id

        # For name-based IDs, check if we have a pubkey mapping
        if conv_id.startswith('name_'):
            name = conv_id[5:]
            pk = name_to_pubkey.get(name)
            if pk:
                return f"pk_{pk}"

        return conv_id

    for msg in messages:
        conv_id = get_canonical_conv_id(msg)

        if conv_id not in conversations:
            conversations[conv_id] = {
                'conversation_id': conv_id,
                'display_name': '',
                'pubkey_prefix': None,
                'last_message_timestamp': 0,
                'last_message_preview': '',
                'unread_count': 0,
                'message_count': 0
            }

        conv = conversations[conv_id]
        conv['message_count'] += 1

        # Update display name
        if msg['direction'] == 'incoming':
            conv['display_name'] = msg['sender']
            if msg.get('pubkey_prefix'):
                conv['pubkey_prefix'] = msg['pubkey_prefix']
        elif msg['direction'] == 'outgoing' and not conv['display_name']:
            conv['display_name'] = msg.get('recipient', 'Unknown')

        # Update last message info
        if msg['timestamp'] > conv['last_message_timestamp']:
            conv['last_message_timestamp'] = msg['timestamp']
            preview = msg['content'][:50]
            if len(msg['content']) > 50:
                preview += '...'
            if msg['is_own']:
                preview = f"You: {preview}"
            conv['last_message_preview'] = preview

    # Convert to list and sort by most recent
    result = list(conversations.values())
    result.sort(key=lambda c: c['last_message_timestamp'], reverse=True)

    logger.info(f"Found {len(result)} DM conversations")
    return result
