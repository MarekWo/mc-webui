"""
REST API endpoints for mc-webui
"""

import logging
from flask import Blueprint, jsonify, request
from app.meshcore import cli, parser
from app.config import config

logger = logging.getLogger(__name__)

api_bp = Blueprint('api', __name__, url_prefix='/api')


@api_bp.route('/messages', methods=['GET'])
def get_messages():
    """
    Get list of messages from Public channel.

    Query parameters:
        limit (int): Maximum number of messages to return
        offset (int): Number of messages to skip from the end

    Returns:
        JSON with messages list
    """
    try:
        limit = request.args.get('limit', type=int)
        offset = request.args.get('offset', default=0, type=int)

        messages = parser.read_messages(limit=limit, offset=offset)

        return jsonify({
            'success': True,
            'count': len(messages),
            'messages': messages
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
    Send a message to the Public channel.

    JSON body:
        text (str): Message content (required)
        reply_to (str): Username to reply to (optional)

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
        if len(text) > 200:
            return jsonify({
                'success': False,
                'error': f'Message too long ({len(text)} chars). Maximum 200 characters allowed due to LoRa constraints.'
            }), 400

        reply_to = data.get('reply_to')

        # Send message via meshcli
        success, message = cli.send_message(text, reply_to=reply_to)

        if success:
            return jsonify({
                'success': True,
                'message': 'Message sent successfully'
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
