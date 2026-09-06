"""
Tests for notification profiles: rule matching, validation and the
per-channel notification state in read_status.

Run: python -m pytest tests/test_notify_profiles.py -v
"""

import sqlite3
import tempfile
from pathlib import Path

import pytest

from app.database import Database
from app.notify_profiles import (
    MAX_NAME_LEN,
    MAX_RULES,
    MAX_VALUE_LEN,
    normalize,
    profile_matches,
    rule_matches,
    validate_profile,
)


@pytest.fixture
def db():
    with tempfile.TemporaryDirectory() as tmp:
        yield Database(Path(tmp) / 'test.db')


# ================================================================
# Normalization - must agree with normalizeText() in filter-utils.js
# ================================================================

class TestNormalize:
    def test_lowercases(self):
        assert normalize('MarWoj') == 'marwoj'

    def test_folds_polish_diacritics(self):
        assert normalize('Kraków Łódź Żółć') == 'krakow lodz zolc'

    def test_folds_sharp_s(self):
        assert normalize('Straße') == 'strasse'

    def test_empty_and_none(self):
        assert normalize('') == ''
        assert normalize(None) == ''


# ================================================================
# Rules
# ================================================================

class TestRuleMatches:
    def test_mention_plain_name(self):
        assert rule_matches({'type': 'mention'}, 'Kosu', 'hej marwoj, jesteś?', 'MarWoj')

    def test_mention_bracket_syntax(self):
        assert rule_matches({'type': 'mention'}, 'Kosu', '@[MarWoj] ping', 'MarWoj')

    def test_mention_needs_own_name(self):
        assert not rule_matches({'type': 'mention'}, 'Kosu', 'marwoj', '')

    def test_mention_absent(self):
        assert not rule_matches({'type': 'mention'}, 'Kosu', 'hello world', 'MarWoj')

    def test_text_substring_case_and_diacritics(self):
        assert rule_matches({'type': 'text', 'value': 'krakow'}, 'x', 'Jadę do Krakowa', '')

    def test_text_part_of_word(self):
        assert rule_matches({'type': 'text', 'value': 'webui'}, 'x', 'mc-webui rocks', '')

    def test_text_no_match(self):
        assert not rule_matches({'type': 'text', 'value': 'webui'}, 'x', 'nothing here', '')

    def test_text_empty_value_never_matches(self):
        assert not rule_matches({'type': 'text', 'value': ''}, 'x', 'anything', '')

    def test_sender_matches_sender_not_content(self):
        assert rule_matches({'type': 'sender', 'value': 'kosu'}, 'Kosu-R', 'hello', '')
        assert not rule_matches({'type': 'sender', 'value': 'kosu'}, 'Other', 'kosu wrote', '')

    def test_unknown_type(self):
        assert not rule_matches({'type': 'regex', 'value': '.*'}, 'x', 'anything', '')


class TestProfileMatches:
    PROFILE = {
        'rules': [{'type': 'mention'}, {'type': 'text', 'value': 'webui'}],
    }

    def test_any_needs_one(self):
        p = {**self.PROFILE, 'match': 'any'}
        assert profile_matches(p, 'x', 'about webui', 'MarWoj')
        assert profile_matches(p, 'x', 'hey MarWoj', 'MarWoj')
        assert not profile_matches(p, 'x', 'plain text', 'MarWoj')

    def test_all_needs_every(self):
        p = {**self.PROFILE, 'match': 'all'}
        assert profile_matches(p, 'x', 'MarWoj, webui broke', 'MarWoj')
        assert not profile_matches(p, 'x', 'about webui', 'MarWoj')

    def test_missing_match_means_any(self):
        assert profile_matches(self.PROFILE, 'x', 'about webui', '')

    def test_no_rules_matches_nothing(self):
        assert not profile_matches({'match': 'all', 'rules': []}, 'x', 'anything', 'me')
        assert not profile_matches({'match': 'any'}, 'x', 'anything', 'me')


# ================================================================
# Validation
# ================================================================

