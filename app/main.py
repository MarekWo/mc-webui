"""
mc-webui v2 — Flask application entry point

Direct device communication via meshcore library (no bridge).
"""

import logging
import shlex
import threading
import time
from flask import Flask, request as flask_request
from flask_socketio import SocketIO, emit
from app.config import config, runtime_config
from app.database import Database
from app.device_manager import DeviceManager
from app.routes.views import views_bp
from app.routes.api import api_bp
from app.version import VERSION_STRING, GIT_BRANCH

# Configure logging
logging.basicConfig(
    level=getattr(logging, config.MC_LOG_LEVEL, logging.INFO),
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

logger = logging.getLogger(__name__)


# Filter to suppress known werkzeug WebSocket errors
class WerkzeugWebSocketFilter(logging.Filter):
    def filter(self, record):
        if record.levelno == logging.ERROR:
            if 'write() before start_response' in str(record.msg):
                return False
            if record.exc_info and record.exc_info[1]:
                if 'write() before start_response' in str(record.exc_info[1]):
                    return False
        return True


logging.getLogger('werkzeug').addFilter(WerkzeugWebSocketFilter())

# Initialize SocketIO globally
socketio = SocketIO()

# Global references (set in create_app)
db = None
device_manager = None


def create_app():
    """Create and configure Flask application"""
    global db, device_manager

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

    # Initialize SocketIO
    socketio.init_app(app, cors_allowed_origins="*", async_mode='threading')

    # v2: Initialize database
    db = Database(config.db_path)
    app.db = db

    # v2: Initialize and start device manager
    device_manager = DeviceManager(config, db, socketio)
    app.device_manager = device_manager

    # Start device connection in background (non-blocking)
    device_manager.start()

    # Update runtime config when device connects, then run v1 migration if needed
    def _wait_for_device_name():
        """Wait for device manager to connect and update runtime config."""
        for _ in range(60):  # wait up to 60 seconds
            time.sleep(1)
            if device_manager.is_connected:
                runtime_config.set_device_name(
                    device_manager.device_name, "device"
                )
                logger.info(f"Device name resolved: {device_manager.device_name}")

                # Auto-migrate v1 data if .msgs file exists and DB is empty
                try:
                    from app.migrate_v1 import should_migrate, migrate_v1_data
                    from pathlib import Path
                    data_dir = Path(config.MC_CONFIG_DIR)
                    dev_name = device_manager.device_name
                    if should_migrate(db, data_dir, dev_name):
                        logger.info("v1 .msgs file detected with empty DB — starting migration")
                        result = migrate_v1_data(db, data_dir, dev_name)
                        logger.info(f"v1 migration result: {result}")
                except Exception as e:
                    logger.error(f"v1 migration failed: {e}")

                return
        logger.warning("Timeout waiting for device connection")

    threading.Thread(target=_wait_for_device_name, daemon=True).start()

    # Start background scheduler (archiving, contact cleanup, message retention)
    from app.archiver.manager import schedule_daily_archiving, init_retention_schedule
    schedule_daily_archiving()
    init_retention_schedule(db=db)

    logger.info(f"mc-webui v2 started — transport: {'TCP' if config.use_tcp else 'serial'}")
    logger.info(f"Database: {config.db_path}")

    return app


# ============================================================
# WebSocket handlers for Chat (real-time message push)
# ============================================================

@socketio.on('connect', namespace='/chat')
def handle_chat_connect():
    """Handle chat WebSocket connection — required for /chat namespace to accept clients."""
    logger.info("Chat WebSocket client connected")


@socketio.on('disconnect', namespace='/chat')
def handle_chat_disconnect():
    logger.debug("Chat WebSocket client disconnected")


# ============================================================
# WebSocket handlers for Console
# ============================================================

@socketio.on('connect', namespace='/console')
def handle_console_connect():
    """Handle console WebSocket connection"""
    logger.info("Console WebSocket client connected")
    emit('console_status', {'message': 'Connected to mc-webui console'})


@socketio.on('disconnect', namespace='/console')
def handle_console_disconnect():
    """Handle console WebSocket disconnection"""
    logger.info("Console WebSocket client disconnected")


@socketio.on('send_command', namespace='/console')
def handle_send_command(data):
    """Handle command from console client — route through DeviceManager."""
    command = data.get('command', '').strip()
    sid = flask_request.sid

    if not command:
        emit('command_response', {'success': False, 'error': 'Empty command'})
        return

    logger.info(f"Console command received: {command}")

    def execute_and_respond():
        try:
            try:
                args = shlex.split(command)
            except ValueError:
                args = command.split()

            if not args:
                socketio.emit('command_response', {
                    'success': False, 'command': command, 'error': 'Empty command'
                }, room=sid, namespace='/console')
                return

            output = _execute_console_command(args)

            socketio.emit('command_response', {
                'success': True,
                'command': command,
                'output': output or '(no output)'
            }, room=sid, namespace='/console')

        except Exception as e:
            logger.error(f"Console command error: {e}")
            socketio.emit('command_response', {
                'success': False,
                'command': command,
                'error': str(e)
            }, room=sid, namespace='/console')

    socketio.start_background_task(execute_and_respond)


def _execute_console_command(args: list) -> str:
    """
    Execute a console command via DeviceManager.
    Maps meshcli-style text commands to DeviceManager methods.
    Simplified router — full ConsoleRouter planned for Phase 2.
    """
    cmd = args[0].lower()

    if not device_manager or not device_manager.is_connected:
        return "Error: Device not connected"

    if cmd == 'infos':
        info = device_manager.get_device_info()
        if info:
            lines = [f"  {k}: {v}" for k, v in info.items()]
            return "Device Info:\n" + "\n".join(lines)
        return "No device info available"

    elif cmd == 'contacts':
        # Show device-only contacts with path info (like meshcore-cli)
        type_names = {0: 'NONE', 1: 'CLI', 2: 'REP', 3: 'ROOM', 4: 'SENS'}
        if not device_manager.mc or not device_manager.mc.contacts:
            return "No contacts on device"
        try:
            device_manager.execute(device_manager.mc.ensure_contacts(follow=True))
        except Exception:
            pass  # use whatever is in memory
        lines = []
        for pk, c in device_manager.mc.contacts.items():
            name = c.get('adv_name', c.get('name', '?'))
            typ = type_names.get(c.get('type', 1), '?')
            pk_short = pk[:12]
            opl = c.get('out_path_len', -1)
            if opl > 0:
                # Decode path: lower 6 bits = hop count, upper 2 bits = hash_size-1
                hop_count = opl & 0x3F
                hash_size = (opl >> 6) + 1
                raw = c.get('out_path', '')
                meaningful = raw[:hop_count * hash_size * 2]
                chunk = hash_size * 2
                hops = [meaningful[i:i+chunk].upper() for i in range(0, len(meaningful), chunk)]
                path_str = '→'.join(hops) if hops else f'len:{opl}'
            elif opl == 0:
                path_str = 'Direct'
            else:
                path_str = 'Flood'
            lines.append(f"  {name:30} {typ:4}  {pk_short}  {path_str}")
        return f"Contacts ({len(lines)}) on device:\n" + "\n".join(lines)

    elif cmd == 'contacts_all':
        # Show all known contacts (device + cached from DB)
        contacts = device_manager.get_contacts_from_device()
        if not contacts:
            return "No contacts"
        lines = []
        for c in contacts:
            name = c.get('name', '?')
            pk = c.get('public_key', '')[:12]
            source = c.get('source', '')
            lines.append(f"  {name} ({pk}...) [{source}]")
        return f"All contacts ({len(contacts)}):\n" + "\n".join(lines)

    elif cmd == 'bat':
        bat = device_manager.get_battery()
        if bat:
            return f"Battery: {bat}"
        return "Battery info unavailable"

    elif cmd in ('advert', 'floodadv'):
        result = device_manager.send_advert(flood=(cmd == 'floodadv'))
        return result.get('message', result.get('error', 'Unknown'))

    elif cmd == 'chan' and len(args) >= 3:
        try:
            ch_idx = int(args[1])
            text = ' '.join(args[2:])
            result = device_manager.send_channel_message(ch_idx, text)
            return result.get('message', result.get('error', 'Unknown'))
        except (ValueError, IndexError):
            return "Usage: chan <channel_idx> <message>"

    elif cmd == 'msg' and len(args) >= 3:
        recipient = args[1]
        text = ' '.join(args[2:])
        contact = device_manager.mc.get_contact_by_name(recipient)
        if contact:
            pubkey = contact.get('public_key', recipient)
        else:
            pubkey = recipient
        result = device_manager.send_dm(pubkey, text)
        return result.get('message', result.get('error', 'Unknown'))

    elif cmd == 'status':
        connected = device_manager.is_connected
        info = device_manager.get_device_info()
        name = info.get('name', info.get('adv_name', 'Unknown')) if info else 'Unknown'
        bat = device_manager.get_battery()
        bat_str = f"{bat.get('voltage', '?')}V" if bat and isinstance(bat, dict) else str(bat) if bat else 'N/A'
        contacts_count = len(device_manager.db.get_contacts()) if device_manager.db else 0
        return (
            f"Device Status:\n"
            f"  Connected: {connected}\n"
            f"  Name: {name}\n"
            f"  Battery: {bat_str}\n"
            f"  Contacts: {contacts_count}"
        )

    elif cmd == 'channels':
        lines = []
        for i in range(device_manager._max_channels):
            ch = device_manager.get_channel_info(i)
            if ch and ch.get('name'):
                lines.append(f"  [{i}] {ch['name']}")
        if not lines:
            return "No channels configured"
        return f"Channels ({len(lines)}):\n" + "\n".join(lines)

    elif cmd == 'stats':
        stats = device_manager.get_device_stats()
        if not stats:
            return "No statistics available"
        lines = ["Device Statistics:"]
        if 'core' in stats:
            core = stats['core']
            uptime_s = core.get('uptime', 0)
            days, rem = divmod(uptime_s, 86400)
            hours, rem = divmod(rem, 3600)
            mins = rem // 60
            lines.append(f"  Uptime: {int(days)}d {int(hours)}h {int(mins)}m")
            if 'queue_length' in core:
                lines.append(f"  Queue: {core['queue_length']}")
            if 'errors' in core:
                lines.append(f"  Errors: {core['errors']}")
        if 'radio' in stats:
            radio = stats['radio']
            if 'tx_air_time' in radio:
                lines.append(f"  TX air time: {radio['tx_air_time']:.1f} min")
            if 'rx_air_time' in radio:
                lines.append(f"  RX air time: {radio['rx_air_time']:.1f} min")
        if 'packets' in stats:
            pkts = stats['packets']
            if 'sent' in pkts:
                lines.append(f"  Packets TX: {pkts['sent']}")
            if 'received' in pkts:
                lines.append(f"  Packets RX: {pkts['received']}")
        return "\n".join(lines)

    elif cmd == 'telemetry' and len(args) >= 2:
        contact_name = ' '.join(args[1:])
        result = device_manager.request_telemetry(contact_name)
        if not result:
            return "Telemetry unavailable"
        if 'error' in result:
            return f"Error: {result['error']}"
        lines = [f"Telemetry: {contact_name}"]
        for k, v in result.items():
            lines.append(f"  {k}: {v}")
        return "\n".join(lines)

    elif cmd == 'neighbors' and len(args) >= 2:
        contact_name = ' '.join(args[1:])
        result = device_manager.request_neighbors(contact_name)
        if not result:
            return "Neighbors unavailable"
        if 'error' in result:
            return f"Error: {result['error']}"
        if isinstance(result, list):
            lines = [f"Neighbors of {contact_name} ({len(result)}):"]
            for n in result:
                name = n.get('name', n.get('public_key', '?')[:8])
                snr = n.get('snr', '?')
                lines.append(f"  {name} (SNR: {snr})")
            return "\n".join(lines)
        lines = [f"Neighbors: {contact_name}"]
        for k, v in result.items():
            lines.append(f"  {k}: {v}")
        return "\n".join(lines)

    elif cmd == 'trace':
        tag = int(args[1]) if len(args) >= 2 else 0
        result = device_manager.send_trace(tag)
        if not result:
            return "Trace unavailable"
        return result.get('message', result.get('error', 'Unknown'))

    elif cmd == 'help':
        return (
            "Available commands:\n"
            "  infos      — Device info (firmware, freq, etc.)\n"
            "  status     — Connection status, battery, contacts count\n"
            "  stats      — Device statistics (uptime, TX/RX, packets)\n"
            "  bat        — Battery voltage\n"
            "  contacts   — List device contacts with path info\n"
            "  contacts_all — List all known contacts (device + cached)\n"
            "  channels   — List configured channels\n"
            "  chan <idx> <msg> — Send channel message\n"
            "  msg <name> <msg> — Send direct message\n"
            "  advert     — Send advertisement\n"
            "  floodadv   — Send flood advertisement\n"
            "  telemetry <name> — Request sensor telemetry\n"
            "  neighbors <name> — List neighbors of a node\n"
            "  trace [tag]      — Send trace packet\n"
            "  help       — Show this help"
        )

    else:
        return f"Unknown command: {cmd}\nType 'help' for available commands."


if __name__ == '__main__':
    app = create_app()
    socketio.run(
        app,
        host=config.FLASK_HOST,
        port=config.FLASK_PORT,
        debug=config.FLASK_DEBUG,
        allow_unsafe_werkzeug=True
    )
