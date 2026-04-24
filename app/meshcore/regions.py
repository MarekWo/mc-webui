"""
MeshCore flood-scope (region) helpers.

Key derivation and name validation for the per-channel region-scope feature.
Kept free of Flask/DB imports so it can be unit-tested in isolation.

Firmware references:
- Key: SHA256('#' + name)[:16]  (TransportKeyStore::getAutoKeyFor)
- Name rule: '-', '$', '#', digits, or any byte >= 'A'  (RegionMap::is_name_char)
- Name length: fits in a 31-char field (30 chars + NUL terminator)
"""

import hashlib
from typing import Tuple

MAX_NAME_LEN = 30  # firmware NodePrefs.default_scope_name[31] = 30 chars + NUL

_ALLOWED_SINGLE_BYTES = (0x2d, 0x24, 0x23)  # '-', '$', '#'


def is_valid_region_name(name: str) -> Tuple[bool, str]:
    """Validate a region name against the firmware's RegionMap::is_name_char rule.

    Returns (ok, error_message). On success error_message is ''.
    """
    if not isinstance(name, str) or not name:
        return False, 'Name must be a non-empty string'
    try:
        encoded = name.encode('utf-8')
    except UnicodeEncodeError:
        return False, 'Name must be UTF-8 encodable'
    if len(encoded) > MAX_NAME_LEN:
        return False, f'Name too long (max {MAX_NAME_LEN} bytes)'
    for b in encoded:
        if b in _ALLOWED_SINGLE_BYTES:
            continue
        if 0x30 <= b <= 0x39:  # digits
            continue
        if b >= 0x41:  # any byte >= 'A'
            continue
        return False, f'Invalid character (byte 0x{b:02x})'
    return True, ''


def derive_scope_key(name: str) -> bytes:
    """Derive the 16-byte scope key: SHA256('#' + name)[:16]."""
    payload = name if name.startswith('#') else '#' + name
    return hashlib.sha256(payload.encode('utf-8')).digest()[:16]


def derive_scope_key_hex(name: str) -> str:
    """Hex-encoded variant of derive_scope_key()."""
    return derive_scope_key(name).hex()
