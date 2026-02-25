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
import shlex
import re
from pathlib import Path
from flask import Flask, request, jsonify
from flask_socketio import SocketIO, emit

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Initialize SocketIO with gevent for async support
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='gevent')

# Configuration
MC_CONFIG_DIR = os.getenv('MC_CONFIG_DIR', '/config')
MC_DEVICE_NAME = os.getenv('MC_DEVICE_NAME', 'meshtastic')
DEFAULT_TIMEOUT = 10
RECV_TIMEOUT = 60

# Serial port detection
SERIAL_BY_ID_PATH = Path('/dev/serial/by-id')
SERIAL_PORT_SOURCE = "config"  # Will be updated by detect_serial_port()


def detect_serial_port() -> str:
    """
    Auto-detect serial port from /dev/serial/by-id/.

    Returns:
        Path to detected serial device

    Raises:
        RuntimeError: If no device found or multiple devices without explicit selection
    """
    global SERIAL_PORT_SOURCE

    env_port = os.getenv('MC_SERIAL_PORT', 'auto')

    # If explicit port specified (not "auto"), use it directly
    if env_port and env_port.lower() != 'auto':
        logger.info(f"Using configured serial port: {env_port}")
        SERIAL_PORT_SOURCE = "config"
        return env_port

    # Auto-detect from /dev/serial/by-id/
    logger.info("Auto-detecting serial port...")

    if not SERIAL_BY_ID_PATH.exists():
        raise RuntimeError(
            "No serial devices found: /dev/serial/by-id/ does not exist. "
            "Make sure a MeshCore device is connected via USB."
        )

    devices = list(SERIAL_BY_ID_PATH.iterdir())

    if len(devices) == 0:
        raise RuntimeError(
            "No serial devices found in /dev/serial/by-id/. "
            "Make sure a MeshCore device is connected via USB."
        )

    if len(devices) == 1:
        device_path = str(devices[0])
        logger.info(f"Auto-detected serial port: {device_path}")
        SERIAL_PORT_SOURCE = "detected"
        return device_path

    # Multiple devices found - list them and fail
    device_list = '\n  - '.join(str(d.name) for d in devices)
    raise RuntimeError(
        f"Multiple serial devices found. Please specify MC_SERIAL_PORT in .env:\n"
        f"  - {device_list}\n\n"
        f"Example: MC_SERIAL_PORT=/dev/serial/by-id/{devices[0].name}"
    )


