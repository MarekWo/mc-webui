#!/usr/bin/env python3
"""
mc-webui Update Webhook Server

A simple HTTP server that listens for update requests and executes
the update script. Designed to run as a systemd service on the host.

Two kinds of installation are supported, told apart at request time:
- source - a git checkout: runs scripts/update.sh (git pull + rebuild)
- image  - a bare docker-compose.yml using the published Docker Hub image:
           runs update-image.sh (docker compose pull + up -d)

Security:
- Listens on all interfaces: the mc-webui container reaches this over the
  Docker bridge, so binding to loopback would put it out of reach
- Token authentication is available via UPDATER_TOKEN but off by default,
  and the web UI does not send one - anyone who can reach port 5050 can
  trigger an update, so keep the port off untrusted networks

Endpoints:
- GET  /health  - Check if webhook is running
- POST /update  - Trigger update (returns immediately, runs in background)
- GET  /status  - Check if update is in progress
"""

import os
import sys
import json
import subprocess
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

# Configuration
HOST = '0.0.0.0'  # Listen on all interfaces (Docker needs this)
PORT = 5050
MCWEBUI_DIR = os.environ.get('MCWEBUI_DIR', os.path.expanduser('~/mc-webui'))
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SOURCE_UPDATE_SCRIPT = os.path.join(MCWEBUI_DIR, 'scripts', 'update.sh')
IMAGE_UPDATE_SCRIPT = os.path.join(SCRIPT_DIR, 'update-image.sh')
AUTH_TOKEN = os.environ.get('UPDATER_TOKEN', '')  # Optional token

# Global state
update_in_progress = False
last_update_result = None
last_update_time = None


def detect_mode():
    """Decide how this installation updates itself.

    Resolved per request rather than cached at startup, so cloning the
    repository into what was an image-only installation flips the mode
    without anyone remembering to restart this service.

    Returns 'source', 'image', or 'unknown'.
    """
    if (os.path.isdir(os.path.join(MCWEBUI_DIR, '.git'))
            and os.path.exists(SOURCE_UPDATE_SCRIPT)):
        return 'source'

    for name in ('docker-compose.yml', 'docker-compose.yaml'):
        if os.path.exists(os.path.join(MCWEBUI_DIR, name)):
            return 'image'

    return 'unknown'


def resolve_update_script():
    """Return (mode, script_path); script_path is None when there is none."""
    mode = detect_mode()
    if mode == 'source':
        return mode, SOURCE_UPDATE_SCRIPT
    if mode == 'image':
        return mode, IMAGE_UPDATE_SCRIPT
    return mode, None


class UpdateHandler(BaseHTTPRequestHandler):
    """HTTP request handler for update webhook."""

    def log_message(self, format, *args):
        """Override to use custom logging format."""
        print(f"[{self.log_date_time_string()}] {args[0]}")

    def send_json(self, data, status=200):
        """Send JSON response."""
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def check_auth(self):
        """Check authorization token if configured."""
        if not AUTH_TOKEN:
            return True

        auth_header = self.headers.get('Authorization', '')
        if auth_header.startswith('Bearer '):
            token = auth_header[7:]
            return token == AUTH_TOKEN

        # Also check query parameter
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)
        token = params.get('token', [''])[0]
        return token == AUTH_TOKEN

    def do_OPTIONS(self):
        """Handle CORS preflight."""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        self.end_headers()

    def do_GET(self):
        """Handle GET requests."""
        parsed = urlparse(self.path)
        path = parsed.path

        if path == '/health':
            self.handle_health()
        elif path == '/status':
            self.handle_status()
        else:
            self.send_json({'error': 'Not found'}, 404)

    def do_POST(self):
        """Handle POST requests."""
        parsed = urlparse(self.path)
        path = parsed.path

        if path == '/update':
            self.handle_update()
        else:
            self.send_json({'error': 'Not found'}, 404)

    def handle_health(self):
        """Health check endpoint."""
        mode, script = resolve_update_script()
        self.send_json({
            'status': 'ok',
            'service': 'mc-webui-updater',
            'update_in_progress': update_in_progress,
            'mcwebui_dir': MCWEBUI_DIR,
            'mode': mode,
            'update_script': script,
            'update_script_present': bool(script and os.path.exists(script)),
            # Carried here as well so the web UI can read the outcome of the
            # run it just triggered without a second round trip.
            'last_update_result': last_update_result,
            'last_update_time': last_update_time
        })

    def handle_status(self):
        """Get update status."""
        self.send_json({
            'update_in_progress': update_in_progress,
            'last_update_result': last_update_result,
            'last_update_time': last_update_time
        })

    def handle_update(self):
        """Trigger update."""
        global update_in_progress

        if not self.check_auth():
            self.send_json({'error': 'Unauthorized'}, 401)
            return

        if update_in_progress:
            self.send_json({
                'success': False,
                'error': 'Update already in progress'
            }, 409)
            return

        mode, script = resolve_update_script()

        if mode == 'unknown':
            self.send_json({
                'success': False,
                'error': (f'No mc-webui installation found in {MCWEBUI_DIR}: '
                          'neither a git checkout nor a docker-compose.yml.')
            }, 500)
            return

        if not script or not os.path.exists(script):
            self.send_json({
                'success': False,
                'error': f'Update script not found: {script}'
            }, 500)
            return

        # Start update in background thread
        update_in_progress = True
        thread = threading.Thread(
            target=run_update, args=(mode, script), daemon=True
        )
        thread.start()

        self.send_json({
            'success': True,
            'mode': mode,
            'message': 'Update started',
            'note': 'Server will restart. Poll /health to detect completion.'
        })


