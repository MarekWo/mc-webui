"""
MeshCore Bridge - HTTP API wrapper for meshcli subprocess calls

This service runs as a separate container with exclusive USB device access.
The main mc-webui container communicates with this bridge via HTTP.

Architecture:
- Maintains a persistent meshcli session (subprocess.Popen)
- Multiplexes: JSON adverts -> .jsonl log, CLI commands -> HTTP responses
- Thread-safe command queue with event-based synchronization
"""

import os
import subprocess
import logging
import threading
import time
import json
import queue
import uuid
from pathlib import Path
from flask import Flask, request, jsonify

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Configuration
MC_SERIAL_PORT = os.getenv('MC_SERIAL_PORT', '/dev/ttyUSB0')
MC_CONFIG_DIR = os.getenv('MC_CONFIG_DIR', '/config')
MC_DEVICE_NAME = os.getenv('MC_DEVICE_NAME', 'meshtastic')
DEFAULT_TIMEOUT = 10
RECV_TIMEOUT = 60

class MeshCLISession:
    """
    Manages a persistent meshcli subprocess session.

    Features:
    - Single long-lived meshcli process with stdin/stdout pipes
    - Multiplexing: JSON adverts logged to .jsonl, CLI commands return responses
    - Thread-safe command queue with event-based synchronization
    - Auto-restart watchdog for crashed meshcli processes
    """

    def __init__(self, serial_port, config_dir, device_name):
        self.serial_port = serial_port
        self.config_dir = Path(config_dir)
        self.device_name = device_name

        # Ensure config directory exists
        self.config_dir.mkdir(parents=True, exist_ok=True)
        self.advert_log_path = self.config_dir / f"{device_name}.adverts.jsonl"

        # Process handle
        self.process = None
        self.process_lock = threading.Lock()

        # Command queue: (cmd_id, command_string, event, response_dict)
        self.command_queue = queue.Queue()

        # Pending commands: cmd_id -> {"event": Event, "response": [], "done": False, "error": None}
        self.pending_commands = {}
        self.pending_lock = threading.Lock()
        self.current_cmd_id = None

        # Threads
        self.stdout_thread = None
        self.stderr_thread = None
        self.stdin_thread = None
        self.watchdog_thread = None

        # Shutdown flag
        self.shutdown_flag = threading.Event()

        # Start session
        self._start_session()

    def _start_session(self):
        """Start meshcli process and worker threads"""
        logger.info(f"Starting meshcli session on {self.serial_port}")

        try:
            self.process = subprocess.Popen(
                ['meshcli', '-s', self.serial_port],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1  # Line-buffered
            )

            logger.info(f"meshcli process started (PID: {self.process.pid})")

            # Start worker threads
            self.stdout_thread = threading.Thread(target=self._read_stdout, daemon=True, name="stdout-reader")
            self.stdout_thread.start()

            self.stderr_thread = threading.Thread(target=self._read_stderr, daemon=True, name="stderr-reader")
            self.stderr_thread.start()

            self.stdin_thread = threading.Thread(target=self._send_commands, daemon=True, name="stdin-writer")
            self.stdin_thread.start()

            self.watchdog_thread = threading.Thread(target=self._watchdog, daemon=True, name="watchdog")
            self.watchdog_thread.start()

            # Initialize session settings
            time.sleep(0.5)  # Let meshcli initialize
            self._init_session_settings()

            logger.info("meshcli session fully initialized")

        except Exception as e:
            logger.error(f"Failed to start meshcli session: {e}")
            raise

    def _load_webui_settings(self):
        """
        Load webui settings from .webui_settings.json file.

        Returns:
            dict: Settings dictionary or empty dict if file doesn't exist
        """
        settings_path = self.config_dir / ".webui_settings.json"

        if not settings_path.exists():
            logger.info("No webui settings file found, using defaults")
            return {}

        try:
            with open(settings_path, 'r', encoding='utf-8') as f:
                settings = json.load(f)
                logger.info(f"Loaded webui settings: {settings}")
                return settings
        except Exception as e:
            logger.error(f"Failed to load webui settings: {e}")
            return {}

    def _init_session_settings(self):
        """Configure meshcli session for advert logging, message subscription, and user-configured settings"""
        logger.info("Configuring meshcli session settings")

        # Send configuration commands directly to stdin (bypass queue for init)
        if self.process and self.process.stdin:
            try:
                # Core settings (always enabled)
                self.process.stdin.write('set json_log_rx on\n')
                self.process.stdin.write('set print_adverts on\n')
                self.process.stdin.write('msgs_subscribe\n')

                # User-configurable settings from .webui_settings.json
                webui_settings = self._load_webui_settings()
                manual_add_contacts = webui_settings.get('manual_add_contacts', False)

                if manual_add_contacts:
                    self.process.stdin.write('set manual_add_contacts on\n')
                    logger.info("Session settings applied: json_log_rx=on, print_adverts=on, manual_add_contacts=on, msgs_subscribe")
                else:
                    logger.info("Session settings applied: json_log_rx=on, print_adverts=on, manual_add_contacts=off (default), msgs_subscribe")

                self.process.stdin.flush()
            except Exception as e:
                logger.error(f"Failed to apply session settings: {e}")

    def _read_stdout(self):
        """Thread: Read stdout line-by-line, parse adverts vs CLI responses"""
        logger.info("stdout reader thread started")

        try:
            for line in iter(self.process.stdout.readline, ''):
                if self.shutdown_flag.is_set():
                    break

                line = line.rstrip('\n\r')
                if not line:
                    continue

                # Try to parse as JSON advert
                if self._is_advert_json(line):
                    self._log_advert(line)
                    continue

                # Otherwise, append to current CLI response
                self._append_to_current_response(line)

        except Exception as e:
            logger.error(f"stdout reader error: {e}")
        finally:
            logger.info("stdout reader thread exiting")

    def _read_stderr(self):
        """Thread: Read stderr and log errors"""
        logger.info("stderr reader thread started")

        try:
            for line in iter(self.process.stderr.readline, ''):
                if self.shutdown_flag.is_set():
                    break

                line = line.rstrip('\n\r')
                if line:
                    logger.warning(f"meshcli stderr: {line}")

        except Exception as e:
            logger.error(f"stderr reader error: {e}")
        finally:
            logger.info("stderr reader thread exiting")

    def _send_commands(self):
        """Thread: Send queued commands to stdin and monitor responses"""
        logger.info("stdin writer thread started")

        try:
            while not self.shutdown_flag.is_set():
                try:
                    # Get command from queue (with timeout to check shutdown flag)
                    cmd_id, command, event, response_dict = self.command_queue.get(timeout=1.0)
                except queue.Empty:
                    continue

                logger.info(f"Sending command [{cmd_id}]: {command}")

                # Register pending command
                with self.pending_lock:
                    self.pending_commands[cmd_id] = response_dict
                    self.current_cmd_id = cmd_id
                    response_dict["last_line_time"] = time.time()

                try:
                    # Send command
                    self.process.stdin.write(f'{command}\n')
                    self.process.stdin.flush()

                    # Start timeout monitor thread
                    monitor_thread = threading.Thread(
                        target=self._monitor_response_timeout,
                        args=(cmd_id, response_dict, event),
                        daemon=True
                    )
                    monitor_thread.start()

                except Exception as e:
                    logger.error(f"Failed to send command [{cmd_id}]: {e}")
                    with self.pending_lock:
                        response_dict["error"] = str(e)
                        response_dict["done"] = True
                        event.set()

        except Exception as e:
            logger.error(f"stdin writer error: {e}")
        finally:
            logger.info("stdin writer thread exiting")

    def _monitor_response_timeout(self, cmd_id, response_dict, event, timeout_ms=300):
        """Monitor if response has finished (no new lines for timeout_ms)"""
        try:
            while not self.shutdown_flag.is_set():
                time.sleep(timeout_ms / 1000.0)

                with self.pending_lock:
                    # Check if command still pending
                    if cmd_id not in self.pending_commands:
                        return  # Already completed

                    # Check if we got new lines recently
                    time_since_last_line = time.time() - response_dict.get("last_line_time", 0)

                    if time_since_last_line >= (timeout_ms / 1000.0):
                        # No new lines for timeout period - mark as done
                        logger.info(f"Command [{cmd_id}] completed (timeout-based)")
                        response_dict["done"] = True
                        event.set()
                        if self.current_cmd_id == cmd_id:
                            self.current_cmd_id = None
                        return

        except Exception as e:
            logger.error(f"Monitor thread error for [{cmd_id}]: {e}")

    def _watchdog(self):
        """Thread: Monitor process health and restart if crashed"""
        logger.info("watchdog thread started")

        while not self.shutdown_flag.is_set():
            time.sleep(5)

            if self.process and self.process.poll() is not None:
                logger.error(f"meshcli process died (exit code: {self.process.returncode})")
                logger.info("Attempting to restart meshcli session...")

                # Cancel all pending commands
                with self.pending_lock:
                    for cmd_id, resp_dict in self.pending_commands.items():
                        resp_dict["error"] = "meshcli process crashed"
                        resp_dict["done"] = True
                        resp_dict["event"].set()
                    self.pending_commands.clear()

                # Restart
                try:
                    self._start_session()
                except Exception as e:
                    logger.error(f"Failed to restart session: {e}")
                    time.sleep(10)  # Wait before retry

        logger.info("watchdog thread exiting")

    def _is_advert_json(self, line):
        """Check if line is a JSON advert"""
        try:
            data = json.loads(line)
            return isinstance(data, dict) and data.get("payload_typename") == "ADVERT"
        except (json.JSONDecodeError, ValueError):
            return False

    def _log_advert(self, json_line):
        """Log advert JSON to .jsonl file with timestamp"""
        try:
            data = json.loads(json_line)
            data["ts"] = time.time()

            with open(self.advert_log_path, 'a', encoding='utf-8') as f:
                f.write(json.dumps(data, ensure_ascii=False) + '\n')

            logger.debug(f"Logged advert from {data.get('from_id', 'unknown')}")

        except Exception as e:
            logger.error(f"Failed to log advert: {e}")

    def _append_to_current_response(self, line):
        """Append line to current CLI command response and update timestamp"""
        with self.pending_lock:
            if not self.current_cmd_id:
                # No active command, probably init output - log and ignore
                logger.debug(f"Unassociated output: {line}")
                return

            cmd_id = self.current_cmd_id

            # Append to response buffer
            self.pending_commands[cmd_id]["response"].append(line)
            # Update timestamp of last received line
            self.pending_commands[cmd_id]["last_line_time"] = time.time()

    def execute_command(self, args, timeout=DEFAULT_TIMEOUT):
        """
        Execute a CLI command via the persistent session.

        Args:
            args: List of command arguments (e.g., ['recv', '--timeout', '60'])
            timeout: Max time to wait for response

        Returns:
            Dict with success, stdout, stderr, returncode
        """
        cmd_id = str(uuid.uuid4())[:8]

        # Build command line - use double quotes for args with spaces/special chars
        # meshcli doesn't parse like shell, so we need simple double-quote wrapping
        quoted_args = []
        for arg in args:
            # If argument contains spaces or special chars, wrap in double quotes
            if ' ' in arg or '"' in arg or "'" in arg:
                # Escape internal double quotes
                escaped = arg.replace('"', '\\"')
                quoted_args.append(f'"{escaped}"')
            else:
                quoted_args.append(arg)

        command = ' '.join(quoted_args)
        event = threading.Event()
        response_dict = {
            "event": event,
            "response": [],
            "done": False,
            "error": None,
            "last_line_time": time.time()
        }

        # Queue command
        self.command_queue.put((cmd_id, command, event, response_dict))
        logger.info(f"Command [{cmd_id}] queued: {command}")

        # Wait for completion
        if not event.wait(timeout):
            logger.error(f"Command [{cmd_id}] timeout after {timeout}s")

            # Cleanup
            with self.pending_lock:
                if cmd_id in self.pending_commands:
                    del self.pending_commands[cmd_id]

            return {
                'success': False,
                'stdout': '',
                'stderr': f'Command timeout after {timeout} seconds',
                'returncode': -1
            }

        # Retrieve response
        with self.pending_lock:
            resp = self.pending_commands.pop(cmd_id, None)

        if not resp:
            return {
                'success': False,
                'stdout': '',
                'stderr': 'Command response lost',
                'returncode': -1
            }

        if resp["error"]:
            return {
                'success': False,
                'stdout': '',
                'stderr': resp["error"],
                'returncode': -1
            }

        return {
            'success': True,
            'stdout': '\n'.join(resp["response"]),
            'stderr': '',
            'returncode': 0
        }

    def shutdown(self):
        """Gracefully shutdown session"""
        logger.info("Shutting down meshcli session")
        self.shutdown_flag.set()

        if self.process:
            try:
                self.process.terminate()
                self.process.wait(timeout=5)
            except:
                self.process.kill()

        logger.info("Session shutdown complete")


