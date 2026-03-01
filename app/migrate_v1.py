"""
Migrate v1 data (.msgs JSONL) into v2 SQLite database.

Runs automatically on startup if .msgs file exists and database is empty.
Can also be run manually: python -m app.migrate_v1

Migrates:
- Live .msgs file (today's messages)
- Archive .msgs files (historical messages)
- Channel messages (CHAN, SENT_CHAN)
- Direct messages (PRIV, SENT_MSG)
"""

import json
import logging
from pathlib import Path
from typing import Optional, List

logger = logging.getLogger(__name__)


def _find_msgs_file(data_dir: Path, device_name: str) -> Optional[Path]:
    """Find the live .msgs file for the given device name."""
    msgs_file = data_dir / f"{device_name}.msgs"
    if msgs_file.exists():
        return msgs_file

    # Try to find any .msgs file in the data dir
    candidates = list(data_dir.glob("*.msgs"))
    # Exclude archive files (pattern: name.YYYY-MM-DD.msgs)
    live_files = [f for f in candidates if f.stem.count('.') == 0]
    if len(live_files) == 1:
        return live_files[0]

    return None


def _find_archive_files(data_dir: Path, device_name: str) -> List[Path]:
    """Find all archive .msgs files, sorted oldest first."""
    archive_files = []

    # Check common archive locations
    archive_dirs = [
        data_dir / 'archive',          # /data/archive/
        data_dir.parent / 'archive',   # sibling archive dir
    ]

    for archive_dir in archive_dirs:
        if archive_dir.exists():
            # Pattern: DeviceName.YYYY-MM-DD.msgs
            for f in archive_dir.glob(f"{device_name}.*.msgs"):
                # Validate it's an archive file (has date in name)
                parts = f.stem.split('.')
                if len(parts) >= 2:
                    archive_files.append(f)

    # Also check data_dir itself for archives
    for f in data_dir.glob(f"{device_name}.*.msgs"):
        parts = f.stem.split('.')
        if len(parts) >= 2 and f not in archive_files:
            archive_files.append(f)

    # Sort by filename (which sorts by date since format is Name.YYYY-MM-DD)
    archive_files.sort(key=lambda f: f.name)

    return archive_files


def migrate_v1_data(db, data_dir: Path, device_name: str) -> dict:
    """
    Import v1 .msgs data into v2 SQLite database.
    Imports both live .msgs file and all archive files.

    Args:
        db: Database instance
        data_dir: Path to meshcore config dir containing .msgs file
        device_name: Device name (used for .msgs filename and own message detection)

    Returns:
        dict with migration stats
    """
    stats = {
        'channel_messages': 0,
        'direct_messages': 0,
        'skipped': 0,
        'errors': 0,
        'files_processed': 0,
    }

    # Collect all files to import: archives first (oldest), then live
    files_to_import = []

    archive_files = _find_archive_files(data_dir, device_name)
    if archive_files:
        files_to_import.extend(archive_files)
        logger.info(f"Found {len(archive_files)} archive files to migrate")

    live_file = _find_msgs_file(data_dir, device_name)
    if live_file:
        files_to_import.append(live_file)

    if not files_to_import:
        logger.info("No .msgs files found, skipping v1 migration")
        return {'status': 'skipped', 'reason': 'no_msgs_files'}

    logger.info(f"Starting v1 data migration: {len(files_to_import)} files to process")

    # Track seen timestamps+text to avoid duplicates across archive and live file
    seen_channel = set()
    seen_dm = set()

    for msgs_file in files_to_import:
        file_stats = _import_msgs_file(
            db, msgs_file, device_name, seen_channel, seen_dm
        )
        stats['channel_messages'] += file_stats['channel_messages']
        stats['direct_messages'] += file_stats['direct_messages']
        stats['skipped'] += file_stats['skipped']
        stats['errors'] += file_stats['errors']
        stats['files_processed'] += 1

    stats['status'] = 'completed'
    logger.info(
        f"v1 migration complete: {stats['files_processed']} files, "
        f"{stats['channel_messages']} channel msgs, "
        f"{stats['direct_messages']} DMs, {stats['skipped']} skipped, "
        f"{stats['errors']} errors"
    )
    return stats


def _import_msgs_file(db, msgs_file: Path, device_name: str,
                      seen_channel: set, seen_dm: set) -> dict:
    """Import a single .msgs file. Returns per-file stats."""
    stats = {'channel_messages': 0, 'direct_messages': 0, 'skipped': 0, 'errors': 0}

    logger.info(f"Importing {msgs_file.name}...")

    try:
        lines = msgs_file.read_text(encoding='utf-8', errors='replace').splitlines()
    except Exception as e:
        logger.error(f"Failed to read {msgs_file}: {e}")
        stats['errors'] += 1
        return stats

    for line_num, raw_line in enumerate(lines, 1):
        raw_line = raw_line.strip()
        if not raw_line:
            continue

        try:
            entry = json.loads(raw_line)
        except json.JSONDecodeError:
            stats['errors'] += 1
            continue

        msg_type = entry.get('type')

        try:
            if msg_type in ('CHAN', 'SENT_CHAN'):
                # Dedup key: timestamp + first 50 chars of text
                ts = entry.get('timestamp', 0)
                text = entry.get('text', '')[:50]
                dedup = (ts, text)
                if dedup in seen_channel:
                    stats['skipped'] += 1
                    continue
                seen_channel.add(dedup)

                _migrate_channel_msg(db, entry, device_name)
                stats['channel_messages'] += 1
            elif msg_type == 'PRIV':
                ts = entry.get('timestamp', 0)
                text = entry.get('text', '')[:50]
                dedup = (ts, text)
                if dedup in seen_dm:
                    stats['skipped'] += 1
                    continue
                seen_dm.add(dedup)

                _migrate_dm_incoming(db, entry)
                stats['direct_messages'] += 1
            elif msg_type == 'SENT_MSG':
                if entry.get('txt_type', 0) == 0:  # Only private messages
                    ts = entry.get('timestamp', 0)
                    text = entry.get('text', '')[:50]
                    dedup = (ts, text)
                    if dedup in seen_dm:
                        stats['skipped'] += 1
                        continue
                    seen_dm.add(dedup)

                    _migrate_dm_outgoing(db, entry, device_name)
                    stats['direct_messages'] += 1
                else:
                    stats['skipped'] += 1
            else:
                stats['skipped'] += 1
        except Exception as e:
            stats['errors'] += 1
            if stats['errors'] <= 5:
                logger.warning(f"Migration error in {msgs_file.name} line {line_num}: {e}")

    logger.info(
        f"  {msgs_file.name}: {stats['channel_messages']} chan, "
        f"{stats['direct_messages']} DMs, {stats['skipped']} skip, "
        f"{stats['errors']} err"
    )
    return stats


