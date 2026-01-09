"""
mc-webui - Flask application entry point
"""

import logging
import requests
from flask import Flask, request as flask_request
from flask_socketio import SocketIO, emit
from app.config import config
from app.routes.views import views_bp
from app.routes.api import api_bp
from app.archiver.manager import schedule_daily_archiving

# Configure logging
logging.basicConfig(
    level=logging.DEBUG if config.FLASK_DEBUG else logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

logger = logging.getLogger(__name__)

# Initialize SocketIO globally
socketio = SocketIO()


def create_app():
    """Create and configure Flask application"""
    app = Flask(__name__)

    # Load configuration
    app.config['DEBUG'] = config.FLASK_DEBUG
    app.config['SECRET_KEY'] = 'mc-webui-secret-key-change-in-production'

    # Register blueprints
    app.register_blueprint(views_bp)
    app.register_blueprint(api_bp)

    # Initialize SocketIO with the app
    socketio.init_app(app, cors_allowed_origins="*", async_mode='gevent')

    # Initialize archive scheduler if enabled
    if config.MC_ARCHIVE_ENABLED:
        schedule_daily_archiving()
        logger.info(f"Archive scheduler enabled - directory: {config.MC_ARCHIVE_DIR}")
    else:
        logger.info("Archive scheduler disabled")

    logger.info(f"mc-webui started - device: {config.MC_DEVICE_NAME}")
    logger.info(f"Messages file: {config.msgs_file_path}")
    logger.info(f"Serial port: {config.MC_SERIAL_PORT}")

    return app


# ============================================================
# WebSocket handlers for Console
# ============================================================

@socketio.on('connect', namespace='/console')
def handle_console_connect():
    """Handle console WebSocket connection"""
    logger.info("Console WebSocket client connected")
    emit('console_status', {'message': 'Connected to mc-webui console proxy'})


@socketio.on('disconnect', namespace='/console')
def handle_console_disconnect():
    """Handle console WebSocket disconnection"""
    logger.info("Console WebSocket client disconnected")


@socketio.on('send_command', namespace='/console')
def handle_send_command(data):
    """Handle command from console client - proxy to bridge via HTTP"""
    command = data.get('command', '').strip()
    # Capture socket ID for use in background task
    sid = flask_request.sid

    if not command:
        emit('command_response', {
            'success': False,
            'error': 'Empty command'
        })
        return

    logger.info(f"Console command received: {command}")

    # Execute command via bridge HTTP API
    def execute_and_respond():
        try:
            response = requests.post(
                config.MC_BRIDGE_URL,
                json={'command': command},
                timeout=30
            )

            if response.status_code == 200:
                result = response.json()
                output = result.get('output', '')
                # Handle list output (join with newlines)
                if isinstance(output, list):
                    output = '\n'.join(output)
                socketio.emit('command_response', {
                    'success': True,
                    'command': command,
                    'output': output
                }, room=sid, namespace='/console')
            else:
                socketio.emit('command_response', {
                    'success': False,
                    'command': command,
                    'error': f'Bridge returned status {response.status_code}'
                }, room=sid, namespace='/console')

        except requests.exceptions.Timeout:
            socketio.emit('command_response', {
                'success': False,
                'command': command,
                'error': 'Command timed out'
            }, room=sid, namespace='/console')
        except requests.exceptions.ConnectionError:
            socketio.emit('command_response', {
                'success': False,
                'command': command,
                'error': 'Cannot connect to meshcore-bridge'
            }, room=sid, namespace='/console')
        except Exception as e:
            logger.error(f"Console command error: {e}")
            socketio.emit('command_response', {
                'success': False,
                'command': command,
                'error': str(e)
            }, room=sid, namespace='/console')

    # Run in background to not block
    socketio.start_background_task(execute_and_respond)


if __name__ == '__main__':
    app = create_app()
    socketio.run(
        app,
        host=config.FLASK_HOST,
        port=config.FLASK_PORT,
        debug=config.FLASK_DEBUG
    )
