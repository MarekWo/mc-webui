"""
Unit tests for the client side of MeshCore firmware 1.18.

- Contact flag bit 0x10 now lets that contact run any CLI command on our node,
  and CMD_ADD_UPDATE_CONTACT overwrites the whole flags byte, so every write
  must carry the device's current flags rather than rebuild them.
- Approving a pending contact used to raise KeyError('out_path') for every
  record not produced by a NEW_CONTACT event (advert-injected, DB fallback).
- A remote CLI command the companion refused to run arrives as a DM with
  txt_type 3 and must be stored and shown as such.
- A named channel slot must never get an all-zero key.
- The companion's own CLI (CMD_RUN_CLI_COMMAND) needs firmware 1.18.

The real meshcore command classes build the frames; only send() is faked, so
the tests see the exact bytes that would reach the device.

Run: python -m pytest tests/test_firmware_1_18.py -v
"""

import asyncio
from types import SimpleNamespace

import pytest

pytest.importorskip('meshcore', reason='app.device_manager needs the meshcore lib')

from meshcore.commands.contact import ContactCommands  # noqa: E402
from meshcore.commands.device import DeviceCommands  # noqa: E402
from meshcore.events import EventType  # noqa: E402

from app.device_manager import (  # noqa: E402
    DeviceManager,
    _device_contact_record,
    describe_contact_flags,
)

PK = 'ab' * 32
CMD_ADD_UPDATE_CONTACT = 0x09
CMD_RUN_CLI_COMMAND = 66


def reply(event_type, payload=None):
    return SimpleNamespace(type=event_type, payload={} if payload is None else payload)


def parse_contact_frame(frame):
    """Fields of a CMD_ADD_UPDATE_CONTACT frame, as the firmware reads them."""
    assert frame[0] == CMD_ADD_UPDATE_CONTACT
    return {
        'public_key': frame[1:33].hex(),
        'type': frame[33],
        'flags': frame[34],
        'out_path_len': frame[35],
        'out_path': frame[36:100].hex().rstrip('0'),
        'name': frame[100:132].rstrip(b'\0').decode(),
        'last_advert': int.from_bytes(frame[132:136], 'little'),
    }


class RecordingCommands(ContactCommands, DeviceCommands):
    """The library's own command code; send() records instead of transmitting."""

    def __init__(self):
        self.frames = []
        self.reply = reply(EventType.OK)

    async def send(self, data, expected_events=None, timeout=None):
        self.frames.append(bytes(data))
        if data[0] == CMD_RUN_CLI_COMMAND:
            return reply(EventType.CLI_REPLY, {'text': f'> {bytes(data[1:]).decode()}'})
        return self.reply

    def contact_frames(self):
        return [parse_contact_frame(f) for f in self.frames if f[0] == CMD_ADD_UPDATE_CONTACT]


class FakeMC:
    def __init__(self, commands):
        self.commands = commands
        self.contacts = {}
        self.pending_contacts = {}

    async def ensure_contacts(self, follow=False):
        return True     # like the library: no refetch unless an advert marked it dirty

    def get_contact_by_name(self, name):
        return next((c for c in self.contacts.values() if c.get('adv_name') == name), None)

    def get_contact_by_key_prefix(self, prefix):
        return next((c for k, c in self.contacts.items() if k.startswith(prefix)), None)


class FakeDB:
    def __init__(self):
        self.contacts = {}
        self.dms = []
        self.upserts = []

    def get_contact(self, public_key):
        return self.contacts.get(public_key)

    def get_contact_by_prefix(self, prefix):
        return None

    def upsert_contact(self, **kwargs):
        self.upserts.append(kwargs)

    def relink_orphaned_dms(self, public_key, name=None):
        pass

    def upsert_channel(self, idx, name, secret):
        pass

    def delete_channel(self, idx):
        pass

    def find_dm_duplicate(self, *args, **kwargs):
        return None

    def is_contact_blocked(self, public_key):
        return False

    def insert_direct_message(self, **kwargs):
        self.dms.append(kwargs)
        return len(self.dms)


class FakeSocketIO:
    def __init__(self):
        self.emitted = []

    def emit(self, event, data, namespace=None):
        self.emitted.append((event, data))


