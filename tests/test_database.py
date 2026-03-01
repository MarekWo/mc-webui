"""
Integration tests for mc-webui v2 Database class.

Run: python -m pytest tests/test_database.py -v
"""

import tempfile
import time
from pathlib import Path
import pytest

from app.database import Database


@pytest.fixture
def db():
    """Create a temporary database for each test."""
    with tempfile.TemporaryDirectory() as tmp:
        yield Database(Path(tmp) / 'test.db')


# ================================================================
# Schema & Initialization
# ================================================================

class TestInitialization:
    def test_creates_database_file(self, db):
        assert db.db_path.exists()

    def test_all_tables_exist(self, db):
        stats = db.get_stats()
        expected_tables = [
            'device', 'contacts', 'channels', 'channel_messages',
            'direct_messages', 'acks', 'echoes', 'paths',
            'advertisements', 'read_status'
        ]
        for table in expected_tables:
            assert table in stats, f"Missing table: {table}"
            assert stats[table] == 0

    def test_wal_mode_enabled(self, db):
        import sqlite3
        conn = sqlite3.connect(str(db.db_path))
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        conn.close()
        assert mode == 'wal'

    def test_db_size_in_stats(self, db):
        stats = db.get_stats()
        assert stats['db_size_bytes'] > 0


# ================================================================
# Device
# ================================================================

class TestDevice:
    def test_set_and_get_device_info(self, db):
        db.set_device_info(public_key='abc123', name='TestDevice')
        info = db.get_device_info()
        assert info is not None
        assert info['public_key'] == 'abc123'
        assert info['name'] == 'TestDevice'

    def test_update_device_info(self, db):
        db.set_device_info(public_key='key1', name='Name1')
        db.set_device_info(public_key='key2', name='Name2')
        info = db.get_device_info()
        assert info['public_key'] == 'key2'
        assert info['name'] == 'Name2'

    def test_get_device_info_empty(self, db):
        assert db.get_device_info() is None


# ================================================================
# Contacts
# ================================================================

class TestContacts:
    def test_upsert_and_get(self, db):
        db.upsert_contact('AABB', name='Alice')
        contacts = db.get_contacts()
        assert len(contacts) == 1
        assert contacts[0]['public_key'] == 'aabb'  # lowercased
        assert contacts[0]['name'] == 'Alice'

    def test_upsert_updates_existing(self, db):
        db.upsert_contact('AABB', name='Alice')
        db.upsert_contact('AABB', name='Alice Updated', source='device')
        contacts = db.get_contacts()
        assert len(contacts) == 1
        assert contacts[0]['name'] == 'Alice Updated'

    def test_upsert_preserves_name_on_empty(self, db):
        db.upsert_contact('AABB', name='Alice')
        db.upsert_contact('AABB', name='')  # empty name should not overwrite
        contact = db.get_contact('AABB')
        assert contact['name'] == 'Alice'

    def test_get_contact_by_key(self, db):
        db.upsert_contact('AABB', name='Alice')
        contact = db.get_contact('aabb')
        assert contact is not None
        assert contact['name'] == 'Alice'

    def test_get_contact_not_found(self, db):
        assert db.get_contact('nonexistent') is None

    def test_delete_contact(self, db):
        db.upsert_contact('AABB', name='Alice')
        assert db.delete_contact('AABB') is True
        assert db.get_contact('AABB') is None

    def test_delete_nonexistent(self, db):
        assert db.delete_contact('nonexistent') is False

    def test_protect_contact(self, db):
        db.upsert_contact('AABB', name='Alice')
        db.set_contact_protected('AABB', True)
        contact = db.get_contact('AABB')
        assert contact['is_protected'] == 1

    def test_protected_not_overwritten(self, db):
        db.upsert_contact('AABB', name='Alice')
        db.set_contact_protected('AABB', True)
        db.upsert_contact('AABB', name='Alice', is_protected=0)
        contact = db.get_contact('AABB')
        assert contact['is_protected'] == 1  # stays protected

    def test_contact_with_gps(self, db):
        db.upsert_contact('CC', name='Bob', adv_lat=52.23, adv_lon=21.01)
        contact = db.get_contact('CC')
        assert abs(contact['adv_lat'] - 52.23) < 0.001
        assert abs(contact['adv_lon'] - 21.01) < 0.001


