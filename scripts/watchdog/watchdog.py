#!/usr/bin/env python3
"""
mc-webui Container Watchdog

Monitors Docker containers and automatically restarts unhealthy ones.
Designed to run as a systemd service on the host.

Features:
- Monitors container health status
- Captures logs before restart for diagnostics
- Logs all events to file
- HTTP endpoint for status check

Configuration via environment variables:
- MCWEBUI_DIR: Path to mc-webui directory (default: ~/mc-webui)
- CHECK_INTERVAL: Seconds between checks (default: 30)
- LOG_FILE: Path to log file (default: /var/log/mc-webui-watchdog.log)
- HTTP_PORT: Port for status endpoint (default: 5051, 0 to disable)
"""

import os
import sys
import json
import subprocess
import threading
import time
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# Configuration
MCWEBUI_DIR = os.environ.get('MCWEBUI_DIR', os.path.expanduser('~/mc-webui'))
CHECK_INTERVAL = int(os.environ.get('CHECK_INTERVAL', '30'))
LOG_FILE = os.environ.get('LOG_FILE', '/var/log/mc-webui-watchdog.log')
HTTP_PORT = int(os.environ.get('HTTP_PORT', '5051'))

# Containers to monitor
CONTAINERS = ['meshcore-bridge', 'mc-webui']

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
            log(f"Container {container_name} is not running (status: {status['status']})", 'WARN')
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
