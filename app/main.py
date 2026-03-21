"""
mc-webui v2 — Flask application entry point

Direct device communication via meshcore library (no bridge).
"""

import json
import logging
import re
import shlex
import threading
import time
from pathlib import Path
from flask import Flask, request as flask_request
from flask_socketio import SocketIO, emit
from app.config import config, runtime_config
from app.database import Database
from app.device_manager import DeviceManager
from app.log_handler import MemoryLogHandler
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


def _sanitize_db_name(name: str) -> str:
    """Sanitize device name for use as database filename."""
    sanitized = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', name)
    sanitized = sanitized.strip('. ')
    return sanitized or 'device'


def _resolve_db_path() -> Path:
    """Resolve database path, preferring existing device-named DB files.

    Priority:
    1. Explicit MC_DB_PATH that is NOT mc-webui.db -> use as-is
    2. Existing device-named .db file in config dir (most recently modified)
    3. Existing mc-webui.db (legacy, will be renamed on device connect)
    4. New mc-webui.db (will be renamed on device connect)
    """
    if config.MC_DB_PATH:
        p = Path(config.MC_DB_PATH)
        if p.name != 'mc-webui.db':
            return p
        db_dir = p.parent
    else:
        db_dir = Path(config.MC_CONFIG_DIR)

    # Scan for existing device-named DBs (anything except mc-webui.db)
    try:
        existing = sorted(
            [f for f in db_dir.glob('*.db')
             if f.name != 'mc-webui.db' and f.is_file()],
            key=lambda f: f.stat().st_mtime,
            reverse=True
        )
        if existing:
            logger.info(f"Found device-named database: {existing[0].name}")
            return existing[0]
    except OSError:
        pass

    # Fallback: mc-webui.db (legacy or new install)
    return db_dir / 'mc-webui.db'


def _migrate_db_to_device_name(db, device_name: str):
    """Rename DB file to match device name if needed.

    Handles three cases:
    - Current DB already matches device name -> no-op
    - Target DB exists (different device was here before) -> switch to it
    - Target DB doesn't exist -> rename current DB files
    """
    safe_name = _sanitize_db_name(device_name)
    current = db.db_path
    target = current.parent / f"{safe_name}.db"

    if current.resolve() == target.resolve():
        return

    if target.exists():
        # Target DB already exists — switch to it
        db.db_path = target
        db._init_db()
        logger.info(f"Switched to existing database: {target.name}")
        return

    # Checkpoint WAL to merge pending writes before rename
    try:
        with db._connect() as conn:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    except Exception as e:
        logger.warning(f"WAL checkpoint before rename: {e}")

    # Rename DB + WAL + SHM files
    for suffix in ['', '-wal', '-shm']:
        src = Path(str(current) + suffix)
        dst = Path(str(target) + suffix)
        if src.exists():
            try:
                src.rename(dst)
            except OSError as e:
                logger.error(f"Failed to rename {src.name} -> {dst.name}: {e}")
                return  # abort migration

    db.db_path = target
    logger.info(f"Database renamed: {current.name} -> {target.name}")


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

    # Initialize in-memory log handler (ring buffer + WebSocket broadcast)
    log_handler = MemoryLogHandler(capacity=2000, socketio=socketio)
    log_handler.setLevel(logging.DEBUG)
    log_handler.setFormatter(logging.Formatter('%(message)s'))
    logging.getLogger().addHandler(log_handler)
    app.log_handler = log_handler

    # v2: Initialize database (auto-detect device-named DB or use default)
    db_path = _resolve_db_path()
    db = Database(db_path)
    app.db = db

    # Migrate settings from .webui_settings.json to DB (one-time)
    settings_file = Path(config.MC_CONFIG_DIR) / ".webui_settings.json"
    if settings_file.exists() and db.get_setting('manual_add_contacts') is None:
        logger.info("Migrating settings from .webui_settings.json to database...")
        db.migrate_protected_contacts_from_file(settings_file)
        db.migrate_settings_from_file(settings_file)
        # Rename old file as backup
        backup = settings_file.with_suffix('.json.bak')
        try:
            settings_file.rename(backup)
            logger.info(f"Settings file backed up to {backup.name}")
        except Exception as e:
            logger.warning(f"Could not rename settings file: {e}")

    # v2: Initialize and start device manager
    device_manager = DeviceManager(config, db, socketio)
    app.device_manager = device_manager

    # Start device connection in background (non-blocking)
    device_manager.start()

    # Update runtime config when device connects, then run migrations if needed
    def _wait_for_device_name():
        """Wait for device manager to connect and update runtime config."""
        for _ in range(60):  # wait up to 60 seconds
            time.sleep(1)
            if device_manager.is_connected:
                dev_name = device_manager.device_name
                runtime_config.set_device_name(dev_name, "device")
                logger.info(f"Device name resolved: {dev_name}")

                # Rename DB to match device name (mc-webui.db -> {name}.db)
                _migrate_db_to_device_name(db, dev_name)

                # Ensure device info is stored in current DB
                if device_manager.self_info:
                    db.set_device_info(
                        public_key=device_manager.self_info.get('public_key', ''),
                        name=dev_name,
                        self_info=json.dumps(device_manager.self_info, default=str)
                    )

                # Auto-migrate v1 data if .msgs file exists and DB is empty
                try:
                    from app.migrate_v1 import should_migrate, migrate_v1_data
                    data_dir = Path(config.MC_CONFIG_DIR)
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
    logger.info(f"Database: {db.db_path}")

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