class TestValidateProfile:
    def test_cleans_and_keeps_rules(self):
        clean, err = validate_profile({
            'name': '  Mentions ',
            'match': 'all',
            'rules': [{'type': 'mention', 'value': 'ignored'}, {'type': 'text', 'value': ' webui '}],
        })
        assert err is None
        assert clean == {
            'name': 'Mentions',
            'match': 'all',
            'rules': [{'type': 'mention'}, {'type': 'text', 'value': 'webui'}],
        }

    def test_default_match_is_any(self):
        clean, _ = validate_profile({'name': 'x', 'rules': [{'type': 'mention'}]})
        assert clean['match'] == 'any'

    @pytest.mark.parametrize('payload, fragment', [
        ('not a dict', 'object'),
        ({'name': '', 'rules': [{'type': 'mention'}]}, 'Name is required'),
        ({'name': 'x' * (MAX_NAME_LEN + 1), 'rules': [{'type': 'mention'}]}, 'too long'),
        ({'name': 'x', 'match': 'some', 'rules': [{'type': 'mention'}]}, 'Match'),
        ({'name': 'x', 'rules': []}, 'At least one rule'),
        ({'name': 'x', 'rules': 'mention'}, 'At least one rule'),
        ({'name': 'x', 'rules': [{'type': 'mention'}] * (MAX_RULES + 1)}, 'Too many'),
        ({'name': 'x', 'rules': ['mention']}, 'must be an object'),
        ({'name': 'x', 'rules': [{'type': 'regex', 'value': 'a'}]}, 'Unknown rule type'),
        ({'name': 'x', 'rules': [{'type': 'text', 'value': '  '}]}, 'cannot be empty'),
        ({'name': 'x', 'rules': [{'type': 'sender', 'value': 'y' * (MAX_VALUE_LEN + 1)}]}, 'too long'),
    ])
    def test_rejects(self, payload, fragment):
        clean, err = validate_profile(payload)
        assert clean is None
        assert fragment in err


# ================================================================
# Per-channel state in read_status
# ================================================================

class TestChannelNotifyState:
    def test_migration_adds_column(self, db):
        with sqlite3.connect(db.db_path) as conn:
            cols = {r[1] for r in conn.execute("PRAGMA table_info(read_status)")}
        assert 'notify_profile' in cols

    def test_profile_mode(self, db):
        db.set_channel_notify(3, muted=False, profile_id='abcd1234')
        assert db.get_channel_notify_profiles() == {3: 'abcd1234'}
        assert db.get_muted_channels() == []

    def test_mute_clears_profile(self, db):
        db.set_channel_notify(3, muted=False, profile_id='abcd1234')
        db.set_channel_notify(3, muted=True)
        assert db.get_channel_notify_profiles() == {}
        assert db.get_muted_channels() == [3]

    def test_muted_with_profile_stores_no_profile(self, db):
        db.set_channel_notify(3, muted=True, profile_id='abcd1234')
        assert db.get_channel_notify_profiles() == {}

    def test_all_mode_clears_both(self, db):
        db.set_channel_notify(3, muted=False, profile_id='abcd1234')
        db.set_channel_notify(3, muted=False, profile_id=None)
        assert db.get_channel_notify_profiles() == {}
        assert db.get_muted_channels() == []

    def test_legacy_set_channel_muted_unmute_lands_on_all(self, db):
        db.set_channel_notify(3, muted=False, profile_id='abcd1234')
        db.set_channel_muted(3, False)
        assert db.get_channel_notify_profiles() == {}

    def test_keeps_last_seen_and_favorite(self, db):
        db.mark_read('chan_3', 1000)
        db.set_channel_favorite(3, True)
        db.set_channel_notify(3, muted=False, profile_id='abcd1234')
        row = db.get_read_status()['chan_3']
        assert row['last_seen_ts'] == 1000
        assert row['is_favorite'] == 1
        assert row['notify_profile'] == 'abcd1234'

    def test_clear_profile_returns_affected_channels(self, db):
        db.set_channel_notify(1, muted=False, profile_id='p1')
        db.set_channel_notify(2, muted=False, profile_id='p2')
        db.set_channel_notify(5, muted=False, profile_id='p1')
        assert sorted(db.clear_channel_notify_profile('p1')) == [1, 5]
        assert db.get_channel_notify_profiles() == {2: 'p2'}
        assert db.clear_channel_notify_profile('p1') == []
