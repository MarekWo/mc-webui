"""
mc-webui - Flask application entry point
"""

import logging
import re
import shlex
import threading
import time
import requests
from flask import Flask, request as flask_request
from flask_socketio import SocketIO, emit
from app.config import config, runtime_config
from app.routes.views import views_bp
from app.routes.api import api_bp
from app.version import VERSION_STRING, GIT_BRANCH
from app.archiver.manager import schedule_daily_archiving
from app.meshcore.cli import fetch_device_name_from_bridge

# Commands that require longer timeout (in seconds)
SLOW_COMMANDS = {
    'node_discover': 15,
    'recv': 60,
    'send': 15,
    'send_msg': 15,
    # Repeater commands
    'req_status': 15,
    'req_neighbours': 15,
    'trace': 15,
}

# Configure logging
logging.basicConfig(
    level=logging.DEBUG if config.FLASK_DEBUG else logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

logger = logging.getLogger(__name__)


# Filter to suppress known werkzeug WebSocket errors (cosmetic issue with dev server)
class WerkzeugWebSocketFilter(logging.Filter):
    def filter(self, record):
        # Suppress "write() before start_response" errors during WebSocket upgrade
        if record.levelno == logging.ERROR:
            # Check message
            if 'write() before start_response' in str(record.msg):
                return False
            # Check exception info (traceback)
            if record.exc_info and record.exc_info[1]:
                if 'write() before start_response' in str(record.exc_info[1]):
                    return False
        return True


# Apply filter to werkzeug logger
logging.getLogger('werkzeug').addFilter(WerkzeugWebSocketFilter())

# Initialize SocketIO globally
socketio = SocketIO()


def create_app():
    """Create and configure Flask application"""
    app = Flask(__name__)

    # Load configuration
    app.config['DEBUG'] = config.FLASK_DEBUG
    app.config['SECRET_KEY'] = 'mc-webui-secret-key-change-in-production'

    # Inject version and branch into all templates
    @app.context_processor
    def inject_version():
        return {'version': VERSION_STRING, 'git_branch': GIT_BRANCH}

    # Register blueprints
    app.register_blueprint(views_bp)
    app.register_blueprint(api_bp)

    # Initialize SocketIO with the app
    # Using 'threading' mode for better compatibility with regular HTTP requests
    # (gevent mode requires monkey-patching and slows down non-WebSocket requests)
    socketio.init_app(app, cors_allowed_origins="*", async_mode='threading')

    # Initialize archive scheduler if enabled
    if config.MC_ARCHIVE_ENABLED:
        schedule_daily_archiving()
        logger.info(f"Archive scheduler enabled - directory: {config.MC_ARCHIVE_DIR}")
    else:
        logger.info("Archive scheduler disabled")

    # Fetch device name from bridge in background thread (with retry)
    def init_device_name():
        device_name, source = fetch_device_name_from_bridge()
        runtime_config.set_device_name(device_name, source)

        # If we got a fallback name, keep retrying in background
        retry_delay = 5
        max_delay = 60
        while source == "fallback":
            time.sleep(retry_delay)
            device_name, source = fetch_device_name_from_bridge()
            if source != "fallback":
                runtime_config.set_device_name(device_name, source)
                logger.info(f"Device name resolved after retry: {device_name}")
                break
            retry_delay = min(retry_delay * 2, max_delay)

    threading.Thread(target=init_device_name, daemon=True).start()

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
    - Prompt lines (e.g., "MarWoj|*" or "DeviceName|*[E]")
    - JSON packet lines (internal mesh protocol data)
    - Echoed command line
    - Leading/trailing whitespace
    """
    if not output:
        return output

    lines = output.split('\n')
    cleaned_lines = []

    # Pattern to match any line containing the meshcli prompt "|*"
    # Examples: "MarWoj|*", "MarWoj|*[E]", "MarWoj|*[E] infos"
    # The prompt is: <name>|*<optional_status><optional_space><optional_command>
    prompt_pattern = re.compile(r'^[^|]+\|\*')

    for line in lines:
        stripped = line.rstrip()

        # Skip empty lines at start
        if not cleaned_lines and not stripped:
            continue

        # Skip any line that starts with the meshcli prompt pattern
        if prompt_pattern.match(stripped):
            continue

        # Skip JSON packet lines (internal mesh protocol data)
        stripped_full = stripped.lstrip()
        if stripped_full.startswith('{') and '"payload_typename"' in stripped_full:
            continue

        cleaned_lines.append(line)

    # Remove leading empty lines
    while cleaned_lines and not cleaned_lines[0].strip():
        cleaned_lines.pop(0)

    # Remove trailing empty lines
    while cleaned_lines and not cleaned_lines[-1].strip():
        cleaned_lines.pop()

    # Strip leading whitespace from first line (leftover from prompt removal)
    if cleaned_lines:
        cleaned_lines[0] = cleaned_lines[0].lstrip()

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
        debug=config.FLASK_DEBUG,
        allow_unsafe_werkzeug=True  # Required for threading mode
    )
