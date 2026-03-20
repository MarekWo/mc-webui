"""
SQLite database for mc-webui v2.

Synchronous wrapper with WAL mode. Thread-safe via connection-per-call pattern.
"""

import sqlite3
import shutil
import logging
import time
from pathlib import Path
from contextlib import contextmanager
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any

logger = logging.getLogger(__name__)

SCHEMA_FILE = Path(__file__).parent / 'schema.sql'


class Database:
    """SQLite database with WAL mode for mc-webui v2."""

    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _init_db(self):
        """Create tables and enable WAL mode."""
        with self._connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=ON")
            schema_sql = SCHEMA_FILE.read_text(encoding='utf-8')
            conn.executescript(schema_sql)
        logger.info(f"Database initialized: {self.db_path}")

    @contextmanager
    def _connect(self):
        """Yield a connection with auto-commit/rollback."""
        conn = sqlite3.connect(str(self.db_path), timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    # ================================================================
    # Device
    # ================================================================

    def set_device_info(self, public_key: str, name: str, self_info: str = None) -> None:
        with self._connect() as conn:
            conn.execute(
                """INSERT INTO device (id, public_key, name, self_info)
                   VALUES (1, ?, ?, ?)
                   ON CONFLICT(id) DO UPDATE SET
                       public_key = excluded.public_key,
                       name = excluded.name,
                       self_info = COALESCE(excluded.self_info, device.self_info)""",
                (public_key, name, self_info)
            )

    def get_device_info(self) -> Optional[Dict]:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM device WHERE id = 1").fetchone()
            return dict(row) if row else None

    # ================================================================
    # Contacts
    # ================================================================

    def upsert_contact(self, public_key: str, name: str = '', **kwargs) -> None:
        public_key = public_key.lower()
        fields = {
            'public_key': public_key,
            'name': name,
            'type': kwargs.get('type', 0),
            'flags': kwargs.get('flags', 0),
            'out_path': kwargs.get('out_path', ''),
            'out_path_len': kwargs.get('out_path_len', 0),
            'last_advert': kwargs.get('last_advert'),
            'adv_lat': kwargs.get('adv_lat'),
            'adv_lon': kwargs.get('adv_lon'),
            'source': kwargs.get('source', 'advert'),
            'is_protected': kwargs.get('is_protected', 0),
        }

        with self._connect() as conn:
            conn.execute(
                """INSERT INTO contacts (public_key, name, type, flags, out_path, out_path_len,
                       last_advert, adv_lat, adv_lon, source, is_protected)
                   VALUES (:public_key, :name, :type, :flags, :out_path, :out_path_len,
                       :last_advert, :adv_lat, :adv_lon, :source, :is_protected)
                   ON CONFLICT(public_key) DO UPDATE SET
                       name = CASE WHEN excluded.name != '' THEN excluded.name ELSE contacts.name END,
                       type = excluded.type,
                       flags = excluded.flags,
                       out_path = CASE WHEN excluded.out_path != '' THEN excluded.out_path ELSE contacts.out_path END,
                       out_path_len = CASE WHEN excluded.out_path_len > 0 THEN excluded.out_path_len ELSE contacts.out_path_len END,
                       last_advert = COALESCE(excluded.last_advert, contacts.last_advert),
                       adv_lat = COALESCE(excluded.adv_lat, contacts.adv_lat),
                       adv_lon = COALESCE(excluded.adv_lon, contacts.adv_lon),
                       last_seen = datetime('now'),
                       source = CASE
                           WHEN excluded.source = 'device' THEN 'device'
                           WHEN contacts.source = 'device' THEN contacts.source
                           ELSE excluded.source
                       END,
                       is_protected = CASE WHEN contacts.is_protected = 1 THEN 1 ELSE excluded.is_protected END,
                       lastmod = datetime('now')""",
                fields
            )

    def get_contacts(self) -> List[Dict]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM contacts ORDER BY last_seen DESC"
            ).fetchall()
            return [dict(r) for r in rows]

    def get_contact(self, public_key: str) -> Optional[Dict]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM contacts WHERE public_key = ?",
                (public_key.lower(),)
            ).fetchone()
            return dict(row) if row else None

    def get_contact_by_prefix(self, prefix: str) -> Optional[Dict]:
        """Find a contact by public key prefix (LIKE match)."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM contacts WHERE public_key LIKE ? AND length(public_key) = 64 LIMIT 1",
                (prefix.lower() + '%',)
            ).fetchone()
            return dict(row) if row else None

    def get_contact_by_name(self, name: str) -> Optional[Dict]:
        """Find a contact by exact name match."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM contacts WHERE name = ? AND length(public_key) = 64 LIMIT 1",
                (name,)
            ).fetchone()
            return dict(row) if row else None

    def delete_contact(self, public_key: str) -> bool:
        """Move contact to cache (source='advert') instead of deleting.

        Contact stays visible in cache and @mentions but not in device list.
        upsert_contact() overwrites source on re-add (back to 'device').
        """
        with self._connect() as conn:
            cursor = conn.execute(
                "UPDATE contacts SET source = 'advert', lastmod = datetime('now') WHERE public_key = ?",
                (public_key.lower(),)
            )
            return cursor.rowcount > 0

    def hard_delete_contact(self, public_key: str) -> bool:
        """Permanently delete a contact from the database."""
        with self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM contacts WHERE public_key = ?",
                (public_key.lower(),)
            )
            return cursor.rowcount > 0

    def downgrade_stale_device_contacts(self, active_device_keys: set) -> int:
        """Downgrade contacts marked 'device' that are no longer on the device."""
        with self._connect() as conn:
            all_device = conn.execute(
                "SELECT public_key FROM contacts WHERE source = 'device'"
            ).fetchall()
            stale_keys = [r['public_key'] for r in all_device
                          if r['public_key'] not in active_device_keys]
            if stale_keys:
                conn.executemany(
                    "UPDATE contacts SET source = 'advert', lastmod = datetime('now') WHERE public_key = ?",
                    [(k,) for k in stale_keys]
                )
            return len(stale_keys)

    def set_contact_protected(self, public_key: str, protected: bool) -> bool:
        with self._connect() as conn:
            cursor = conn.execute(
                "UPDATE contacts SET is_protected = ?, lastmod = datetime('now') WHERE public_key = ?",
                (1 if protected else 0, public_key.lower())
            )
            return cursor.rowcount > 0

    # ================================================================
    # Ignored / Blocked Contacts
    # ================================================================

    def set_contact_ignored(self, public_key: str, ignored: bool) -> bool:
        pk = public_key.lower()
        with self._connect() as conn:
            if ignored:
                conn.execute(
                    "INSERT OR IGNORE INTO ignored_contacts (public_key) VALUES (?)", (pk,))
                # Remove from blocked if setting ignored
                conn.execute(
                    "DELETE FROM blocked_contacts WHERE public_key = ?", (pk,))
            else:
                conn.execute(
                    "DELETE FROM ignored_contacts WHERE public_key = ?", (pk,))
            return True

    def set_contact_blocked(self, public_key: str, blocked: bool) -> bool:
        pk = public_key.lower()
        with self._connect() as conn:
            if blocked:
                conn.execute(
                    "INSERT OR IGNORE INTO blocked_contacts (public_key) VALUES (?)", (pk,))
                # Remove from ignored if setting blocked
                conn.execute(
                    "DELETE FROM ignored_contacts WHERE public_key = ?", (pk,))
            else:
                conn.execute(
                    "DELETE FROM blocked_contacts WHERE public_key = ?", (pk,))
            return True

    def is_contact_ignored(self, public_key: str) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM ignored_contacts WHERE public_key = ?",
                (public_key.lower(),)
            ).fetchone()
            return row is not None

    def is_contact_blocked(self, public_key: str) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM blocked_contacts WHERE public_key = ?",
                (public_key.lower(),)
            ).fetchone()
            return row is not None

    def get_ignored_keys(self) -> set:
        with self._connect() as conn:
            rows = conn.execute("SELECT public_key FROM ignored_contacts").fetchall()
            return {r['public_key'] for r in rows}

    def get_blocked_keys(self) -> set:
        with self._connect() as conn:
            rows = conn.execute("SELECT public_key FROM blocked_contacts").fetchall()
            return {r['public_key'] for r in rows}

    def set_name_blocked(self, name: str, blocked: bool) -> bool:
        with self._connect() as conn:
            if blocked:
                conn.execute(
                    "INSERT OR IGNORE INTO blocked_names (name) VALUES (?)", (name,))
            else:
                conn.execute(
                    "DELETE FROM blocked_names WHERE name = ?", (name,))
            return True

    def get_blocked_names_list(self) -> list:
        """Return list of directly blocked names (from blocked_names table)."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT name, created_at FROM blocked_names ORDER BY created_at DESC"
            ).fetchall()
            return [dict(r) for r in rows]

    def get_blocked_contact_names(self) -> set:
        """Return all blocked names: from blocked_contacts (by pubkey) + blocked_names (by name)."""
        with self._connect() as conn:
            # Names from pubkey-blocked contacts
            rows1 = conn.execute(
                """SELECT c.name FROM blocked_contacts bc
                   JOIN contacts c ON bc.public_key = c.public_key
                   WHERE c.name != ''"""
            ).fetchall()
            # Names from directly blocked names
            rows2 = conn.execute(
                "SELECT name FROM blocked_names"
            ).fetchall()
            return {r['name'] for r in rows1} | {r['name'] for r in rows2}

    # ================================================================
    # Protected Contacts (DB-backed)
    # ================================================================

    def get_protected_keys(self) -> set:
        """Return set of public_keys that are protected."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT public_key FROM contacts WHERE is_protected = 1"
            ).fetchall()
            return {r['public_key'] for r in rows}

    # ================================================================
    # App Settings (key-value store)
    # ================================================================

    def get_setting(self, key: str) -> Optional[str]:
        """Get a setting value (JSON string) by key."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT value FROM app_settings WHERE key = ?", (key,)
            ).fetchone()
            return row['value'] if row else None

    def set_setting(self, key: str, value: str) -> None:
        """Set a setting value (JSON string)."""
        with self._connect() as conn:
            conn.execute(
                """INSERT INTO app_settings (key, value)
                   VALUES (?, ?)
                   ON CONFLICT(key) DO UPDATE SET
                       value = excluded.value,
                       updated_at = datetime('now')""",
                (key, value)
            )

    def get_setting_json(self, key: str, default=None):
        """Get a setting, JSON-decoded. Returns default if not found."""
        import json
        raw = self.get_setting(key)
        if raw is None:
            return default
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return default

    def set_setting_json(self, key: str, value) -> None:
        """Set a setting, JSON-encoding the value."""
        import json
        self.set_setting(key, json.dumps(value, ensure_ascii=False))

    def migrate_protected_contacts_from_file(self, settings_path) -> int:
        """One-time migration: import protected_contacts from .webui_settings.json into DB.

        Returns number of contacts marked as protected.
        """
        import json
        from pathlib import Path
        settings_path = Path(settings_path)
        if not settings_path.exists():
            return 0

        try:
            with open(settings_path, 'r', encoding='utf-8') as f:
                settings = json.load(f)
            protected = settings.get('protected_contacts', [])
            if not protected:
                return 0

            count = 0
            with self._connect() as conn:
                for pk in protected:
                    pk = pk.lower()
                    cursor = conn.execute(
                        "UPDATE contacts SET is_protected = 1, lastmod = datetime('now') WHERE public_key = ?",
                        (pk,)
                    )
                    if cursor.rowcount > 0:
                        count += 1
                    else:
                        # Contact not in DB yet - insert minimal record
                        conn.execute(
                            """INSERT OR IGNORE INTO contacts (public_key, name, is_protected, source)
                               VALUES (?, '', 1, 'advert')""",
                            (pk,)
                        )
                        count += 1

            logger.info(f"Migrated {count} protected contacts from settings file to DB")
            return count
        except Exception as e:
            logger.error(f"Failed to migrate protected contacts: {e}")
            return 0

    def migrate_settings_from_file(self, settings_path) -> bool:
        """One-time migration: import cleanup/retention/manual_add settings from .webui_settings.json.

        Returns True if migration was performed.
        """
        import json
        from pathlib import Path
        settings_path = Path(settings_path)
        if not settings_path.exists():
            return False

        try:
            with open(settings_path, 'r', encoding='utf-8') as f:
                settings = json.load(f)

            migrated = False

            if 'cleanup_settings' in settings:
                self.set_setting_json('cleanup_settings', settings['cleanup_settings'])
                migrated = True

            if 'retention_settings' in settings:
                self.set_setting_json('retention_settings', settings['retention_settings'])
                migrated = True

            if 'manual_add_contacts' in settings:
                self.set_setting_json('manual_add_contacts', settings['manual_add_contacts'])
                migrated = True

            if migrated:
                logger.info("Migrated app settings from .webui_settings.json to DB")
            return migrated
        except Exception as e:
            logger.error(f"Failed to migrate settings: {e}")
            return False

    # ================================================================
    # Channels
    # ================================================================

    def upsert_channel(self, idx: int, name: str, secret: str = None) -> None:
        with self._connect() as conn:
            conn.execute(
                """INSERT INTO channels (idx, name, secret)
                   VALUES (?, ?, ?)
                   ON CONFLICT(idx) DO UPDATE SET
                       name = excluded.name,
                       secret = COALESCE(excluded.secret, channels.secret),
                       updated_at = datetime('now')""",
                (idx, name, secret)
            )

    def get_channels(self) -> List[Dict]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM channels ORDER BY idx"
            ).fetchall()
            return [dict(r) for r in rows]

    def delete_channel(self, idx: int) -> bool:
        with self._connect() as conn:
            cursor = conn.execute("DELETE FROM channels WHERE idx = ?", (idx,))
            return cursor.rowcount > 0

    # ================================================================
    # Channel Messages
    # ================================================================

    def insert_channel_message(self, channel_idx: int, sender: str, content: str,
                                timestamp: int, **kwargs) -> int:
        with self._connect() as conn:
            cursor = conn.execute(
                """INSERT INTO channel_messages
                   (channel_idx, sender, content, timestamp, sender_timestamp,
                    is_own, txt_type, snr, path_len, pkt_payload, raw_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (channel_idx, sender, content, timestamp,
                 kwargs.get('sender_timestamp'),
                 1 if kwargs.get('is_own') else 0,
                 kwargs.get('txt_type', 0),
                 kwargs.get('snr'),
                 kwargs.get('path_len'),
                 kwargs.get('pkt_payload'),
                 kwargs.get('raw_json'))
            )
            return cursor.lastrowid

    def get_channel_message_by_id(self, msg_id: int) -> Optional[Dict]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM channel_messages WHERE id = ?", (msg_id,)
            ).fetchone()
            return dict(row) if row else None

    def get_channel_messages(self, channel_idx: int = None, limit: int = 50,
                              offset: int = 0, days: int = None) -> List[Dict]:
        with self._connect() as conn:
            conditions = []
            params: list = []

            if channel_idx is not None:
                conditions.append("channel_idx = ?")
                params.append(channel_idx)

            if days is not None and days > 0:
                cutoff = int((datetime.now() - timedelta(days=days)).timestamp())
                conditions.append("timestamp >= ?")
                params.append(cutoff)

            where = (" WHERE " + " AND ".join(conditions)) if conditions else ""

            if limit and limit > 0:
                query = f"""SELECT * FROM (
                    SELECT * FROM channel_messages{where}
                    ORDER BY timestamp DESC LIMIT ? OFFSET ?
                ) ORDER BY timestamp ASC"""
                params.extend([limit, offset])
            else:
                query = f"SELECT * FROM channel_messages{where} ORDER BY timestamp ASC"

            rows = conn.execute(query, params).fetchall()
            return [dict(r) for r in rows]

    def get_message_dates(self) -> List[Dict]:
        """Get distinct dates that have channel messages, with counts.
        Returns list of {'date': 'YYYY-MM-DD', 'message_count': N}, newest first."""
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT date(timestamp, 'unixepoch', 'localtime') as date,
                          COUNT(*) as message_count
                   FROM channel_messages
                   WHERE timestamp > 0
                   GROUP BY date
                   ORDER BY date DESC"""
            ).fetchall()
            return [dict(r) for r in rows]

    def get_channel_messages_by_date(self, date_str: str,
                                      channel_idx: int = None) -> List[Dict]:
        """Get channel messages for a specific date (YYYY-MM-DD)."""
        with self._connect() as conn:
            conditions = ["date(timestamp, 'unixepoch', 'localtime') = ?"]
            params: list = [date_str]

            if channel_idx is not None:
                conditions.append("channel_idx = ?")
                params.append(channel_idx)

            where = " WHERE " + " AND ".join(conditions)
            query = f"SELECT * FROM channel_messages{where} ORDER BY timestamp ASC"
            rows = conn.execute(query, params).fetchall()
            return [dict(r) for r in rows]

    def delete_channel_messages(self, channel_idx: int) -> int:
        with self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM channel_messages WHERE channel_idx = ?",
                (channel_idx,)
            )
            return cursor.rowcount

    # ================================================================
    # Direct Messages
    # ================================================================

    def insert_direct_message(self, contact_pubkey: str, direction: str,
                               content: str, timestamp: int, **kwargs) -> int:
        if contact_pubkey:
            contact_pubkey = contact_pubkey.lower()
        with self._connect() as conn:
            cursor = conn.execute(
                """INSERT INTO direct_messages
                   (contact_pubkey, direction, content, timestamp, sender_timestamp,
                    txt_type, snr, path_len, expected_ack, pkt_payload, signature, raw_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (contact_pubkey, direction, content, timestamp,
                 kwargs.get('sender_timestamp'),
                 kwargs.get('txt_type', 0),
                 kwargs.get('snr'),
                 kwargs.get('path_len'),
                 kwargs.get('expected_ack'),
                 kwargs.get('pkt_payload'),
                 kwargs.get('signature'),
                 kwargs.get('raw_json'))
            )
            return cursor.lastrowid

    def get_dm_messages(self, contact_pubkey: str, limit: int = 50,
                         offset: int = 0) -> List[Dict]:
        contact_pubkey = contact_pubkey.lower()
        with self._connect() as conn:
            # Support both full key and prefix matching
            if len(contact_pubkey) < 64:
                condition = "contact_pubkey LIKE ?"
                param = contact_pubkey + '%'
            else:
                condition = "contact_pubkey = ?"
                param = contact_pubkey
            rows = conn.execute(
                f"""SELECT * FROM (
                    SELECT * FROM direct_messages
                    WHERE {condition}
                    ORDER BY timestamp DESC LIMIT ? OFFSET ?
                ) ORDER BY timestamp ASC""",
                (param, limit, offset)
            ).fetchall()
            return [dict(r) for r in rows]

    def get_dm_conversations(self) -> List[Dict]:
        """Get list of DM conversations with last message info."""
        with self._connect() as conn:
            rows = conn.execute(
                """SELECT
                    dm.contact_pubkey,
                    COALESCE(c.name, dm.contact_pubkey) AS display_name,
                    COUNT(*) AS message_count,
                    MAX(dm.timestamp) AS last_message_timestamp,
                    (SELECT content FROM direct_messages d2
                     WHERE d2.contact_pubkey = dm.contact_pubkey
                     ORDER BY d2.timestamp DESC LIMIT 1) AS last_message_preview,
                    (SELECT direction FROM direct_messages d3
                     WHERE d3.contact_pubkey = dm.contact_pubkey
                     ORDER BY d3.timestamp DESC LIMIT 1) AS last_direction
                FROM direct_messages dm
                LEFT JOIN contacts c ON dm.contact_pubkey = c.public_key
                WHERE dm.contact_pubkey IS NOT NULL
                GROUP BY dm.contact_pubkey
                ORDER BY last_message_timestamp DESC"""
            ).fetchall()
            return [dict(r) for r in rows]

    # ================================================================
    # ACKs
    # ================================================================

    def insert_ack(self, expected_ack: str, **kwargs) -> None:
        with self._connect() as conn:
            conn.execute(
                """INSERT INTO acks (expected_ack, snr, rssi, route_type, is_retry, dm_id)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (expected_ack,
                 kwargs.get('snr'),
                 kwargs.get('rssi'),
                 kwargs.get('route_type'),
                 1 if kwargs.get('is_retry') else 0,
                 kwargs.get('dm_id'))
            )

    def get_ack_for_dm(self, expected_ack: str) -> Optional[Dict]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM acks WHERE expected_ack = ? ORDER BY received_at DESC LIMIT 1",
                (expected_ack,)
            ).fetchone()
            return dict(row) if row else None

    def get_dm_by_id(self, dm_id: int) -> Optional[Dict]:
        """Fetch a direct message by its ID."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM direct_messages WHERE id = ?", (dm_id,)
            ).fetchone()
            return dict(row) if row else None

    def relink_orphaned_dms(self, public_key: str, name: str = '') -> int:
        """Re-link DMs with NULL contact_pubkey back to this contact.

        When a contact is deleted, ON DELETE SET NULL nullifies contact_pubkey.
        When the contact is re-added, re-link those orphaned DMs.
        Matches by pubkey prefix in raw_json (incoming) or contact name (outgoing).
        """
        public_key = public_key.lower()
        prefix = public_key[:12]
        with self._connect() as conn:
            if name:
                cursor = conn.execute(
                    """UPDATE direct_messages SET contact_pubkey = ?
                       WHERE contact_pubkey IS NULL
                       AND (raw_json LIKE ? OR raw_json LIKE ?
                            OR raw_json IS NULL)""",
                    (public_key, f'%{prefix}%', f'%"name": "{name}"%')
                )
            else:
                cursor = conn.execute(
                    """UPDATE direct_messages SET contact_pubkey = ?
                       WHERE contact_pubkey IS NULL
                       AND (raw_json LIKE ? OR raw_json IS NULL)""",
                    (public_key, f'%{prefix}%')
                )
            if cursor.rowcount > 0:
                logger.info(f"Re-linked {cursor.rowcount} orphaned DMs to {public_key[:12]}...")
            return cursor.rowcount

    def find_dm_duplicate(self, contact_pubkey: str, content: str,
                           sender_timestamp: int = None,
                           window_seconds: int = 300) -> Optional[Dict]:
        """Check for duplicate incoming DM (for receiver-side dedup).

        If sender_timestamp is provided, matches exact (sender, timestamp, text).
        Otherwise falls back to time-window match (same sender + text within window).
        """
        contact_pubkey = contact_pubkey.lower()
        with self._connect() as conn:
            if sender_timestamp is not None:
                row = conn.execute(
                    """SELECT id FROM direct_messages
                       WHERE contact_pubkey = ? AND direction = 'in'
                       AND content = ? AND sender_timestamp = ?
                       LIMIT 1""",
                    (contact_pubkey, content, sender_timestamp)
                ).fetchone()
            else:
                cutoff = int(time.time()) - window_seconds
                row = conn.execute(
                    """SELECT id FROM direct_messages
                       WHERE contact_pubkey = ? AND direction = 'in'
                       AND content = ? AND timestamp > ?
                       LIMIT 1""",
                    (contact_pubkey, content, cutoff)
                ).fetchone()
            return dict(row) if row else None

    # ================================================================
    # Echoes
    # ================================================================

    def insert_echo(self, pkt_payload: str, **kwargs) -> None:
        with self._connect() as conn:
            conn.execute(
                """INSERT INTO echoes (pkt_payload, path, snr, direction, cm_id)
                   VALUES (?, ?, ?, ?, ?)""",
                (pkt_payload,
                 kwargs.get('path'),
                 kwargs.get('snr'),
                 kwargs.get('direction', 'incoming'),
                 kwargs.get('cm_id'))
            )

    def get_echoes_for_message(self, pkt_payload: str) -> List[Dict]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM echoes WHERE pkt_payload = ? ORDER BY received_at ASC",
                (pkt_payload,)
            ).fetchall()
            return [dict(r) for r in rows]

    def update_message_pkt_payload(self, msg_id: int, pkt_payload: str) -> None:
        """Set pkt_payload on a channel message (used for sent message echo correlation)."""
        with self._connect() as conn:
            conn.execute(
                "UPDATE channel_messages SET pkt_payload = ? WHERE id = ?",
                (pkt_payload, msg_id)
            )

    # ================================================================
    # Paths
    # ================================================================

    def insert_path(self, contact_pubkey: str, **kwargs) -> None:
        with self._connect() as conn:
            conn.execute(
                """INSERT INTO paths (contact_pubkey, pkt_payload, path, snr, path_len)
                   VALUES (?, ?, ?, ?, ?)""",
                (contact_pubkey,
                 kwargs.get('pkt_payload'),
                 kwargs.get('path'),
                 kwargs.get('snr'),
                 kwargs.get('path_len'))
            )

    # ================================================================
    # Advertisements
    # ================================================================

    def insert_advertisement(self, public_key: str, name: str, **kwargs) -> None:
        with self._connect() as conn:
            conn.execute(
                """INSERT INTO advertisements
                   (public_key, name, type, lat, lon, timestamp, snr, raw_payload)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (public_key.lower(), name,
                 kwargs.get('type', 0),
                 kwargs.get('lat'),
                 kwargs.get('lon'),
                 kwargs.get('timestamp', 0),
                 kwargs.get('snr'),
                 kwargs.get('raw_payload'))
            )

    def get_advertisements(self, limit: int = 100, public_key: str = None) -> list:
        with self._connect() as conn:
            if public_key:
                rows = conn.execute(
                    """SELECT * FROM advertisements
                       WHERE public_key = ?
                       ORDER BY timestamp DESC LIMIT ?""",
                    (public_key.lower(), limit)
                ).fetchall()
            else:
                rows = conn.execute(
                    """SELECT * FROM advertisements
                       ORDER BY timestamp DESC LIMIT ?""",
                    (limit,)
                ).fetchall()
            return [dict(r) for r in rows]

    # ================================================================
    # Read Status
    # ================================================================

    def mark_read(self, key: str, timestamp: int) -> None:
        with self._connect() as conn:
            conn.execute(
                """INSERT INTO read_status (key, last_seen_ts)
                   VALUES (?, ?)
                   ON CONFLICT(key) DO UPDATE SET
                       last_seen_ts = MAX(read_status.last_seen_ts, excluded.last_seen_ts),
                       updated_at = datetime('now')""",
                (key, timestamp)
            )

    def get_read_status(self) -> Dict[str, Dict]:
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM read_status").fetchall()
            return {r['key']: dict(r) for r in rows}

    def set_channel_muted(self, channel_idx: int, muted: bool) -> None:
        key = f"chan_{channel_idx}"
        with self._connect() as conn:
            conn.execute(
                """INSERT INTO read_status (key, is_muted)
                   VALUES (?, ?)
                   ON CONFLICT(key) DO UPDATE SET
                       is_muted = excluded.is_muted,
                       updated_at = datetime('now')""",
                (key, 1 if muted else 0)
            )

    # ================================================================
    # Full-Text Search
    # ================================================================

    def search_messages(self, query: str, limit: int = 50) -> List[Dict]:
        """Search channel and direct messages using FTS5."""
        results = []
        with self._connect() as conn:
            # Search channel messages
            rows = conn.execute(
                """SELECT cm.*, 'channel' AS msg_source
                   FROM channel_messages cm
                   JOIN channel_messages_fts fts ON cm.id = fts.rowid
                   WHERE channel_messages_fts MATCH ?
                   ORDER BY cm.timestamp DESC LIMIT ?""",
                (query, limit)
            ).fetchall()
            results.extend(dict(r) for r in rows)

            # Search direct messages
            rows = conn.execute(
                """SELECT dm.*, 'dm' AS msg_source
                   FROM direct_messages dm
                   JOIN direct_messages_fts fts ON dm.id = fts.rowid
                   WHERE direct_messages_fts MATCH ?
                   ORDER BY dm.timestamp DESC LIMIT ?""",
                (query, limit)
            ).fetchall()
            results.extend(dict(r) for r in rows)

        # Sort combined results by timestamp descending
        results.sort(key=lambda r: r['timestamp'], reverse=True)
        return results[:limit]

    # ================================================================
    # Maintenance
    # ================================================================

    def get_stats(self) -> Dict[str, Any]:
        """Get row counts for all tables."""
        tables = ['device', 'contacts', 'channels', 'channel_messages',
                  'direct_messages', 'acks', 'echoes', 'paths',
                  'advertisements', 'read_status']
        stats = {}
        with self._connect() as conn:
            for table in tables:
                row = conn.execute(f"SELECT COUNT(*) as cnt FROM {table}").fetchone()
                stats[table] = row['cnt']
            # DB file size
            stats['db_size_bytes'] = self.db_path.stat().st_size if self.db_path.exists() else 0
        return stats

    def cleanup_old_messages(self, days: int, include_dms: bool = False,
                             include_adverts: bool = False) -> dict:
        """Delete messages older than N days. Returns counts per table."""
        cutoff = int((datetime.now() - timedelta(days=days)).timestamp())
        result = {}
        with self._connect() as conn:
            cursor = conn.execute(
                "DELETE FROM channel_messages WHERE timestamp < ?", (cutoff,)
            )
            result['channel_messages'] = cursor.rowcount

            if include_dms:
                cursor = conn.execute(
                    "DELETE FROM direct_messages WHERE timestamp < ?", (cutoff,)
                )
                result['direct_messages'] = cursor.rowcount

            if include_adverts:
                cursor = conn.execute(
                    "DELETE FROM advertisements WHERE timestamp < ?", (cutoff,)
                )
                result['advertisements'] = cursor.rowcount

        return result

    # ================================================================
    # Backup
    # ================================================================

    def create_backup(self, backup_dir: Path) -> Path:
        """Create a backup using sqlite3.backup(). Returns backup file path."""
        backup_dir = Path(backup_dir)
        backup_dir.mkdir(parents=True, exist_ok=True)

        date_str = datetime.now().strftime('%Y-%m-%d')
        backup_path = backup_dir / f"mc-webui.{date_str}.db"

        source = sqlite3.connect(str(self.db_path))
        dest = sqlite3.connect(str(backup_path))
        try:
            source.backup(dest)
            logger.info(f"Backup created: {backup_path}")
        finally:
            dest.close()
            source.close()

        return backup_path

    def list_backups(self, backup_dir: Path) -> List[Dict]:
        """List available backups sorted by date descending."""
        backup_dir = Path(backup_dir)
        if not backup_dir.exists():
            return []

        backups = []
        for f in sorted(backup_dir.glob("mc-webui.*.db"), reverse=True):
            backups.append({
                'filename': f.name,
                'path': str(f),
                'size_bytes': f.stat().st_size,
                'created': datetime.fromtimestamp(f.stat().st_mtime).isoformat()
            })
        return backups

    def cleanup_old_backups(self, backup_dir: Path, retention_days: int) -> int:
        """Remove backups older than retention_days. Returns count removed."""
        backup_dir = Path(backup_dir)
        if not backup_dir.exists():
            return 0

        cutoff = datetime.now() - timedelta(days=retention_days)
        removed = 0
        for f in backup_dir.glob("mc-webui.*.db"):
            if datetime.fromtimestamp(f.stat().st_mtime) < cutoff:
                f.unlink()
                removed += 1
                logger.info(f"Removed old backup: {f.name}")
        return removed