def device_contact(**overrides):
    """A contact as the library holds it after reading the device's table."""
    contact = {
        'public_key': PK, 'type': 1, 'flags': 0x13, 'out_path_len': 2,
        'out_path': 'a1b2', 'out_path_hash_mode': 0, 'adv_name': 'Alice',
        'last_advert': 1700000000, 'adv_lat': 50.5, 'adv_lon': 20.5, 'lastmod': 1700000001,
    }
    contact.update(overrides)
    return contact


@pytest.fixture
def commands():
    return RecordingCommands()


@pytest.fixture
def dm(commands):
    manager = DeviceManager(config=SimpleNamespace(MC_DEVICE_NAME='auto'),
                            db=FakeDB(), socketio=FakeSocketIO())
    manager.mc = FakeMC(commands)
    manager._connected = True
    manager._fw_ver_code = 14
    manager.execute = lambda coro, timeout=None: asyncio.run(coro)
    manager._refresh_channel_secret = lambda idx: None
    return manager


# ================================================================
# Approving a pending contact
# ================================================================

def test_approve_contact_injected_from_an_advert(dm, commands):
    # the shape _on_advertisement puts into mc.pending_contacts
    dm.mc.pending_contacts[PK] = {
        'public_key': PK, 'adv_name': 'Bob', 'name': 'Bob', 'type': 1,
        'adv_lat': None, 'adv_lon': None, 'last_advert': 1700000000,
    }

    result = dm.approve_contact(PK)

    assert result['success'], result
    [frame] = commands.contact_frames()
    assert frame['name'] == 'Bob'
    assert frame['flags'] == 0
    assert frame['out_path_len'] == 0xFF       # flood
    assert PK not in dm.mc.pending_contacts
    assert dm.mc.contacts[PK]['out_path_len'] == -1


def test_approve_contact_from_the_db_fallback(dm, commands):
    dm.db.contacts[PK] = {
        'public_key': PK, 'name': 'Carol', 'type': 2, 'source': 'advert',
        'adv_lat': 50.1, 'adv_lon': 20.2, 'last_advert': '1700000000',
    }

    result = dm.approve_contact(PK)

    assert result['success'], result
    [frame] = commands.contact_frames()
    assert (frame['name'], frame['type'], frame['last_advert']) == ('Carol', 2, 1700000000)


def test_approve_contact_reports_a_device_refusal(dm, commands):
    dm.mc.pending_contacts[PK] = {'public_key': PK, 'adv_name': 'Bob', 'type': 1}
    commands.reply = reply(EventType.ERROR, {'error_code': 3, 'code_string': 'TABLE_FULL'})

    result = dm.approve_contact(PK)

    assert not result['success']
    assert 'TABLE_FULL' in result['error']
    assert PK in dm.mc.pending_contacts        # still pending, nothing claimed


# ================================================================
# Re-adding a contact the device already holds (rename)
# ================================================================

def test_readding_a_device_contact_keeps_its_flags_and_path(dm, commands):
    dm.mc.contacts[PK] = device_contact()

    result = dm.add_contact_manual('Alice Renamed', PK, 1)

    assert result['success'], result
    [frame] = commands.contact_frames()
    assert frame['flags'] == 0x13              # remote CLI + favourite + base telemetry kept
    assert (frame['out_path_len'], frame['out_path']) == (2, 'a1b2')
    assert frame['name'] == 'Alice Renamed'
    assert dm.mc.contacts[PK]['adv_name'] == 'Alice Renamed'


def test_a_new_manual_contact_gets_no_flags(dm, commands):
    result = dm.add_contact_manual('Dave', PK, 1)

    assert result['success'], result
    [frame] = commands.contact_frames()
    assert frame['flags'] == 0
    assert frame['out_path_len'] == 0xFF


def test_a_path_change_carries_the_current_flags(dm, commands):
    dm.mc.contacts[PK] = device_contact(flags=0x10)

    dm.change_path(PK, 'c3d4')

    [frame] = commands.contact_frames()
    assert frame['flags'] == 0x10


# ================================================================
# change_contact_flags
# ================================================================

def test_change_flags_reports_the_previous_value(dm, commands):
    dm.mc.contacts[PK] = device_contact(flags=0x03)

    result = dm.change_contact_flags('Alice', 0x13)

    assert result['success'], result
    assert (result['old_flags'], result['flags']) == (0x03, 0x13)
    [frame] = commands.contact_frames()
    assert frame['flags'] == 0x13
    assert dm.mc.contacts[PK]['flags'] == 0x13


