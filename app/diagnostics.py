"""Diagnostic capture — packaged evidence from a server we cannot log into.

A user presses Start, reproduces the problem, presses Stop, and gets a .zip
that answers what a screenshot never can: which radio frames actually reached
the app, what the echo correlator decided about each one, and how the device's
own packet counter moved over the same window. The maintainer reads it offline
with scripts/diag_report.py instead of asking for shell access.

The measurement this exists for: the device counts every packet its radio
receives (stats.packets.recv), while the app only ever sees the RX-log frames
the firmware manages to push over the companion link. A 4-frame queue in the
firmware drops the rest silently — no log, no counter. Comparing the counter
delta against the frames in events.jsonl turns that invisible loss into a
number.

Threading model — the part that matters:

- record() is called from DeviceManager's asyncio thread, on the same hot path
  as Observer.handle_raw_packet(). It builds one dict and appends it to a
  deque: no disk, no network, no locks. deque.append and len() are atomic under
  the GIL. Even threading.Event.set() is a lock and is deliberately avoided —
  the writer polls rather than being signalled.
- One writer thread per session owns every file handle. It drains the queue,
  splits log lines into log.txt and everything else into events.jsonl, polls
  device stats on an interval, enforces the caps, and runs the whole
  finalize-and-zip sequence. Stopping never happens on the caller's thread; a
  request thread only raises a flag and joins.
- Only one capture runs at a time, guarded by _lifecycle_lock.

Every timestamp written here is UTC epoch seconds. The database writes UTC and
the container logs local time, and mixing the two has already cost this project
a debugging session.
"""

import json
import logging
import shutil
import threading
import time
import zipfile
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

from app.version import RELEASE_VERSION, VERSION_STRING

logger = logging.getLogger(__name__)

# Zipline instance the maintainer collects captures on. Shipped as a default
# because the URL is not a secret; the token is not shipped and never will be —
# this repository is public, so a baked-in write token would let anyone upload
# anything. The user pastes a token the maintainer hands them out-of-band.
DEFAULT_UPLOAD_URL = 'https://share.marwoj.net/api/upload'

SETTINGS_KEY = 'diagnostics_upload'
UPLOADS_KEY = 'diagnostics_uploads'   # {capture_id: shared_url}

DURATION_CHOICES_MIN = (5, 15, 30, 60)
DEFAULT_DURATION_MIN = 15
DEFAULT_MAX_MB = 25
MAX_MB_LIMIT = 100
MAX_STORED_CAPTURES = 10

_QUEUE_MAX = 20000          # events buffered before we start counting drops
_DRAIN_INTERVAL = 0.4       # seconds between writer passes
_STATS_INTERVAL = 60.0      # seconds between device stats samples
_SCHEMA = 1


def _utc_stamp() -> str:
    """Capture id: sortable, unambiguous, safe in a filename on any OS."""
    return datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')