# ================================================================
# Channels
# ================================================================

class TestChannels:
    def test_upsert_and_list(self, db):
        db.upsert_channel(0, 'Public')
        db.upsert_channel(1, 'Private', secret='abc123')
        channels = db.get_channels()
        assert len(channels) == 2
        assert channels[0]['idx'] == 0
        assert channels[1]['name'] == 'Private'

    def test_delete_channel(self, db):
        db.upsert_channel(0, 'Public')
        assert db.delete_channel(0) is True
        assert len(db.get_channels()) == 0


# ================================================================
# Channel Messages
# ================================================================

class TestChannelMessages:
    def test_insert_and_get(self, db):
        ts = int(time.time())
        msg_id = db.insert_channel_message(
            channel_idx=0, sender='Alice', content='Hello!',
            timestamp=ts, snr=-5.5, path_len=2
        )
        assert msg_id > 0

        messages = db.get_channel_messages(0)
        assert len(messages) == 1
        assert messages[0]['sender'] == 'Alice'
        assert messages[0]['content'] == 'Hello!'
        assert messages[0]['snr'] == -5.5

    def test_limit_and_offset(self, db):
        ts = int(time.time())
        for i in range(10):
            db.insert_channel_message(0, f'User{i}', f'Msg {i}', ts + i)

        messages = db.get_channel_messages(0, limit=3)
        assert len(messages) == 3
        # Should be the last 3 messages
        assert messages[0]['content'] == 'Msg 7'
        assert messages[2]['content'] == 'Msg 9'

    def test_filter_by_channel(self, db):
        ts = int(time.time())
        db.insert_channel_message(0, 'A', 'Chan 0 msg', ts)
        db.insert_channel_message(1, 'B', 'Chan 1 msg', ts + 1)

        ch0 = db.get_channel_messages(0)
        ch1 = db.get_channel_messages(1)
        assert len(ch0) == 1
        assert len(ch1) == 1
        assert ch0[0]['content'] == 'Chan 0 msg'

    def test_delete_channel_messages(self, db):
        ts = int(time.time())
        db.insert_channel_message(0, 'A', 'Keep', ts)
        db.insert_channel_message(1, 'B', 'Delete', ts)
        deleted = db.delete_channel_messages(1)
        assert deleted == 1
        assert len(db.get_channel_messages(0)) == 1
        assert len(db.get_channel_messages(1)) == 0

    def test_own_message(self, db):
        ts = int(time.time())
        db.insert_channel_message(0, 'Me', 'My msg', ts, is_own=True)
        messages = db.get_channel_messages(0)
        assert messages[0]['is_own'] == 1


# ================================================================
# Direct Messages
# ================================================================

class TestDirectMessages:
    def test_insert_and_get(self, db):
        db.upsert_contact('aabb', name='Alice')
        ts = int(time.time())
        dm_id = db.insert_direct_message('aabb', 'in', 'Hello', ts)
        assert dm_id > 0

        messages = db.get_dm_messages('aabb')
        assert len(messages) == 1
        assert messages[0]['direction'] == 'in'
        assert messages[0]['content'] == 'Hello'

    def test_conversations_list(self, db):
        db.upsert_contact('aa', name='Alice')
        db.upsert_contact('bb', name='Bob')
        ts = int(time.time())
        db.insert_direct_message('aa', 'in', 'Hi from Alice', ts)
        db.insert_direct_message('bb', 'out', 'Hi to Bob', ts + 1)

        convos = db.get_dm_conversations()
        assert len(convos) == 2
        # Most recent first
        assert convos[0]['display_name'] == 'Bob'
        assert convos[1]['display_name'] == 'Alice'

    def test_dm_with_ack(self, db):
        db.upsert_contact('aa', name='Alice')
        ts = int(time.time())
        dm_id = db.insert_direct_message('aa', 'out', 'Test', ts, expected_ack='ACK123')
        db.insert_ack('ACK123', snr=-3.0, dm_id=dm_id)

        ack = db.get_ack_for_dm('ACK123')
        assert ack is not None
        assert ack['snr'] == -3.0

    def test_dm_with_pkt_payload(self, db):
        db.upsert_contact('cc', name='Charlie')
        ts = int(time.time())
        dm_id = db.insert_direct_message(
            'cc', 'in', 'Hello', ts, pkt_payload='deadbeef01020304'
        )
        messages = db.get_dm_messages('cc')
        assert len(messages) == 1
        assert messages[0]['pkt_payload'] == 'deadbeef01020304'


