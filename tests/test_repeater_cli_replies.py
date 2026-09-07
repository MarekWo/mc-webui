"""
Unit tests for reading repeater CLI replies: the settings batch, and the
`region` tree behind Settings → Regions.

The firmware's reply text is the only capability signal available for a remote
repeater: FIRMWARE_VER_CODE stayed at 13 across v1.16 → v1.17, so it cannot
tell us whether a node knows a setting added in v1.17 (`cad`).

Run: python -m pytest tests/test_repeater_cli_replies.py -v
"""

import pytest

from app.routes.api import (
    _parse_region_tree,
    _region_command,
    _region_tree_truncated,
    _reply_is_unsupported,
)


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


# ================================================================
# Parsing the `region` tree (Settings → Regions)
# ================================================================
#
# The firmware prints one line per region: indent = nesting depth, `^` marks the
# home region and a trailing ` F` means flood is allowed. Names may legitimately
# be `F` or end in `^`, so the suffixes are stripped right-to-left.
# Captured live from MarWoj Mobile Observer (firmware 2.2.15).


def test_parse_live_capture():
    """The exact bytes a real repeater sent for a wildcard plus one region."""
    entries = _parse_region_tree('*^ F\n pl F\n')
    assert entries == [
        {'name': '*', 'depth': 0, 'parent': None, 'flood_allowed': True,
         'is_home': True, 'is_root': True},
        {'name': 'pl', 'depth': 1, 'parent': '*', 'flood_allowed': True,
         'is_home': False, 'is_root': False},
    ]


def test_missing_f_suffix_means_flood_denied():
    entries = _parse_region_tree('*^ F\n pl F\n kra\n')
    assert [(e['name'], e['flood_allowed']) for e in entries] == [
        ('*', True), ('pl', True), ('kra', False),
    ]


def test_nesting_assigns_parents_by_indent():
    raw = '* F\n pl F\n  kra^ F\n  waw\n de\n'
    entries = _parse_region_tree(raw)
    assert [(e['name'], e['depth'], e['parent']) for e in entries] == [
        ('*', 0, None),
        ('pl', 1, '*'),
        ('kra', 2, 'pl'),
        ('waw', 2, 'pl'),
        ('de', 1, '*'),      # back out to the root, not left under `pl`
    ]
    assert next(e for e in entries if e['name'] == 'kra')['is_home'] is True


def test_region_named_f_is_not_mistaken_for_the_flood_flag():
    """`F` is a legal region name, so ` F F` is the region F with flood allowed."""
    entries = _parse_region_tree('* F\n F F\n G\n')
    assert [(e['name'], e['flood_allowed']) for e in entries] == [
        ('*', True), ('F', True), ('G', False),
    ]


def test_hash_prefix_is_stripped():
    """`#name` marks an auto-derived scope key; the name the user sees has no `#`."""
    entries = _parse_region_tree('* F\n #pl F\n')
    assert entries[1]['name'] == 'pl'


def test_blank_lines_and_empty_input_are_ignored():
    assert _parse_region_tree('') == []
    assert _parse_region_tree('\n\n') == []
    assert len(_parse_region_tree('* F\n\n pl F\n')) == 2


# ---------------- truncation ----------------
# `exportTo(reply, 160)` silently clips a tree that does not fit. A complete
# export always ends in the newline the firmware writes after the last region.

def test_short_reply_is_not_truncated():
    assert _region_tree_truncated('*^ F\n pl F\n') is False


def test_full_length_reply_without_trailing_newline_is_truncated():
    raw = '* F\n' + ''.join(f' region{i:02d} F\n' for i in range(14))
    raw = raw[:159]                      # clipped mid-line, as the firmware would
    assert len(raw) >= 158
    assert _region_tree_truncated(raw) is True


def test_full_length_reply_that_ends_cleanly_is_not_truncated():
    raw = '* F\n' + ''.join(f' region{i:02d} F\n' for i in range(14))
    assert len(raw) >= 158 and raw.endswith('\n')
    assert _region_tree_truncated(raw) is False


# ================================================================
# Building region CLI commands
# ================================================================

@pytest.mark.parametrize('action, name, parent, expected', [
    ('add',           'pl',  '',    'region put pl'),
    ('add',           'kra', 'pl',  'region put kra pl'),
    ('add',           'pl',  '*',   'region put pl'),      # the root is implicit
    ('remove',        'pl',  '',    'region remove pl'),
    ('allow_flood',   'pl',  '',    'region allowf pl'),
    ('deny_flood',    'pl',  '',    'region denyf pl'),
    ('set_home',      'pl',  '',    'region home pl'),
    ('set_default',   'pl',  '',    'region default pl'),
    ('clear_default', '',    '',    'region default <null>'),
    ('save',          '',    '',    'region save'),
    ('allow_flood',   '*',   '',    'region allowf *'),
])
def test_region_command_builds(action, name, parent, expected):
    cmd, err = _region_command(action, name, parent)
    assert err is None
    assert cmd == expected


@pytest.mark.parametrize('action, name', [
    ('add',         'pl;reboot'),   # command separator
    ('add',         'ab cd'),       # a space would become the parent argument
    ('add',         'a' * 31),      # over the firmware's 30-byte field
    ('add',         ''),            # no name
    ('add',         '*'),           # the wildcard cannot be created
    ('remove',      '*'),           # nor deleted
    ('set_default', '*'),           # nor made the default scope
    ('bogus',       'pl'),          # unknown action
])
def test_region_command_rejects(action, name):
    cmd, err = _region_command(action, name, '')
    assert cmd is None
    assert err
