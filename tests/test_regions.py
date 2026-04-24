"""
Unit + integration tests for the per-channel region-scope data layer.

Run: python -m pytest tests/test_regions.py -v
"""

import sqlite3
import tempfile
from pathlib import Path

import pytest

from app.database import Database
from app.meshcore.regions import (
    MAX_NAME_LEN,
    derive_scope_key,
    derive_scope_key_hex,
    is_valid_region_name,
)


@pytest.fixture
def db():
    with tempfile.TemporaryDirectory() as tmp:
        yield Database(Path(tmp) / 'test.db')


# ================================================================
# Key derivation (known vectors)
# ================================================================

class TestKeyDerivation:
    # Firmware rule: key = SHA256('#' + name)[:16]
    # Vectors computed offline and baked in to catch regressions.
    def test_pl(self):
        assert derive_scope_key_hex('pl') == '89e07394d9523e8996cae464c7770516'

    def test_pl_ma(self):
        assert derive_scope_key_hex('pl-ma') == '71a012b2fcfee9b6a29a28729236f1b8'

    def test_krakow(self):
        assert derive_scope_key_hex('krakow') == '1482a54016edec3b8d13a879b7af62a3'

    def test_returns_16_bytes(self):
        assert len(derive_scope_key('pl')) == 16

    def test_hash_input_skips_existing_hash_prefix(self):
        # '#pl' must produce the same key as 'pl' — firmware does not double-prefix.
        assert derive_scope_key_hex('#pl') == derive_scope_key_hex('pl')


# ================================================================
# Name validation (firmware RegionMap::is_name_char rule)
# ================================================================

class TestNameValidation:
    @pytest.mark.parametrize('name', [
        'pl', 'pl-ma', 'pl#test', '$EU', '999', 'Malopolska', 'a',
        '-leading-dash-ok', 'UPPER', 'mixedCase',
        # Firmware rule `c >= 'A'` (0x41) admits underscore (0x5F) too.
        'my_region',
    ])
    def test_valid(self, name):
        ok, err = is_valid_region_name(name)
        assert ok, f'expected valid, got error: {err}'

    @pytest.mark.parametrize('name', [
        '',            # empty
        ' pl',         # space (0x20)
        'my region',   # embedded space
        'a.b',         # dot (0x2E)
        'a,b',         # comma (0x2C)
        'a/b',         # slash (0x2F)
        'a:b',         # colon (0x3A)
        'a+b',         # plus (0x2B)
        'a@b',         # at-sign (0x40)
        'a(b',         # (0x28)
        'a*b',         # (0x2A)
    ])
    def test_invalid(self, name):
        ok, _ = is_valid_region_name(name)
        assert not ok, f'expected invalid for: {name!r}'

    def test_too_long_rejected(self):
        too_long = 'a' * (MAX_NAME_LEN + 1)
        ok, _ = is_valid_region_name(too_long)
        assert not ok

    def test_at_length_limit_accepted(self):
        at_limit = 'a' * MAX_NAME_LEN
        ok, _ = is_valid_region_name(at_limit)
        assert ok

    def test_non_string_rejected(self):
        for bad in [None, 42, b'pl', ['pl']]:
            ok, _ = is_valid_region_name(bad)
            assert not ok

    def test_accented_chars_accepted(self):
        # Firmware rule admits any byte >= 'A' (0x41), which includes all UTF-8
        # continuation bytes (>=0x80), so accented chars pass.
        ok, _ = is_valid_region_name('Malopolska')
        assert ok
        ok, _ = is_valid_region_name('Kraków')
        assert ok


# ================================================================
# DB: region CRUD
# ================================================================