# ============================================================
# WebSocket handlers for System Log viewer
# ============================================================

@socketio.on('connect', namespace='/logs')
def handle_logs_connect():
    """Handle log viewer WebSocket connection."""
    logger.debug("Log viewer WebSocket client connected")


@socketio.on('disconnect', namespace='/logs')
def handle_logs_disconnect():
    logger.debug("Log viewer WebSocket client disconnected")


def _parse_time_arg(value: str) -> int:
    """Parse time argument with optional suffix: s (seconds), m (minutes, default), h (hours)."""
    value = value.strip().lower()
    if value.endswith('s'):
        return int(value[:-1])
    elif value.endswith('h'):
        return int(value[:-1]) * 3600
    elif value.endswith('m'):
        return int(value[:-1]) * 60
    else:
        return int(value) * 60  # default: minutes


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
        type_names = {0: 'NONE', 1: 'COM', 2: 'REP', 3: 'ROOM', 4: 'SENS'}
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
            uptime_s = core.get('uptime_secs', 0)
            days, rem = divmod(uptime_s, 86400)
            hours, rem = divmod(rem, 3600)
            mins = rem // 60
            lines.append(f"  Uptime: {int(days)}d {int(hours)}h {int(mins)}m")
            lines.append(f"  Battery: {core.get('battery_mv', '?')} mV")
            lines.append(f"  Queue: {core.get('queue_len', 0)}")
            lines.append(f"  Errors: {core.get('errors', 0)}")
        if 'radio' in stats:
            radio = stats['radio']
            lines.append(f"  Noise floor: {radio.get('noise_floor', '?')} dBm")
            lines.append(f"  Last RSSI: {radio.get('last_rssi', '?')} dBm")
            lines.append(f"  Last SNR: {radio.get('last_snr', '?')} dB")
            tx_s = radio.get('tx_air_secs', 0)
            rx_s = radio.get('rx_air_secs', 0)
            lines.append(f"  TX air time: {tx_s / 60:.1f} min")
            lines.append(f"  RX air time: {rx_s / 60:.1f} min")
        if 'packets' in stats:
            pkts = stats['packets']
            lines.append(f"  Packets TX: {pkts.get('sent', 0)} (flood: {pkts.get('flood_tx', 0)}, direct: {pkts.get('direct_tx', 0)})")
            lines.append(f"  Packets RX: {pkts.get('recv', 0)} (flood: {pkts.get('flood_rx', 0)}, direct: {pkts.get('direct_rx', 0)})")
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

    elif cmd == 'trace' and len(args) >= 2:
        path = args[1]
        result = device_manager.send_trace(path)
        if result.get('success'):
            data = result['data']
            # Format like meshcore-cli: snr > [hash]snr > [hash]snr
            # Each element has snr + optional hash pointing to next hop
            output = ""
            for t in data.get('path', []):
                output += f"{t['snr']:.2f}"
                if 'hash' in t:
                    output += f" > [{t['hash']}]"
            return output if output else "(empty trace)"
        return f"Error: {result.get('error')}"

    elif cmd == 'trace':
        return "Usage: trace <path>\n  Path: comma-separated hex hashes (e.g. 5e,d1,e7)"

    # ── Repeater commands ────────────────────────────────────────

    elif cmd == 'login' and len(args) >= 3:
        name = args[1]
        password = ' '.join(args[2:])
        result = device_manager.repeater_login(name, password)
        if result.get('success'):
            return result.get('message', 'OK')
        return f"Error: {result.get('error')}"

    elif cmd == 'login':
        return "Usage: login <name> <password>"

    elif cmd == 'logout' and len(args) >= 2:
        name = ' '.join(args[1:])
        result = device_manager.repeater_logout(name)
        if result.get('success'):
            return result.get('message', 'OK')
        return f"Error: {result.get('error')}"

    elif cmd == 'cmd' and len(args) >= 3:
        name = args[1]
        remote_cmd = ' '.join(args[2:])
        result = device_manager.repeater_cmd(name, remote_cmd)
        if result.get('success'):
            return result.get('message', 'OK')
        return f"Error: {result.get('error')}"

    elif cmd == 'cmd':
        return "Usage: cmd <name> <command>"

    elif cmd == 'req_status' and len(args) >= 2:
        name = ' '.join(args[1:])
        result = device_manager.repeater_req_status(name)
        if result.get('success'):
            data = result['data']
            lines = [f"Status of {name}:"]
            for k, v in data.items():
                lines.append(f"  {k}: {v}")
            return "\n".join(lines)
        return f"Error: {result.get('error')}"

    elif cmd == 'req_regions' and len(args) >= 2:
        name = ' '.join(args[1:])
        result = device_manager.repeater_req_regions(name)
        if result.get('success'):
            data = result['data']
            return f"{name} repeats {data}"
        return f"Error: {result.get('error')}"

    elif cmd == 'req_owner' and len(args) >= 2:
        name = ' '.join(args[1:])
        result = device_manager.repeater_req_owner(name)
        if result.get('success'):
            data = result['data']
            owner = data.get('owner', '')
            if owner:
                return f"{data.get('name', name)} is owned by {owner}"
            return f"{data.get('name', name)} has no owner set"
        return f"Error: {result.get('error')}"

    elif cmd == 'req_acl' and len(args) >= 2:
        name = ' '.join(args[1:])
        result = device_manager.repeater_req_acl(name)
        if result.get('success'):
            data = result['data']
            lines = [f"ACL of {name}:"]
            if isinstance(data, dict):
                for k, v in data.items():
                    lines.append(f"  {k}: {v}")
            else:
                lines.append(f"  {data}")
            return "\n".join(lines)
        return f"Error: {result.get('error')}"

    elif cmd == 'req_clock' and len(args) >= 2:
        name = ' '.join(args[1:])
        result = device_manager.repeater_req_clock(name)
        if result.get('success'):
            import datetime as _dt
            data = result['data']
            hex_data = data.get('data', '')
            timestamp = int.from_bytes(bytes.fromhex(hex_data[0:8]), byteorder="little", signed=False)
            dt_str = _dt.datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d %H:%M:%S")
            return f"Clock of {name}: {dt_str} ({timestamp})"
        return f"Error: {result.get('error')}"

    elif cmd == 'req_neighbours' and len(args) >= 2:
        name = ' '.join(args[1:])
        result = device_manager.repeater_req_neighbours(name)
        if result.get('success'):
            data = result['data']
            total = data.get('neighbours_count', 0)
            got = data.get('results_count', 0)
            lines = [f"Got {got} neighbours out of {total} from {name}:"]
            for n in data.get('neighbours', []):
                pubkey = n.get('pubkey', '')
                ct_name = device_manager.resolve_contact_name(pubkey)
                if ct_name:
                    label = f"[{pubkey[0:8]}] {ct_name}"
                else:
                    label = f"[{pubkey}]"

                t_s = n.get('secs_ago', 0)
                if t_s >= 86400:
                    time_ago = f"{int(t_s / 86400)}d ago ({t_s}s)"
                elif t_s >= 3600:
                    time_ago = f"{int(t_s / 3600)}h ago ({t_s}s)"
                elif t_s >= 60:
                    time_ago = f"{int(t_s / 60)}m ago ({t_s}s)"
                else:
                    time_ago = f"{t_s}s"

                snr = n.get('snr', 0)
                lines.append(f" {label:30s} {time_ago}, {snr}dB SNR")
            return "\n".join(lines)
        return f"Error: {result.get('error')}"

    elif cmd == 'req_mma' and len(args) >= 4:
        name = args[1]
        try:
            from_secs = _parse_time_arg(args[2])
            to_secs = _parse_time_arg(args[3])
        except ValueError as e:
            return f"Error: {e}"
        result = device_manager.repeater_req_mma(name, from_secs, to_secs)
        if result.get('success'):
            data = result['data']
            lines = [f"MMA of {name} ({args[2]} → {args[3]}):"]
            for k, v in data.items():
                lines.append(f"  {k}: {v}")
            return "\n".join(lines)
        return f"Error: {result.get('error')}"

    elif cmd == 'req_mma':
        return "Usage: req_mma <name> <from_time> <to_time>\n  Time format: number with optional suffix s/m/h (default: minutes)"

    # ── Contact management commands ──────────────────────────────

    elif cmd == 'contact_info' and len(args) >= 2:
        name = ' '.join(args[1:])
        result = device_manager.contact_info(name)
        if result.get('success'):
            data = result['data']
            lines = [f"Contact: {data.get('adv_name', data.get('name', name))}"]
            for k, v in sorted(data.items()):
                if isinstance(v, bytes):
                    v = v.hex()
                lines.append(f"  {k}: {v}")
            return "\n".join(lines)
        return f"Error: {result.get('error')}"

    elif cmd == 'path' and len(args) >= 2:
        name = ' '.join(args[1:])
        result = device_manager.contact_path(name)
        if result.get('success'):
            data = result['data']
            opl = data.get('out_path_len', -1)
            raw = data.get('out_path', '')
            if opl > 0:
                hop_count = opl & 0x3F
                hash_size = (opl >> 6) + 1
                meaningful = raw[:hop_count * hash_size * 2]
                chunk = hash_size * 2
                hops = [meaningful[i:i+chunk].upper() for i in range(0, len(meaningful), chunk)]
                path_str = ' → '.join(hops) if hops else f'len:{opl}'
                return f"Path to {name}: {path_str} ({hop_count} hops)"
            elif opl == 0:
                return f"Path to {name}: Direct"
            else:
                return f"Path to {name}: Flood (no path)"
        return f"Error: {result.get('error')}"

    elif cmd == 'disc_path' and len(args) >= 2:
        name = ' '.join(args[1:])
        result = device_manager.discover_path(name)
        if result.get('success'):
            data = result['data']
            lines = [f"Discovered path to {name}:"]
            for k, v in data.items():
                lines.append(f"  {k}: {v}")
            return "\n".join(lines)
        return f"Error: {result.get('error')}"

    elif cmd == 'reset_path' and len(args) >= 2:
        name = ' '.join(args[1:])
        contact = device_manager.resolve_contact(name)
        if not contact:
            return f"Error: Contact not found: {name}"
        result = device_manager.reset_path(contact.get('public_key', name))
        if result.get('success'):
            return f"Path reset for {contact.get('adv_name', name)}"
        return f"Error: {result.get('error')}"

    elif cmd == 'change_path' and len(args) >= 3:
        name = args[1]
        path = args[2]
        result = device_manager.change_path(name, path)
        if result.get('success'):
            return result.get('message', 'OK')
        return f"Error: {result.get('error')}"

    elif cmd == 'change_path':
        return "Usage: change_path <name> <path>\n  Path: hex string, e.g. 6a61"

    elif cmd == 'advert_path' and len(args) >= 2:
        name = ' '.join(args[1:])
        result = device_manager.advert_path(name)
        if result.get('success'):
            data = result['data']
            lines = [f"Advert path to {name}:"]
            for k, v in data.items():
                lines.append(f"  {k}: {v}")
            return "\n".join(lines)
        return f"Error: {result.get('error')}"

    elif cmd == 'share_contact' and len(args) >= 2:
        name = ' '.join(args[1:])
        result = device_manager.share_contact(name)
        if result.get('success'):
            return result.get('message', 'OK')
        return f"Error: {result.get('error')}"

    elif cmd == 'export_contact' and len(args) >= 2:
        name = ' '.join(args[1:])
        result = device_manager.export_contact(name)
        if result.get('success'):
            uri = result['data'].get('uri', '')
            return f"URI: {uri}"
        return f"Error: {result.get('error')}"

    elif cmd == 'import_contact' and len(args) >= 2:
        uri = args[1]
        result = device_manager.import_contact_uri(uri)
        if result.get('success'):
            return result.get('message', 'OK')
        return f"Error: {result.get('error')}"

    elif cmd == 'remove_contact' and len(args) >= 2:
        name = ' '.join(args[1:])
        contact = device_manager.resolve_contact(name)
        if not contact:
            return f"Error: Contact not found: {name}"
        result = device_manager.delete_contact(contact.get('public_key', name))
        if result.get('success'):
            return f"Contact removed: {contact.get('adv_name', name)}"
        return f"Error: {result.get('error')}"

    elif cmd == 'change_flags' and len(args) >= 3:
        name = args[1]
        try:
            flags = int(args[2])
        except ValueError:
            return "Error: flags must be an integer"
        result = device_manager.change_contact_flags(name, flags)
        if result.get('success'):
            return result.get('message', 'OK')
        return f"Error: {result.get('error')}"

    elif cmd == 'change_flags':
        return "Usage: change_flags <name> <flags>\n  Flags: integer (tel_l|tel_a|star)"

    elif cmd == 'pending_contacts':
        result = device_manager.get_pending_contacts()
        if not result:
            return "No pending contacts"
        lines = [f"Pending contacts ({len(result)}):"]
        for c in result:
            name = c.get('adv_name', c.get('name', '?'))
            pk = c.get('public_key', '')[:12]
            lines.append(f"  {name} ({pk}...)")
        return "\n".join(lines)

    elif cmd == 'add_pending' and len(args) >= 2:
        key_or_name = ' '.join(args[1:])
        # Try to find in pending contacts
        pending = device_manager.get_pending_contacts()
        target = None
        for c in (pending or []):
            if c.get('public_key', '').startswith(key_or_name) or c.get('adv_name', '') == key_or_name:
                target = c
                break
        if not target:
            return f"Error: Not found in pending: {key_or_name}"
        result = device_manager.approve_contact(target['public_key'])
        if result.get('success'):
            return f"Contact added: {target.get('adv_name', key_or_name)}"
        return f"Error: {result.get('error')}"

    elif cmd == 'flush_pending':
        result = device_manager.clear_pending_contacts()
        if result.get('success'):
            return result.get('message', 'Pending contacts flushed')
        return f"Error: {result.get('error')}"

    # ── Device management commands ───────────────────────────────

    elif cmd == 'get' and len(args) >= 2:
        param = args[1]
        result = device_manager.get_param(param)
        if result.get('help') == 'get':
            return (
                "Get parameters from device:\n"
                "  name             — node name\n"
                "  tx               — TX power\n"
                "  coords           — adv coordinates (lat, lon)\n"
                "  lat              — latitude\n"
                "  lon              — longitude\n"
                "  bat              — battery level in mV\n"
                "  radio            — radio parameters (freq, bw, sf, cr)\n"
                "  stats            — device status/statistics\n"
                "  custom           — all custom variables (JSON)\n"
                "  path_hash_mode   — path hash mode"
            )
        if result.get('success'):
            data = result.get('data', {})
            lines = []
            for k, v in data.items():
                if isinstance(v, dict):
                    lines.append(f"  {k}:")
                    for k2, v2 in v.items():
                        lines.append(f"    {k2}: {v2}")
                else:
                    lines.append(f"  {k}: {v}")
            return "\n".join(lines) if lines else "OK"
        return f"Error: {result.get('error')}"

    elif cmd == 'get':
        return "Usage: get <param>\n  Type 'get help' for available params"

    elif cmd == 'set' and len(args) >= 3:
        param = args[1]
        value = ' '.join(args[2:])
        result = device_manager.set_param(param, value)
        if result.get('success'):
            if 'data' in result:
                data = result['data']
                lines = []
                for k, v in data.items():
                    lines.append(f"  {k}: {v}")
                return "\n".join(lines)
            return result.get('message', 'OK')
        return f"Error: {result.get('error')}"

    elif cmd == 'set' and len(args) == 2 and args[1] == 'help':
        result = device_manager.set_param('help', '')
        return (
            "Set device parameters:\n"
            " Device:\n"
            "  name <name>                    — node name\n"
            "  tx <dbm>                       — TX power\n"
            "  coords <lat>,<lon>             — coordinates\n"
            "  lat <lat>                      — latitude\n"
            "  lon <lon>                      — longitude\n"
            "  pin <pin>                      — BLE pin\n"
            "  radio <freq,bw,sf,cr>          — radio params\n"
            "  multi_acks <on/off>            — multi-acks feature\n"
            "  manual_add_contacts <on/off>   — manual contact approval\n"
            "  telemetry_mode_base <mode>     — basic telemetry (all/selected/off)\n"
            "  telemetry_mode_loc <mode>      — location telemetry\n"
            "  telemetry_mode_env <mode>      — environment telemetry\n"
            "  advert_loc_policy <policy>     — location in adverts\n"
            "  path_hash_mode <value>         — path hash mode\n"
            "  <custom_var> <value>           — set custom variable"
        )

    elif cmd == 'set':
        return "Usage: set <param> <value>\n  Type 'set help' for available params"

    elif cmd == 'clock':
        if len(args) >= 2 and args[1] == 'sync':
            import time as _time
            import datetime as _dt
            epoch = int(_time.time())
            result = device_manager.set_clock(epoch)
            if result.get('success'):
                dt_str = _dt.datetime.fromtimestamp(epoch).strftime("%Y-%m-%d %H:%M:%S")
                return f"Clock synced to {dt_str} ({epoch})"
            return f"Error: {result.get('error')}"
        result = device_manager.get_clock()
        if result.get('success'):
            import datetime as _dt
            data = result['data']
            timestamp = data.get('time', 0)
            dt_str = _dt.datetime.fromtimestamp(timestamp).strftime("%Y-%m-%d %H:%M:%S")
            return f"Current time: {dt_str} ({timestamp})"
        return f"Error: {result.get('error')}"

    elif cmd == 'time' and len(args) >= 2:
        try:
            epoch = int(args[1])
        except ValueError:
            return "Usage: time <epoch>"
        result = device_manager.set_clock(epoch)
        if result.get('success'):
            return result.get('message', 'OK')
        return f"Error: {result.get('error')}"

    elif cmd == 'reboot':
        result = device_manager.reboot_device()
        if result.get('success'):
            return result.get('message', 'OK')
        return f"Error: {result.get('error')}"

    elif cmd == 'ver':
        result = device_manager.query_device()
        if result.get('success'):
            data = result['data']
            fw_ver = data.get('fw ver', 0)
            if fw_ver >= 3:
                lines = ["Device info:"]
                lines.append(f"  Model: {data.get('model', '?')}")
                lines.append(f"  Version: {data.get('ver', '?')}")
                lines.append(f"  Build date: {data.get('fw_build', '?')}")
                if 'repeat' in data:
                    lines.append(f"  Repeat: {'on' if data['repeat'] else 'off'}")
                return "\n".join(lines)
            return f"Firmware version: {fw_ver}"
        return f"Error: {result.get('error')}"

    elif cmd == 'scope' and len(args) >= 2:
        scope = ' '.join(args[1:])
        result = device_manager.set_flood_scope(scope)
        if result.get('success'):
            return result.get('message', 'OK')
        return f"Error: {result.get('error')}"

    elif cmd == 'self_telemetry':
        result = device_manager.get_self_telemetry()
        if result.get('success'):
            data = result['data']
            lines = ["Self telemetry:"]
            lpp = data.get('lpp', [])
            for sensor in lpp:
                ch = sensor.get('channel', '?')
                stype = sensor.get('type', '?')
                val = sensor.get('value', '?')
                unit = ''
                if stype == 'voltage':
                    unit = ' V'
                elif stype == 'temperature':
                    unit = ' C'
                elif stype == 'humidity':
                    unit = ' %'
                elif stype == 'pressure':
                    unit = ' hPa'
                lines.append(f"  Ch {ch}: {stype} = {val}{unit}")
            if not lpp:
                lines.append("  (no sensor data)")
            return "\n".join(lines)
        return f"Error: {result.get('error')}"

    elif cmd == 'node_discover':
        type_filter = args[1] if len(args) >= 2 else None
        result = device_manager.node_discover(type_filter)
        if result.get('success'):
            data = result['data']
            if not data:
                return "No nodes discovered"
            lines = [f"Discovered nodes ({len(data)}):"]
            for node in data:
                if isinstance(node, dict):
                    name = node.get('adv_name', node.get('name', '?'))
                    pk = node.get('public_key', '')[:12]
                    lines.append(f"  {name} ({pk}...)")
                else:
                    lines.append(f"  {node}")
            return "\n".join(lines)
        return f"Error: {result.get('error')}"

    # ── Channel management commands ──────────────────────────────

    elif cmd == 'get_channel' and len(args) >= 2:
        try:
            idx = int(args[1])
        except ValueError:
            return "Usage: get_channel <index>"
        ch = device_manager.get_channel_info(idx)
        if ch and ch.get('name'):
            lines = [f"Channel [{idx}]:"]
            for k, v in ch.items():
                lines.append(f"  {k}: {v}")
            return "\n".join(lines)
        return f"Channel {idx} not configured"

    elif cmd == 'set_channel' and len(args) >= 3:
        try:
            idx = int(args[1])
            name = args[2]
            secret = bytes.fromhex(args[3]) if len(args) >= 4 else None
            result = device_manager.set_channel(idx, name, secret)
            if result.get('success'):
                return f"Channel [{idx}] set to: {name}"
            return f"Error: {result.get('error')}"
        except (ValueError, IndexError) as e:
            return f"Usage: set_channel <index> <name> [key_hex]"

    elif cmd == 'add_channel' and len(args) >= 2:
        name = args[1]
        secret = bytes.fromhex(args[2]) if len(args) >= 3 else None
        # Find next available channel slot
        idx = None
        for i in range(device_manager._max_channels):
            ch = device_manager.get_channel_info(i)
            if not ch or not ch.get('name'):
                idx = i
                break
        if idx is None:
            return "Error: No free channel slots"
        result = device_manager.set_channel(idx, name, secret)
        if result.get('success'):
            return f"Channel [{idx}] added: {name}"
        return f"Error: {result.get('error')}"

    elif cmd == 'remove_channel' and len(args) >= 2:
        try:
            idx = int(args[1])
        except ValueError:
            return "Usage: remove_channel <index>"
        result = device_manager.remove_channel(idx)
        if result.get('success'):
            return f"Channel [{idx}] removed"
        return f"Error: {result.get('error')}"

    elif cmd == 'help':
        return (
            "Available commands:\n\n"
            " General\n"
            "  infos      — Device info (firmware, freq, etc.)\n"
            "  status     — Connection status, battery, contacts count\n"
            "  stats      — Device statistics (uptime, TX/RX, packets)\n"
            "  bat        — Battery voltage\n"
            "  contacts   — List device contacts with path info\n"
            "  contacts_all — List all known contacts (device + cached)\n"
            "  channels   — List configured channels\n\n"
            " Messaging\n"
            "  chan <idx> <msg> — Send channel message\n"
            "  msg <name> <msg> — Send direct message\n"
            "  advert     — Send advertisement\n"
            "  floodadv   — Send flood advertisement\n"
            "  telemetry <name> — Request sensor telemetry\n"
            "  neighbors <name> — List neighbors of a node\n"
            "  trace [tag]      — Send trace packet\n\n"
            " Contacts\n"
            "  contact_info <name>     — Contact details (JSON)\n"
            "  path <name>             — Show path to contact\n"
            "  disc_path <name>        — Discover new path\n"
            "  reset_path <name>       — Reset path to flood\n"
            "  change_path <name> <p>  — Change path to contact\n"
            "  advert_path <name>      — Get path from advert\n"
            "  share_contact <name>    — Share contact with mesh\n"
            "  export_contact <name>   — Export contact URI\n"
            "  import_contact <URI>    — Import contact from URI\n"
            "  remove_contact <name>   — Remove contact from device\n"
            "  change_flags <n> <f>    — Change contact flags\n"
            "  pending_contacts        — Show pending contacts\n"
            "  add_pending <name>      — Add pending contact\n"
            "  flush_pending           — Flush pending list\n\n"
            " Repeaters\n"
            "  login <name> <pwd>  — Log into a repeater\n"
            "  logout <name>       — Log out of a repeater\n"
            "  cmd <name> <cmd>    — Send command to a repeater\n"
            "  req_status <name>      — Request repeater status\n"
            "  req_neighbours <name>  — Request repeater neighbours\n"
            "  req_regions <name>     — Request repeater regions\n"
            "  req_owner <name>       — Request repeater owner\n"
            "  req_acl <name>         — Request access control list\n"
            "  req_clock <name>       — Request repeater clock\n"
            "  req_mma <n> <f> <t>    — Request min/max/avg sensor data\n\n"
            " Management\n"
            "  get <param>          — Get device parameter\n"
            "  set <param> <value>  — Set device parameter\n"
            "  clock                — Get device clock\n"
            "  clock sync           — Sync device clock to now\n"
            "  time <epoch>         — Set device time\n"
            "  reboot               — Reboot device\n"
            "  ver                  — Firmware version\n"
            "  scope <scope>        — Set flood scope\n"
            "  self_telemetry       — Own telemetry data\n"
            "  node_discover [type] — Discover mesh nodes\n\n"
            " Channels\n"
            "  get_channel <n>            — Channel info\n"
            "  set_channel <n> <nm> [key] — Set channel\n"
            "  add_channel <name> [key]   — Add channel\n"
            "  remove_channel <n>         — Remove channel\n\n"
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
