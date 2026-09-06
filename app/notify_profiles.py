"""
Notification profiles — what counts as news on a channel.

A profile is a named list of rules a channel message is tested against. A
channel in profile mode raises its unread badge and posts a browser
notification only for messages that pass; the rest still land in the chat,
they just do not call for attention. Profiles apply to channels only — a
direct message is always news.

Rules (`type`, optional `value`):

- ``mention`` — the message contains this device's name
- ``text``    — the message contains ``value``
- ``sender``  — the sender's name contains ``value``

Matching is case-insensitive and folds diacritics ("Kraków" matches "krakow"),
using the same table as the chat filter, so a rule behaves like the search box
the user already knows. A profile's ``match`` says whether ``any`` rule or
``all`` rules must pass.

Profiles live as one JSON list under the ``notification_profiles`` key of
``app_settings``; which channel uses which profile is the ``notify_profile``
column of ``read_status`` (see read_status.py).

The browser evaluates the same rules for the notification it posts on a live
socket message (app.js: notificationProfileMatches), and this module evaluates
them for the unread counts. The two must agree, or a message would light the
badge and not the notification, or the other way round.
"""

import logging
import secrets
from typing import Dict, List, Optional, Tuple

from flask import current_app

logger = logging.getLogger(__name__)

SETTING_KEY = 'notification_profiles'

RULE_TYPES = ('mention', 'text', 'sender')
MATCH_MODES = ('any', 'all')

MAX_NAME_LEN = 60
MAX_RULES = 20
MAX_VALUE_LEN = 100

# Same table as normalizeText() in app/static/js/filter-utils.js.
_DIACRITIC_MAP = {
    'ą': 'a', 'á': 'a', 'à': 'a', 'â': 'a', 'ä': 'a', 'ã': 'a', 'å': 'a',
    'ć': 'c', 'č': 'c', 'ç': 'c',
    'ę': 'e', 'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e',
    'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i',
    'ł': 'l',
    'ń': 'n', 'ñ': 'n',
    'ó': 'o', 'ò': 'o', 'ô': 'o', 'ö': 'o', 'õ': 'o', 'ő': 'o', 'ø': 'o',
    'ś': 's', 'š': 's', 'ß': 'ss',
    'ú': 'u', 'ù': 'u', 'û': 'u', 'ü': 'u', 'ű': 'u',
    'ý': 'y', 'ÿ': 'y',
    'ź': 'z', 'ż': 'z', 'ž': 'z',
}
_DIACRITIC_TABLE = str.maketrans(_DIACRITIC_MAP)


# ================================================================
# Matching
# ================================================================

def normalize(text) -> str:
    """Lowercase and fold diacritics, exactly as the chat filter does."""
    if not text:
        return ''
    return str(text).lower().translate(_DIACRITIC_TABLE)


def rule_matches(rule: dict, sender: str, content: str, own_name: str) -> bool:
    """True when one rule passes for a message."""
    rtype = rule.get('type')
    if rtype == 'mention':
        needle = normalize(own_name)
        return bool(needle) and needle in normalize(content)
    if rtype == 'text':
        needle = normalize(rule.get('value'))
        return bool(needle) and needle in normalize(content)
    if rtype == 'sender':
        needle = normalize(rule.get('value'))
        return bool(needle) and needle in normalize(sender)
    return False


def profile_matches(profile: dict, sender: str, content: str, own_name: str) -> bool:
    """
    True when a message passes the profile.

    A profile without rules passes nothing: validation never stores one, so
    reaching that case means the data was edited by hand, and staying quiet is
    the safer misreading of an intent nobody spelled out.
    """
    rules = profile.get('rules') or []
    if not rules:
        return False
    results = (rule_matches(r, sender, content, own_name) for r in rules)
    if profile.get('match') == 'all':
        return all(results)
    return any(results)


# ================================================================
# Validation
# ================================================================

def validate_profile(data) -> Tuple[Optional[dict], Optional[str]]:
    """
    Check a profile sent by the browser and return it cleaned up.

    Returns ``(profile, None)`` on success or ``(None, error)`` with a message
    fit for a 400 response. The id is not part of the check — the caller
    assigns or preserves it.
    """
    if not isinstance(data, dict):
        return None, 'Profile must be an object'

    name = str(data.get('name') or '').strip()
    if not name:
        return None, 'Name is required'
    if len(name) > MAX_NAME_LEN:
        return None, f'Name is too long (max {MAX_NAME_LEN} characters)'

    match = data.get('match') or 'any'
    if match not in MATCH_MODES:
        return None, "Match must be 'any' or 'all'"

    raw_rules = data.get('rules')
    if not isinstance(raw_rules, list) or not raw_rules:
        return None, 'At least one rule is required'
    if len(raw_rules) > MAX_RULES:
        return None, f'Too many rules (max {MAX_RULES})'

    rules = []
    for raw in raw_rules:
        if not isinstance(raw, dict):
            return None, 'Each rule must be an object'
        rtype = raw.get('type')
        if rtype not in RULE_TYPES:
            return None, f'Unknown rule type: {rtype!r}'
        if rtype == 'mention':
            rules.append({'type': 'mention'})
            continue
        value = str(raw.get('value') or '').strip()
        if not value:
            return None, 'Rule text cannot be empty'
        if len(value) > MAX_VALUE_LEN:
            return None, f'Rule text is too long (max {MAX_VALUE_LEN} characters)'
        rules.append({'type': rtype, 'value': value})

    return {'name': name, 'match': match, 'rules': rules}, None


def summarize(profile: dict) -> str:
    """One-line description for logs."""
    parts = []
    for r in profile.get('rules') or []:
        if r.get('type') == 'mention':
            parts.append('mention')
        else:
            parts.append(f"{r.get('type')}={r.get('value')!r}")
    return f"{profile.get('name')!r} ({profile.get('match')}: {', '.join(parts)})"


# ================================================================
# Storage
# ================================================================

def _get_db():
    return getattr(current_app, 'db', None)


def load_profiles() -> List[dict]:
    """All profiles, in the order they were created."""
    db = _get_db()
    if not db:
        return []
    profiles = db.get_setting_json(SETTING_KEY, [])
    if not isinstance(profiles, list):
        logger.warning("notification_profiles setting is not a list; ignoring it")
        return []
    return [p for p in profiles if isinstance(p, dict) and p.get('id')]


def save_profiles(profiles: List[dict]) -> bool:
    db = _get_db()
    if not db:
        return False
    try:
        db.set_setting_json(SETTING_KEY, profiles)
        return True
    except Exception as e:
        logger.error(f"Failed to save notification profiles: {e}")
        return False


def profiles_by_id() -> Dict[str, dict]:
    return {p['id']: p for p in load_profiles()}


def get_profile(profile_id: str) -> Optional[dict]:
    return profiles_by_id().get(profile_id)


def new_profile_id(existing: List[dict]) -> str:
    taken = {p.get('id') for p in existing}
    while True:
        candidate = secrets.token_hex(4)
        if candidate not in taken:
            return candidate