# Global session instance
meshcli_session = None


@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    session_status = "healthy" if meshcli_session and meshcli_session.process and meshcli_session.process.poll() is None else "unhealthy"

    return jsonify({
        'status': session_status,
        'serial_port': MC_SERIAL_PORT,
        'advert_log': str(meshcli_session.advert_log_path) if meshcli_session else None
    }), 200


@app.route('/cli', methods=['POST'])
def execute_cli():
    """
    Execute meshcli command via persistent session.

    Request JSON:
        {
            "args": ["recv"],
            "timeout": 60  (optional)
        }

    Response JSON:
        {
            "success": true,
            "stdout": "...",
            "stderr": "...",
            "returncode": 0
        }
    """
    try:
        data = request.get_json()

        if not data or 'args' not in data:
            return jsonify({
                'success': False,
                'stdout': '',
                'stderr': 'Missing required field: args',
                'returncode': -1
            }), 400

        args = data['args']
        timeout = data.get('timeout', DEFAULT_TIMEOUT)

        # Special handling for recv command (longer timeout)
        if args and args[0] == 'recv':
            timeout = data.get('timeout', RECV_TIMEOUT)

        if not isinstance(args, list):
            return jsonify({
                'success': False,
                'stdout': '',
                'stderr': 'args must be a list',
                'returncode': -1
            }), 400

        # Check session health
        if not meshcli_session or not meshcli_session.process:
            return jsonify({
                'success': False,
                'stdout': '',
                'stderr': 'meshcli session not initialized',
                'returncode': -1
            }), 503

        # Execute via persistent session
        result = meshcli_session.execute_command(args, timeout)

        return jsonify(result), 200

    except Exception as e:
        logger.error(f"API error: {e}")
        return jsonify({
            'success': False,
            'stdout': '',
            'stderr': str(e),
            'returncode': -1
        }), 500


