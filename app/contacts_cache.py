"""
Contacts Cache - Persistent storage of all known node names + public keys.

Stores every node name ever seen (from device contacts and adverts),
so @mention autocomplete works even for removed contacts.

File format: JSONL ({device_name}.contacts_cache.jsonl)
Each line: {"public_key": "...", "name": "...", "first_seen": ts, "last_seen": ts, "source": "advert"|"device"}
"""

import json
import logging
import time
from pathlib import Path
from threading import Lock

from app.config import config, runtime_config

logger = logging.getLogger(__name__)

_cache_lock = Lock()
_cache: dict = {}  # {public_key: {name, first_seen, last_seen, source}}
_cache_loaded = False
_adverts_offset = 0  # File offset for incremental advert scanning


def _get_cache_path() -> Path:
    device_name = runtime_config.get_device_name()
    return Path(config.MC_CONFIG_DIR) / f"{device_name}.contacts_cache.jsonl"


def _get_adverts_path() -> Path:
    device_name = runtime_config.get_device_name()
    return Path(config.MC_CONFIG_DIR) / f"{device_name}.adverts.jsonl"


def load_cache() -> dict:
    """Load cache from disk into memory. Returns copy of cache dict."""
    global _cache, _cache_loaded

    with _cache_lock:
        if _cache_loaded:
            return _cache.copy()

        cache_path = _get_cache_path()
        _cache = {}

        if not cache_path.exists():
            _cache_loaded = True
            logger.info("Contacts cache file does not exist yet")
            return _cache.copy()

        try:
            with open(cache_path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                        pk = entry.get('public_key', '').lower()
                        if pk:
                            _cache[pk] = entry
                    except json.JSONDecodeError:
                        continue

            _cache_loaded = True
            logger.info(f"Loaded contacts cache: {len(_cache)} entries")
        except Exception as e:
            logger.error(f"Failed to load contacts cache: {e}")
            _cache_loaded = True

        return _cache.copy()


def save_cache() -> bool:
    """Write full cache to disk (atomic write)."""
    with _cache_lock:
        cache_path = _get_cache_path()
        try:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            temp_file = cache_path.with_suffix('.tmp')
            with open(temp_file, 'w', encoding='utf-8') as f:
                for entry in _cache.values():
                    f.write(json.dumps(entry, ensure_ascii=False) + '\n')
            temp_file.replace(cache_path)
            logger.debug(f"Saved contacts cache: {len(_cache)} entries")
            return True
        except Exception as e:
            logger.error(f"Failed to save contacts cache: {e}")
            return False


def upsert_contact(public_key: str, name: str, source: str = "advert") -> bool:
    """Add or update a contact in the cache. Returns True if cache was modified."""
    pk = public_key.lower()
    now = int(time.time())

    with _cache_lock:
        existing = _cache.get(pk)
        if existing:
            changed = False
            if name and name != existing.get('name'):
                existing['name'] = name
                changed = True
            existing['last_seen'] = now
            return changed
        else:
            if not name:
                return False
            _cache[pk] = {
                'public_key': pk,
                'name': name,
                'first_seen': now,
                'last_seen': now,
                'source': source,
            }
            return True


def get_all_contacts() -> list:
    """Get all cached contacts as a list of dicts (shallow copies)."""
    with _cache_lock:
        return [entry.copy() for entry in _cache.values()]


def get_all_names() -> list:
    """Get all unique non-empty contact names sorted alphabetically."""
    with _cache_lock:
        return sorted(set(
            entry['name'] for entry in _cache.values()
            if entry.get('name')
        ))


def parse_advert_payload(pkt_payload_hex: str):
    """
    Parse advert pkt_payload to extract public_key and node_name.

    Layout of pkt_payload (byte offsets):
      [0:32]   Public Key (32 bytes = 64 hex chars)
      [32:36]  Timestamp (4 bytes)
      [36:100] Signature (64 bytes)
      [100]    App Flags (1 byte) - bit 4: Location, bit 7: Name
      [101+]   If Location (bit 4): Lat (4 bytes) + Lon (4 bytes)
               If Name (bit 7): Node name (UTF-8, variable length)

    Returns:
        (public_key_hex, node_name) or (None, None) on failure
    """
    try:
        raw = bytes.fromhex(pkt_payload_hex)
        if len(raw) < 101:
            return None, None

        public_key = pkt_payload_hex[:64].lower()
        app_flags = raw[100]

        has_location = bool(app_flags & 0x10)  # bit 4
        has_name = bool(app_flags & 0x80)      # bit 7

        if not has_name:
            return public_key, None

        name_offset = 101
        if has_location:
            name_offset += 8  # lat(4) + lon(4)

        if name_offset >= len(raw):
            return public_key, None

        name_bytes = raw[name_offset:]
        node_name = name_bytes.decode('utf-8', errors='replace').rstrip('\x00')

        return public_key, node_name if node_name else None
    except Exception:
        return None, None


def scan_new_adverts() -> int:
    """
    Scan .adverts.jsonl for new entries since last scan.
    Returns number of new/updated contacts.
    """
    global _adverts_offset

    adverts_path = _get_adverts_path()
    if not adverts_path.exists():
        return 0

    updated = 0
    try:
        with open(adverts_path, 'r', encoding='utf-8') as f:
            f.seek(_adverts_offset)
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    advert = json.loads(line)
                    pkt_payload = advert.get('pkt_payload', '')
                    if not pkt_payload:
                        continue
                    pk, name = parse_advert_payload(pkt_payload)
                    if pk and name:
                        if upsert_contact(pk, name, source="advert"):
                            updated += 1
                except json.JSONDecodeError:
                    continue
            _adverts_offset = f.tell()
    except Exception as e:
        logger.error(f"Failed to scan adverts: {e}")

    if updated > 0:
        save_cache()
        logger.info(f"Contacts cache updated: {updated} new/changed entries")

    return updated


def initialize_from_device(contacts_detailed: dict):
    """
    Seed cache from /api/contacts/detailed response dict.
    Called once at startup if cache file doesn't exist.

    Args:
        contacts_detailed: dict of {public_key: {adv_name, type, ...}} from meshcli
    """
    added = 0
    for pk, details in contacts_detailed.items():
        name = details.get('adv_name', '')
        if upsert_contact(pk, name, source="device"):
            added += 1

    if added > 0:
        save_cache()
        logger.info(f"Initialized contacts cache from device: {added} contacts")
