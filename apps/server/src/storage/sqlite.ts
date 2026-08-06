import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AccountRow,
  AccountStatus,
  FeedEventRow,
  MemberRow,
  Position,
  RawArchiveRow,
  SnapshotRow,
  StoredPosition,
  Visibility,
} from "../domain.js";
import type { FeedEventType } from "../types.js";
import type { Storage } from "./index.js";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS members (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  visibility  TEXT NOT NULL CHECK (visibility IN ('named','anonymous','paused')),
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

CREATE TABLE IF NOT EXISTS raw_archive (
  id           INTEGER PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  fetched_at   TEXT NOT NULL,
  tool         TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS raw_archive_time ON raw_archive(fetched_at);
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
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async upsertMember(m: MemberRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO members (id, name, visibility, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, visibility = excluded.visibility`,
      )
      .run(m.id, m.name, m.visibility, m.createdAt);
  }

  async listMembers(): Promise<MemberRow[]> {
    const rows = this.db
      .prepare(`SELECT * FROM members ORDER BY created_at, id`)
      .all() as Record<string, string>[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      visibility: r.visibility as Visibility,
      createdAt: r.created_at,
    }));
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
      limit?: number;
    } = {},
  ): Promise<FeedEventRow[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.accountId) {
      where.push("account_id = ?");
      params.push(opts.accountId);
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
