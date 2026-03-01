#!/usr/bin/env python3
"""
mc-webui Container Watchdog

Monitors Docker containers and automatically restarts unhealthy ones.
Designed to run as a systemd service on the host.

Features:
- Monitors container health status
- Automatically starts stopped containers (configurable)
- Captures logs before restart for diagnostics
- Logs all events to file
- HTTP endpoint for status check

Configuration via environment variables:
- MCWEBUI_DIR: Path to mc-webui directory (default: ~/mc-webui)
- CHECK_INTERVAL: Seconds between checks (default: 30)
- LOG_FILE: Path to log file (default: /var/log/mc-webui-watchdog.log)
- HTTP_PORT: Port for status endpoint (default: 5051, 0 to disable)
- AUTO_START: Start stopped containers (default: true, set to 'false' to disable)
"""

import os
import sys
import json
import subprocess
import threading
import time
import fcntl
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# Configuration
MCWEBUI_DIR = os.environ.get('MCWEBUI_DIR', os.path.expanduser('~/mc-webui'))
CHECK_INTERVAL = int(os.environ.get('CHECK_INTERVAL', '30'))
LOG_FILE = os.environ.get('LOG_FILE', '/var/log/mc-webui-watchdog.log')
HTTP_PORT = int(os.environ.get('HTTP_PORT', '5051'))
AUTO_START = os.environ.get('AUTO_START', 'true').lower() != 'false'

# Containers to monitor (v2: single container, no meshcore-bridge)
CONTAINERS = ['mc-webui']

# Global state
last_check_time = None
last_check_results = {}
restart_history = []


def log(message: str, level: str = 'INFO'):
    """Log message to file and stdout."""
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    line = f"[{timestamp}] [{level}] {message}"
    print(line)

    try:
        with open(LOG_FILE, 'a') as f:
            f.write(line + '\n')
    except Exception as e:
        print(f"[{timestamp}] [ERROR] Failed to write to log file: {e}")


# USB Device Reset Constant
USBDEVFS_RESET = 21780 # 0x5514

def auto_detect_usb_device() -> str:
    """Attempt to auto-detect the physical USB device path (e.g., /dev/bus/usb/001/002) for LoRa."""
    env_file = os.path.join(MCWEBUI_DIR, '.env')
    serial_port = 'auto'
    
    if os.path.exists(env_file):
        try:
            with open(env_file, 'r') as f:
                for line in f:
                    if line.startswith('MC_SERIAL_PORT='):
                        serial_port = line.split('=', 1)[1].strip().strip('"\'')
                        break
        except Exception as e:
            log(f"Failed to read .env file for serial port: {e}", "WARN")

    if serial_port.lower() == 'auto':
        by_id_path = Path('/dev/serial/by-id')
        if by_id_path.exists():
            devices = list(by_id_path.iterdir())
            if len(devices) == 1:
                serial_port = str(devices[0])
            elif len(devices) > 1:
                log("Multiple serial devices found, cannot auto-detect USB device for reset", "WARN")
                return None
            else:
                log("No serial devices found in /dev/serial/by-id", "WARN")
                return None
        else:
            log("/dev/serial/by-id does not exist", "WARN")
            return None

    if not serial_port or not os.path.exists(serial_port):
        log(f"Serial port {serial_port} not found", "WARN")
        return None

    try:
        # Resolve symlink to get actual tty device (e.g., /dev/ttyACM0)
        real_tty = os.path.realpath(serial_port)
        tty_name = os.path.basename(real_tty)

        # Find USB bus and dev number via sysfs
        sysfs_path = f"/sys/class/tty/{tty_name}/device"
        if not os.path.exists(sysfs_path):
            log(f"Sysfs path {sysfs_path} not found", "WARN")
            return None

        usb_dev_dir = os.path.dirname(os.path.realpath(sysfs_path))
        busnum_file = os.path.join(usb_dev_dir, "busnum")
        devnum_file = os.path.join(usb_dev_dir, "devnum")

        if os.path.exists(busnum_file) and os.path.exists(devnum_file):
            with open(busnum_file) as f:
                busnum = int(f.read().strip())
            with open(devnum_file) as f:
                devnum = int(f.read().strip())
            return f"/dev/bus/usb/{busnum:03d}/{devnum:03d}"
            
        log("Could not find busnum/devnum files in sysfs", "WARN")
        return None
    except Exception as e:
        log(f"Error during USB device auto-detection: {e}", "ERROR")
        return None

def reset_usb_device():
    """Perform a hardware USB bus reset on the LoRa device."""
    device_path = os.environ.get('USB_DEVICE_PATH')
    if not device_path:
        device_path = auto_detect_usb_device()

    if not device_path:
        log("Cannot perform USB reset: device path could not be determined", "WARN")
        return False

    log(f"Performing hardware USB bus reset on {device_path}", "WARN")
    try:
        with open(device_path, 'w') as fd:
            fcntl.ioctl(fd, USBDEVFS_RESET, 0)
        log("USB bus reset successful", "INFO")
        return True
    except Exception as e:
        log(f"USB reset failed: {e}", "ERROR")
        return False