def _migrate_channel_msg(db, entry: dict, device_name: str):
    """Migrate a CHAN or SENT_CHAN entry."""
    raw_text = entry.get('text', '').strip()
    if not raw_text:
        return

    is_own = entry.get('type') == 'SENT_CHAN'
    channel_idx = entry.get('channel_idx', 0)
    timestamp = entry.get('timestamp', 0)

    if is_own:
        sender = entry.get('sender', device_name)
        content = raw_text
    else:
        # Parse sender from "SenderName: message" format
        if ':' in raw_text:
            sender, content = raw_text.split(':', 1)
            sender = sender.strip()
            content = content.strip()
        else:
            sender = 'Unknown'
            content = raw_text

    db.insert_channel_message(
        channel_idx=channel_idx,
        sender=sender,
        content=content,
        timestamp=timestamp,
        sender_timestamp=entry.get('sender_timestamp'),
        is_own=is_own,
        txt_type=entry.get('txt_type', 0),
        snr=entry.get('SNR'),
        path_len=entry.get('path_len'),
        pkt_payload=entry.get('pkt_payload'),
        raw_json=json.dumps(entry, default=str),
    )


def _migrate_dm_incoming(db, entry: dict):
    """Migrate a PRIV (incoming DM) entry."""
    text = entry.get('text', '').strip()
    if not text:
        return

    pubkey_prefix = entry.get('pubkey_prefix', '')

    # Use None if pubkey not in contacts table (FK constraint)
    contact_key = pubkey_prefix if pubkey_prefix else None
    if contact_key:
        contact_key = _resolve_pubkey(db, contact_key)

    db.insert_direct_message(
        contact_pubkey=contact_key,
        direction='in',
        content=text,
        timestamp=entry.get('timestamp', 0),
        sender_timestamp=entry.get('sender_timestamp'),
        txt_type=entry.get('txt_type', 0),
        snr=entry.get('SNR'),
        path_len=entry.get('path_len'),
        pkt_payload=entry.get('pkt_payload'),
        raw_json=json.dumps(entry, default=str),
    )


def _migrate_dm_outgoing(db, entry: dict, device_name: str):
    """Migrate a SENT_MSG (outgoing DM) entry."""
    text = entry.get('text', '').strip()
    if not text:
        return

    # For outgoing DMs, we don't have recipient pubkey in v1 data.
    # In v1, conversation_id was "name_{recipient}" — we store the name
    # in raw_json for reference.
    recipient = entry.get('recipient', entry.get('name', ''))

    # Try to find pubkey from contacts table by recipient name
    contact_pubkey = _lookup_pubkey_by_name(db, recipient)

    db.insert_direct_message(
        contact_pubkey=contact_pubkey,
        direction='out',
        content=text,
        timestamp=entry.get('timestamp', 0),
        sender_timestamp=entry.get('sender_timestamp'),
        txt_type=entry.get('txt_type', 0),
        expected_ack=entry.get('expected_ack'),
        pkt_payload=entry.get('pkt_payload'),
        raw_json=json.dumps(entry, default=str),
    )


def _resolve_pubkey(db, pubkey_prefix: str) -> Optional[str]:
    """Check if a pubkey prefix matches a contact. Returns full key or None."""
    if not pubkey_prefix:
        return None
    try:
        contacts = db.get_contacts()
        prefix = pubkey_prefix.lower()
        for c in contacts:
            pk = (c.get('public_key') or '').lower()
            if pk and pk.startswith(prefix):
                return pk
    except Exception:
        pass
    return None


def _lookup_pubkey_by_name(db, name: str) -> Optional[str]:
    """Look up a contact's public_key by name. Returns None if not found."""
    if not name:
        return None
    try:
        contacts = db.get_contacts()
        for c in contacts:
            if c.get('name') == name:
                return c.get('public_key')
    except Exception:
        pass
    return None


def should_migrate(db, data_dir: Path, device_name: str) -> bool:
    """Check if migration is needed: .msgs files exist and DB has no messages."""
    # Check for live file
    has_live = _find_msgs_file(data_dir, device_name) is not None
    # Check for archive files
    has_archives = len(_find_archive_files(data_dir, device_name)) > 0

    if not has_live and not has_archives:
        return False

    # Only migrate if DB is empty (no channel messages and no DMs)
    try:
        stats = db.get_stats()
        total = stats.get('channel_messages', 0) + stats.get('direct_messages', 0)
        return total == 0
    except Exception:
        return False
