"""
Unit tests for renaming the device.

The firmware writes its own name in front of every channel message it sends.
mc-webui stores own messages under its copy of that name, and builds each
message's raw_packet (what Resend replays) and echo candidates from it too. A
rename that left the copy stale until the next reconnect made Resend broadcast
a second packet under the old name (2026-09-11).

Run: python -m pytest tests/test_device_rename.py -v
"""

import asyncio
from concurrent.futures import TimeoutError as FuturesTimeoutError
from types import SimpleNamespace

import pytest

pytest.importorskip('meshcore', reason='app.device_manager needs the meshcore lib')

from meshcore.events import EventType  # noqa: E402

from app.config import RuntimeConfig, runtime_config  # noqa: E402
from app.device_manager import (  # noqa: E402
    DeviceManager,
    _compute_pkt_payload,
    _payload_from_raw_packet,
)

SECRET = '5c' * 16          # channel secrets are 16 bytes
PUBLIC_KEY = '88' * 32


def reply(event_type, payload=None):
    return SimpleNamespace(type=event_type, payload={} if payload is None else payload)


class FakeFirmware:
    """The companion firmware, as far as a rename and a channel send reach it.

    Commands return plain tuples, which the DeviceManager.execute patched in
    below plays against this object, so no event loop is needed.
    """

    def __init__(self, name):
        self.name = name
        self.received_names = []        # bytes of every set_name, as sent
        self.set_name_reply = None      # an event to answer set_name with instead of OK
        self.lose_set_name_reply = False
        self.appstart_reply = None      # an event to answer appstart with instead of SELF_INFO

    def set_name(self, name):
        return ('set_name', name)

    def send_appstart(self):
        return ('appstart',)

    def send_chan_msg(self, channel_idx, text):
        return ('send_chan_msg', channel_idx, text)

    def run(self, command):
        kind = command[0]
        if kind == 'set_name':
            raw = command[1].encode('utf-8')
            self.received_names.append(raw)
            if self.set_name_reply is not None:
                return self.set_name_reply
            # CMD_SET_ADVERT_NAME keeps sizeof(node_name) - 1 = 31 bytes
            self.name = raw[:31].decode('utf-8', 'ignore')
            if self.lose_set_name_reply:
                raise FuturesTimeoutError()
            return reply(EventType.OK)
        if kind == 'appstart':
            if self.appstart_reply is not None:
                return self.appstart_reply
            return reply(EventType.SELF_INFO, {'name': self.name, 'public_key': PUBLIC_KEY})
        if kind == 'send_chan_msg':
            return reply(EventType.OK)
        raise AssertionError(f'unexpected command {command!r}')


class FakeDB:
    def __init__(self):
        self.messages = {}          # msg_id -> insert_channel_message kwargs
        self.raw_packets = {}       # msg_id -> raw_packet hex
        self.own_payloads = set()   # pkt_payloads of own rows
        self.device = None

    def get_channel_scope(self, channel_idx):
        return None

    def insert_channel_message(self, **kwargs):
        msg_id = len(self.messages) + 1
        self.messages[msg_id] = kwargs
        return msg_id

    def update_message_raw_packet(self, msg_id, raw_packet):
        self.raw_packets[msg_id] = raw_packet

    def has_own_channel_message_with_pkt_payload(self, pkt_payload):
        return pkt_payload in self.own_payloads

    def get_blocked_contact_names(self):
        return set()

    def set_device_info(self, public_key, name, self_info=None):
        self.device = {'public_key': public_key, 'name': name}


class FakeSocketIO:
    def __init__(self):
        self.emitted = []

    def emit(self, event, data, namespace=None):
        self.emitted.append((event, data))

    def announced_names(self):
        return [data['name'] for event, data in self.emitted if event == 'device_name']


@pytest.fixture
def firmware():
    return FakeFirmware('MarWoj Tester')


@pytest.fixture
def dm(firmware, monkeypatch):
    # RuntimeConfig keeps the name on the class, shared by the whole process
    monkeypatch.setattr(RuntimeConfig, '_device_name', None)
    monkeypatch.setattr(RuntimeConfig, '_device_name_source', 'config')

    manager = DeviceManager(config=SimpleNamespace(MC_DEVICE_NAME='auto'),
                            db=FakeDB(), socketio=FakeSocketIO())
    manager.mc = SimpleNamespace(commands=firmware)
    manager._connected = True
    manager._device_name = firmware.name
    manager._channel_secrets = {4: SECRET}
    manager.execute = lambda command, timeout=None: firmware.run(command)
    manager.set_flood_scope_key = lambda key_hex: {'success': True}
    manager._refresh_channel_secret = lambda channel_idx: SECRET
    return manager


# ================================================================
# The new name reaches every copy
# ================================================================

