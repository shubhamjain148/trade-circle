-- Migration number: 0001 	 2026-08-06T00:00:00.000Z
--
-- Mirrors the SCHEMA constant in src/storage/sqlite.ts. Two differences, both
-- forced by D1:
--   * no PRAGMA statements — D1 owns journalling, and foreign keys are already
--     enforced (`PRAGMA foreign_keys = ON` is the D1 default);
--   * `members.role` is declared inline rather than added by a guarded ALTER,
--     because a D1 migration runs exactly once against a known-empty database.
-- Keep the two in step: sqlite.ts is local dev, this is production.

CREATE TABLE IF NOT EXISTS members (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  visibility  TEXT NOT NULL CHECK (visibility IN ('named','anonymous','paused')),
  role        TEXT NOT NULL DEFAULT 'member',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id             TEXT PRIMARY KEY,
  member_id      TEXT NOT NULL REFERENCES members(id),
  provider       TEXT NOT NULL DEFAULT 'indmoney',
  status         TEXT NOT NULL CHECK (status IN ('active','needs_reauth','paused','revoked')),
  last_polled_at TEXT
);
CREATE INDEX IF NOT EXISTS accounts_member ON accounts(member_id);

-- Full poll payload per account; latest row is the diff baseline, the rest is history.
CREATE TABLE IF NOT EXISTS snapshots (
  id           INTEGER PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  taken_at     TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_acct_time ON snapshots(account_id, taken_at DESC);

CREATE TABLE IF NOT EXISTS positions_current (
  account_id       TEXT NOT NULL REFERENCES accounts(id),
  instrument_id    TEXT NOT NULL,
  symbol           TEXT NOT NULL,
  name             TEXT NOT NULL,
  qty              REAL NOT NULL,
  avg_cost         REAL NOT NULL,
  mkt_value        REAL NOT NULL,
  pct_of_portfolio REAL NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (account_id, instrument_id)
);

-- Append-only. id is a content hash, so a replayed tick collides instead of duplicating.
CREATE TABLE IF NOT EXISTS feed_events (
  id               TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts(id),
  type             TEXT NOT NULL CHECK (type IN ('NEW_POSITION','EXITED','SIZE_UP','SIZE_DOWN')),
  instrument_id    TEXT NOT NULL,
  symbol           TEXT NOT NULL,
  instrument_name  TEXT NOT NULL,
  pct_of_portfolio REAL NOT NULL,
  qty_change_pct   REAL,
  detected_at      TEXT NOT NULL,
  suppressed       INTEGER NOT NULL DEFAULT 0,
  suppress_reason  TEXT
);
CREATE INDEX IF NOT EXISTS feed_events_time ON feed_events(detected_at DESC);
CREATE INDEX IF NOT EXISTS feed_events_acct_time ON feed_events(account_id, detected_at DESC);

-- Group chat. Sorted with feed_events into one timeline by (time, id), so the
-- ordering key has to be comparable across both tables: ISO strings, always.
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL REFERENCES members(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_time ON messages(created_at DESC);

CREATE TABLE IF NOT EXISTS raw_archive (
  id           INTEGER PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  fetched_at   TEXT NOT NULL,
  tool         TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS raw_archive_time ON raw_archive(fetched_at);

-- Single-use join links. Only the hash is stored, so the DB cannot mint a login.
CREATE TABLE IF NOT EXISTS invite_tokens (
  token_hash TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS invite_tokens_member ON invite_tokens(member_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_member ON sessions(member_id);

-- The vault. client_info_json_enc is required: without the DCR registration the
-- SDK will not refresh, and the friend gets a spurious re-login (appendix 1 §1.3).
CREATE TABLE IF NOT EXISTS oauth_connections (
  account_id                     TEXT PRIMARY KEY REFERENCES accounts(id),
  provider                       TEXT NOT NULL DEFAULT 'indmoney',
  access_token_enc               TEXT NOT NULL,
  refresh_token_enc              TEXT,
  expires_at                     TEXT,
  scope                          TEXT,
  client_info_json_enc           TEXT NOT NULL,
  authorization_server_meta_json TEXT NOT NULL,
  created_at                     TEXT NOT NULL,
  updated_at                     TEXT NOT NULL,
  status                         TEXT NOT NULL CHECK (status IN ('active','needs_reauth','revoked'))
);

-- Short-lived; state is the only thing tying a callback back to a member.
CREATE TABLE IF NOT EXISTS oauth_states (
  state                          TEXT PRIMARY KEY,
  member_id                      TEXT NOT NULL REFERENCES members(id),
  code_verifier_enc              TEXT NOT NULL,
  issuer                         TEXT NOT NULL,
  authorization_server_url       TEXT NOT NULL,
  authorization_server_meta_json TEXT NOT NULL,
  client_info_json_enc           TEXT NOT NULL,
  resource                       TEXT,
  created_at                     TEXT NOT NULL,
  expires_at                     TEXT NOT NULL
);

-- Schema capture. INDmoney publishes no tool schemas, so the first real connect
-- is the only source of truth for src/mcp/toolmap.ts.
CREATE TABLE IF NOT EXISTS tool_catalog (
  id          INTEGER PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  captured_at TEXT NOT NULL,
  tools_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_catalog_acct ON tool_catalog(account_id, captured_at DESC);
