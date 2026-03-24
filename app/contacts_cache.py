"""
Contacts Cache - DB-backed contact name/key lookup.

All contact data is stored in the SQLite contacts table.
JSONL files are no longer used.

Kept for backward compatibility: get_all_names(), get_all_contacts(),
parse_advert_payload().
"""

import logging
import math
import struct

logger = logging.getLogger(__name__)

_TYPE_LABELS = {0: 'COM', 1: 'COM', 2: 'REP', 3: 'ROOM', 4: 'SENS'}


def _get_db():
    """Get database instance (deferred import to avoid circular imports)."""
    from app.main import db
    return db


def get_all_contacts() -> list:
    """Get all known contacts from DB."""
    try:
        db = _get_db()
        if db:
            contacts = db.get_contacts()
            return [{
                'public_key': c.get('public_key', ''),
                'name': c.get('name', ''),
                'first_seen': c.get('first_seen', ''),
                'last_seen': c.get('last_seen', ''),
                'source': c.get('source', ''),
                'lat': c.get('adv_lat', 0.0) or 0.0,
                'lon': c.get('adv_lon', 0.0) or 0.0,
                'type_label': _TYPE_LABELS.get(c.get('type', 1), 'UNKNOWN'),
            } for c in contacts]
    except Exception as e:
        logger.error(f"Failed to get contacts: {e}")
    return []


def get_all_names() -> list:
    """Get all unique non-empty contact names sorted alphabetically."""
    try:
        db = _get_db()
        if db:
            contacts = db.get_contacts()
            return sorted(set(c.get('name', '') for c in contacts if c.get('name')))
    except Exception as e:
        logger.error(f"Failed to get contact names: {e}")
    return []


def parse_advert_payload(pkt_payload_hex: str):
    """
    Parse advert pkt_payload to extract public_key, node_name, and GPS coordinates.

    Layout of pkt_payload (byte offsets):
      [0:32]   Public Key (32 bytes = 64 hex chars)
      [32:36]  Timestamp (4 bytes)
      [36:100] Signature (64 bytes)
      [100]    App Flags (1 byte) - bit 4: Location, bit 7: Name
      [101+]   If Location (bit 4): Lat (4 bytes, LE int32/1e6) + Lon (4 bytes, LE int32/1e6)
               If Name (bit 7): Node name (UTF-8, variable length)

    Returns:
        (public_key_hex, node_name, lat, lon) or (None, None, 0, 0) on failure
    """
    try:
        raw = bytes.fromhex(pkt_payload_hex)
        if len(raw) < 101:
            return None, None, 0.0, 0.0

        public_key = pkt_payload_hex[:64].lower()
        app_flags = raw[100]

        has_location = bool(app_flags & 0x10)  # bit 4
        has_name = bool(app_flags & 0x80)      # bit 7

        lat, lon = 0.0, 0.0
        name_offset = 101

        if has_location:
            if len(raw) >= 109:
                lat_i, lon_i = struct.unpack('<ii', raw[101:109])
                lat, lon = lat_i / 1e6, lon_i / 1e6
                # Validate: discard NaN, Infinity, and out-of-range values
                if (math.isnan(lat) or math.isnan(lon) or
                        math.isinf(lat) or math.isinf(lon) or
                        not (-90 <= lat <= 90) or not (-180 <= lon <= 180)):
                    lat, lon = 0.0, 0.0
            name_offset += 8

        if not has_name:
            return public_key, None, lat, lon

        if name_offset >= len(raw):
            return public_key, None, lat, lon

        name_bytes = raw[name_offset:]
        node_name = name_bytes.decode('utf-8', errors='replace').rstrip('\x00')

        return public_key, node_name if node_name else None, lat, lon
    except Exception:
        return None, None, 0.0, 0.0