def test_rename_is_adopted_everywhere(dm):
    result = dm.set_param('name', 'MarWoj Tester 2')

    assert result['success'] is True
    assert result['name'] == 'MarWoj Tester 2'
    assert dm.device_name == 'MarWoj Tester 2'
    assert runtime_config.get_device_name() == 'MarWoj Tester 2'
    assert runtime_config.get_device_name_source() == 'device'
    assert dm.socketio.announced_names() == ['MarWoj Tester 2']
    assert dm.db.device == {'public_key': PUBLIC_KEY, 'name': 'MarWoj Tester 2'}


def test_message_sent_after_rename_is_built_with_the_new_name(dm):
    """Regression (2026-09-11): the raw_packet snapshot was still built from
    the old name, so Resend put a packet reading 'MarWoj Tester: ...' on air
    next to the original 'MarWoj Tester 2: ...', and no echo ever matched."""
    dm.set_param('name', 'MarWoj Tester 2')

    result = dm.send_channel_message(4, 'Renamed, then sent')

    assert result['success'] is True
    on_air = _compute_pkt_payload(SECRET, result['timestamp'], 0,
                                  'MarWoj Tester 2: Renamed, then sent')
    assert dm.db.messages[result['id']]['sender'] == 'MarWoj Tester 2'
    assert _payload_from_raw_packet(dm.db.raw_packets[result['id']]) == on_air
    assert on_air in dm._pending_echoes[-1]['expected_payloads']


def test_long_name_is_cut_on_a_character_boundary(dm, firmware):
    """The firmware keeps 31 bytes and cuts wherever that lands. Inside a
    character, the name read back (decoded with 'ignore') would be shorter than
    the bytes the firmware puts on air, and every message would mismatch again."""
    name = 'MarWoj Tester ' + '📻' * 5            # 34 bytes, byte 31 inside an emoji
    with pytest.raises(UnicodeDecodeError):
        name.encode('utf-8')[:31].decode('utf-8')

    result = dm.set_param('name', name)

    kept = 'MarWoj Tester ' + '📻' * 4
    assert firmware.received_names == [kept.encode('utf-8')]
    assert result['name'] == kept
    assert dm.device_name == kept


def test_empty_name_never_reaches_the_device(dm, firmware):
    result = dm.set_param('name', '   ')

    assert result['success'] is False
    assert firmware.received_names == []
    assert dm.device_name == 'MarWoj Tester'


# ================================================================
# Failures: the device's answer decides, not the command's
# ================================================================

@pytest.mark.parametrize('payload', [
    {'error_code': 6},                  # device frame, code the lib has no string for
    {},                                 # bare one-byte ERROR frame
    {'reason': 'no_event_received'},    # the lib gave up waiting
])
def test_refused_rename_keeps_the_name_the_device_still_has(dm, firmware, payload):
    firmware.set_name_reply = reply(EventType.ERROR, payload)

    result = dm.set_param('name', 'MarWoj Tester 2')

    assert result['success'] is False
    assert 'None' not in result['error']
    assert dm.device_name == 'MarWoj Tester'
    assert runtime_config.get_device_name() == 'MarWoj Tester'


def test_lost_reply_still_adopts_the_name_the_device_took(dm, firmware):
    """execute() gives up after 5 s while the command may already have landed;
    the device then sends under the new name, so ours has to follow it."""
    firmware.lose_set_name_reply = True

    result = dm.set_param('name', 'MarWoj Tester 2')

    assert result['success'] is False
    assert dm.device_name == 'MarWoj Tester 2'
    assert dm.socketio.announced_names() == ['MarWoj Tester 2']


def test_unanswered_read_back_is_not_cached_as_device_info(dm, firmware):
    """An ERROR event has a payload too; cached as SELF_INFO it blanked the
    name and position shown in Settings."""
    firmware.appstart_reply = reply(EventType.ERROR, {'reason': 'no_event_received'})

    result = dm.set_param('name', 'MarWoj Tester 2')

    # Accepted, so the device holds exactly the name it was sent
    assert result['success'] is True
    assert dm.device_name == 'MarWoj Tester 2'
    assert dm.self_info is None
    assert dm.get_device_info() == {}


# ================================================================
# A resend of a message from before the rename
# ================================================================

def loopback(text, sender_timestamp=1789104318):
    return SimpleNamespace(payload={
        'channel_idx': 4, 'text': text, 'txt_type': 0,
        'sender_timestamp': sender_timestamp, 'timestamp': sender_timestamp + 60,
    })


def test_resend_from_before_the_rename_is_still_recognised(dm):
    """A resend replays the original bytes, old name included. The self-echo
    guard only fired for the current name, so after a rename the looped-back
    resend was stored as a new message from the old name."""
    text = 'MarWoj Tester: sent before the rename'
    dm.db.own_payloads.add(_compute_pkt_payload(SECRET, 1789104318, 0, text))
    dm.set_param('name', 'MarWoj Tester 2')

    asyncio.run(dm._on_channel_message(loopback(text)))

    assert dm.db.messages == {}


def test_someone_elses_message_is_still_stored(dm):
    asyncio.run(dm._on_channel_message(loopback('Kolargol: hello')))

    assert [m['sender'] for m in dm.db.messages.values()] == ['Kolargol']