class _NoLock:
    """No-op stand-in for logging.Handler.lock.

    The handler's emit() only appends to a deque, which is atomic under the
    GIL, so the per-record handler lock buys nothing and would put the device's
    asyncio thread behind whatever else happens to be logging. Python 3.13's
    Handler.handle() uses `with self.lock`, while older versions call
    acquire()/release() — support both, because setting lock to None (the
    classic trick) raises on 3.13.
    """

    def acquire(self):
        pass

    def release(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _CaptureLogHandler(logging.Handler):
    """Mirror log records into the running capture.

    Never touches disk: emit() hands the line to the same queue the writer
    thread drains, so a log call on the asyncio thread stays as cheap as any
    other tap.
    """

    def __init__(self, manager):
        super().__init__(level=logging.DEBUG)
        self._manager = manager

    def createLock(self):
        # logging.Handler.handle() takes this lock around every emit(). Our
        # emit only appends to a deque, which needs no lock — and the hot-path
        # contract above says not to take one.
        self.lock = _NoLock()

    def emit(self, record):
        try:
            manager = self._manager
            session = manager._session
            if session is None:
                return
            if session.writer_ident == threading.get_ident():
                return  # our own writer thread: logging here would feed itself
            if record.name.startswith('app.diagnostics'):
                return
            if record.name == 'werkzeug':
                msg = record.getMessage()
                # The Diagnostics tab polls status once a second while open;
                # left in, those access lines would be most of the capture.
                if ('/socket.io/' in msg or '/api/logs/' in msg
                        or '/api/diagnostics/' in msg):
                    return
            manager.record('log', lvl=record.levelname, src=record.name,
                           msg=record.getMessage())
        except Exception:
            pass  # a capture must never break the thing it is observing


class _Session:
    """State of one running capture. Owned by its writer thread once started."""

    def __init__(self, capture_id, work_dir, options, note):
        self.id = capture_id
        self.dir = work_dir
        self.options = options
        self.note = note
        self.queue = deque()
        self.thread = None
        self.writer_ident = None
        self.started_at = time.time()
        self.stop_requested = False
        self.stop_reason = None
        self.dropped = 0
        self.events = 0
        self.log_lines = 0
        self.bytes = 0
        self.by_kind = {}
        self.stats_before = None
        self.stats_before_at = None
        self.stats_after = None
        self.stats_after_at = None
        self.last_stats_at = 0.0
        self.error = None


class DiagnosticsManager:
    """Owns capture lifecycle, stored captures, and upload."""

    def __init__(self, config, db, socketio=None):
        self.config = config
        self.db = db
        self.socketio = socketio
        self.device_manager = None   # set by main.py after DeviceManager exists
        # Hot-path flag: call sites test this before building any arguments,
        # so a stopped capture costs one attribute load.
        self.recording = False
        self._session = None
        self._lifecycle_lock = threading.Lock()
        self._log_handler = None
        self._prev_root_level = None

    # ------------------------------------------------------------------
    # Storage
    # ------------------------------------------------------------------

    @property
    def captures_dir(self) -> Path:
        return Path(self.config.MC_CONFIG_DIR) / 'diagnostics'

    def _ensure_dir(self) -> Path:
        d = self.captures_dir
        d.mkdir(parents=True, exist_ok=True)
        return d

    def list_captures(self):
        """Stored captures, newest first."""
        try:
            d = self.captures_dir
            if not d.is_dir():
                return []
            uploads = self.db.get_setting_json(UPLOADS_KEY, {}) or {}
            rows = []
            for path in d.glob('*.zip'):
                try:
                    st = path.stat()
                except OSError:
                    continue
                capture_id = path.stem
                rows.append({
                    'id': capture_id,
                    'size_bytes': st.st_size,
                    'created_at': st.st_mtime,
                    'shared_url': uploads.get(capture_id),
                })
            rows.sort(key=lambda r: r['created_at'], reverse=True)
            return rows
        except Exception as e:
            logger.error(f"Failed to list captures: {e}")
            return []

    def capture_path(self, capture_id: str):
        """Resolve a capture id to its zip, refusing anything path-shaped."""
        if not capture_id or '/' in capture_id or '\\' in capture_id or '..' in capture_id:
            return None
        path = self.captures_dir / f'{capture_id}.zip'
        return path if path.is_file() else None

    def delete_capture(self, capture_id: str) -> dict:
        path = self.capture_path(capture_id)
        if not path:
            return {'success': False, 'error': 'Capture not found'}
        try:
            path.unlink()
            uploads = self.db.get_setting_json(UPLOADS_KEY, {}) or {}
            if uploads.pop(capture_id, None) is not None:
                self.db.set_setting_json(UPLOADS_KEY, uploads)
            return {'success': True}
        except OSError as e:
            return {'success': False, 'error': str(e)}

    def _sweep(self, keep=MAX_STORED_CAPTURES):
        """Drop orphaned work dirs and captures beyond the retention count.

        /data is the user's config directory, not scratch space — an unbounded
        pile of captures there is our problem, not theirs.
        """
        try:
            d = self.captures_dir
            if not d.is_dir():
                return
            for child in d.iterdir():
                if child.is_dir():  # a work dir only outlives its writer on a crash
                    shutil.rmtree(child, ignore_errors=True)
            zips = sorted(d.glob('*.zip'), key=lambda p: p.stat().st_mtime, reverse=True)
            for stale in zips[keep:]:
                stale.unlink(missing_ok=True)
                logger.info(f"Diagnostics: pruned old capture {stale.stem}")
        except Exception as e:
            logger.warning(f"Diagnostics sweep failed: {e}")

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self, duration_min=None, max_mb=None, debug_logs=True, note='') -> dict:
        with self._lifecycle_lock:
            if self._session is not None:
                return {'success': False, 'error': 'A capture is already running'}

            try:
                duration_min = int(duration_min or DEFAULT_DURATION_MIN)
            except (TypeError, ValueError):
                duration_min = DEFAULT_DURATION_MIN
            if duration_min not in DURATION_CHOICES_MIN:
                duration_min = DEFAULT_DURATION_MIN
            try:
                max_mb = int(max_mb or DEFAULT_MAX_MB)
            except (TypeError, ValueError):
                max_mb = DEFAULT_MAX_MB
            max_mb = max(1, min(max_mb, MAX_MB_LIMIT))

            options = {
                'duration_min': duration_min,
                'max_mb': max_mb,
                'debug_logs': bool(debug_logs),
            }

            try:
                self._sweep()
                base = self._ensure_dir()
                capture_id = f'mc-webui-diag-{_utc_stamp()}'
                work_dir = base / capture_id
                work_dir.mkdir(parents=True, exist_ok=True)
            except OSError as e:
                return {'success': False, 'error': f'Cannot create capture directory: {e}'}

            session = _Session(capture_id, work_dir, options, (note or '').strip()[:200])
            self._session = session
            self.recording = True

            # DEBUG lines are where the echo correlator explains itself, but a
            # server left at the default INFO never emits them — the logger
            # filters before any handler runs. Lift the floor for the capture
            # and put it back afterwards.
            if options['debug_logs']:
                root = logging.getLogger()
                self._prev_root_level = root.level
                root.setLevel(logging.DEBUG)

            self._log_handler = _CaptureLogHandler(self)
            logging.getLogger().addHandler(self._log_handler)

            session.thread = threading.Thread(
                target=self._run, args=(session,),
                name='diag-writer', daemon=True)
            session.thread.start()

        logger.info(f"Diagnostics: capture {session.id} started "
                    f"({duration_min} min / {max_mb} MB cap)")
        return {'success': True, 'status': self.status()}

    def stop(self) -> dict:
        with self._lifecycle_lock:
            session = self._session
            if session is None:
                return {'success': False, 'error': 'No capture is running'}
            session.stop_requested = True
            thread = session.thread

        if thread:
            # Finalisation may wait on one device stats poll (~15 s worst case).
            thread.join(timeout=90)
        if session.error:
            return {'success': False, 'error': session.error, 'id': session.id}
        return {'success': True, 'id': session.id, 'reason': session.stop_reason}

    def status(self) -> dict:
        session = self._session
        if session is None:
            return {'recording': False}
        return {
            'recording': True,
            'id': session.id,
            'note': session.note,
            'started_at': session.started_at,
            'elapsed_sec': round(time.time() - session.started_at, 1),
            'events': session.events + len(session.queue),
            'dropped': session.dropped,
            'bytes': session.bytes,
            'max_seconds': session.options['duration_min'] * 60,
            'max_bytes': session.options['max_mb'] * 1024 * 1024,
            'stopping': session.stop_requested,
        }

    # ------------------------------------------------------------------
    # Hot path
    # ------------------------------------------------------------------

    def record(self, kind: str, **data) -> None:
        """Append one event. Safe to call from the device's asyncio thread."""
        session = self._session
        if session is None:
            return
        try:
            if len(session.queue) >= _QUEUE_MAX:
                session.dropped += 1
                return
            entry = {'t': time.time(), 'k': kind}
            entry.update(data)
            session.queue.append(entry)
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Writer thread
    # ------------------------------------------------------------------

    def _run(self, session: _Session):
        session.writer_ident = threading.get_ident()
        events_path = session.dir / 'events.jsonl'
        log_path = session.dir / 'log.txt'
        max_bytes = session.options['max_mb'] * 1024 * 1024
        deadline = session.started_at + session.options['duration_min'] * 60

        try:
            with open(events_path, 'w', encoding='utf-8') as events_fh, \
                    open(log_path, 'w', encoding='utf-8') as log_fh:

                self._sample_stats(session, first=True)

                while True:
                    self._drain(session, events_fh, log_fh)

                    if session.stop_requested:
                        session.stop_reason = 'user'
                        break
                    now = time.time()
                    if now >= deadline:
                        session.stop_reason = 'duration'
                        break
                    if session.bytes >= max_bytes:
                        session.stop_reason = 'size'
                        break
                    if now - session.last_stats_at >= _STATS_INTERVAL:
                        self._sample_stats(session)
                        continue  # stats can block; re-check the caps at once

                    time.sleep(_DRAIN_INTERVAL)

                self._drain(session, events_fh, log_fh)
                events_fh.flush()
                log_fh.flush()

            self._sample_stats(session, last=True)
            self._finalize(session)
        except Exception as e:
            session.error = str(e)
            logger.error(f"Diagnostics writer failed: {e}", exc_info=True)
        finally:
            self._teardown(session)

    def _drain(self, session, events_fh, log_fh):
        """Move everything queued to disk. Only this thread writes files."""
        queue = session.queue
        written = 0
        while True:
            try:
                entry = queue.popleft()
            except IndexError:
                break
            try:
                if entry['k'] == 'log':
                    line = (f"{_iso(entry['t'])} {entry.get('lvl', ''):<8}"
                            f"{entry.get('src', '')} | {entry.get('msg', '')}\n")
                    log_fh.write(line)
                    session.log_lines += 1
                else:
                    line = json.dumps(entry, ensure_ascii=False, default=str) + '\n'
                    events_fh.write(line)
                    session.events += 1
                    kind = entry['k']
                    session.by_kind[kind] = session.by_kind.get(kind, 0) + 1
                session.bytes += len(line.encode('utf-8', 'replace'))
                written += 1
            except Exception:
                pass
        return written

    def _sample_stats(self, session, first=False, last=False):
        """Poll the device's own counters. Blocking, hence writer-thread only."""
        session.last_stats_at = time.time()
        stats = None
        dm = self.device_manager
        try:
            if dm is not None and dm.is_connected:
                stats = dm.get_device_stats()
        except Exception as e:
            logger.debug(f"Diagnostics stats sample failed: {e}")

        now = time.time()
        if first:
            session.stats_before = stats
            session.stats_before_at = now
        elif last:
            session.stats_after = stats
            session.stats_after_at = now
        else:
            # In-flight samples ride the event stream, so a long capture yields
            # a curve rather than just two endpoints.
            self.record('stats', stats=stats)

    def _finalize(self, session):
        """Write meta + endpoint stats, zip the directory, drop the work dir."""
        stopped_at = time.time()
        meta = {
            'schema': _SCHEMA,
            'capture_id': session.id,
            'note': session.note,
            'timestamps': 'UTC epoch seconds',
            'app': {
                'release': RELEASE_VERSION,
                'build': VERSION_STRING,
            },
            'transport': getattr(self.config, 'transport_type', None),
            'options': session.options,
            'started_at': session.started_at,
            'stopped_at': stopped_at,
            'duration_sec': round(stopped_at - session.started_at, 1),
            'stop_reason': session.stop_reason,
            'stats_before_at': session.stats_before_at,
            'stats_after_at': session.stats_after_at,
            'counters': {
                'events': session.events,
                'by_kind': session.by_kind,
                'log_lines': session.log_lines,
                'dropped': session.dropped,
                'bytes': session.bytes,
            },
            'device': self._device_meta(),
        }

        (session.dir / 'meta.json').write_text(
            json.dumps(meta, indent=2, ensure_ascii=False, default=str), encoding='utf-8')
        for name, payload in (('stats_before.json', session.stats_before),
                              ('stats_after.json', session.stats_after)):
            (session.dir / name).write_text(
                json.dumps(payload, indent=2, ensure_ascii=False, default=str),
                encoding='utf-8')

        zip_path = self.captures_dir / f'{session.id}.zip'
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
            for item in sorted(session.dir.iterdir()):
                if item.is_file():
                    zf.write(item, arcname=f'{session.id}/{item.name}')

        logger.info(
            f"Diagnostics: capture {session.id} finished ({session.stop_reason}), "
            f"{session.events} events, {session.log_lines} log lines, "
            f"{zip_path.stat().st_size} B zipped")

    def _device_meta(self):
        dm = self.device_manager
        if dm is None:
            return {'connected': False}
        try:
            return {
                'connected': bool(dm.is_connected),
                'name': dm.device_name,
                'fw_ver_code': getattr(dm, '_fw_ver_code', None),
                'path_hash_mode': getattr(dm, '_path_hash_mode', None),
                'max_channels': getattr(dm, '_max_channels', None),
                'self_info': dm.self_info,
            }
        except Exception as e:
            return {'connected': False, 'error': str(e)}

    def _teardown(self, session):
        try:
            if self._log_handler is not None:
                logging.getLogger().removeHandler(self._log_handler)
                self._log_handler = None
            if self._prev_root_level is not None:
                logging.getLogger().setLevel(self._prev_root_level)
                self._prev_root_level = None
            shutil.rmtree(session.dir, ignore_errors=True)
        finally:
            self.recording = False
            self._session = None

    # ------------------------------------------------------------------
    # Upload (Zipline)
    # ------------------------------------------------------------------

    def get_upload_settings(self, include_token=False) -> dict:
        raw = self.db.get_setting_json(SETTINGS_KEY, {}) or {}
        out = {
            'url': raw.get('url') or DEFAULT_UPLOAD_URL,
            'has_token': bool(raw.get('token')),
        }
        if include_token:
            out['token'] = raw.get('token') or ''
        return out

    def save_upload_settings(self, url=None, token=None) -> dict:
        raw = self.db.get_setting_json(SETTINGS_KEY, {}) or {}
        if url is not None:
            url = (url or '').strip() or DEFAULT_UPLOAD_URL
            if not url.startswith(('http://', 'https://')):
                return {'success': False, 'error': 'Upload URL must start with http:// or https://'}
            raw['url'] = url
        if token is not None:
            # An empty string clears the token; the API never returns it, so
            # the form cannot round-trip it the way it does other fields.
            raw['token'] = (token or '').strip()
        self.db.set_setting_json(SETTINGS_KEY, raw)
        return {'success': True, 'settings': self.get_upload_settings()}

    def upload(self, capture_id: str) -> dict:
        """Send one capture to the configured Zipline instance.

        Mirrors the share.marwoj.net upload script: a bare `authorization`
        token (no Bearer), one multipart `file` field, and
        `x-zipline-original-name` so the maintainer downloads
        mc-webui-diag-<stamp>.zip rather than a random slug.
        """
        import requests

        path = self.capture_path(capture_id)
        if not path:
            return {'success': False, 'error': 'Capture not found'}

        settings = self.get_upload_settings(include_token=True)
        token = settings.get('token')
        if not token:
            return {'success': False, 'error': 'No upload token configured'}

        try:
            with open(path, 'rb') as fh:
                resp = requests.post(
                    settings['url'],
                    headers={
                        'authorization': token,
                        'x-zipline-original-name': 'true',
                    },
                    files={'file': (path.name, fh, 'application/zip')},
                    timeout=180,
                )
        except requests.RequestException as e:
            logger.error(f"Diagnostics upload failed: {e}")
            return {'success': False, 'error': f'Upload failed: {e}'}

        if resp.status_code >= 400:
            detail = (resp.text or '').strip()[:200]
            return {'success': False,
                    'error': f'Upload rejected (HTTP {resp.status_code}): {detail}'}

        url = _extract_zipline_url(resp)
        if not url:
            return {'success': False,
                    'error': 'Upload succeeded but the server returned no link'}

        uploads = self.db.get_setting_json(UPLOADS_KEY, {}) or {}
        uploads[capture_id] = url
        self.db.set_setting_json(UPLOADS_KEY, uploads)
        logger.info(f"Diagnostics: capture {capture_id} uploaded to {url}")
        return {'success': True, 'url': url}


def _extract_zipline_url(resp):
    """Pull the share link out of an upload response.

    Zipline v4 answers {"files":[{"url": "..."}]}; older builds answered
    {"files":["..."]}. Accept both rather than pinning to one deployment.
    """
    try:
        data = resp.json()
    except ValueError:
        text = (resp.text or '').strip()
        return text if text.startswith('http') else None
    files = data.get('files') if isinstance(data, dict) else None
    if isinstance(files, list) and files:
        first = files[0]
        if isinstance(first, dict):
            return first.get('url')
        if isinstance(first, str):
            return first
    if isinstance(data, dict):
        return data.get('url')
    return None


def _iso(epoch: float) -> str:
    """UTC ISO-8601 with milliseconds — the log file's human-readable column."""
    return datetime.fromtimestamp(epoch, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'