class TestRegionCrud:
    def test_create_and_list(self, db):
        rid = db.create_region('pl', derive_scope_key_hex('pl'))
        assert rid > 0
        regions = db.list_regions()
        assert len(regions) == 1
        assert regions[0]['name'] == 'pl'
        assert regions[0]['key_hex'] == derive_scope_key_hex('pl')
        assert regions[0]['is_default'] == 0

    def test_duplicate_name_raises(self, db):
        db.create_region('pl', derive_scope_key_hex('pl'))
        with pytest.raises(sqlite3.IntegrityError):
            db.create_region('pl', derive_scope_key_hex('pl'))

    def test_get_by_id_and_name(self, db):
        rid = db.create_region('pl-ma', derive_scope_key_hex('pl-ma'))
        by_id = db.get_region(rid)
        by_name = db.get_region_by_name('pl-ma')
        assert by_id and by_name
        assert by_id['id'] == by_name['id'] == rid

    def test_get_missing_returns_none(self, db):
        assert db.get_region(999) is None
        assert db.get_region_by_name('missing') is None

    def test_delete(self, db):
        rid = db.create_region('pl', derive_scope_key_hex('pl'))
        assert db.delete_region(rid) is True
        assert db.get_region(rid) is None
        assert db.delete_region(rid) is False  # already gone

    def test_list_ordered_by_name(self, db):
        db.create_region('pl-ma', derive_scope_key_hex('pl-ma'))
        db.create_region('pl', derive_scope_key_hex('pl'))
        db.create_region('krakow', derive_scope_key_hex('krakow'))
        names = [r['name'] for r in db.list_regions()]
        assert names == ['krakow', 'pl', 'pl-ma']


# ================================================================
# DB: default region
# ================================================================

class TestDefaultRegion:
    def test_no_default_initially(self, db):
        assert db.get_default_region() is None

    def test_set_and_get_default(self, db):
        rid = db.create_region('pl', derive_scope_key_hex('pl'))
        db.set_default_region(rid)
        d = db.get_default_region()
        assert d is not None
        assert d['id'] == rid
        assert d['is_default'] == 1

    def test_set_default_clears_previous(self, db):
        a = db.create_region('pl', derive_scope_key_hex('pl'))
        b = db.create_region('pl-ma', derive_scope_key_hex('pl-ma'))
        db.set_default_region(a)
        db.set_default_region(b)
        # only one default
        defaults = [r for r in db.list_regions() if r['is_default']]
        assert len(defaults) == 1
        assert defaults[0]['id'] == b

    def test_set_default_none_clears_all(self, db):
        rid = db.create_region('pl', derive_scope_key_hex('pl'))
        db.set_default_region(rid)
        db.set_default_region(None)
        assert db.get_default_region() is None


# ================================================================
# DB: channel_scopes mapping
# ================================================================

class TestChannelScopes:
    def test_set_and_get(self, db):
        rid = db.create_region('pl', derive_scope_key_hex('pl'))
        db.set_channel_scope(3, rid)
        scope = db.get_channel_scope(3)
        assert scope is not None
        assert scope['region_id'] == rid
        assert scope['name'] == 'pl'
        assert scope['key_hex'] == derive_scope_key_hex('pl')

    def test_get_missing_returns_none(self, db):
        assert db.get_channel_scope(5) is None

    def test_set_none_clears(self, db):
        rid = db.create_region('pl', derive_scope_key_hex('pl'))
        db.set_channel_scope(3, rid)
        db.set_channel_scope(3, None)
        assert db.get_channel_scope(3) is None

    def test_upsert_replaces(self, db):
        a = db.create_region('pl', derive_scope_key_hex('pl'))
        b = db.create_region('pl-ma', derive_scope_key_hex('pl-ma'))
        db.set_channel_scope(3, a)
        db.set_channel_scope(3, b)
        scope = db.get_channel_scope(3)
        assert scope['region_id'] == b

    def test_cascade_on_region_delete(self, db):
        rid = db.create_region('pl', derive_scope_key_hex('pl'))
        db.set_channel_scope(3, rid)
        db.set_channel_scope(4, rid)
        db.delete_region(rid)
        assert db.get_channel_scope(3) is None
        assert db.get_channel_scope(4) is None

    def test_get_all_channel_scopes(self, db):
        a = db.create_region('pl', derive_scope_key_hex('pl'))
        b = db.create_region('pl-ma', derive_scope_key_hex('pl-ma'))
        db.set_channel_scope(0, a)
        db.set_channel_scope(3, b)
        all_scopes = db.get_all_channel_scopes()
        assert set(all_scopes.keys()) == {0, 3}
        assert all_scopes[0]['name'] == 'pl'
        assert all_scopes[3]['name'] == 'pl-ma'


# ================================================================
# Schema presence
# ================================================================

class TestSchema:
    def test_regions_and_channel_scopes_tables_exist(self, db):
        with db._connect() as conn:
            tables = {r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()}
        assert 'regions' in tables
        assert 'channel_scopes' in tables
