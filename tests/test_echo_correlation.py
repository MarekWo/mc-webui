"""
Unit tests for sent-message echo correlation.

A sent channel message learns its packet hash (and therefore its route badge)
only by hearing its own echo come back from a repeater. These tests cover the
matching rules that decide whether an incoming echo belongs to one of our
recent sends.

Run: python -m pytest tests/test_echo_correlation.py -v
"""

import pytest

pytest.importorskip('meshcore', reason='app.device_manager needs the meshcore lib')

from app.device_manager import (  # noqa: E402
    DeviceManager,
    _build_grp_txt_raw_packet,
    _compute_pkt_payload,
    _payload_from_raw_packet,
)

SECRET = '5c' * 32
SCOPE_KEY = 'a7' * 32


class FakeDB:
    """Records the writes _process_echo makes, nothing else."""

    def __init__(self):
        self.echoes = []
        self.payloads = {}       # msg_id -> pkt_payload
        self.raw_packets = {}    # msg_id -> raw_packet hex

    def insert_echo(self, pkt_payload, **kwargs):
        self.echoes.append(dict(pkt_payload=pkt_payload, **kwargs))

    def update_message_pkt_payload(self, msg_id, pkt_payload):
        self.payloads[msg_id] = pkt_payload

    def update_message_raw_packet(self, msg_id, raw_packet):
        self.raw_packets[msg_id] = raw_packet

    def get_channel_scope(self, channel_idx):
        return None


@pytest.fixture
def dm():
    manager = DeviceManager(config=None, db=FakeDB())
    manager._channel_secrets = {0: SECRET, 7: SECRET}
    return manager


def payload_for(sender_timestamp, text):
    return _compute_pkt_payload(SECRET, sender_timestamp, 0, text)


def backdate(manager, seconds):
    """Age the most recently registered pending send."""
    manager._pending_echoes[-1]['timestamp'] -= seconds


# ================================================================
# Multiple sends in flight
# ================================================================

class TestMultiplePendingSends:
    def test_resend_does_not_steal_another_sends_echo(self, dm):
        """Regression (msg #71179, 2026-08-07): a resend of an older message
        fired 33 ms before this message's echo came back. With a single
        correlation slot the echo was filed as foreign traffic and the message
        never got a route badge."""
        fresh = payload_for(1000, 'MarWoj: fresh send')
        older = payload_for(500, 'MarWoj: older message')
        dm._register_pending_echo(msg_id=71179, channel_idx=7,
                                  expected_payloads={fresh}, guess_pkt_payload=fresh)
        dm._register_pending_echo(msg_id=71177, channel_idx=7, pkt_payload=older,
                                  expected_payloads={older}, guess_pkt_payload=older)

        dm._process_echo(fresh, path='d103df', snr=12.0, hash_size=3)

        assert dm.db.payloads == {71179: fresh}
        assert dm.db.echoes[-1]['direction'] == 'sent'
        assert dm.db.raw_packets == {}  # ts+0 guess was right, no rebuild

    def test_back_to_back_sends_each_get_their_own_echo(self, dm):
        first = payload_for(1000, 'MarWoj: one')
        second = payload_for(1030, 'MarWoj: two')
        dm._register_pending_echo(msg_id=1, channel_idx=0,
                                  expected_payloads={first}, guess_pkt_payload=first)
        dm._register_pending_echo(msg_id=2, channel_idx=0,
                                  expected_payloads={second}, guess_pkt_payload=second)

        dm._process_echo(second, path='5e34e8', hash_size=3)
        dm._process_echo(first, path='d103df', hash_size=3)

        assert dm.db.payloads == {1: first, 2: second}
        assert [e['direction'] for e in dm.db.echoes] == ['sent', 'sent']

    def test_second_repeater_echo_is_still_ours(self, dm):
        payload = payload_for(1000, 'MarWoj: two repeaters heard this')
        dm._register_pending_echo(msg_id=5, channel_idx=0,
                                  expected_payloads={payload}, guess_pkt_payload=payload)

        dm._process_echo(payload, path='d103df', hash_size=3)
        dm._process_echo(payload, path='5e34e8', hash_size=3)

        assert [e['direction'] for e in dm.db.echoes] == ['sent', 'sent']
        assert len(dm.db.payloads) == 1  # written once, not on every echo

    def test_foreign_payload_stays_incoming(self, dm):
        mine = payload_for(1000, 'MarWoj: mine')
        theirs = payload_for(1000, 'Kolargol: theirs')
        dm._register_pending_echo(msg_id=1, channel_idx=0,
                                  expected_payloads={mine}, guess_pkt_payload=mine)

        dm._process_echo(theirs, path='e7615e34', hash_size=2)

        assert dm.db.payloads == {}
        assert dm.db.echoes[-1]['direction'] == 'incoming'

    def test_one_pending_entry_per_message(self, dm):
        payload = payload_for(1000, 'MarWoj: resent twice')
        for _ in range(3):
            dm._register_pending_echo(msg_id=9, channel_idx=0, pkt_payload=payload,
                                      expected_payloads={payload},
                                      guess_pkt_payload=payload)
        assert len(dm._pending_echoes) == 1

    def test_pending_list_is_capped(self, dm):
        for i in range(DeviceManager._MAX_PENDING_ECHOES + 10):
            dm._register_pending_echo(msg_id=i, channel_idx=0,
                                      expected_payloads={payload_for(i, f'msg {i}')})
        assert len(dm._pending_echoes) == DeviceManager._MAX_PENDING_ECHOES