def count_recent_restarts(container_name: str, minutes: int = 8) -> int:
    """Count how many times a container was restarted in the last N minutes due to unhealthiness."""
    cutoff_time = time.time() - (minutes * 60)
    count = 0
    for entry in restart_history:
        if entry.get('container') == container_name and 'restart_success' in entry:
            try:
                dt = datetime.fromisoformat(entry['timestamp'])
                if dt.timestamp() >= cutoff_time:
                    count += 1
            except ValueError:
                pass
    return count


def run_docker_command(args: list, timeout: int = 30) -> tuple:
    """Run docker command and return (success, stdout, stderr)."""
    try:
        result = subprocess.run(
            ['docker'] + args,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=MCWEBUI_DIR
        )
        return result.returncode == 0, result.stdout.strip(), result.stderr.strip()
    except subprocess.TimeoutExpired:
        return False, '', 'Command timed out'
    except Exception as e:
        return False, '', str(e)


def run_compose_command(args: list, timeout: int = 60) -> tuple:
    """Run docker compose command and return (success, stdout, stderr)."""
    try:
        result = subprocess.run(
            ['docker', 'compose'] + args,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=MCWEBUI_DIR
        )
        return result.returncode == 0, result.stdout.strip(), result.stderr.strip()
    except subprocess.TimeoutExpired:
        return False, '', 'Command timed out'
    except Exception as e:
        return False, '', str(e)


def get_container_status(container_name: str) -> dict:
    """Get container status including health."""
    # Get container info
    success, stdout, stderr = run_docker_command([
        'inspect',
        '--format', '{{.State.Status}}|{{.State.Health.Status}}|{{.State.StartedAt}}',
        container_name
    ])

    if not success:
        return {
            'name': container_name,
            'exists': False,
            'status': 'not_found',
            'health': 'unknown',
            'error': stderr
        }

    parts = stdout.split('|')
    status = parts[0] if len(parts) > 0 else 'unknown'
    health = parts[1] if len(parts) > 1 else 'none'
    started_at = parts[2] if len(parts) > 2 else ''

    # Handle empty health (no healthcheck defined)
    if health == '' or health == '<no value>':
        health = 'none'

    return {
        'name': container_name,
        'exists': True,
        'status': status,
        'health': health,
        'started_at': started_at
    }


def get_container_logs(container_name: str, lines: int = 100) -> str:
    """Get recent container logs."""
    success, stdout, stderr = run_compose_command([
        'logs', '--tail', str(lines), container_name
    ])
    return stdout if success else f"Failed to get logs: {stderr}"


def restart_container(container_name: str) -> bool:
    """Restart a container using docker compose."""
    log(f"Restarting container: {container_name}", 'WARN')

    success, stdout, stderr = run_compose_command([
        'restart', container_name
    ], timeout=120)

    if success:
        log(f"Container {container_name} restarted successfully")
        return True
    else:
        log(f"Failed to restart {container_name}: {stderr}", 'ERROR')
        return False


def start_container(container_name: str) -> bool:
    """Start a stopped container using docker compose."""
    log(f"Starting container: {container_name}", 'WARN')

    success, stdout, stderr = run_compose_command([
        'start', container_name
    ], timeout=120)

    if success:
        log(f"Container {container_name} started successfully")
        return True
    else:
        log(f"Failed to start {container_name}: {stderr}", 'ERROR')
        return False


def handle_stopped_container(container_name: str, status: dict):
    """Handle a stopped container - log and start it."""
    global restart_history

    log(f"Container {container_name} is stopped! Status: {status['status']}", 'WARN')

    # Start the container
    start_success = start_container(container_name)

    # Record in history
    restart_history.append({
        'timestamp': datetime.now().isoformat(),
        'container': container_name,
        'action': 'start',
        'status_before': status,
        'success': start_success
    })

    # Keep only last 50 entries
    if len(restart_history) > 50:
        restart_history = restart_history[-50:]