# ================================================================
# Echoes
# ================================================================

class TestEchoes:
    def test_insert_and_get(self, db):
        ts = int(time.time())
        cm_id = db.insert_channel_message(0, 'Me', 'Test', ts, pkt_payload='PKT1')
        db.insert_echo('PKT1', path='Me>Node1>Node2', snr=-4.0, cm_id=cm_id)

        echoes = db.get_echoes_for_message('PKT1')
        assert len(echoes) == 1
        assert echoes[0]['path'] == 'Me>Node1>Node2'


# ================================================================
# Full-Text Search (FTS5)
# ================================================================

class TestFTS:
    def test_search_channel_messages(self, db):
        ts = int(time.time())
        db.insert_channel_message(0, 'Alice', 'MeshCore is awesome', ts)
        db.insert_channel_message(0, 'Bob', 'Hello world', ts + 1)

        results = db.search_messages('awesome')
        assert len(results) == 1
        assert results[0]['content'] == 'MeshCore is awesome'

    def test_search_direct_messages(self, db):
        db.upsert_contact('aa', name='Alice')
        ts = int(time.time())
        db.insert_direct_message('aa', 'in', 'Secret mesh network', ts)

        results = db.search_messages('mesh network')
        assert len(results) == 1
        assert results[0]['msg_source'] == 'dm'

    def test_search_combined(self, db):
        db.upsert_contact('aa', name='Alice')
        ts = int(time.time())
        db.insert_channel_message(0, 'Bob', 'Testing mesh', ts)
        db.insert_direct_message('aa', 'in', 'Testing mesh too', ts + 1)

        results = db.search_messages('testing mesh')
        assert len(results) == 2

    def test_search_no_results(self, db):
        results = db.search_messages('nonexistent')
        assert len(results) == 0


# ================================================================
# Read Status
# ================================================================

class TestReadStatus:
    def test_mark_and_get(self, db):
        db.mark_read('chan_0', 1000)
        status = db.get_read_status()
        assert 'chan_0' in status
        assert status['chan_0']['last_seen_ts'] == 1000

    def test_mark_keeps_max_timestamp(self, db):
        db.mark_read('chan_0', 2000)
        db.mark_read('chan_0', 1000)  # older — should not downgrade
        status = db.get_read_status()
        assert status['chan_0']['last_seen_ts'] == 2000

    def test_mute_channel(self, db):
        db.set_channel_muted(0, True)
        status = db.get_read_status()
        assert status['chan_0']['is_muted'] == 1

        db.set_channel_muted(0, False)
        status = db.get_read_status()
        assert status['chan_0']['is_muted'] == 0


# ================================================================
# Backup
# ================================================================

class TestBackup:
    def test_create_backup(self, db):
        db.insert_channel_message(0, 'Test', 'Backup test', int(time.time()))
        backup_dir = db.db_path.parent / 'backups'
        backup_path = db.create_backup(backup_dir)
        assert backup_path.exists()
        assert backup_path.stat().st_size > 0

    def test_list_backups(self, db):
        backup_dir = db.db_path.parent / 'backups'
        db.create_backup(backup_dir)
        backups = db.list_backups(backup_dir)
        assert len(backups) == 1
        assert 'mc-webui.' in backups[0]['filename']

    def test_list_backups_empty_dir(self, db):
        with tempfile.TemporaryDirectory() as tmp:
            backups = db.list_backups(Path(tmp))
            assert len(backups) == 0


# ================================================================
# Maintenance
# ================================================================

class TestMaintenance:
    def test_cleanup_old_messages(self, db):
        now = int(time.time())
        old = now - 86400 * 10  # 10 days ago
        db.insert_channel_message(0, 'Old', 'Old msg', old)
        db.insert_channel_message(0, 'New', 'New msg', now)

        deleted = db.cleanup_old_messages(days=5)
        assert deleted == 1
        remaining = db.get_channel_messages(0)
        assert len(remaining) == 1
        assert remaining[0]['content'] == 'New msg'

    def test_stats(self, db):
        db.upsert_contact('aa', name='Alice')
        db.insert_channel_message(0, 'A', 'Test', int(time.time()))
        stats = db.get_stats()
        assert stats['contacts'] == 1
        assert stats['channel_messages'] == 1


