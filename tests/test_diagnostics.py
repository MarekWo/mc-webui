"""
Unit tests for the diagnostic capture (Settings > Diagnostics).

The capture is the evidence a maintainer gets from a server they cannot log
into, so the things worth pinning down are: it records from the hot path
without blocking, it always ends in a readable zip, its caps actually stop it,
and it never leaks the upload token back out over the API.

Run: python -m pytest tests/test_diagnostics.py -v
"""

import json
import threading
import time
import zipfile

import pytest

from app.diagnostics import (
    DEFAULT_UPLOAD_URL,
    DiagnosticsManager,
    _extract_zipline_url,
)


class FakeConfig:
    transport_type = 'tcp'

    def __init__(self, tmp_path):
        self.MC_CONFIG_DIR = str(tmp_path)


class FakeDB:
    """app_settings, reduced to a dict."""

    def __init__(self):
        self.store = {}

    def get_setting_json(self, key, default=None):
        return self.store.get(key, default)

    def set_setting_json(self, key, value):
        self.store[key] = value


class FakeDeviceManager:
    """Reports a packet counter that climbs on every poll."""

    def __init__(self, connected=True):
        self.is_connected = connected
        self.device_name = 'TestNode'
        self.self_info = {'public_key': 'ab' * 32, 'name': 'TestNode'}
        self._fw_ver_code = 13
        self._path_hash_mode = 1
        self._max_channels = 8
        self.polls = 0

    def get_device_stats(self):
        self.polls += 1
        return {'packets': {'recv': 1000 + self.polls * 10, 'sent': 5}}


@pytest.fixture
def manager(tmp_path):
    mgr = DiagnosticsManager(FakeConfig(tmp_path), FakeDB())
    mgr.device_manager = FakeDeviceManager()
    yield mgr
    if mgr.recording:
        mgr.stop()


def read_zip(path):
    """Return {member basename: text} for a finished capture."""
    with zipfile.ZipFile(path) as zf:
        return {n.rsplit('/', 1)[-1]: zf.read(n).decode('utf-8') for n in zf.namelist()}


class TestLifecycle:
    def test_capture_round_trip(self, manager):
        assert manager.start()['success'] is True
        assert manager.recording is True

        manager.record('rx_log', hex='0505', snr=7.5)
        manager.record('send', msg_id=42, text='hello')
        result = manager.stop()

        assert result['success'] is True
        assert result['reason'] == 'user'
        assert manager.recording is False

        captures = manager.list_captures()
        assert len(captures) == 1
        members = read_zip(manager.capture_path(captures[0]['id']))
        assert set(members) >= {'meta.json', 'events.jsonl',
                                'stats_before.json', 'stats_after.json', 'log.txt'}

        events = [json.loads(line) for line in members['events.jsonl'].splitlines()]
        kinds = [e['k'] for e in events]
        assert 'rx_log' in kinds and 'send' in kinds
        assert next(e for e in events if e['k'] == 'send')['msg_id'] == 42

        meta = json.loads(members['meta.json'])
        assert meta['schema'] == 1
        assert meta['transport'] == 'tcp'
        assert meta['device']['name'] == 'TestNode'
        assert meta['counters']['by_kind']['rx_log'] == 1
        # Both endpoints are needed for the frame-loss comparison to mean anything.
        assert json.loads(members['stats_before.json'])['packets']['recv'] == 1010
        assert json.loads(members['stats_after.json'])['packets']['recv'] == 1020

    def test_work_dir_is_removed(self, manager, tmp_path):
        manager.start()
        manager.record('rx_log', hex='00')
        manager.stop()
        leftovers = [p for p in (tmp_path / 'diagnostics').iterdir() if p.is_dir()]
        assert leftovers == []

    def test_second_start_is_refused(self, manager):
        manager.start()
        second = manager.start()
        assert second['success'] is False
        assert 'already running' in second['error']

    def test_stop_without_capture(self, manager):
        result = manager.stop()
        assert result['success'] is False

    def test_record_while_idle_is_a_no_op(self, manager):
        manager.record('rx_log', hex='00')  # must not raise
        assert manager.status() == {'recording': False}

    def test_status_reports_progress(self, manager):
        manager.start(duration_min=5)
        manager.record('rx_log', hex='00')
        status = manager.status()
        assert status['recording'] is True
        assert status['max_seconds'] == 300
        assert status['events'] >= 1


class TestCaps:
    def test_size_cap_stops_the_capture(self, manager):
        manager.start(max_mb=1)
        # 1 MB of payload, written well before any duration cap could fire.
        blob = 'a' * 8192
        for _ in range(200):
            manager.record('rx_log', hex=blob)

        deadline = time.time() + 20
        while manager.recording and time.time() < deadline:
            time.sleep(0.2)

        assert manager.recording is False, 'size cap never fired'
        capture = manager.list_captures()[0]
        meta = json.loads(read_zip(manager.capture_path(capture['id']))['meta.json'])
        assert meta['stop_reason'] == 'size'

    def test_invalid_options_fall_back_to_defaults(self, manager):
        manager.start(duration_min=999, max_mb='nonsense')
        status = manager.status()
        assert status['max_seconds'] == 15 * 60
        assert status['max_bytes'] == 25 * 1024 * 1024

    def test_retention_prunes_old_captures(self, manager):
        manager._sweep(keep=0)  # nothing stored yet — must not raise
        manager.start()
        manager.stop()
        assert len(manager.list_captures()) == 1
        manager._sweep(keep=0)
        assert manager.list_captures() == []


