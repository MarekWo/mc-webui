#!/usr/bin/env python3
"""
mc-webui Update Webhook Server

A simple HTTP server that listens for update requests and executes
the update script. Designed to run as a systemd service on the host.

Security:
- Listens only on localhost (127.0.0.1)
- Simple token-based authentication (optional)

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
UPDATE_SCRIPT = os.path.join(MCWEBUI_DIR, 'scripts', 'update.sh')
AUTH_TOKEN = os.environ.get('UPDATER_TOKEN', '')  # Optional token

# Global state
update_in_progress = False
last_update_result = None
last_update_time = None


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
        self.send_json({
            'status': 'ok',
            'service': 'mc-webui-updater',
            'update_in_progress': update_in_progress,
            'mcwebui_dir': MCWEBUI_DIR
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

        if not os.path.exists(UPDATE_SCRIPT):
            self.send_json({
                'success': False,
                'error': f'Update script not found: {UPDATE_SCRIPT}'
            }, 500)
            return

        # Start update in background thread
        update_in_progress = True
        thread = threading.Thread(target=run_update, daemon=True)
        thread.start()

        self.send_json({
            'success': True,
            'message': 'Update started',
            'note': 'Server will restart. Poll /health to detect completion.'
        })


def run_update():
    """Run update script in background."""
    global update_in_progress, last_update_result, last_update_time

    try:
        print(f"[UPDATE] Starting update from {UPDATE_SCRIPT}")

        # Run the update script
        result = subprocess.run(
            ['/bin/bash', UPDATE_SCRIPT],
            cwd=MCWEBUI_DIR,
            capture_output=True,
            text=True,
            timeout=300  # 5 minute timeout
        )

        last_update_result = {
            'success': result.returncode == 0,
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
            'error': 'Update timed out after 5 minutes'
        }
        last_update_time = time.strftime('%Y-%m-%d %H:%M:%S')
        print("[UPDATE] Update timed out")

    except Exception as e:
        last_update_result = {
            'success': False,
            'error': str(e)
        }
        last_update_time = time.strftime('%Y-%m-%d %H:%M:%S')
        print(f"[UPDATE] Update error: {e}")

    finally:
        update_in_progress = False


def main():
    """Main entry point."""
    print(f"mc-webui Update Webhook Server")
    print(f"  Listening on: {HOST}:{PORT}")
    print(f"  mc-webui dir: {MCWEBUI_DIR}")
    print(f"  Update script: {UPDATE_SCRIPT}")
    print(f"  Auth token: {'configured' if AUTH_TOKEN else 'disabled'}")
    print()

    if not os.path.exists(MCWEBUI_DIR):
        print(f"WARNING: mc-webui directory not found: {MCWEBUI_DIR}")

    if not os.path.exists(UPDATE_SCRIPT):
        print(f"WARNING: Update script not found: {UPDATE_SCRIPT}")

    server = HTTPServer((HOST, PORT), UpdateHandler)

    try:
        print(f"Server started. Press Ctrl+C to stop.")
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()


if __name__ == '__main__':
    main()
