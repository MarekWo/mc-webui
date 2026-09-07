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
import hmac
from typing import Optional, Tuple

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


# Transport code — the 16-bit region stamp carried in the header of
# ROUTE_TYPE_TRANSPORT_FLOOD / _DIRECT packets (TransportKey::calcTransportCode
# in MeshCore Core/src/helpers/TransportKeyStore.cpp). The region *name* never
# travels: a receiver can only recognise a region whose key it already holds,
# by recomputing the code and comparing.
PAYLOAD_TYPE_GRP_TXT = 0x05


def calc_transport_code(key: bytes, payload_type: int, payload: bytes) -> bytes:
    """First 2 bytes of HMAC-SHA256(key, payload_type || payload), in wire order.

    0x0000 and 0xFFFF are reserved: the firmware bumps them to 0x0001 / 0xFFFE
    as a little-endian uint16, hence the byte order of the substitutes.
    """
    digest = hmac.new(key, bytes([payload_type & 0x0F]) + payload, hashlib.sha256).digest()
    code = digest[:2]
    if code == b'\x00\x00':
        return b'\x01\x00'
    if code == b'\xff\xff':
        return b'\xfe\xff'
    return code


def match_region_by_transport_code(transport_codes_hex: str, payload_type: int,
                                   payload: bytes, regions) -> Optional[str]:
    """Name of the region whose key reproduces the packet's transport code.

    `transport_codes_hex` is the 4-byte header field (8 hex chars); only the
    first code — the scope the sender stamped — is compared. `regions` is any
    iterable of {'name', 'key_hex'} dicts, normally the instance's own region
    table. Returns None when nothing matches: the packet was scoped to a region
    this instance does not know, or to a private ($name) region whose key is
    not derivable from its name. A 16-bit code leaves a 1-in-65536 chance per
    known region of a false match, which is fine for a display hint.
    """
    if not transport_codes_hex or len(transport_codes_hex) < 4:
        return None
    try:
        code = bytes.fromhex(transport_codes_hex[:4])
    except ValueError:
        return None
    for region in regions:
        key_hex = region.get('key_hex')
        if not key_hex:
            continue
        try:
            key = bytes.fromhex(key_hex)
        except ValueError:
            continue
        if calc_transport_code(key, payload_type, payload) == code:
            return region.get('name')
    return None