def parse_result_marker(stdout):
    """Read the MC_UPDATE_RESULT=... line the update scripts print last.

    It separates "something new was installed" from "the remote had nothing
    newer". Without it the web UI can only watch for the version to change,
    and then sits through its whole timeout whenever there was legitimately
    nothing to change - which is the normal case while a pushed commit is
    still being built into an image. None means a script older than the
    marker, and the caller should fall back to watching the version.
    """
    for line in reversed((stdout or '').strip().splitlines()):
        line = line.strip()
        if line.startswith('MC_UPDATE_RESULT='):
            return line.split('=', 1)[1].strip()
    return None


def run_update(mode, script):
    """Run update script in background."""
    global update_in_progress, last_update_result, last_update_time

    try:
        print(f"[UPDATE] Starting {mode} update from {script}")

        # Run the update script
        result = subprocess.run(
            ['/bin/bash', script],
            cwd=MCWEBUI_DIR,
            capture_output=True,
            text=True,
            timeout=300  # 5 minute timeout
        )

        marker = parse_result_marker(result.stdout)
        last_update_result = {
            'success': result.returncode == 0,
            'mode': mode,
            'changed': None if marker is None else marker == 'updated',
            'returncode': result.returncode,
            'stdout': result.stdout[-2000:] if result.stdout else '',  # Last 2000 chars
            'stderr': result.stderr[-500:] if result.stderr else ''
        }
        last_update_time = time.strftime('%Y-%m-%d %H:%M:%S')

        if result.returncode == 0:
            print(f"[UPDATE] Update completed successfully")
        else:
            print(f"[UPDATE] Update failed with code {result.returncode}")
            print(f"[UPDATE] stderr: {result.stderr}")

    except subprocess.TimeoutExpired:
        last_update_result = {
            'success': False,
            'mode': mode,
            'error': 'Update timed out after 5 minutes'
        }
        last_update_time = time.strftime('%Y-%m-%d %H:%M:%S')
        print("[UPDATE] Update timed out")

    except Exception as e:
        last_update_result = {
            'success': False,
            'mode': mode,
            'error': str(e)
        }
        last_update_time = time.strftime('%Y-%m-%d %H:%M:%S')
        print(f"[UPDATE] Update error: {e}")

    finally:
        update_in_progress = False


def main():
    """Main entry point."""
    mode, script = resolve_update_script()

    print(f"mc-webui Update Webhook Server")
    print(f"  Listening on: {HOST}:{PORT}")
    print(f"  mc-webui dir: {MCWEBUI_DIR}")
    print(f"  Install mode: {mode}")
    print(f"  Update script: {script or '(none)'}")
    print(f"  Auth token: {'configured' if AUTH_TOKEN else 'disabled'}")
    print()

    if not os.path.exists(MCWEBUI_DIR):
        print(f"WARNING: mc-webui directory not found: {MCWEBUI_DIR}")

    if mode == 'unknown':
        print(f"WARNING: {MCWEBUI_DIR} holds neither a git checkout nor a "
              "docker-compose.yml - nothing to update")
    elif not script or not os.path.exists(script):
        print(f"WARNING: Update script not found: {script}")

    server = HTTPServer((HOST, PORT), UpdateHandler)

    try:
        print(f"Server started. Press Ctrl+C to stop.")
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()


if __name__ == '__main__':
    main()