# ================================================================
# Advertisements
# ================================================================

class TestAdvertisements:
    def test_insert(self, db):
        db.insert_advertisement(
            'AABB', 'Alice', type=1, lat=52.23, lon=21.01,
            timestamp=int(time.time()), snr=-3.0
        )
        stats = db.get_stats()
        assert stats['advertisements'] == 1


# ================================================================
# Paths
# ================================================================

class TestPaths:
    def test_insert(self, db):
        db.insert_path('aa', pkt_payload='PKT', path='A>B>C', snr=-5.0, path_len=3)
        stats = db.get_stats()
        assert stats['paths'] == 1


# ================================================================
# v1 Migration
# ================================================================

class TestV1Migration:
    def _write_msgs(self, path, lines):
        """Write JSONL lines to a .msgs file."""
        import json
        with open(path, 'w') as f:
            for line in lines:
                f.write(json.dumps(line) + '\n')

    def test_migrate_channel_messages(self, db):
        import tempfile, json
        from app.migrate_v1 import migrate_v1_data, should_migrate

        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            self._write_msgs(data_dir / 'TestDevice.msgs', [
                {'type': 'CHAN', 'channel_idx': 0, 'text': 'Alice: Hello world', 'timestamp': 1000, 'SNR': -5.0, 'path_len': 2},
                {'type': 'SENT_CHAN', 'channel_idx': 0, 'text': 'My message', 'timestamp': 1001, 'sender': 'TestDevice'},
                {'type': 'CHAN', 'channel_idx': 1, 'text': 'Bob: On channel 1', 'timestamp': 1002},
            ])

            assert should_migrate(db, data_dir, 'TestDevice')

            result = migrate_v1_data(db, data_dir, 'TestDevice')
            assert result['status'] == 'completed'
            assert result['channel_messages'] == 3

            msgs = db.get_channel_messages()
            assert len(msgs) == 3
            assert msgs[0]['sender'] == 'Alice'
            assert msgs[0]['content'] == 'Hello world'
            assert msgs[1]['sender'] == 'TestDevice'
            assert msgs[1]['content'] == 'My message'
            assert msgs[1]['is_own'] == 1
            assert msgs[2]['sender'] == 'Bob'
            assert msgs[2]['channel_idx'] == 1

    def test_migrate_dm_messages(self, db):
        import tempfile, json
        from app.migrate_v1 import migrate_v1_data

        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            self._write_msgs(data_dir / 'TestDevice.msgs', [
                {'type': 'PRIV', 'text': 'Hello from Alice', 'timestamp': 2000, 'pubkey_prefix': 'aabb', 'name': 'Alice'},
                {'type': 'SENT_MSG', 'text': 'Reply to Alice', 'timestamp': 2001, 'recipient': 'Alice', 'txt_type': 0},
                {'type': 'SENT_MSG', 'text': 'Channel sent', 'timestamp': 2002, 'txt_type': 1},  # should be skipped
            ])

            result = migrate_v1_data(db, data_dir, 'TestDevice')
            assert result['status'] == 'completed'
            assert result['direct_messages'] == 2
            assert result['skipped'] == 1

    def test_should_migrate_false_when_db_has_data(self, db):
        import tempfile
        from app.migrate_v1 import should_migrate

        with tempfile.TemporaryDirectory() as tmp:
            data_dir = Path(tmp)
            self._write_msgs(data_dir / 'Dev.msgs', [
                {'type': 'CHAN', 'text': 'Test: msg', 'timestamp': 1000},
            ])

            # Add a message to DB first
            db.insert_channel_message(0, 'X', 'Existing', int(time.time()))

            assert not should_migrate(db, data_dir, 'Dev')

    def test_should_migrate_false_when_no_msgs_file(self, db):
        import tempfile
        from app.migrate_v1 import should_migrate

        with tempfile.TemporaryDirectory() as tmp:
            assert not should_migrate(db, Path(tmp), 'NoDevice')
