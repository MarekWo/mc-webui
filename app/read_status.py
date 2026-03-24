"""
Read Status Manager - DB-backed storage for message read status

Manages the last seen timestamps for channels and DM conversations,
providing cross-device synchronization for unread message tracking.
All data is stored in the read_status table of the SQLite database.
"""

import logging
from flask import current_app

logger = logging.getLogger(__name__)


def _get_db():
    """Get database instance from Flask app context."""
    return getattr(current_app, 'db', None)


def load_read_status():
    """Load read status from database.

    Returns:
        dict: Read status with 'channels', 'dm', and 'muted_channels' keys
    """
    try:
        db = _get_db()
        rows = db.get_read_status()

        channels = {}
        dm = {}
        muted_channels = []

        for key, row in rows.items():
            if key.startswith('chan_'):
                chan_idx = key[5:]  # "chan_0" -> "0"
                channels[chan_idx] = row['last_seen_ts']
                if row.get('is_muted'):
                    try:
                        muted_channels.append(int(chan_idx))
                    except ValueError:
                        pass
            elif key.startswith('dm_'):
                conv_id = key[3:]  # "dm_name_User1" -> "name_User1"
                dm[conv_id] = row['last_seen_ts']

        return {
            'channels': channels,
            'dm': dm,
            'muted_channels': muted_channels,
        }

    except Exception as e:
        logger.error(f"Error loading read status: {e}")
        return {'channels': {}, 'dm': {}, 'muted_channels': []}


def save_read_status(status):
    """No-op — data is written per-operation via mark_* functions."""
    return True


def mark_channel_read(channel_idx, timestamp):
    """Mark a channel as read up to a specific timestamp."""
    try:
        db = _get_db()
        db.mark_read(f"chan_{channel_idx}", int(timestamp))
        logger.debug(f"Marked channel {channel_idx} as read at timestamp {timestamp}")
        return True
    except Exception as e:
        logger.error(f"Error marking channel {channel_idx} as read: {e}")
        return False


def mark_dm_read(conversation_id, timestamp):
    """Mark a DM conversation as read up to a specific timestamp."""
    try:
        db = _get_db()
        db.mark_read(f"dm_{conversation_id}", int(timestamp))
        logger.debug(f"Marked DM conversation {conversation_id} as read at timestamp {timestamp}")
        return True
    except Exception as e:
        logger.error(f"Error marking DM conversation {conversation_id} as read: {e}")
        return False


def get_channel_last_seen(channel_idx):
    """Get last seen timestamp for a specific channel."""
    try:
        status = load_read_status()
        return status['channels'].get(str(channel_idx), 0)
    except Exception as e:
        logger.error(f"Error getting last seen for channel {channel_idx}: {e}")
        return 0


def get_dm_last_seen(conversation_id):
    """Get last seen timestamp for a specific DM conversation."""
    try:
        status = load_read_status()
        return status['dm'].get(conversation_id, 0)
    except Exception as e:
        logger.error(f"Error getting last seen for DM {conversation_id}: {e}")
        return 0


def get_muted_channels():
    """Get list of muted channel indices."""
    try:
        db = _get_db()
        return db.get_muted_channels()
    except Exception as e:
        logger.error(f"Error getting muted channels: {e}")
        return []


def set_channel_muted(channel_idx, muted):
    """Set mute state for a channel."""
    try:
        db = _get_db()
        db.set_channel_muted(int(channel_idx), muted)
        logger.info(f"Channel {channel_idx} {'muted' if muted else 'unmuted'}")
        return True
    except Exception as e:
        logger.error(f"Error setting mute for channel {channel_idx}: {e}")
        return False


def mark_all_channels_read(channel_timestamps):
    """Mark all channels as read in bulk.

    Args:
        channel_timestamps (dict): {"0": timestamp, "1": timestamp, ...}
    """
    try:
        db = _get_db()
        for channel_key, timestamp in channel_timestamps.items():
            db.mark_read(f"chan_{channel_key}", int(timestamp))
        logger.info(f"Marked {len(channel_timestamps)} channels as read")
        return True
    except Exception as e:
        logger.error(f"Error marking all channels as read: {e}")
        return False
