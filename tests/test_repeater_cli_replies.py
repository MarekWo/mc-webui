"""
Unit tests for classifying repeater CLI replies in the settings batch.

The firmware's reply text is the only capability signal available for a remote
repeater: FIRMWARE_VER_CODE stayed at 13 across v1.16 → v1.17, so it cannot
tell us whether a node knows a setting added in v1.17 (`cad`).

Run: python -m pytest tests/test_repeater_cli_replies.py -v
"""

import pytest

from app.routes.api import _reply_is_unsupported


# ================================================================
# Replies that mean "this node does not have that setting"
# ================================================================

@pytest.mark.parametrize('reply', [
    '??: cad',                            # unknown `get` field (any version)
    'unknown config: cad on',             # unknown `set` field
    'Error: unsupported',                 # v1.17 hardware refusal
    'Error: unsupported by this board',   # v1.16 wording, still recognised
    '  ??: radio.fem.rxgain  ',           # surrounding whitespace
    'ERROR: UNSUPPORTED',                 # case-insensitive
])
def test_unsupported_replies(reply):
    assert _reply_is_unsupported(reply) is True


# ================================================================
# Everything else — a value, a real failure, or nothing at all
# ================================================================

@pytest.mark.parametrize('reply', [
    '> on',
    '> 869.525,250.00,11,5',
    'OK',
    'OK - repeat is now ON',
    'Error, max 64',                      # a genuine rejection, not a capability gap
    'Error: failed to apply LoRa FEM RX gain',
    '',
    None,
])
def test_supported_or_failed_replies(reply):
    assert _reply_is_unsupported(reply) is False
