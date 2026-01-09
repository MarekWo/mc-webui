"""
mc-webui - Flask application entry point
"""

import logging
import re
import shlex
import requests
from flask import Flask, request as flask_request
from flask_socketio import SocketIO, emit
from app.config import config
from app.routes.views import views_bp
from app.routes.api import api_bp
from app.archiver.manager import schedule_daily_archiving

# Commands that require longer timeout (in seconds)
SLOW_COMMANDS = {
    'node_discover': 15,
    'recv': 60,
    'send': 15,
    'send_msg': 15,
}

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
# Console output helpers
# ============================================================

def clean_console_output(output: str, command: str) -> str:
    """
    Clean meshcli console output by removing:
    - Prompt lines (e.g., "MarWoj|*" or "DeviceName|*[N]")
    - Echoed command line
    - Leading/trailing whitespace
    """
    if not output:
        return output

    lines = output.split('\n')
    cleaned_lines = []

    # Pattern to match prompt: <name>|*[optional] or <name>|*
    # Examples: "MarWoj|*", "MarWoj|*[3]", "Device Name|*"
    prompt_pattern = re.compile(r'^.+\|\*(\[\d+\])?\s*$')

    # Pattern to match prompt followed by command echo
    # Example: "MarWoj|* contacts" or "MarWoj|*[3] get_radio"
    prompt_cmd_pattern = re.compile(r'^.+\|\*(\[\d+\])?\s+\S+')

    for line in lines:
        stripped = line.rstrip()

        # Skip empty lines at start
        if not cleaned_lines and not stripped:
            continue

        # Skip lines that are just the prompt
        if prompt_pattern.match(stripped):
            continue

        # Skip lines that are prompt + echoed command
        if prompt_cmd_pattern.match(stripped):
            # Check if this line is just echoing the command
            # Extract the part after the prompt
            match = re.match(r'^.+\|\*(\[\d+\])?\s+(.+)$', stripped)
            if match:
                echoed_part = match.group(2).strip()
                if echoed_part == command.strip():
                    continue

        cleaned_lines.append(line)

    # Remove leading empty lines
    while cleaned_lines and not cleaned_lines[0].strip():
        cleaned_lines.pop(0)

    # Remove trailing empty lines
    while cleaned_lines and not cleaned_lines[-1].strip():
        cleaned_lines.pop()

    return '\n'.join(cleaned_lines)


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
    # Parse command into args list (split by spaces, respecting quotes)
    try:
        args = shlex.split(command)
    except ValueError:
        args = command.split()

    # Determine timeout based on command
    base_command = args[0] if args else ''
    cmd_timeout = SLOW_COMMANDS.get(base_command, 10)

    def execute_and_respond():
        try:
            response = requests.post(
                config.MC_BRIDGE_URL,
                json={'args': args, 'timeout': cmd_timeout},
                timeout=cmd_timeout + 5  # HTTP timeout slightly longer
            )

            if response.status_code == 200:
                result = response.json()
                if result.get('success'):
                    raw_output = result.get('stdout', '')
                    # Clean output: remove prompts and echoed commands
                    output = clean_console_output(raw_output, command)
                    if not output:
                        output = '(no output)'
                    socketio.emit('command_response', {
                        'success': True,
                        'command': command,
                        'output': output
                    }, room=sid, namespace='/console')
                else:
                    error = result.get('stderr', 'Unknown error')
                    socketio.emit('command_response', {
                        'success': False,
                        'command': command,
                        'error': error
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
