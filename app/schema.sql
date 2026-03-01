-- mc-webui v2 SQLite Schema
-- WAL mode and foreign keys are enabled programmatically in Database.__init__

-- Schema versioning for future migrations
CREATE TABLE IF NOT EXISTS schema_version (
    version     INTEGER PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO schema_version (version) VALUES (1);

-- Device identity and settings
CREATE TABLE IF NOT EXISTS device (
    id          INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
    public_key  TEXT NOT NULL DEFAULT '',
    name        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    self_info   TEXT  -- JSON blob with full device info
);

-- All known contacts (replaces contacts_cache.jsonl)
CREATE TABLE IF NOT EXISTS contacts (
    public_key      TEXT PRIMARY KEY,       -- hex, lowercase
    name            TEXT NOT NULL DEFAULT '',
    type            INTEGER DEFAULT 0,      -- node type from device
    flags           INTEGER DEFAULT 0,
    out_path        TEXT DEFAULT '',         -- outgoing path string
    out_path_len    INTEGER DEFAULT 0,
    last_advert     TEXT,                   -- ISO 8601 timestamp
    adv_lat         REAL,                   -- GPS latitude from advert
    adv_lon         REAL,                   -- GPS longitude from advert
    first_seen      TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen       TEXT NOT NULL DEFAULT (datetime('now')),
    source          TEXT DEFAULT 'advert',  -- 'advert', 'device', 'manual'
    is_protected    INTEGER DEFAULT 0,      -- 1 = protected from cleanup
    lastmod         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Channel configuration
CREATE TABLE IF NOT EXISTS channels (
    idx         INTEGER PRIMARY KEY,        -- channel index (0-7)
    name        TEXT NOT NULL DEFAULT '',
    secret      TEXT,                       -- channel secret/key (hex)
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Channel messages (replaces CHAN/SENT_CHAN from .msgs)
CREATE TABLE IF NOT EXISTS channel_messages (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_idx         INTEGER NOT NULL DEFAULT 0,
    sender              TEXT NOT NULL DEFAULT '',
    content             TEXT NOT NULL DEFAULT '',
    timestamp           INTEGER NOT NULL DEFAULT 0,         -- unix epoch
    sender_timestamp    INTEGER,                            -- sender's clock
    is_own              INTEGER NOT NULL DEFAULT 0,         -- 1 = sent by us
    txt_type            INTEGER DEFAULT 0,
    snr                 REAL,
    path_len            INTEGER,
    pkt_payload         TEXT,                               -- for echo matching
    raw_json            TEXT,                               -- original JSON line
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Direct messages (replaces PRIV/SENT_MSG from .msgs)
CREATE TABLE IF NOT EXISTS direct_messages (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_pubkey      TEXT,                               -- FK to contacts (nullable for unknown)
    direction           TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    content             TEXT NOT NULL DEFAULT '',
    timestamp           INTEGER NOT NULL DEFAULT 0,         -- unix epoch
    sender_timestamp    INTEGER,
    txt_type            INTEGER DEFAULT 0,
    snr                 REAL,
    path_len            INTEGER,
    expected_ack        TEXT,                               -- ACK code for delivery tracking
    pkt_payload         TEXT,                               -- raw packet payload for hash/analyzer
    signature           TEXT,                               -- dedup signature
    raw_json            TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (contact_pubkey) REFERENCES contacts(public_key) ON DELETE SET NULL
);

-- ACK tracking (replaces .acks.jsonl)
CREATE TABLE IF NOT EXISTS acks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    expected_ack    TEXT NOT NULL,           -- ACK code to match
    received_at     TEXT NOT NULL DEFAULT (datetime('now')),
    snr             REAL,
    rssi            REAL,
    route_type      TEXT,                   -- 'direct', 'flood', etc.
    is_retry        INTEGER DEFAULT 0,
    dm_id           INTEGER,                -- FK to direct_messages (nullable)
    FOREIGN KEY (dm_id) REFERENCES direct_messages(id) ON DELETE SET NULL
);

-- Echo tracking (replaces .echoes.jsonl)
CREATE TABLE IF NOT EXISTS echoes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    pkt_payload     TEXT NOT NULL,           -- matches channel_messages.pkt_payload
    path            TEXT,                   -- relay path string
    snr             REAL,
    received_at     TEXT NOT NULL DEFAULT (datetime('now')),
    direction       TEXT DEFAULT 'incoming', -- 'sent' or 'incoming'
    cm_id           INTEGER,                -- FK to channel_messages (nullable)
    FOREIGN KEY (cm_id) REFERENCES channel_messages(id) ON DELETE SET NULL
);

-- Path tracking (replaces .path.jsonl)
CREATE TABLE IF NOT EXISTS paths (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_pubkey  TEXT,
    pkt_payload     TEXT,
    path            TEXT,
    snr             REAL,
    path_len        INTEGER,
    received_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Advertisements (replaces .adverts.jsonl)
CREATE TABLE IF NOT EXISTS advertisements (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key      TEXT NOT NULL,
    name            TEXT NOT NULL DEFAULT '',
    type            INTEGER DEFAULT 0,
    lat             REAL,
    lon             REAL,
    timestamp       INTEGER NOT NULL DEFAULT 0,
    snr             REAL,
    raw_payload     TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Read status tracking (replaces .read_status.json)
CREATE TABLE IF NOT EXISTS read_status (
    key             TEXT PRIMARY KEY,       -- 'chan_0', 'dm_<pubkey>', etc.
    last_seen_ts    INTEGER DEFAULT 0,      -- unix timestamp
    is_muted        INTEGER DEFAULT 0,      -- 1 = muted (channels only)
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_cm_channel_ts ON channel_messages(channel_idx, timestamp);
CREATE INDEX IF NOT EXISTS idx_cm_pkt ON channel_messages(pkt_payload);
CREATE INDEX IF NOT EXISTS idx_dm_contact ON direct_messages(contact_pubkey, timestamp);
CREATE INDEX IF NOT EXISTS idx_dm_ack ON direct_messages(expected_ack);
CREATE INDEX IF NOT EXISTS idx_acks_code ON acks(expected_ack);
CREATE INDEX IF NOT EXISTS idx_echoes_pkt ON echoes(pkt_payload);
CREATE INDEX IF NOT EXISTS idx_adv_pubkey ON advertisements(public_key, timestamp);
CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);

-- ============================================================
-- Full-Text Search (FTS5)
-- ============================================================

CREATE VIRTUAL TABLE IF NOT EXISTS channel_messages_fts USING fts5(
    content,
    content=channel_messages,
    content_rowid=id
);

CREATE VIRTUAL TABLE IF NOT EXISTS direct_messages_fts USING fts5(
    content,
    content=direct_messages,
    content_rowid=id
);

-- FTS triggers: keep FTS index in sync with source tables

CREATE TRIGGER IF NOT EXISTS cm_fts_insert AFTER INSERT ON channel_messages BEGIN
    INSERT INTO channel_messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS cm_fts_delete AFTER DELETE ON channel_messages BEGIN
    INSERT INTO channel_messages_fts(channel_messages_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS cm_fts_update AFTER UPDATE OF content ON channel_messages BEGIN
    INSERT INTO channel_messages_fts(channel_messages_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
    INSERT INTO channel_messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS dm_fts_insert AFTER INSERT ON direct_messages BEGIN
    INSERT INTO direct_messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS dm_fts_delete AFTER DELETE ON direct_messages BEGIN
    INSERT INTO direct_messages_fts(direct_messages_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS dm_fts_update AFTER UPDATE OF content ON direct_messages BEGIN
    INSERT INTO direct_messages_fts(direct_messages_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
    INSERT INTO direct_messages_fts(rowid, content) VALUES (new.id, new.content);
END;
