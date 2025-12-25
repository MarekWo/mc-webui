"""
REST API endpoints for mc-webui
"""

import logging
import json
import re
import base64
import time
from datetime import datetime
from io import BytesIO
from flask import Blueprint, jsonify, request, send_file
from app.meshcore import cli, parser
from app.config import config
from app.archiver import manager as archive_manager

logger = logging.getLogger(__name__)

api_bp = Blueprint('api', __name__, url_prefix='/api')

# Simple cache for get_channels() to reduce USB/meshcli calls
# Channels don't change frequently, so caching for 30s is safe
_channels_cache = None
_channels_cache_timestamp = 0
CHANNELS_CACHE_TTL = 30  # seconds


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

        # Read messages (from archive or live .msgs file)
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

        # Get message count
        message_count = parser.count_messages()

        # Get latest message timestamp
        latest = parser.get_latest_message()
        latest_timestamp = latest['timestamp'] if latest else None

        return jsonify({
            'success': True,
            'connected': connected,
            'device_name': config.MC_DEVICE_NAME,
            'serial_port': config.MC_SERIAL_PORT,
            'message_count': message_count,
            'latest_message_timestamp': latest_timestamp,
            'refresh_interval': config.MC_REFRESH_INTERVAL
        }), 200

    except Exception as e:
        logger.error(f"Error getting status: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


@api_bp.route('/contacts/cleanup', methods=['POST'])
def cleanup_contacts():
    """
    Clean up inactive contacts.

    JSON body:
        hours (int): Inactivity threshold in hours (optional, default from config)

    Returns:
        JSON with cleanup result
    """
    try:
        data = request.get_json() or {}
        hours = data.get('hours', config.MC_INACTIVE_HOURS)

        if not isinstance(hours, int) or hours < 1:
            return jsonify({
                'success': False,
                'error': 'Invalid hours value (must be positive integer)'
            }), 400

        # Execute cleanup command
        success, message = cli.clean_inactive_contacts(hours)

        if success:
            return jsonify({
                'success': True,
                'message': f'Cleanup completed: {message}',
                'hours': hours
            }), 200
        else:
            return jsonify({
                'success': False,
                'error': message
            }), 500

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
        command (str): Command name (required) - one of: advert, floodadv

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
            return jsonify({
                'success': True,
                'command': command,
                'message': message or f'{command} executed successfully'
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
    Get list of available message archives.

    Returns:
        JSON with list of archives, each with:
        - date (str): Archive date in YYYY-MM-DD format
        - message_count (int): Number of messages in archive
        - file_size (int): Archive file size in bytes
    """
    try:
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
            return jsonify({
                'success': True,
                'message': message,
                'channel': {
                    'name': name,
                    'key': key
                }
            }), 201
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
            # Find first free slot (1-7, skip 0 which is Public)
            success_ch, channels = get_channels_cached()
            if not success_ch:
                return jsonify({
                    'success': False,
                    'error': 'Failed to get current channels'
                }), 500

            used_indices = {ch['index'] for ch in channels}
            index = None
            for i in range(1, 8):  # Assume max 8 channels
                if i not in used_indices:
                    index = i
                    break

            if index is None:
                return jsonify({
                    'success': False,
                    'error': 'No free channel slots available'
                }), 400

        success, message = cli.set_channel(index, name, key)

        if success:
            invalidate_channels_cache()  # Clear cache to force refresh
            return jsonify({
                'success': True,
                'message': f'Joined channel "{name}" at slot {index}',
                'channel': {
                    'index': index,
                    'name': name,
                    'key': key if key else 'auto-generated'
                }
            }), 200
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

        updates = []
        total_unread = 0

        # Check each channel for new messages
        for channel in channels:
            channel_idx = channel['index']

            # Get latest message for this channel
            messages = parser.read_messages(
                limit=1,
                channel_idx=channel_idx,
                days=7  # Only check recent messages
            )

            latest_timestamp = 0
            if messages and len(messages) > 0:
                latest_timestamp = messages[0]['timestamp']

            # Check if there are updates
            last_seen_ts = last_seen.get(channel_idx, 0)
            has_updates = latest_timestamp > last_seen_ts

            # Count unread messages (messages newer than last_seen)
            unread_count = 0
            if has_updates:
                all_messages = parser.read_messages(
                    limit=500,
                    channel_idx=channel_idx,
                    days=7
                )
                unread_count = sum(1 for msg in all_messages if msg['timestamp'] > last_seen_ts)
                total_unread += unread_count

            updates.append({
                'index': channel_idx,
                'name': channel['name'],
                'has_updates': has_updates,
                'latest_timestamp': latest_timestamp,
                'unread_count': unread_count
            })

        return jsonify({
            'success': True,
            'channels': updates,
            'total_unread': total_unread
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

        messages, pubkey_to_name = parser.read_dm_messages(
            limit=limit,
            conversation_id=conversation_id,
            days=days
        )

        # Determine display name from conversation_id or messages
        display_name = 'Unknown'
        if conversation_id.startswith('pk_'):
            pk = conversation_id[3:]
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

        # Get all conversations
        conversations = parser.get_dm_conversations(days=7)

        updates = []
        total_unread = 0

        for conv in conversations:
            conv_id = conv['conversation_id']
            last_seen_ts = last_seen.get(conv_id, 0)

            # Count unread
            if conv['last_message_timestamp'] > last_seen_ts:
                # Need to count actual unread messages
                messages, _ = parser.read_dm_messages(
                    conversation_id=conv_id,
                    days=7
                )
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