@app.route('/pending_contacts', methods=['GET'])
def get_pending_contacts():
    """
    Get list of pending contacts awaiting approval.

    Response JSON:
        {
            "success": true,
            "pending": [
                {"name": "Skyllancer", "public_key": "f9ef..."},
                {"name": "KRA Reksio mob2🐕", "public_key": "41d5..."}
            ],
            "raw_stdout": "..."
        }
    """
    try:
        # Check session health
        if not meshcli_session or not meshcli_session.process:
            return jsonify({
                'success': False,
                'error': 'meshcli session not initialized',
                'pending': []
            }), 503

        # Execute pending_contacts command
        result = meshcli_session.execute_command(['pending_contacts'], timeout=DEFAULT_TIMEOUT)

        if not result['success']:
            return jsonify({
                'success': False,
                'error': result.get('stderr', 'Command failed'),
                'pending': [],
                'raw_stdout': result.get('stdout', '')
            }), 200

        # Parse stdout
        stdout = result.get('stdout', '').strip()
        pending = []

        if stdout:
            for line in stdout.split('\n'):
                line = line.strip()

                # Skip empty lines
                if not line:
                    continue

                # Skip JSON lines (adverts, messages, or other JSON output from meshcli)
                if line.startswith('{') or line.startswith('['):
                    continue

                # Skip meshcli prompt lines (e.g., "MarWoj|*")
                if line.endswith('|*'):
                    continue

                # Parse lines with format: "Name: <hex_public_key>"
                if ':' in line:
                    parts = line.split(':', 1)
                    if len(parts) == 2:
                        name = parts[0].strip()
                        public_key = parts[1].strip().replace(' ', '')  # Remove spaces from hex

                        # Additional validation: pubkey should be hex characters only
                        if name and public_key and all(c in '0123456789abcdefABCDEF' for c in public_key):
                            pending.append({
                                'name': name,
                                'public_key': public_key
                            })

        return jsonify({
            'success': True,
            'pending': pending,
            'raw_stdout': stdout
        }), 200

    except Exception as e:
        logger.error(f"API error in /pending_contacts: {e}")
        return jsonify({
            'success': False,
            'error': str(e),
            'pending': []
        }), 500