def handle_unhealthy_container(container_name: str, status: dict):
    """Handle an unhealthy container - log details and restart."""
    global restart_history

    log(f"Container {container_name} is unhealthy! Status: {status}", 'WARN')

    # Capture logs before restart
    log(f"Capturing logs from {container_name} before restart...")
    logs = get_container_logs(container_name, lines=200)

    # Save detailed diagnostic info
    diag_file = f"/tmp/mc-webui-watchdog-{container_name}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.log"
    try:
        with open(diag_file, 'w') as f:
            f.write(f"=== Container Diagnostic Report ===\n")
            f.write(f"Timestamp: {datetime.now().isoformat()}\n")
            f.write(f"Container: {container_name}\n")
            f.write(f"Status: {json.dumps(status, indent=2)}\n")
            f.write(f"\n=== Recent Logs ===\n")
            f.write(logs)
        log(f"Diagnostic info saved to: {diag_file}")
    except Exception as e:
        log(f"Failed to save diagnostic info: {e}", 'ERROR')

    # v2: mc-webui owns the device connection directly — USB reset if repeated failures
    if container_name == 'mc-webui':
        recent_restarts = count_recent_restarts(container_name, minutes=8)
        if recent_restarts >= 3:
            log(f"{container_name} has been restarted {recent_restarts} times in the last 8 minutes. Attempting hardware USB reset.", "WARN")
            if reset_usb_device():
                time.sleep(2)  # Give OS time to re-enumerate the device before Docker brings it back

    # Restart the container
    restart_success = restart_container(container_name)

    # Record in history
    restart_history.append({
        'timestamp': datetime.now().isoformat(),
        'container': container_name,
        'status_before': status,
        'restart_success': restart_success,
        'diagnostic_file': diag_file
    })

    # Keep only last 50 entries
    if len(restart_history) > 50:
        restart_history = restart_history[-50:]


def check_containers():
    """Check all monitored containers."""
    global last_check_time, last_check_results

    last_check_time = datetime.now().isoformat()
    results = {}

    for container_name in CONTAINERS:
        status = get_container_status(container_name)
        results[container_name] = status

        # Check if container needs attention
        if not status['exists']:
            log(f"Container {container_name} not found", 'WARN')
        elif status['status'] != 'running':
            if AUTO_START:
                handle_stopped_container(container_name, status)
            else:
                log(f"Container {container_name} is not running (status: {status['status']}), AUTO_START disabled", 'WARN')
        elif status['health'] == 'unhealthy':
            handle_unhealthy_container(container_name, status)

    last_check_results = results
    return results


class WatchdogHandler(BaseHTTPRequestHandler):
    """HTTP request handler for watchdog status."""

    def log_message(self, format, *args):
        """Suppress default logging."""
        pass

    def send_json(self, data, status=200):
        """Send JSON response."""
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data, indent=2).encode())

    def do_GET(self):
        """Handle GET requests."""
        if self.path == '/health':
            self.send_json({
                'status': 'ok',
                'service': 'mc-webui-watchdog',
                'check_interval': CHECK_INTERVAL,
                'last_check': last_check_time
            })
        elif self.path == '/status':
            self.send_json({
                'last_check_time': last_check_time,
                'containers': last_check_results,
                'restart_history_count': len(restart_history),
                'recent_restarts': restart_history[-10:] if restart_history else []
            })
        elif self.path == '/history':
            self.send_json({
                'restart_history': restart_history
            })
        else:
            self.send_json({'error': 'Not found'}, 404)


def run_http_server():
    """Run HTTP status server."""
    if HTTP_PORT <= 0:
        return

    try:
        server = HTTPServer(('0.0.0.0', HTTP_PORT), WatchdogHandler)
        log(f"HTTP status server started on port {HTTP_PORT}")
        server.serve_forever()
    except Exception as e:
        log(f"HTTP server error: {e}", 'ERROR')


def main():
    """Main entry point."""
    log("=" * 60)
    log("mc-webui Container Watchdog starting")
    log(f"  mc-webui directory: {MCWEBUI_DIR}")
    log(f"  Check interval: {CHECK_INTERVAL}s")
    log(f"  Log file: {LOG_FILE}")
    log(f"  HTTP port: {HTTP_PORT if HTTP_PORT > 0 else 'disabled'}")
    log(f"  Auto-start stopped containers: {AUTO_START}")
    log(f"  Monitoring containers: {', '.join(CONTAINERS)}")
    log("=" * 60)

    # Verify mc-webui directory exists
    if not os.path.exists(MCWEBUI_DIR):
        log(f"WARNING: mc-webui directory not found: {MCWEBUI_DIR}", 'WARN')

    # Verify docker is available
    success, stdout, stderr = run_docker_command(['--version'])
    if not success:
        log(f"ERROR: Docker not available: {stderr}", 'ERROR')
        sys.exit(1)
    log(f"Docker version: {stdout}")

    # Start HTTP server in background thread
    if HTTP_PORT > 0:
        http_thread = threading.Thread(target=run_http_server, daemon=True)
        http_thread.start()

    # Main monitoring loop
    log("Starting monitoring loop...")
    try:
        while True:
            try:
                check_containers()
            except Exception as e:
                log(f"Error during container check: {e}", 'ERROR')

            time.sleep(CHECK_INTERVAL)
    except KeyboardInterrupt:
        log("Shutting down...")


if __name__ == '__main__':
    main()
