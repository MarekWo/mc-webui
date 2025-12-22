"""
REST API endpoints for mc-webui
"""

import logging
import json
import re
import base64
from datetime import datetime
from io import BytesIO
from flask import Blueprint, jsonify, request, send_file
from app.meshcore import cli, parser
from app.config import config
from app.archiver import manager as archive_manager

logger = logging.getLogger(__name__)

api_bp = Blueprint('api', __name__, url_prefix='/api')


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
    Get list of configured channels.

    Returns:
        JSON with channels list
    """
    try:
        success, channels = cli.get_channels()

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
        key (str): 32-char hex key (required)
        index (int): Channel slot (optional, auto-detect if not provided)

    Returns:
        JSON with result
    """
    try:
        data = request.get_json()

        if not data or 'name' not in data or 'key' not in data:
            return jsonify({
                'success': False,
                'error': 'Missing required fields: name, key'
            }), 400

        name = data['name'].strip()
        key = data['key'].strip().lower()

        # Auto-detect free slot if not provided
        if 'index' in data:
            index = int(data['index'])
        else:
            # Find first free slot (1-7, skip 0 which is Public)
            success_ch, channels = cli.get_channels()
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
            return jsonify({
                'success': True,
                'message': f'Joined channel "{name}" at slot {index}',
                'channel': {
                    'index': index,
                    'name': name,
                    'key': key
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
    Remove a channel.

    Args:
        index: Channel index to remove

    Returns:
        JSON with result
    """
    try:
        success, message = cli.remove_channel(index)

        if success:
            return jsonify({
                'success': True,
                'message': f'Channel {index} removed'
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