@app.route('/add_pending', methods=['POST'])
def add_pending_contact():
    """
    Add a pending contact by name or public key.

    Request JSON:
        {
            "selector": "<name_or_pubkey_prefix_or_pubkey>"
        }

    Response JSON:
        {
            "success": true,
            "stdout": "...",
            "stderr": "",
            "returncode": 0
        }
    """
    try:
        data = request.get_json()

        if not data or 'selector' not in data:
            return jsonify({
                'success': False,
                'stdout': '',
                'stderr': 'Missing required field: selector',
                'returncode': -1
            }), 400

        selector = data['selector']

        # Validate selector is non-empty string
        if not isinstance(selector, str) or not selector.strip():
            return jsonify({
                'success': False,
                'stdout': '',
                'stderr': 'selector must be a non-empty string',
                'returncode': -1
            }), 400

        # Check session health
        if not meshcli_session or not meshcli_session.process:
            return jsonify({
                'success': False,
                'stdout': '',
                'stderr': 'meshcli session not initialized',
                'returncode': -1
            }), 503

        # Execute add_pending command
        result = meshcli_session.execute_command(['add_pending', selector.strip()], timeout=DEFAULT_TIMEOUT)

        return jsonify(result), 200

    except Exception as e:
        logger.error(f"API error in /add_pending: {e}")
        return jsonify({
            'success': False,
            'stdout': '',
            'stderr': str(e),
            'returncode': -1
        }), 500