def test_change_flags_failure_leaves_the_record_untouched(dm, commands):
    dm.mc.contacts[PK] = device_contact(flags=0x03)
    commands.reply = reply(EventType.ERROR, {'reason': 'timeout'})

    result = dm.change_contact_flags('Alice', 0x13)

    assert not result['success']
    assert dm.mc.contacts[PK]['flags'] == 0x03


def test_change_flags_rejects_out_of_range_values(dm, commands):
    dm.mc.contacts[PK] = device_contact()

    assert not dm.change_contact_flags('Alice', 256)['success']
    assert commands.frames == []


def test_describe_contact_flags():
    assert describe_contact_flags(0) == 'none'
    assert describe_contact_flags(0x13) == 'favourite, telemetry: base, remote CLI'
    assert describe_contact_flags(0x41) == 'favourite, unknown 0x40'


def test_contact_record_fills_what_the_library_requires():
    record = _device_contact_record({'public_key': PK.upper(), 'name': 'Eve',
                                     'last_advert': '1700000000.0', 'adv_lat': None})
    assert record['public_key'] == PK
    assert record['adv_name'] == 'Eve'
    assert (record['flags'], record['out_path'], record['out_path_len']) == (0, '', -1)
    assert record['last_advert'] == 1700000000
    assert record['adv_lat'] == 0.0


# ================================================================
# Remote CLI command arriving as a DM (txt_type 3)
# ================================================================

def test_remote_cli_command_is_stored_with_its_type(dm):
    dm.mc.contacts[PK] = device_contact(flags=0)
    event = SimpleNamespace(payload={
        'pubkey_prefix': PK[:12], 'txt_type': 3, 'text': 'get wifi.pwd',
        'sender_timestamp': 1700000100,
    })

    asyncio.run(dm._on_dm_received(event))

    [stored] = dm.db.dms
    assert (stored['txt_type'], stored['content']) == (3, 'get wifi.pwd')
    [(name, data)] = dm.socketio.emitted
    assert name == 'new_message' and data['txt_type'] == 3


def test_plain_dm_is_stored_as_type_0(dm):
    dm.mc.contacts[PK] = device_contact()
    event = SimpleNamespace(payload={'pubkey_prefix': PK[:12], 'txt_type': 0, 'text': 'hi',
                                     'sender_timestamp': 1700000100})

    asyncio.run(dm._on_dm_received(event))

    assert dm.db.dms[0]['txt_type'] == 0


# ================================================================
# Channel keys
# ================================================================

def test_named_channel_with_all_zero_key_is_refused(dm, commands):
    result = dm.set_channel(3, 'Secret', bytes(16))

    assert not result['success']
    assert commands.frames == []


def test_channel_without_key_gets_a_derived_one(dm, commands):
    assert dm.set_channel(3, 'Friends', None)['success']
    assert dm.remove_channel(3)['success']

    for frame in commands.frames:
        assert any(frame[34:50]), 'the library must never send a zero key'


# ================================================================
# Companion CLI (CMD_RUN_CLI_COMMAND)
# ================================================================

def test_device_cli_returns_the_reply(dm, commands):
    result = dm.run_device_cli('get cad')

    assert result == {'success': True, 'reply': '> get cad'}
    assert commands.frames == [bytes([CMD_RUN_CLI_COMMAND]) + b'get cad']


def test_device_cli_needs_firmware_1_18(dm, commands):
    dm._fw_ver_code = 13

    result = dm.run_device_cli('get cad')

    assert not result['success'] and '1.18' in result['error']
    assert commands.frames == []


def test_device_cli_refuses_poweroff(dm, commands):
    for command in ('poweroff', 'shutdown'):
        assert not dm.run_device_cli(command)['success']
    assert commands.frames == []


def test_device_cli_set_name_goes_through_set_param(dm, commands, monkeypatch):
    calls = []
    monkeypatch.setattr(dm, 'set_param', lambda param, value: calls.append((param, value))
                        or {'success': True, 'message': 'renamed'})

    assert dm.run_device_cli('set name New Name')['success']
    assert calls == [('name', 'New Name')]
    assert commands.frames == []