# ================================================================
# Correlation windows
# ================================================================

class TestCorrelationWindow:
    def test_late_echo_still_correlates(self, dm):
        """Observed on prod: repeats arriving 62 s and 200 s after the send."""
        payload = payload_for(1000, 'MarWoj: slow repeater')
        dm._register_pending_echo(msg_id=1, channel_idx=0,
                                  expected_payloads={payload}, guess_pkt_payload=payload)
        backdate(dm, 200)

        dm._process_echo(payload, path='ee6ccf', hash_size=3)

        assert dm.db.payloads == {1: payload}

    def test_echo_past_ttl_is_dropped(self, dm):
        payload = payload_for(1000, 'MarWoj: ancient')
        dm._register_pending_echo(msg_id=1, channel_idx=0,
                                  expected_payloads={payload}, guess_pkt_payload=payload)
        backdate(dm, DeviceManager._ECHO_MATCH_TTL + 1)

        dm._process_echo(payload, path='d103df', hash_size=3)

        assert dm.db.payloads == {}
        assert dm.db.echoes[-1]['direction'] == 'incoming'
        assert dm._pending_echoes == []


class TestChannelHashFallback:
    """Loose matching for the no-secret edge case: same channel-hash byte,
    short window only, because it can grab a foreign message."""

    def test_matches_within_short_window(self, dm):
        payload = payload_for(1000, 'MarWoj: no secret at send time')
        dm._register_pending_echo(msg_id=1, channel_idx=0)  # no expected_payloads

        dm._process_echo(payload, path='d103df', hash_size=3)

        assert dm.db.payloads == {1: payload}
        assert dm.db.echoes[-1]['direction'] == 'sent'

    def test_not_used_after_60s(self, dm):
        payload = payload_for(1000, 'MarWoj: too late for a loose match')
        dm._register_pending_echo(msg_id=1, channel_idx=0)
        backdate(dm, DeviceManager._ECHO_FALLBACK_TTL + 1)

        dm._process_echo(payload, path='d103df', hash_size=3)

        assert dm.db.payloads == {}
        assert dm.db.echoes[-1]['direction'] == 'incoming'

    def test_other_channel_hash_is_not_ours(self, dm):
        dm._channel_secrets = {0: SECRET}
        other = _compute_pkt_payload(SCOPE_KEY, 1000, 0, 'Someone: other channel')
        dm._register_pending_echo(msg_id=1, channel_idx=0)

        dm._process_echo(other, path='d103df', hash_size=3)

        assert dm.db.payloads == {}
        assert dm.db.echoes[-1]['direction'] == 'incoming'


# ================================================================
# Recovering the payload from a raw_packet snapshot (resend path)
# ================================================================

class TestPayloadFromRawPacket:
    def test_round_trip_flood(self):
        payload = payload_for(1000, 'MarWoj: plain flood')
        raw = _build_grp_txt_raw_packet(payload, scope_key_hex=None, path_hash_size=3)
        assert _payload_from_raw_packet(raw) == payload

    def test_round_trip_transport_flood(self):
        payload = payload_for(1000, 'MarWoj: region-scoped')
        raw = _build_grp_txt_raw_packet(payload, scope_key_hex=SCOPE_KEY, path_hash_size=2)
        assert _payload_from_raw_packet(raw) == payload

    def test_accepts_bytes(self):
        payload = payload_for(1000, 'MarWoj: bytes in')
        raw = _build_grp_txt_raw_packet(payload, path_hash_size=1)
        assert _payload_from_raw_packet(bytes.fromhex(raw)) == payload

    @pytest.mark.parametrize('bad', [None, '', '15'])
    def test_returns_none_when_unparsable(self, bad):
        assert _payload_from_raw_packet(bad) is None

    def test_resend_recovers_the_badge_of_an_uncorrelated_message(self, dm):
        """A message that missed its echo has no stored pkt_payload. The resend
        arms correlation from the raw_packet snapshot instead, so the next echo
        writes the payload onto the message row and the badge appears."""
        payload = payload_for(1000, 'MarWoj: badge-less until resent')
        raw = _build_grp_txt_raw_packet(payload, scope_key_hex=None, path_hash_size=3)
        recovered = _payload_from_raw_packet(raw)
        dm._register_pending_echo(msg_id=71179, channel_idx=7, pkt_payload=None,
                                  expected_payloads={recovered},
                                  guess_pkt_payload=recovered)

        dm._process_echo(payload, path='d103df', snr=12.0, hash_size=3)

        assert dm.db.payloads == {71179: payload}
        assert dm.db.echoes[-1]['direction'] == 'sent'