@app.route('/set_manual_add_contacts', methods=['POST'])
def set_manual_add_contacts():
    """
    Enable or disable manual contact approval mode.

    This setting is:
    1. Saved to .webui_settings.json for persistence across container restarts
    2. Applied immediately to the running meshcli session

    Request JSON:
        {
            "enabled": true/false
        }

    Response JSON:
        {
            "success": true,
            "message": "manual_add_contacts set to on"
        }
    """
    try:
        data = request.get_json()

        if not data or 'enabled' not in data:
            return jsonify({
                'success': False,
                'error': 'Missing required field: enabled'
            }), 400

        enabled = data['enabled']

        if not isinstance(enabled, bool):
            return jsonify({
                'success': False,
                'error': 'enabled must be a boolean'
            }), 400

        # Save to persistent settings file
        settings_path = meshcli_session.config_dir / ".webui_settings.json"

        try:
            # Read existing settings or create new
            if settings_path.exists():
                with open(settings_path, 'r', encoding='utf-8') as f:
                    settings = json.load(f)
            else:
                settings = {}

            # Update manual_add_contacts setting
            settings['manual_add_contacts'] = enabled

            # Write back to file
            with open(settings_path, 'w', encoding='utf-8') as f:
                json.dump(settings, f, indent=2, ensure_ascii=False)

            logger.info(f"Saved manual_add_contacts={enabled} to {settings_path}")

        except Exception as e:
            logger.error(f"Failed to save settings file: {e}")
            return jsonify({
                'success': False,
                'error': f'Failed to save settings: {str(e)}'
            }), 500

        # Apply setting immediately to running session
        if not meshcli_session or not meshcli_session.process:
            return jsonify({
                'success': False,
                'error': 'meshcli session not initialized'
            }), 503

        # Execute set manual_add_contacts on|off command
        command_value = 'on' if enabled else 'off'
        result = meshcli_session.execute_command(['set', 'manual_add_contacts', command_value], timeout=DEFAULT_TIMEOUT)

        if not result['success']:
            return jsonify({
                'success': False,
                'error': f"Failed to apply setting: {result.get('stderr', 'Unknown error')}"
            }), 500

        return jsonify({
            'success': True,
            'message': f"manual_add_contacts set to {command_value}",
            'enabled': enabled
        }), 200

    except Exception as e:
        logger.error(f"API error in /set_manual_add_contacts: {e}")
        return jsonify({
            'success': False,
            'error': str(e)
        }), 500


if __name__ == '__main__':
    logger.info(f"Starting MeshCore Bridge on port 5001")
    logger.info(f"Serial port: {MC_SERIAL_PORT}")
    logger.info(f"Config dir: {MC_CONFIG_DIR}")
    logger.info(f"Device name: {MC_DEVICE_NAME}")

    # Initialize persistent meshcli session
    try:
        meshcli_session = MeshCLISession(
            serial_port=MC_SERIAL_PORT,
            config_dir=MC_CONFIG_DIR,
            device_name=MC_DEVICE_NAME
        )
        logger.info(f"Advert logging to: {meshcli_session.advert_log_path}")
    except Exception as e:
        logger.error(f"Failed to initialize meshcli session: {e}")
        logger.error("Bridge will start but /cli endpoint will be unavailable")

    # Run on all interfaces to allow Docker network access
    app.run(host='0.0.0.0', port=5001, debug=False)
