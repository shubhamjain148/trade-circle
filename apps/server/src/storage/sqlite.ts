import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AccountRow,
  AccountStatus,
  DeviceLinkRow,
  FeedEventRow,
  InviteTokenRow,
  MemberRole,
  MemberRow,
  MessageRow,
  OAuthConnectionRow,
  OAuthConnectionStatus,
  OAuthStateRow,
  Position,
  RawArchiveRow,
  SessionRow,
  SnapshotRow,
  StoredPosition,
  ToolCatalogRow,
  Visibility,
} from "../domain.js";
import type { FeedEventType } from "../types.js";
import type { Storage } from "./index.js";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- role is additive: fresh databases get it here, older ones get it from the
-- guarded ALTER in init() below. No CHECK on it for that reason — SQLite can
-- add a defaulted column but not a constrained one, and two definitions of the
-- same column that disagree is worse than none.
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

-- Second-device links: a member signing themselves in elsewhere. Short-lived
-- and single-use; see migrations/0002_device_links.sql for why it is its own
-- table rather than a column on invite_tokens.
CREATE TABLE IF NOT EXISTS device_links (
  token_hash TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS device_links_member ON device_links(member_id);

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
`;

export const defaultDbPath = process.env.DB_PATH ?? "./data/watcher.db";

export class SqliteStorage implements Storage {
  private db: DatabaseSync;

  constructor(path: string = defaultDbPath) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
  }

  async init(): Promise<void> {
    this.db.exec(SCHEMA);
    this.addColumn("members", "role", `TEXT NOT NULL DEFAULT 'member'`);
  }

  /**
   * Idempotent ALTER for databases created before a column existed. SQLite has
   * no ADD COLUMN IF NOT EXISTS, so the table_info read is the guard.
   */
  private addColumn(table: string, column: string, definition: string): void {
    const columns = this.db
      .prepare(`SELECT name FROM pragma_table_info(?)`)
      .all(table) as { name: string }[];
    if (columns.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async upsertMember(m: MemberRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO members (id, name, visibility, role, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, visibility = excluded.visibility,
           role = excluded.role`,
      )
      .run(m.id, m.name, m.visibility, m.role, m.createdAt);
  }

  async listMembers(): Promise<MemberRow[]> {
    const rows = this.db
      .prepare(`SELECT * FROM members ORDER BY created_at, id`)
      .all() as Record<string, string>[];
    return rows.map(toMember);
  }

  async getMember(id: string): Promise<MemberRow | undefined> {
    const r = this.db.prepare(`SELECT * FROM members WHERE id = ?`).get(id) as
      | Record<string, string>
      | undefined;
    return r ? toMember(r) : undefined;
  }

  async upsertAccount(a: AccountRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO accounts (id, member_id, provider, status, last_polled_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status`,
      )
      .run(a.id, a.memberId, a.provider, a.status, a.lastPolledAt);
  }

  async listAccounts(): Promise<AccountRow[]> {
    const rows = this.db
      .prepare(`SELECT * FROM accounts ORDER BY id`)
      .all() as Record<string, string | null>[];
    return rows.map(toAccount);
  }

  async getAccount(id: string): Promise<AccountRow | undefined> {
    const row = this.db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) as
      | Record<string, string | null>
      | undefined;
    return row ? toAccount(row) : undefined;
  }

  async getAccountByMember(memberId: string): Promise<AccountRow | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM accounts WHERE member_id = ? ORDER BY id LIMIT 1`)
      .get(memberId) as Record<string, string | null> | undefined;
    return row ? toAccount(row) : undefined;
  }

  async setAccountStatus(accountId: string, status: AccountStatus): Promise<void> {
    this.db
      .prepare(`UPDATE accounts SET status = ? WHERE id = ?`)
      .run(status, accountId);
  }

  async markPolled(accountId: string, at: string): Promise<void> {
    this.db
      .prepare(`UPDATE accounts SET last_polled_at = ? WHERE id = ?`)
      .run(at, accountId);
  }

  async saveSnapshot(
    accountId: string,
    takenAt: string,
    positions: Position[],
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO snapshots (account_id, taken_at, payload_json) VALUES (?, ?, ?)`,
      )
      .run(accountId, takenAt, JSON.stringify(positions));
  }

  async latestSnapshot(accountId: string): Promise<SnapshotRow | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM snapshots WHERE account_id = ? ORDER BY taken_at DESC, id DESC LIMIT 1`,
      )
      .get(accountId) as Record<string, string | number> | undefined;
    if (!row) return undefined;
    return {
      id: Number(row.id),
      accountId: String(row.account_id),
      takenAt: String(row.taken_at),
      positions: JSON.parse(String(row.payload_json)) as Position[],
    };
  }

  async getCurrentPositions(accountId: string): Promise<StoredPosition[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM positions_current WHERE account_id = ? ORDER BY instrument_id`,
      )
      .all(accountId) as Record<string, string | number>[];
    return rows.map((r) => ({
      accountId: String(r.account_id),
      instrumentId: String(r.instrument_id),
      symbol: String(r.symbol),
      name: String(r.name),
      qty: Number(r.qty),
      avgCost: Number(r.avg_cost),
      mktValue: Number(r.mkt_value),
      pctOfPortfolio: Number(r.pct_of_portfolio),
      updatedAt: String(r.updated_at),
    }));
  }

  async replaceCurrentPositions(
    accountId: string,
    positions: StoredPosition[],
  ): Promise<void> {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(`DELETE FROM positions_current WHERE account_id = ?`)
        .run(accountId);
      const insert = this.db.prepare(
        `INSERT INTO positions_current
           (account_id, instrument_id, symbol, name, qty, avg_cost, mkt_value, pct_of_portfolio, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const p of positions) {
        insert.run(
          accountId,
          p.instrumentId,
          p.symbol,
          p.name,
          p.qty,
          p.avgCost,
          p.mktValue,
          p.pctOfPortfolio,
          p.updatedAt,
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async insertFeedEvents(events: FeedEventRow[]): Promise<void> {
    if (events.length === 0) return;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO feed_events
         (id, account_id, type, instrument_id, symbol, instrument_name,
          pct_of_portfolio, qty_change_pct, detected_at, suppressed, suppress_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN");
    try {
      for (const e of events) {
        insert.run(
          e.id,
          e.accountId,
          e.type,
          e.instrumentId,
          e.symbol,
          e.instrumentName,
          e.pctOfPortfolio,
          e.qtyChangePct,
          e.detectedAt,
          e.suppressed ? 1 : 0,
          e.suppressReason,
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async listFeedEvents(
    opts: {
      accountId?: string;
      includeSuppressed?: boolean;
      since?: string;
      limit?: number;
    } = {},
  ): Promise<FeedEventRow[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.accountId) {
      where.push("account_id = ?");
      params.push(opts.accountId);
    }
    // Inclusive: the chat cursor breaks same-timestamp ties on id, so the
    // boundary row has to survive the SQL and be filtered in the merge.
    if (opts.since) {
      where.push("detected_at >= ?");
      params.push(opts.since);
    }
    if (!opts.includeSuppressed) where.push("suppressed = 0");
    const sql =
      `SELECT * FROM feed_events` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY detected_at DESC, id DESC LIMIT ?`;
    params.push(opts.limit ?? 200);
    const rows = this.db.prepare(sql).all(...params) as Record<
      string,
      string | number | null
    >[];
    return rows.map((r) => ({
      id: String(r.id),
      accountId: String(r.account_id),
      type: String(r.type) as FeedEventType,
      instrumentId: String(r.instrument_id),
      symbol: String(r.symbol),
      instrumentName: String(r.instrument_name),
      pctOfPortfolio: Number(r.pct_of_portfolio),
      qtyChangePct: r.qty_change_pct === null ? null : Number(r.qty_change_pct),
      detectedAt: String(r.detected_at),
      suppressed: Number(r.suppressed) === 1,
      suppressReason: r.suppress_reason === null ? null : String(r.suppress_reason),
    }));
  }

  async insertMessage(message: MessageRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO messages (id, member_id, body, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(message.id, message.memberId, message.body, message.createdAt);
  }

  async listMessages(
    opts: { since?: string; limit?: number } = {},
  ): Promise<MessageRow[]> {
    // Same shape as listFeedEvents — newest first, so the two lists merge
    // without either side having to be re-sorted end to end.
    const sql =
      `SELECT * FROM messages` +
      (opts.since ? ` WHERE created_at >= ?` : "") +
      ` ORDER BY created_at DESC, id DESC LIMIT ?`;
    const params: (string | number)[] = opts.since ? [opts.since] : [];
    params.push(opts.limit ?? 200);
    const rows = this.db.prepare(sql).all(...params) as Record<string, string>[];
    return rows.map((r) => ({
      id: r.id,
      memberId: r.member_id,
      body: r.body,
      createdAt: r.created_at,
    }));
  }

  async archiveRaw(
    accountId: string,
    fetchedAt: string,
    tool: string,
    payload: unknown,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO raw_archive (account_id, fetched_at, tool, payload_json) VALUES (?, ?, ?, ?)`,
      )
      .run(accountId, fetchedAt, tool, JSON.stringify(payload));
  }

  async listRawArchive(accountId: string): Promise<RawArchiveRow[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM raw_archive WHERE account_id = ? ORDER BY fetched_at DESC, id DESC`,
      )
      .all(accountId) as Record<string, string | number>[];
    return rows.map((r) => ({
      id: Number(r.id),
      accountId: String(r.account_id),
      fetchedAt: String(r.fetched_at),
      tool: String(r.tool),
      payload: JSON.parse(String(r.payload_json)) as unknown,
    }));
  }

  async pruneRawArchive(olderThan: string): Promise<number> {
    const res = this.db
      .prepare(`DELETE FROM raw_archive WHERE fetched_at < ?`)
      .run(olderThan);
    return Number(res.changes);
  }

  async createInvite(invite: InviteTokenRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO invite_tokens (token_hash, member_id, created_at, used_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(invite.tokenHash, invite.memberId, invite.createdAt, invite.usedAt);
  }

  async consumeInvite(
    tokenHash: string,
    at: string,
  ): Promise<InviteTokenRow | "used" | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM invite_tokens WHERE token_hash = ?`)
      .get(tokenHash) as Record<string, string | null> | undefined;
    if (!row) return undefined;
    if (row.used_at) return "used";
    this.db
      .prepare(`UPDATE invite_tokens SET used_at = ? WHERE token_hash = ?`)
      .run(at, tokenHash);
    return {
      tokenHash: String(row.token_hash),
      memberId: String(row.member_id),
      createdAt: String(row.created_at),
      usedAt: at,
    };
  }

  async listInvites(): Promise<InviteTokenRow[]> {
    const rows = this.db
      .prepare(`SELECT * FROM invite_tokens ORDER BY created_at, token_hash`)
      .all() as Record<string, string | null>[];
    return rows.map((r) => ({
      tokenHash: String(r.token_hash),
      memberId: String(r.member_id),
      createdAt: String(r.created_at),
      usedAt: r.used_at ?? null,
    }));
  }

  /**
   * Voids every unspent link for a member and reports how many died. Used
   * links are left alone — they are the record of how someone got in.
   */
  async deletePendingInvites(memberId: string): Promise<number> {
    const res = this.db
      .prepare(`DELETE FROM invite_tokens WHERE member_id = ? AND used_at IS NULL`)
      .run(memberId);
    return Number(res.changes);
  }

  async createDeviceLink(link: DeviceLinkRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO device_links (token_hash, member_id, created_at, expires_at, used_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        link.tokenHash,
        link.memberId,
        link.createdAt,
        link.expiresAt,
        link.usedAt,
      );
  }

  /**
   * Expiry is checked before the stamp, so a link that ran out of time is never
   * reported as spent: the two states send the friend to different screens.
   */
  async consumeDeviceLink(
    tokenHash: string,
    now: string,
  ): Promise<DeviceLinkRow | "used" | "expired" | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM device_links WHERE token_hash = ?`)
      .get(tokenHash) as Record<string, string | null> | undefined;
    if (!row) return undefined;
    if (row.used_at) return "used";
    if (String(row.expires_at) <= now) return "expired";
    this.db
      .prepare(`UPDATE device_links SET used_at = ? WHERE token_hash = ?`)
      .run(now, tokenHash);
    return {
      tokenHash: String(row.token_hash),
      memberId: String(row.member_id),
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
      usedAt: now,
    };
  }

  async listDeviceLinks(memberId: string): Promise<DeviceLinkRow[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM device_links WHERE member_id = ? ORDER BY created_at, token_hash`,
      )
      .all(memberId) as Record<string, string | null>[];
    return rows.map((r) => ({
      tokenHash: String(r.token_hash),
      memberId: String(r.member_id),
      createdAt: String(r.created_at),
      expiresAt: String(r.expires_at),
      usedAt: r.used_at ?? null,
    }));
  }

  async deleteDeviceLink(tokenHash: string): Promise<void> {
    this.db.prepare(`DELETE FROM device_links WHERE token_hash = ?`).run(tokenHash);
  }

  async createSession(session: SessionRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, member_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        session.tokenHash,
        session.memberId,
        session.createdAt,
        session.expiresAt,
      );
  }

  async getSession(
    tokenHash: string,
    now: string,
  ): Promise<SessionRow | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?`)
      .get(tokenHash, now) as Record<string, string> | undefined;
    if (!row) return undefined;
    return {
      tokenHash: row.token_hash,
      memberId: row.member_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
  }

  async upsertOAuthConnection(c: OAuthConnectionRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO oauth_connections
           (account_id, provider, access_token_enc, refresh_token_enc, expires_at, scope,
            client_info_json_enc, authorization_server_meta_json, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           access_token_enc = excluded.access_token_enc,
           refresh_token_enc = excluded.refresh_token_enc,
           expires_at = excluded.expires_at,
           scope = excluded.scope,
           client_info_json_enc = excluded.client_info_json_enc,
           authorization_server_meta_json = excluded.authorization_server_meta_json,
           updated_at = excluded.updated_at,
           status = excluded.status`,
      )
      .run(
        c.accountId,
        c.provider,
        c.accessTokenEnc,
        c.refreshTokenEnc,
        c.expiresAt,
        c.scope,
        c.clientInfoJsonEnc,
        c.authorizationServerMetaJson,
        c.createdAt,
        c.updatedAt,
        c.status,
      );
  }

  async getOAuthConnection(
    accountId: string,
  ): Promise<OAuthConnectionRow | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM oauth_connections WHERE account_id = ?`)
      .get(accountId) as Record<string, string | null> | undefined;
    return row ? toConnection(row) : undefined;
  }

  async listOAuthConnections(): Promise<OAuthConnectionRow[]> {
    const rows = this.db
      .prepare(`SELECT * FROM oauth_connections ORDER BY account_id`)
      .all() as Record<string, string | null>[];
    return rows.map(toConnection);
  }

  async setOAuthConnectionStatus(
    accountId: string,
    status: OAuthConnectionStatus,
    updatedAt: string,
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE oauth_connections SET status = ?, updated_at = ? WHERE account_id = ?`,
      )
      .run(status, updatedAt, accountId);
  }

  async deleteOAuthConnection(accountId: string): Promise<void> {
    this.db
      .prepare(`DELETE FROM oauth_connections WHERE account_id = ?`)
      .run(accountId);
  }

  async findClientInfoForIssuer(issuer: string): Promise<string | undefined> {
    const row = this.db
      .prepare(
        `SELECT client_info_json_enc FROM oauth_connections
         WHERE json_extract(authorization_server_meta_json, '$.issuer') = ?
         ORDER BY created_at LIMIT 1`,
      )
      .get(issuer) as Record<string, string> | undefined;
    return row?.client_info_json_enc;
  }

  async createOAuthState(s: OAuthStateRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO oauth_states
           (state, member_id, code_verifier_enc, issuer, authorization_server_url,
            authorization_server_meta_json, client_info_json_enc, resource, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.state,
        s.memberId,
        s.codeVerifierEnc,
        s.issuer,
        s.authorizationServerUrl,
        s.authorizationServerMetaJson,
        s.clientInfoJsonEnc,
        s.resource,
        s.createdAt,
        s.expiresAt,
      );
  }

  async consumeOAuthState(
    state: string,
    now: string,
  ): Promise<OAuthStateRow | undefined> {
    const row = this.db
      .prepare(`SELECT * FROM oauth_states WHERE state = ?`)
      .get(state) as Record<string, string | null> | undefined;
    // Single-use whether or not it was still valid.
    this.db.prepare(`DELETE FROM oauth_states WHERE state = ?`).run(state);
    this.db.prepare(`DELETE FROM oauth_states WHERE expires_at <= ?`).run(now);
    if (!row || String(row.expires_at) <= now) return undefined;
    return {
      state: String(row.state),
      memberId: String(row.member_id),
      codeVerifierEnc: String(row.code_verifier_enc),
      issuer: String(row.issuer),
      authorizationServerUrl: String(row.authorization_server_url),
      authorizationServerMetaJson: String(row.authorization_server_meta_json),
      clientInfoJsonEnc: String(row.client_info_json_enc),
      resource: row.resource ?? null,
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
    };
  }

  async saveToolCatalog(
    accountId: string,
    capturedAt: string,
    tools: unknown,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO tool_catalog (account_id, captured_at, tools_json) VALUES (?, ?, ?)`,
      )
      .run(accountId, capturedAt, JSON.stringify(tools));
  }

  async latestToolCatalog(accountId: string): Promise<ToolCatalogRow | undefined> {
    const row = this.db
      .prepare(
        `SELECT * FROM tool_catalog WHERE account_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1`,
      )
      .get(accountId) as Record<string, string | number> | undefined;
    if (!row) return undefined;
    return {
      id: Number(row.id),
      accountId: String(row.account_id),
      capturedAt: String(row.captured_at),
      tools: JSON.parse(String(row.tools_json)) as unknown,
    };
  }
}

function toConnection(r: Record<string, string | null>): OAuthConnectionRow {
  return {
    accountId: String(r.account_id),
    provider: "indmoney",
    accessTokenEnc: String(r.access_token_enc),
    refreshTokenEnc: r.refresh_token_enc ?? null,
    expiresAt: r.expires_at ?? null,
    scope: r.scope ?? null,
    clientInfoJsonEnc: String(r.client_info_json_enc),
    authorizationServerMetaJson: String(r.authorization_server_meta_json),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    status: String(r.status) as OAuthConnectionStatus,
  };
}

function toMember(r: Record<string, string>): MemberRow {
  return {
    id: r.id,
    name: r.name,
    visibility: r.visibility as Visibility,
    // Rows written before the column existed read back as NULL under the
    // ALTER's default only for *new* writes, so default defensively here too.
    role: (r.role as MemberRole) ?? "member",
    createdAt: r.created_at,
  };
}

function toAccount(r: Record<string, string | null>): AccountRow {
  return {
    id: String(r.id),
    memberId: String(r.member_id),
    provider: "indmoney",
    status: String(r.status) as AccountStatus,
    lastPolledAt: r.last_polled_at ?? null,
  };
}

export async function createStorage(path?: string): Promise<Storage> {
  const storage = new SqliteStorage(path);
  await storage.init();
  return storage;
}