class TestLogMirror:
    def test_log_lines_land_in_the_capture(self, manager):
        import logging
        manager.start(debug_logs=True)
        logging.getLogger('app.test_probe').debug('probe line for the capture')
        manager.stop()

        members = read_zip(manager.capture_path(manager.list_captures()[0]['id']))
        assert 'probe line for the capture' in members['log.txt']

    def test_root_log_level_is_restored(self, manager):
        import logging
        root = logging.getLogger()
        before = root.level
        manager.start(debug_logs=True)
        assert root.level == logging.DEBUG
        manager.stop()
        assert root.level == before

    def test_no_handler_is_left_behind(self, manager):
        import logging
        root = logging.getLogger()
        before = len(root.handlers)
        manager.start()
        manager.stop()
        assert len(root.handlers) == before


class TestHotPath:
    def test_record_never_raises_and_counts_drops(self, manager):
        from app import diagnostics
        manager.start()
        original = diagnostics._QUEUE_MAX
        diagnostics._QUEUE_MAX = 0  # force the overflow branch
        try:
            manager.record('rx_log', hex='00')
        finally:
            diagnostics._QUEUE_MAX = original
        assert manager._session.dropped == 1

    def test_concurrent_writers(self, manager):
        manager.start()

        def spam():
            for i in range(200):
                manager.record('rx_log', hex=f'{i:04x}')

        threads = [threading.Thread(target=spam) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        manager.stop()

        members = read_zip(manager.capture_path(manager.list_captures()[0]['id']))
        lines = members['events.jsonl'].splitlines()
        assert len([l for l in lines if '"rx_log"' in l]) == 800


class TestUploadSettings:
    def test_default_url_and_no_token(self, manager):
        settings = manager.get_upload_settings()
        assert settings['url'] == DEFAULT_UPLOAD_URL
        assert settings['has_token'] is False
        assert 'token' not in settings, 'the token must never leave over the API'

    def test_saving_a_token_does_not_expose_it(self, manager):
        manager.save_upload_settings(token='secret-token')
        assert manager.get_upload_settings() == {'url': DEFAULT_UPLOAD_URL, 'has_token': True}
        assert manager.get_upload_settings(include_token=True)['token'] == 'secret-token'

    def test_url_must_be_http(self, manager):
        result = manager.save_upload_settings(url='ftp://example.com')
        assert result['success'] is False

    def test_blank_url_restores_the_default(self, manager):
        manager.save_upload_settings(url='https://example.com/api/upload')
        manager.save_upload_settings(url='')
        assert manager.get_upload_settings()['url'] == DEFAULT_UPLOAD_URL

    def test_upload_without_token_fails_clearly(self, manager):
        manager.start()
        manager.stop()
        capture_id = manager.list_captures()[0]['id']
        result = manager.upload(capture_id)
        assert result['success'] is False
        assert 'token' in result['error']


class TestCapturePath:
    @pytest.mark.parametrize('bad', ['../secrets', 'a/b', 'a\\b', '..', ''])
    def test_traversal_is_refused(self, manager, bad):
        assert manager.capture_path(bad) is None

    def test_unknown_id_is_not_found(self, manager):
        assert manager.capture_path('mc-webui-diag-does-not-exist') is None
        assert manager.delete_capture('mc-webui-diag-does-not-exist')['success'] is False


class TestZiplineResponse:
    class FakeResponse:
        def __init__(self, payload=None, text=''):
            self._payload = payload
            self.text = text

        def json(self):
            if self._payload is None:
                raise ValueError('not json')
            return self._payload

    def test_v4_object_shape(self):
        resp = self.FakeResponse({'files': [{'url': 'https://share.example/u/a.zip'}]})
        assert _extract_zipline_url(resp) == 'https://share.example/u/a.zip'

    def test_v3_string_shape(self):
        resp = self.FakeResponse({'files': ['https://share.example/u/b.zip']})
        assert _extract_zipline_url(resp) == 'https://share.example/u/b.zip'

    def test_bare_url_body(self):
        resp = self.FakeResponse(None, text='https://share.example/u/c.zip\n')
        assert _extract_zipline_url(resp) == 'https://share.example/u/c.zip'

    def test_unrecognised_body(self):
        assert _extract_zipline_url(self.FakeResponse({'files': []})) is None
        assert _extract_zipline_url(self.FakeResponse(None, text='nope')) is None


class TestDisconnectedDevice:
    def test_capture_survives_a_missing_device(self, tmp_path):
        mgr = DiagnosticsManager(FakeConfig(tmp_path), FakeDB())
        mgr.device_manager = FakeDeviceManager(connected=False)
        mgr.start()
        mgr.record('rx_log', hex='00')
        assert mgr.stop()['success'] is True

        members = read_zip(mgr.capture_path(mgr.list_captures()[0]['id']))
        # No stats to compare, but the capture is still readable — the report
        # script says so rather than crashing.
        assert json.loads(members['stats_before.json']) is None
        assert json.loads(members['meta.json'])['device']['connected'] is False