# Detect serial port at startup
MC_SERIAL_PORT = detect_serial_port()

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

        # Auto-detected device name from meshcli prompt
        self.detected_name = None
        self.name_detection_done = threading.Event()

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

        # Echo tracking for "Heard X repeats" feature
        self.pending_echo = None  # {timestamp, channel_idx, pkt_payload}
        self.echo_counts = {}     # pkt_payload -> {paths: set(), timestamp: float, channel_idx: int}
        self.incoming_paths = {}  # pkt_payload -> {path, snr, path_len, timestamp}
        self.echo_lock = threading.Lock()
        self.echo_log_path = self.config_dir / f"{device_name}.echoes.jsonl"

        # ACK tracking for DM delivery status
        self.acks = {}  # ack_code -> {snr, rssi, route, path, ts}
        self.acks_file = self.config_dir / f"{device_name}.acks.jsonl"

        # Auto-retry for DM messages
        self.auto_retry_enabled = True
        self.auto_retry_max_attempts = 5      # max direct attempts (including first send)
        self.auto_retry_max_flood = 3         # max flood attempts (after reset_path)
        self.retry_ack_codes = set()          # expected_ack codes of retry attempts (not first)
        self.retry_groups = {}                # original_ack -> [retry_ack_1, retry_ack_2, ...]
        self.retry_lock = threading.Lock()
        self.active_retries = {}              # original_ack -> threading.Event (cancel signal)

        # Load persisted data from disk
        self._load_echoes()
        self._load_acks()

        # Start session
        self._start_session()

    def _update_log_paths(self, new_name):
        """Update advert/echo/ack log paths after device name detection, renaming existing files."""
        new_advert = self.config_dir / f"{new_name}.adverts.jsonl"
        new_echo = self.config_dir / f"{new_name}.echoes.jsonl"
        new_acks = self.config_dir / f"{new_name}.acks.jsonl"

        # Rename existing files if they use the old (configured) name
        for old_path, new_path in [
            (self.advert_log_path, new_advert),
            (self.echo_log_path, new_echo),
            (self.acks_file, new_acks),
        ]:
            if old_path != new_path and old_path.exists() and not new_path.exists():
                try:
                    old_path.rename(new_path)
                    logger.info(f"Renamed {old_path.name} -> {new_path.name}")
                except OSError as e:
                    logger.warning(f"Failed to rename {old_path.name}: {e}")

        self.advert_log_path = new_advert
        self.echo_log_path = new_echo
        self.acks_file = new_acks
        logger.info(f"Log paths updated for device: {new_name}")

        # Reload echo and ACK data from the correct files
        # (initial _load_echoes/_load_acks may have failed with the "auto" name)
        self._load_echoes()
        self._load_acks()

    def _start_session(self):
        """Start meshcli process and worker threads"""
        logger.info(f"Starting meshcli session on {self.serial_port}")

        try:
            # Set terminal size env vars for meshcli (fallback for os.get_terminal_size())
            env = os.environ.copy()
            env['COLUMNS'] = '120'
            env['LINES'] = '40'

            self.process = subprocess.Popen(
                ['meshcli', '-s', self.serial_port],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,  # Line-buffered
                env=env
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

        # Wait for device name detection from prompt, then fallback to .infos
        if not self.name_detection_done.wait(timeout=1.0):
            logger.info("Device name not detected from prompt, trying .infos command")
            self._detect_name_from_infos()

    def _detect_name_from_infos(self):
        """Fallback: detect device name via .infos command"""
        if self.detected_name:
            return

        try:
            result = self.execute_command(['.infos'], timeout=5)
            if result['success'] and result['stdout']:
                # Try to parse JSON output from .infos
                stdout = result['stdout'].strip()
                # Find JSON object in output
                for line in stdout.split('\n'):
                    line = line.strip()
                    if line.startswith('{'):
                        try:
                            data = json.loads(line)
                            if 'name' in data:
                                self.detected_name = data['name']
                                logger.info(f"Detected device name from .infos: {self.detected_name}")
                                self._update_log_paths(self.detected_name)
                                self.name_detection_done.set()
                                return
                        except json.JSONDecodeError:
                            continue
        except Exception as e:
            logger.warning(f"Failed to detect device name from .infos: {e}")

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

                # Detect device name from meshcli prompt: "DeviceName|*" or "DeviceName|*[E]"
                # Handle status prefixes like "Fetching channels ....DeviceName|*"
                if not self.detected_name and '|*' in line:
                    before_prompt = line.split('|*')[0]
                    # If line contains dots (status indicator), extract name after last dot sequence
                    if '.' in before_prompt:
                        # Split by one or more dots and take the last non-empty part
                        parts = re.split(r'\.+', before_prompt)
                        name_part = parts[-1].strip() if parts else ''
                    else:
                        name_part = before_prompt.strip()

                    if name_part:
                        self.detected_name = name_part
                        logger.info(f"Detected device name from prompt: {self.detected_name}")
                        self._update_log_paths(self.detected_name)
                        self.name_detection_done.set()

                # Try to parse as JSON advert
                if self._is_advert_json(line):
                    self._log_advert(line)
                    continue

                # Try to parse as GRP_TXT echo (for "Heard X repeats" feature)
                echo_data = self._parse_grp_txt_echo(line)
                if echo_data:
                    self._process_echo(echo_data)
                    continue

                # Try to parse as ACK packet (for DM delivery tracking)
                ack_data = self._parse_ack_packet(line)
                if ack_data:
                    self._process_ack(ack_data)
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
            start_time = time.time()
            # Get command timeout from response_dict (default 10s)
            cmd_timeout = response_dict.get("timeout", 10)

            # For slow commands (timeout >= 15s like node_discover), wait minimum time before allowing completion
            # because meshcli may echo prompt immediately but real results come later
            is_slow_command = cmd_timeout >= 15
            min_elapsed = (cmd_timeout * 0.7) if is_slow_command else 0

            logger.info(f"Monitor [{cmd_id}] started, cmd_timeout={cmd_timeout}s, min_elapsed={min_elapsed:.1f}s")

            while not self.shutdown_flag.is_set():
                time.sleep(timeout_ms / 1000.0)

                with self.pending_lock:
                    # Check if command still pending
                    if cmd_id not in self.pending_commands:
                        return  # Already completed

                    # Check if we got new lines recently
                    time_since_last_line = time.time() - response_dict.get("last_line_time", 0)
                    total_elapsed = time.time() - start_time
                    has_output = len(response_dict.get("response", [])) > 0

                    # Can only complete if:
                    # 1. Minimum elapsed time has passed (for slow commands), AND
                    # 2. We have output AND no new lines for timeout_ms
                    can_complete = total_elapsed >= min_elapsed

                    if can_complete and has_output and time_since_last_line >= (timeout_ms / 1000.0):
                        # No new lines for timeout period - mark as done
                        logger.info(f"Command [{cmd_id}] completed (timeout-based, has_output={has_output})")
                        response_dict["done"] = True
                        event.set()

                        # If this is a WebSocket command, emit response to that client
                        if cmd_id.startswith("ws_"):
                            socket_id = response_dict.get("socket_id")
                            if socket_id:
                                output = '\n'.join(response_dict.get("response", []))
                                socketio.emit('command_response', {
                                    'success': True,
                                    'output': output,
                                    'cmd_id': cmd_id
                                }, room=socket_id, namespace='/console')

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

    def _parse_grp_txt_echo(self, line):
        """Parse GRP_TXT JSON echo, return data dict or None."""
        try:
            data = json.loads(line)
            if isinstance(data, dict) and data.get("payload_typename") == "GRP_TXT":
                return {
                    'pkt_payload': data.get('pkt_payload'),
                    'path': data.get('path', ''),
                    'snr': data.get('snr'),
                    'path_len': data.get('path_len'),
                }
        except (json.JSONDecodeError, ValueError):
            pass
        return None

    def _process_echo(self, echo_data):
        """Process a GRP_TXT echo: track as sent echo or incoming path."""
        pkt_payload = echo_data.get('pkt_payload')
        path = echo_data.get('path', '')
        if not pkt_payload:
            return

        with self.echo_lock:
            current_time = time.time()

            # If this pkt_payload is already tracked as sent echo, add path
            if pkt_payload in self.echo_counts:
                if path not in self.echo_counts[pkt_payload]['paths']:
                    self.echo_counts[pkt_payload]['paths'].add(path)
                    self._save_echo({
                        'type': 'sent_echo', 'pkt_payload': pkt_payload,
                        'path': path, 'msg_ts': self.echo_counts[pkt_payload]['timestamp'],
                        'channel_idx': self.echo_counts[pkt_payload]['channel_idx']
                    })
                logger.debug(f"Echo: added path {path} to existing payload, total: {len(self.echo_counts[pkt_payload]['paths'])}")
                return

            # If we have a pending sent message waiting for correlation
            if self.pending_echo and self.pending_echo.get('pkt_payload') is None:
                # Check time window (60 seconds)
                if current_time - self.pending_echo['timestamp'] < 60:
                    # Associate this pkt_payload with the pending message
                    self.pending_echo['pkt_payload'] = pkt_payload
                    self.echo_counts[pkt_payload] = {
                        'paths': {path},
                        'timestamp': self.pending_echo['timestamp'],
                        'channel_idx': self.pending_echo['channel_idx']
                    }
                    self._save_echo({
                        'type': 'sent_echo', 'pkt_payload': pkt_payload,
                        'path': path, 'msg_ts': self.pending_echo['timestamp'],
                        'channel_idx': self.pending_echo['channel_idx']
                    })
                    logger.info(f"Echo: correlated pkt_payload with sent message, first path: {path}")
                    return

            # Not a sent echo -> accumulate as incoming message path
            if pkt_payload not in self.incoming_paths:
                self.incoming_paths[pkt_payload] = {
                    'paths': [],
                    'first_ts': current_time,
                }
            self.incoming_paths[pkt_payload]['paths'].append({
                'path': path,
                'snr': echo_data.get('snr'),
                'path_len': echo_data.get('path_len'),
                'ts': current_time,
            })
            self._save_echo({
                'type': 'rx_echo', 'pkt_payload': pkt_payload,
                'path': path, 'snr': echo_data.get('snr'),
                'path_len': echo_data.get('path_len')
            })
            logger.debug(f"Echo: stored incoming path {path} (path_len={echo_data.get('path_len')}, total paths: {len(self.incoming_paths[pkt_payload]['paths'])})")

            # Cleanup old incoming paths (> 7 days, matching .echoes.jsonl retention)
            cutoff = current_time - (7 * 24 * 3600)
            self.incoming_paths = {k: v for k, v in self.incoming_paths.items()
                                   if v['first_ts'] > cutoff}

    def register_pending_echo(self, channel_idx, timestamp):
        """Register a sent message for echo tracking."""
        with self.echo_lock:
            self.pending_echo = {
                'timestamp': timestamp,
                'channel_idx': channel_idx,
                'pkt_payload': None
            }
            # Cleanup old echo counts (> 7 days, matching .echoes.jsonl retention)
            cutoff = time.time() - (7 * 24 * 3600)
            self.echo_counts = {k: v for k, v in self.echo_counts.items()
                               if v['timestamp'] > cutoff}
            logger.debug(f"Registered pending echo for channel {channel_idx}")

    def get_echo_count(self, timestamp, channel_idx):
        """Get echo count for a message by timestamp and channel."""
        with self.echo_lock:
            for pkt_payload, data in self.echo_counts.items():
                # Match within 5 second window
                if (abs(data['timestamp'] - timestamp) < 5 and
                    data['channel_idx'] == channel_idx):
                    return len(data['paths'])
        return 0

    def _save_echo(self, record):
        """Append echo record to .echoes.jsonl file."""
        try:
            record['ts'] = time.time()
            with open(self.echo_log_path, 'a', encoding='utf-8') as f:
                f.write(json.dumps(record, ensure_ascii=False) + '\n')
        except Exception as e:
            logger.error(f"Failed to save echo: {e}")

    def _load_echoes(self):
        """Load echo data from .echoes.jsonl on startup."""
        if not self.echo_log_path.exists():
            return

        cutoff = time.time() - (7 * 24 * 3600)  # 7 days
        kept_lines = []
        loaded_sent = 0
        loaded_incoming = 0

        try:
            with open(self.echo_log_path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    ts = record.get('ts', 0)
                    if ts < cutoff:
                        continue  # Skip old records

                    kept_lines.append(line)
                    pkt_payload = record.get('pkt_payload')
                    if not pkt_payload:
                        continue

                    echo_type = record.get('type')

                    if echo_type == 'sent_echo':
                        if pkt_payload in self.echo_counts:
                            # Add path to existing entry
                            path = record.get('path', '')
                            if path:
                                self.echo_counts[pkt_payload]['paths'].add(path)
                        else:
                            self.echo_counts[pkt_payload] = {
                                'paths': {record.get('path', '')},
                                'timestamp': record.get('msg_ts', ts),
                                'channel_idx': record.get('channel_idx', 0)
                            }
                            loaded_sent += 1

                    elif echo_type == 'rx_echo':
                        if pkt_payload not in self.incoming_paths:
                            self.incoming_paths[pkt_payload] = {
                                'paths': [],
                                'first_ts': ts,
                            }
                            loaded_incoming += 1
                        self.incoming_paths[pkt_payload]['paths'].append({
                            'path': record.get('path', ''),
                            'snr': record.get('snr'),
                            'path_len': record.get('path_len'),
                            'ts': ts,
                        })

            # Rewrite file with only recent records (compact)
            with open(self.echo_log_path, 'w', encoding='utf-8') as f:
                for line in kept_lines:
                    f.write(line + '\n')

            logger.info(f"Loaded echoes from disk: {loaded_sent} sent, {loaded_incoming} incoming (kept {len(kept_lines)} records)")

        except Exception as e:
            logger.error(f"Failed to load echoes: {e}")

    # =========================================================================
    # ACK tracking for DM delivery status
    # =========================================================================

    def _parse_ack_packet(self, line):
        """Parse ACK JSON packet from stdout, return data dict or None."""
        try:
            data = json.loads(line)
            if isinstance(data, dict) and data.get("payload_typename") == "ACK":
                return {
                    'ack_code': data.get('pkt_payload'),
                    'snr': data.get('snr'),
                    'rssi': data.get('rssi'),
                    'route': data.get('route_typename'),
                    'path': data.get('path', ''),
                    'path_len': data.get('path_len', 0),
                }
        except (json.JSONDecodeError, ValueError):
            pass
        return None

    def _process_ack(self, ack_data):
        """Process an ACK packet: store delivery confirmation."""
        ack_code = ack_data.get('ack_code')
        if not ack_code:
            return

        # Only store the first ACK per code (ignore duplicates from multi_acks)
        if ack_code in self.acks:
            logger.debug(f"ACK duplicate ignored: code={ack_code}")
            return

        record = {
            'ack_code': ack_code,
            'snr': ack_data.get('snr'),
            'rssi': ack_data.get('rssi'),
            'route': ack_data.get('route'),
            'path': ack_data.get('path', ''),
            'ts': time.time(),
        }

        self.acks[ack_code] = record
        self._save_ack(record)
        logger.info(f"ACK received: code={ack_code}, snr={ack_data.get('snr')}, route={ack_data.get('route')}")

    def _save_ack(self, record):
        """Append ACK record to .acks.jsonl file."""
        try:
            with open(self.acks_file, 'a', encoding='utf-8') as f:
                f.write(json.dumps(record, ensure_ascii=False) + '\n')
        except Exception as e:
            logger.error(f"Failed to save ACK: {e}")

    def _load_acks(self):
        """Load ACK data from .acks.jsonl on startup with 7-day cleanup."""
        if not self.acks_file.exists():
            return

        cutoff = time.time() - (7 * 24 * 3600)  # 7 days
        kept_lines = []
        loaded = 0

        try:
            with open(self.acks_file, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        record = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    ts = record.get('ts', 0)
                    if ts < cutoff:
                        continue  # Skip old records

                    kept_lines.append(line)
                    ack_code = record.get('ack_code')
                    if ack_code:
                        self.acks[ack_code] = record
                        loaded += 1

            # Rewrite file with only recent records (compact)
            with open(self.acks_file, 'w', encoding='utf-8') as f:
                for line in kept_lines:
                    f.write(line + '\n')

            logger.info(f"Loaded ACKs from disk: {loaded} records (kept {len(kept_lines)})")

        except Exception as e:
            logger.error(f"Failed to load ACKs: {e}")

    # =========================================================================
    # Auto-retry for DM messages
    # =========================================================================

    def _start_retry(self, recipient, text, original_ack, suggested_timeout):
        """Start background retry thread for a DM message."""
        cancel_event = threading.Event()
        with self.retry_lock:
            self.active_retries[original_ack] = cancel_event
            self.retry_groups[original_ack] = []

        thread = threading.Thread(
            target=self._retry_send,
            args=(recipient, text, original_ack, suggested_timeout, cancel_event),
            daemon=True,
            name=f"retry-{original_ack[:8]}"
        )
        thread.start()
        logger.info(f"Auto-retry started for ack={original_ack}, "
                     f"direct={self.auto_retry_max_attempts}, "
                     f"flood={self.auto_retry_max_flood}, "
                     f"timeout={suggested_timeout}ms")

    def _retry_send(self, recipient, text, original_ack, suggested_timeout, cancel_event):
        """Background retry loop for a DM message.

        Phase 1: Direct attempts (up to auto_retry_max_attempts)
        Phase 2: Flood attempts (up to auto_retry_max_flood) after reset_path
        """
        # Wait timeout in seconds (use suggested_timeout from device, with 1.2x margin)
        wait_timeout = max(suggested_timeout / 1000 * 1.2, 5.0)

        max_direct = self.auto_retry_max_attempts   # includes the first send
        max_flood = self.auto_retry_max_flood
        total_max = max_direct + max_flood

        # Attempt 1 was already sent by the caller. Start from attempt index 1.
        attempt = 1  # 0-indexed; attempt 0 was the initial send
        flood_mode = False
        flood_attempts = 0

        while attempt < total_max:
            if cancel_event.is_set():
                logger.info(f"Retry cancelled for ack={original_ack}")
                break

            # Collect all ack codes in the group to check
            with self.retry_lock:
                all_acks = [original_ack] + self.retry_groups.get(original_ack, [])

            # Poll for ACK (check all ack codes — any ACK means delivered)
            ack_received = self._wait_for_any_ack(all_acks, wait_timeout, cancel_event)
            if ack_received:
                mode = "flood" if flood_mode else "direct"
                logger.info(f"ACK received (attempt {attempt}, {mode}), "
                             f"retry done for original={original_ack}")
                break

            if cancel_event.is_set():
                break

            # Check limits for current mode
            if not flood_mode and attempt >= max_direct:
                # Switch to flood mode
                logger.info(f"Retry: resetting path for {recipient} (switching to flood, "
                             f"{max_direct} direct attempts exhausted)")
                try:
                    self.execute_command(['reset_path', recipient], timeout=5)
                except Exception as e:
                    logger.error(f"Retry: reset_path failed: {e}")
                flood_mode = True

            if flood_mode and flood_attempts >= max_flood:
                break

            # Send retry
            mode_str = "flood" if flood_mode else "direct"
            logger.info(f"Retry {mode_str} attempt {attempt + 1}/{total_max} "
                         f"for '{text[:30]}' → {recipient}")

            try:
                result = self.execute_command(['.msg', recipient, text], timeout=DEFAULT_TIMEOUT)
                if result.get('success'):
                    new_ack = self._extract_ack_from_response(result.get('stdout', ''))
                    new_timeout = self._extract_timeout_from_response(result.get('stdout', ''))
                    if new_ack:
                        with self.retry_lock:
                            self.retry_ack_codes.add(new_ack)
                            self.retry_groups.setdefault(original_ack, []).append(new_ack)
                        if new_timeout:
                            wait_timeout = max(new_timeout / 1000 * 1.2, 5.0)
                        logger.info(f"Retry sent, new ack={new_ack}")
                    else:
                        logger.warning(f"Retry: could not parse expected_ack from response: "
                                        f"{result.get('stdout', '')[:200]}")
                        break
                else:
                    logger.error(f"Retry: msg command failed: {result.get('stderr', '')}")
                    break
            except Exception as e:
                logger.error(f"Retry: send failed: {e}")
                break

            attempt += 1
            if flood_mode:
                flood_attempts += 1

        # Cleanup active retry tracking
        with self.retry_lock:
            self.active_retries.pop(original_ack, None)

        if attempt >= total_max:
            logger.warning(f"Auto-retry exhausted ({max_direct} direct + {max_flood} flood) "
                            f"for '{text[:30]}' → {recipient}")

    def _wait_for_any_ack(self, ack_codes, timeout_seconds, cancel_event):
        """Poll self.acks dict for any of the given ack_codes with timeout."""
        start = time.time()
        poll_interval = 0.5  # Check every 500ms
        while time.time() - start < timeout_seconds:
            for code in ack_codes:
                if code in self.acks:
                    return True
            if cancel_event.is_set():
                return False
            cancel_event.wait(poll_interval)
        return any(code in self.acks for code in ack_codes)

    def _parse_msg_response(self, stdout):
        """Parse msg command response (may be multi-line pretty-printed JSON).

        Returns dict with expected_ack, suggested_timeout, etc. or None.
        """
        if not stdout or not stdout.strip():
            return None

        # Try parsing the entire stdout as one JSON object (handles indent=4)
        try:
            data = json.loads(stdout.strip())
            if isinstance(data, dict) and 'expected_ack' in data:
                return data
        except (json.JSONDecodeError, ValueError):
            pass

        # Fallback: try each line individually (single-line JSON)
        for line in stdout.strip().split('\n'):
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
                if isinstance(data, dict) and 'expected_ack' in data:
                    return data
            except (json.JSONDecodeError, ValueError):
                continue

        # Last resort: regex extraction
        import re
        ack_match = re.search(r'"expected_ack"\s*:\s*"([0-9a-fA-F]+)"', stdout)
        timeout_match = re.search(r'"suggested_timeout"\s*:\s*(\d+)', stdout)
        if ack_match:
            result = {'expected_ack': ack_match.group(1)}
            if timeout_match:
                result['suggested_timeout'] = int(timeout_match.group(1))
            return result

        return None

    def _extract_ack_from_response(self, stdout):
        """Extract expected_ack from msg command response."""
        data = self._parse_msg_response(stdout)
        return data.get('expected_ack') if data else None

    def _extract_timeout_from_response(self, stdout):
        """Extract suggested_timeout from msg command response."""
        data = self._parse_msg_response(stdout)
        return data.get('suggested_timeout') if data else None

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
            "last_line_time": time.time(),
            "timeout": timeout  # Pass timeout to monitor thread
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

    def execute_ws_command(self, command_text, socket_id, timeout=DEFAULT_TIMEOUT):
        """
        Execute a CLI command from WebSocket client.

        The response will be emitted via socketio.emit in _monitor_response_timeout.

        Args:
            command_text: Raw command string from user
            socket_id: WebSocket session ID for response routing
            timeout: Max time to wait for response

        Returns:
            Dict with success status (response already emitted via WebSocket)
        """
        cmd_id = f"ws_{uuid.uuid4().hex[:8]}"

        # Parse command into args (respects quotes)
        try:
            args = shlex.split(command_text)
        except ValueError:
            args = command_text.split()

        # Build command line - use double quotes for args with spaces/special chars
        quoted_args = []
        for arg in args:
            if ' ' in arg or '"' in arg or "'" in arg:
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
            "last_line_time": time.time(),
            "socket_id": socket_id,  # Track which WebSocket client sent this
            "timeout": timeout  # Pass timeout to monitor thread
        }

        # Queue command
        self.command_queue.put((cmd_id, command, event, response_dict))
        logger.info(f"WebSocket command [{cmd_id}] queued: {command}")

        # Wait for completion
        if not event.wait(timeout):
            logger.error(f"WebSocket command [{cmd_id}] timeout after {timeout}s")

            # Cleanup
            with self.pending_lock:
                if cmd_id in self.pending_commands:
                    del self.pending_commands[cmd_id]

            # Emit error to client
            socketio.emit('command_response', {
                'success': False,
                'error': f'Command timeout after {timeout} seconds',
                'cmd_id': cmd_id
            }, room=socket_id, namespace='/console')

            return {'success': False, 'error': f'Command timeout after {timeout}s'}

        # Response already emitted in _monitor_response_timeout
        return {'success': True}

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
    """Health check endpoint with device name detection info"""
    session_status = "healthy" if meshcli_session and meshcli_session.process and meshcli_session.process.poll() is None else "unhealthy"

    # Determine device name and source
    detected_name = meshcli_session.detected_name if meshcli_session else None
    device_name = detected_name or MC_DEVICE_NAME
    name_source = "detected" if detected_name else "config"

    # Log warning if there's a mismatch between detected and configured names
    if detected_name and detected_name != MC_DEVICE_NAME:
        logger.warning(f"Device name mismatch: detected='{detected_name}', configured='{MC_DEVICE_NAME}'")

    return jsonify({
        'status': session_status,
        'serial_port': MC_SERIAL_PORT,
        'serial_port_source': SERIAL_PORT_SOURCE,
        'advert_log': str(meshcli_session.advert_log_path) if meshcli_session else None,
        'echoes_log': str(meshcli_session.echo_log_path) if meshcli_session else None,
        'device_name': device_name,
        'device_name_source': name_source
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

        # Force JSON output for msg/m commands (prefix with dot)
        # so we get expected_ack and suggested_timeout for auto-retry
        if args and args[0] in ('msg', 'm'):
            args = ['.' + args[0]] + args[1:]

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

        # Auto-retry: after successful msg command, start background retry
        if (result.get('success') and args and args[0] in ('.msg', '.m')
                and len(args) >= 3 and meshcli_session.auto_retry_enabled
                and meshcli_session.auto_retry_max_attempts > 1):
            stdout = result.get('stdout', '')
            expected_ack = meshcli_session._extract_ack_from_response(stdout)
            suggested_timeout = meshcli_session._extract_timeout_from_response(stdout)
            if expected_ack and suggested_timeout:
                recipient = args[1]
                text = args[2]
                meshcli_session._start_retry(
                    recipient, text, expected_ack, suggested_timeout
                )
            else:
                logger.warning(f"Auto-retry: could not extract ack/timeout from msg response: "
                               f"{stdout[:300]}")

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
                {
                    "name": "KRK - WD 🔌",
                    "public_key": "2d86b4a7...",
                    "type": 2,
                    "adv_lat": 50.02377,
                    "adv_lon": 19.96038,
                    "last_advert": 1715889153,
                    "lastmod": 1716372319,
                    "out_path_len": -1,
                    "out_path": ""
                }
            ],
            "count": 1
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

        # Execute .pending_contacts command (JSON format)
        result = meshcli_session.execute_command(['.pending_contacts'], timeout=DEFAULT_TIMEOUT)

        if not result['success']:
            return jsonify({
                'success': False,
                'error': result.get('stderr', 'Command failed'),
                'pending': [],
                'raw_stdout': result.get('stdout', '')
            }), 200

        # Parse JSON stdout using brace-matching (handles prettified multi-line JSON)
        stdout = result.get('stdout', '').strip()
        pending = []

        if stdout:
            # Use brace-matching to extract complete JSON objects
            depth = 0
            start_idx = None

            for i, char in enumerate(stdout):
                if char == '{':
                    if depth == 0:
                        start_idx = i
                    depth += 1
                elif char == '}':
                    depth -= 1
                    if depth == 0 and start_idx is not None:
                        json_str = stdout[start_idx:i+1]
                        try:
                            # Parse the JSON object (nested dict structure)
                            parsed = json.loads(json_str)

                            # Extract contacts from nested structure
                            # Format: {public_key_hash: {public_key, type, adv_name, ...}}
                            if isinstance(parsed, dict):
                                for key_hash, contact_data in parsed.items():
                                    if isinstance(contact_data, dict) and 'public_key' in contact_data:
                                        pending.append({
                                            'name': contact_data.get('adv_name', 'Unknown'),
                                            'public_key': contact_data.get('public_key', ''),
                                            'type': contact_data.get('type', 1),
                                            'adv_lat': contact_data.get('adv_lat', 0.0),
                                            'adv_lon': contact_data.get('adv_lon', 0.0),
                                            'last_advert': contact_data.get('last_advert', 0),
                                            'lastmod': contact_data.get('lastmod', 0),
                                            'out_path_len': contact_data.get('out_path_len', -1),
                                            'out_path': contact_data.get('out_path', '')
                                        })
                        except json.JSONDecodeError as e:
                            logger.warning(f"Failed to parse pending contact JSON: {e}")
                        start_idx = None

        return jsonify({
            'success': True,
            'pending': pending,
            'count': len(pending)
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


# =============================================================================
# Echo tracking endpoints for "Heard X repeats" feature
# =============================================================================

@app.route('/register_echo', methods=['POST'])
def register_echo():
    """
    Register a sent message for echo tracking.

    Called after successfully sending a channel message to start
    tracking repeater echoes for that message.

    Request JSON:
        {
            "channel_idx": 0,
            "timestamp": 1706500000.123
        }
    """
    if not meshcli_session:
        return jsonify({'success': False, 'error': 'Not initialized'}), 503

    data = request.get_json()
    channel_idx = data.get('channel_idx', 0)
    timestamp = data.get('timestamp', time.time())

    meshcli_session.register_pending_echo(channel_idx, timestamp)
    return jsonify({'success': True}), 200


@app.route('/echo_counts', methods=['GET'])
def get_echo_counts():
    """
    Get echo data for sent and incoming messages.

    Returns sent echo counts (with repeater paths) and incoming message
    path info, allowing the caller to match with displayed messages.

    Response JSON:
        {
            "success": true,
            "echo_counts": [
                {"timestamp": 1706500000.123, "channel_idx": 0, "count": 3, "paths": ["5e", "d1", "a3"], "pkt_payload": "abcd..."},
                ...
            ],
            "incoming_paths": [
                {"pkt_payload": "efgh...", "timestamp": 1706500000.456, "paths": [
                    {"path": "8a40a605", "path_len": 4, "snr": 11.0, "ts": 1706500000.456}, ...
                ]},
                ...
            ]
        }
    """
    if not meshcli_session:
        return jsonify({'success': False, 'error': 'Not initialized'}), 503

    with meshcli_session.echo_lock:
        sent = []
        for pkt_payload, data in meshcli_session.echo_counts.items():
            sent.append({
                'timestamp': data['timestamp'],
                'channel_idx': data['channel_idx'],
                'count': len(data['paths']),
                'paths': list(data['paths']),
                'pkt_payload': pkt_payload,
            })

        incoming = []
        for pkt_payload, data in meshcli_session.incoming_paths.items():
            incoming.append({
                'pkt_payload': pkt_payload,
                'timestamp': data['first_ts'],
                'paths': data['paths'],
            })

    return jsonify({
        'success': True,
        'echo_counts': sent,
        'incoming_paths': incoming
    }), 200


# =============================================================================
# ACK tracking endpoint for DM delivery status
# =============================================================================

@app.route('/ack_status', methods=['GET'])
def get_ack_status():
    """
    Get ACK status for sent DMs by their expected_ack codes.

    Query params:
        ack_codes: comma-separated list of expected_ack hex codes

    Response JSON:
        {
            "success": true,
            "acks": {
                "544a4d8f": {"snr": 13.0, "rssi": -32, "route": "DIRECT", "ts": 1706500000.123},
                "ff3b55ce": null
            }
        }
    """
    if not meshcli_session:
        return jsonify({'success': False, 'error': 'Not initialized'}), 503

    requested = request.args.get('ack_codes', '')
    codes = [c.strip() for c in requested.split(',') if c.strip()]

    result = {}
    for code in codes:
        ack_info = meshcli_session.acks.get(code)
        # If no ACK for this code, check retry group (maybe a retry attempt got the ACK)
        if ack_info is None:
            with meshcli_session.retry_lock:
                retry_codes = meshcli_session.retry_groups.get(code, [])
            for retry_code in retry_codes:
                ack_info = meshcli_session.acks.get(retry_code)
                if ack_info is not None:
                    break
        result[code] = ack_info

    return jsonify({'success': True, 'acks': result}), 200


# =============================================================================
# Auto-retry endpoints
# =============================================================================

@app.route('/retry_ack_codes', methods=['GET'])
def get_retry_ack_codes():
    """Return set of expected_ack codes that belong to retry attempts (not first send)."""
    if not meshcli_session:
        return jsonify({'success': False, 'error': 'Not initialized'}), 503

    with meshcli_session.retry_lock:
        codes = list(meshcli_session.retry_ack_codes)

    return jsonify({'success': True, 'retry_ack_codes': codes}), 200


@app.route('/auto_retry/config', methods=['GET'])
def get_auto_retry_config():
    """Get current auto-retry configuration."""
    if not meshcli_session:
        return jsonify({'success': False, 'error': 'Not initialized'}), 503

    return jsonify({
        'success': True,
        'enabled': meshcli_session.auto_retry_enabled,
        'max_attempts': meshcli_session.auto_retry_max_attempts,
        'max_flood': meshcli_session.auto_retry_max_flood,
        'active_retries': len(meshcli_session.active_retries),
    }), 200


@app.route('/auto_retry/config', methods=['POST'])
def set_auto_retry_config():
    """Update auto-retry configuration."""
    if not meshcli_session:
        return jsonify({'success': False, 'error': 'Not initialized'}), 503

    data = request.get_json()
    if not data:
        return jsonify({'success': False, 'error': 'Missing JSON body'}), 400

    if 'enabled' in data:
        meshcli_session.auto_retry_enabled = bool(data['enabled'])
    if 'max_attempts' in data:
        val = int(data['max_attempts'])
        meshcli_session.auto_retry_max_attempts = max(1, min(val, 10))
    if 'max_flood' in data:
        val = int(data['max_flood'])
        meshcli_session.auto_retry_max_flood = max(0, min(val, 10))

    logger.info(f"Auto-retry config updated: enabled={meshcli_session.auto_retry_enabled}, "
                f"max_attempts={meshcli_session.auto_retry_max_attempts}, "
                f"max_flood={meshcli_session.auto_retry_max_flood}")

    return jsonify({
        'success': True,
        'enabled': meshcli_session.auto_retry_enabled,
        'max_attempts': meshcli_session.auto_retry_max_attempts,
        'max_flood': meshcli_session.auto_retry_max_flood,
    }), 200


# =============================================================================
# WebSocket handlers for console
# =============================================================================

@socketio.on('connect', namespace='/console')
def console_connect():
    """Handle console client connection"""
    logger.info(f"Console client connected: {request.sid}")
    emit('console_status', {'status': 'connected', 'message': 'Connected to meshcli'})


@socketio.on('disconnect', namespace='/console')
def console_disconnect():
    """Handle console client disconnection"""
    logger.info(f"Console client disconnected: {request.sid}")


@socketio.on('send_command', namespace='/console')
def handle_console_command(data):
    """Handle command from console client"""
    if not meshcli_session or not meshcli_session.process:
        emit('command_response', {'success': False, 'error': 'meshcli session not available'})
        return

    command_text = data.get('command', '').strip()
    if not command_text:
        return

    logger.info(f"Console command from {request.sid}: {command_text}")

    # Execute command asynchronously using socketio background task
    def execute_async():
        meshcli_session.execute_ws_command(command_text, request.sid)

    socketio.start_background_task(execute_async)


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

    # Run with SocketIO (supports WebSocket) on all interfaces
    socketio.run(app, host='0.0.0.0', port=5001, debug=False)
