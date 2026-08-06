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
  PushSubscriptionRow,
  RawArchiveRow,
  SessionRow,
  SnapshotRow,
  StoredPosition,
  ToolCatalogRow,
  Visibility,
} from "../domain.js";
import type { FeedEventType } from "../types.js";
import type { Storage } from "./index.js";

/**
 * The Cloudflare Workers implementation of Storage, mirroring src/storage/sqlite.ts
 * statement for statement. D1 *is* SQLite, so the SQL is the same text; what
 * differs is the shape of the client:
 *
 *   - every call is async, and `.bind()` takes the whole parameter list at once;
 *   - there is no `exec("BEGIN")`. `batch()` is the transaction primitive — it
 *     runs its statements sequentially in one implicit transaction and rolls the
 *     whole thing back if any statement fails;
 *   - `undefined` is not a bindable value, so every optional column is coerced
 *     to `null` on the way in (see `nul`);
 *   - booleans are not bindable either, hence the explicit 1/0 for `suppressed`.
 *
 * Schema lives in migrations/0001_init.sql rather than here: `init()` is a no-op
 * because `wrangler d1 migrations apply` owns the DDL. Semantics that the rest
 * of the app depends on — content-hash primary keys making `insertFeedEvents`
 * idempotent, single-use invites and OAuth states, inclusive `since` bounds —
 * are preserved exactly.
 */

/** Bindable D1 parameter types. Deliberately excludes `undefined`. */
type Param = string | number | null;

type Row = Record<string, unknown>;

export class D1Storage implements Storage {
  constructor(private readonly db: D1Database) {}

  /** Schema is applied by `wrangler d1 migrations apply`, not at boot. */
  async init(): Promise<void> {}

  /** D1 connections are managed by the runtime; nothing to release. */
  async close(): Promise<void> {}

  private all(sql: string, ...params: Param[]): Promise<Row[]> {
    return this.db
      .prepare(sql)
      .bind(...params)
      .all<Row>()
      .then((r) => r.results ?? []);
  }

  private first(sql: string, ...params: Param[]): Promise<Row | undefined> {
    return this.db
      .prepare(sql)
      .bind(...params)
      .first<Row>()
      .then((r) => r ?? undefined);
  }

  private run(sql: string, ...params: Param[]): Promise<D1Result> {
    return this.db
      .prepare(sql)
      .bind(...params)
      .run();
  }

  async upsertMember(m: MemberRow): Promise<void> {
    await this.run(
      `INSERT INTO members (id, name, visibility, role, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, visibility = excluded.visibility,
         role = excluded.role`,
      m.id,
      m.name,
      m.visibility,
      m.role,
      m.createdAt,
    );
  }

  async listMembers(): Promise<MemberRow[]> {
    return (await this.all(`SELECT * FROM members ORDER BY created_at, id`)).map(toMember);
  }

  async getMember(id: string): Promise<MemberRow | undefined> {
    const row = await this.first(`SELECT * FROM members WHERE id = ?`, id);
    return row ? toMember(row) : undefined;
  }

  async upsertAccount(a: AccountRow): Promise<void> {
    await this.run(
      `INSERT INTO accounts (id, member_id, provider, status, last_polled_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status`,
      a.id,
      a.memberId,
      a.provider,
      a.status,
      nul(a.lastPolledAt),
    );
  }

  async listAccounts(): Promise<AccountRow[]> {
    return (await this.all(`SELECT * FROM accounts ORDER BY id`)).map(toAccount);
  }

  async getAccount(id: string): Promise<AccountRow | undefined> {
    const row = await this.first(`SELECT * FROM accounts WHERE id = ?`, id);
    return row ? toAccount(row) : undefined;
  }

  async getAccountByMember(memberId: string): Promise<AccountRow | undefined> {
    const row = await this.first(
      `SELECT * FROM accounts WHERE member_id = ? ORDER BY id LIMIT 1`,
      memberId,
    );
    return row ? toAccount(row) : undefined;
  }

  async setAccountStatus(accountId: string, status: AccountStatus): Promise<void> {
    await this.run(`UPDATE accounts SET status = ? WHERE id = ?`, status, accountId);
  }

  async markPolled(accountId: string, at: string): Promise<void> {
    await this.run(`UPDATE accounts SET last_polled_at = ? WHERE id = ?`, at, accountId);
  }

  async saveSnapshot(
    accountId: string,
    takenAt: string,
    positions: Position[],
  ): Promise<void> {
    await this.run(
      `INSERT INTO snapshots (account_id, taken_at, payload_json) VALUES (?, ?, ?)`,
      accountId,
      takenAt,
      JSON.stringify(positions),
    );
  }

  async latestSnapshot(accountId: string): Promise<SnapshotRow | undefined> {
    const row = await this.first(
      `SELECT * FROM snapshots WHERE account_id = ? ORDER BY taken_at DESC, id DESC LIMIT 1`,
      accountId,
    );
    if (!row) return undefined;
    return {
      id: Number(row.id),
      accountId: String(row.account_id),
      takenAt: String(row.taken_at),
      positions: JSON.parse(String(row.payload_json)) as Position[],
    };
  }

  async getCurrentPositions(accountId: string): Promise<StoredPosition[]> {
    const rows = await this.all(
      `SELECT * FROM positions_current WHERE account_id = ? ORDER BY instrument_id`,
      accountId,
    );
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
    // batch() is the transaction: the delete and the inserts land together or
    // not at all, so a failed tick never leaves an account with no positions.
    const insert = this.db.prepare(
      `INSERT INTO positions_current
         (account_id, instrument_id, symbol, name, qty, avg_cost, mkt_value, pct_of_portfolio, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    await this.db.batch([
      this.db.prepare(`DELETE FROM positions_current WHERE account_id = ?`).bind(accountId),
      ...positions.map((p) =>
        insert.bind(
          accountId,
          p.instrumentId,
          p.symbol,
          p.name,
          p.qty,
          p.avgCost,
          p.mktValue,
          p.pctOfPortfolio,
          p.updatedAt,
        ),
      ),
    ]);
  }

  async insertFeedEvents(events: FeedEventRow[]): Promise<void> {
    if (events.length === 0) return;
    // INSERT OR IGNORE against the content-hash primary key: replaying a tick
    // collides instead of duplicating (same guarantee as the sqlite impl).
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO feed_events
         (id, account_id, type, instrument_id, symbol, instrument_name,
          pct_of_portfolio, qty_change_pct, detected_at, suppressed, suppress_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    await this.db.batch(
      events.map((e) =>
        insert.bind(
          e.id,
          e.accountId,
          e.type,
          e.instrumentId,
          e.symbol,
          e.instrumentName,
          e.pctOfPortfolio,
          nul(e.qtyChangePct),
          e.detectedAt,
          e.suppressed ? 1 : 0,
          nul(e.suppressReason),
        ),
      ),
    );
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
    const params: Param[] = [];
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
    const rows = await this.all(sql, ...params);
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
    await this.run(
      `INSERT INTO messages (id, member_id, body, created_at) VALUES (?, ?, ?, ?)`,
      message.id,
      message.memberId,
      message.body,
      message.createdAt,
    );
  }

  async listMessages(
    opts: { since?: string; limit?: number } = {},
  ): Promise<MessageRow[]> {
    const sql =
      `SELECT * FROM messages` +
      (opts.since ? ` WHERE created_at >= ?` : "") +
      ` ORDER BY created_at DESC, id DESC LIMIT ?`;
    const params: Param[] = opts.since ? [opts.since] : [];
    params.push(opts.limit ?? 200);
    const rows = await this.all(sql, ...params);
    return rows.map((r) => ({
      id: String(r.id),
      memberId: String(r.member_id),
      body: String(r.body),
      createdAt: String(r.created_at),
    }));
  }

  async archiveRaw(
    accountId: string,
    fetchedAt: string,
    tool: string,
    payload: unknown,
  ): Promise<void> {
    await this.run(
      `INSERT INTO raw_archive (account_id, fetched_at, tool, payload_json) VALUES (?, ?, ?, ?)`,
      accountId,
      fetchedAt,
      tool,
      JSON.stringify(payload),
    );
  }

  async listRawArchive(accountId: string): Promise<RawArchiveRow[]> {
    const rows = await this.all(
      `SELECT * FROM raw_archive WHERE account_id = ? ORDER BY fetched_at DESC, id DESC`,
      accountId,
    );
    return rows.map((r) => ({
      id: Number(r.id),
      accountId: String(r.account_id),
      fetchedAt: String(r.fetched_at),
      tool: String(r.tool),
      payload: JSON.parse(String(r.payload_json)) as unknown,
    }));
  }

  async pruneRawArchive(olderThan: string): Promise<number> {
    const res = await this.run(
      `DELETE FROM raw_archive WHERE fetched_at < ?`,
      olderThan,
    );
    return Number(res.meta.changes ?? 0);
  }

  async createInvite(invite: InviteTokenRow): Promise<void> {
    await this.run(
      `INSERT INTO invite_tokens (token_hash, member_id, created_at, used_at)
       VALUES (?, ?, ?, ?)`,
      invite.tokenHash,
      invite.memberId,
      invite.createdAt,
      nul(invite.usedAt),
    );
  }

  async consumeInvite(
    tokenHash: string,
    at: string,
  ): Promise<InviteTokenRow | "used" | undefined> {
    // Read-then-write rather than a single UPDATE ... RETURNING because the
    // caller distinguishes "unknown" from "already spent", and D1 has no
    // interactive transaction to hold the two statements together. The window
    // is a double-redeem of the same link within one round trip; the stamp
    // still lands exactly once, so at worst two tabs both get a session for
    // the member the link already named.
    const row = await this.first(
      `SELECT * FROM invite_tokens WHERE token_hash = ?`,
      tokenHash,
    );
    if (!row) return undefined;
    if (row.used_at) return "used";
    await this.run(
      `UPDATE invite_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`,
      at,
      tokenHash,
    );
    return {
      tokenHash: String(row.token_hash),
      memberId: String(row.member_id),
      createdAt: String(row.created_at),
      usedAt: at,
    };
  }

  async listInvites(): Promise<InviteTokenRow[]> {
    const rows = await this.all(
      `SELECT * FROM invite_tokens ORDER BY created_at, token_hash`,
    );
    return rows.map((r) => ({
      tokenHash: String(r.token_hash),
      memberId: String(r.member_id),
      createdAt: String(r.created_at),
      usedAt: r.used_at === null ? null : String(r.used_at),
    }));
  }

  /**
   * Voids every unspent link for a member and reports how many died. Used
   * links are left alone — they are the record of how someone got in.
   */
  async deletePendingInvites(memberId: string): Promise<number> {
    const res = await this.run(
      `DELETE FROM invite_tokens WHERE member_id = ? AND used_at IS NULL`,
      memberId,
    );
    return Number(res.meta.changes ?? 0);
  }

  async createDeviceLink(link: DeviceLinkRow): Promise<void> {
    await this.run(
      `INSERT INTO device_links (token_hash, member_id, created_at, expires_at, used_at)
       VALUES (?, ?, ?, ?, ?)`,
      link.tokenHash,
      link.memberId,
      link.createdAt,
      link.expiresAt,
      nul(link.usedAt),
    );
  }

  /**
   * Read-then-write for the same reason as consumeInvite: three outcomes the
   * caller must tell apart, and no interactive transaction to hold them in.
   * Expiry is checked before the stamp — a link that ran out of time is never
   * reported as spent.
   */
  async consumeDeviceLink(
    tokenHash: string,
    now: string,
  ): Promise<DeviceLinkRow | "used" | "expired" | undefined> {
    const row = await this.first(
      `SELECT * FROM device_links WHERE token_hash = ?`,
      tokenHash,
    );
    if (!row) return undefined;
    if (row.used_at) return "used";
    if (String(row.expires_at) <= now) return "expired";
    await this.run(
      `UPDATE device_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`,
      now,
      tokenHash,
    );
    return {
      tokenHash: String(row.token_hash),
      memberId: String(row.member_id),
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
      usedAt: now,
    };
  }

  async listDeviceLinks(memberId: string): Promise<DeviceLinkRow[]> {
    const rows = await this.all(
      `SELECT * FROM device_links WHERE member_id = ? ORDER BY created_at, token_hash`,
      memberId,
    );
    return rows.map((r) => ({
      tokenHash: String(r.token_hash),
      memberId: String(r.member_id),
      createdAt: String(r.created_at),
      expiresAt: String(r.expires_at),
      usedAt: r.used_at === null ? null : String(r.used_at),
    }));
  }

  async deleteDeviceLink(tokenHash: string): Promise<void> {
    await this.run(`DELETE FROM device_links WHERE token_hash = ?`, tokenHash);
  }

  async upsertPushSubscription(s: PushSubscriptionRow): Promise<void> {
    // A browser re-subscribing hands back the same endpoint, so this is the
    // normal path rather than the exceptional one — and it clears failed_count,
    // because a device that just proved it has a live endpoint is not failing.
    await this.run(
      `INSERT INTO push_subscriptions
         (endpoint_hash, member_id, subscription_json, created_at, last_ok_at, failed_count)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint_hash) DO UPDATE SET
         member_id = excluded.member_id,
         subscription_json = excluded.subscription_json,
         failed_count = 0`,
      s.endpointHash,
      s.memberId,
      s.subscriptionJson,
      s.createdAt,
      nul(s.lastOkAt),
      s.failedCount,
    );
  }

  async listPushSubscriptions(): Promise<PushSubscriptionRow[]> {
    return (
      await this.all(
        `SELECT * FROM push_subscriptions ORDER BY created_at, endpoint_hash`,
      )
    ).map(toPushSubscription);
  }

  async getPushSubscription(
    endpointHash: string,
  ): Promise<PushSubscriptionRow | undefined> {
    const row = await this.first(
      `SELECT * FROM push_subscriptions WHERE endpoint_hash = ?`,
      endpointHash,
    );
    return row ? toPushSubscription(row) : undefined;
  }

  async deletePushSubscription(endpointHash: string): Promise<void> {
    await this.run(
      `DELETE FROM push_subscriptions WHERE endpoint_hash = ?`,
      endpointHash,
    );
  }

  async markPushSubscriptionOk(endpointHash: string, at: string): Promise<void> {
    await this.run(
      `UPDATE push_subscriptions SET last_ok_at = ?, failed_count = 0
       WHERE endpoint_hash = ?`,
      at,
      endpointHash,
    );
  }

  async bumpPushSubscriptionFailure(endpointHash: string): Promise<number> {
    await this.run(
      `UPDATE push_subscriptions SET failed_count = failed_count + 1
       WHERE endpoint_hash = ?`,
      endpointHash,
    );
    return (await this.getPushSubscription(endpointHash))?.failedCount ?? 0;
  }

  async createSession(session: SessionRow): Promise<void> {
    await this.run(
      `INSERT INTO sessions (token_hash, member_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
      session.tokenHash,
      session.memberId,
      session.createdAt,
      session.expiresAt,
    );
  }

  async getSession(tokenHash: string, now: string): Promise<SessionRow | undefined> {
    const row = await this.first(
      `SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?`,
      tokenHash,
      now,
    );
    if (!row) return undefined;
    return {
      tokenHash: String(row.token_hash),
      memberId: String(row.member_id),
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
    };
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.run(`DELETE FROM sessions WHERE token_hash = ?`, tokenHash);
  }

  async upsertOAuthConnection(c: OAuthConnectionRow): Promise<void> {
    await this.run(
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
      c.accountId,
      c.provider,
      c.accessTokenEnc,
      nul(c.refreshTokenEnc),
      nul(c.expiresAt),
      nul(c.scope),
      c.clientInfoJsonEnc,
      c.authorizationServerMetaJson,
      c.createdAt,
      c.updatedAt,
      c.status,
    );
  }

  async getOAuthConnection(accountId: string): Promise<OAuthConnectionRow | undefined> {
    const row = await this.first(
      `SELECT * FROM oauth_connections WHERE account_id = ?`,
      accountId,
    );
    return row ? toConnection(row) : undefined;
  }

  async listOAuthConnections(): Promise<OAuthConnectionRow[]> {
    return (
      await this.all(`SELECT * FROM oauth_connections ORDER BY account_id`)
    ).map(toConnection);
  }

  async setOAuthConnectionStatus(
    accountId: string,
    status: OAuthConnectionStatus,
    updatedAt: string,
  ): Promise<void> {
    await this.run(
      `UPDATE oauth_connections SET status = ?, updated_at = ? WHERE account_id = ?`,
      status,
      updatedAt,
      accountId,
    );
  }

  async deleteOAuthConnection(accountId: string): Promise<void> {
    await this.run(`DELETE FROM oauth_connections WHERE account_id = ?`, accountId);
  }

  async findClientInfoForIssuer(issuer: string): Promise<string | undefined> {
    const row = await this.first(
      `SELECT client_info_json_enc FROM oauth_connections
       WHERE json_extract(authorization_server_meta_json, '$.issuer') = ?
       ORDER BY created_at LIMIT 1`,
      issuer,
    );
    return row ? String(row.client_info_json_enc) : undefined;
  }

  async createOAuthState(s: OAuthStateRow): Promise<void> {
    await this.run(
      `INSERT INTO oauth_states
         (state, member_id, code_verifier_enc, issuer, authorization_server_url,
          authorization_server_meta_json, client_info_json_enc, resource, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.state,
      s.memberId,
      s.codeVerifierEnc,
      s.issuer,
      s.authorizationServerUrl,
      s.authorizationServerMetaJson,
      s.clientInfoJsonEnc,
      nul(s.resource),
      s.createdAt,
      s.expiresAt,
    );
  }

  async consumeOAuthState(state: string, now: string): Promise<OAuthStateRow | undefined> {
    const row = await this.first(`SELECT * FROM oauth_states WHERE state = ?`, state);
    // Single-use whether or not it was still valid; the expiry sweep rides
    // along in the same batch so the table cannot grow unbounded.
    await this.db.batch([
      this.db.prepare(`DELETE FROM oauth_states WHERE state = ?`).bind(state),
      this.db.prepare(`DELETE FROM oauth_states WHERE expires_at <= ?`).bind(now),
    ]);
    if (!row || String(row.expires_at) <= now) return undefined;
    return {
      state: String(row.state),
      memberId: String(row.member_id),
      codeVerifierEnc: String(row.code_verifier_enc),
      issuer: String(row.issuer),
      authorizationServerUrl: String(row.authorization_server_url),
      authorizationServerMetaJson: String(row.authorization_server_meta_json),
      clientInfoJsonEnc: String(row.client_info_json_enc),
      resource: row.resource === null ? null : String(row.resource),
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
    };
  }

  async saveToolCatalog(
    accountId: string,
    capturedAt: string,
    tools: unknown,
  ): Promise<void> {
    await this.run(
      `INSERT INTO tool_catalog (account_id, captured_at, tools_json) VALUES (?, ?, ?)`,
      accountId,
      capturedAt,
      JSON.stringify(tools),
    );
  }

  async latestToolCatalog(accountId: string): Promise<ToolCatalogRow | undefined> {
    const row = await this.first(
      `SELECT * FROM tool_catalog WHERE account_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1`,
      accountId,
    );
    if (!row) return undefined;
    return {
      id: Number(row.id),
      accountId: String(row.account_id),
      capturedAt: String(row.captured_at),
      tools: JSON.parse(String(row.tools_json)) as unknown,
    };
  }
}

/** D1 rejects `undefined` as a bound parameter; SQL NULL is what we mean anyway. */
function nul<T extends string | number>(value: T | null | undefined): T | null {
  return value ?? null;
}

function toMember(r: Row): MemberRow {
  return {
    id: String(r.id),
    name: String(r.name),
    visibility: String(r.visibility) as Visibility,
    role: (r.role as MemberRole | null) ?? "member",
    createdAt: String(r.created_at),
  };
}

function toAccount(r: Row): AccountRow {
  return {
    id: String(r.id),
    memberId: String(r.member_id),
    provider: "indmoney",
    status: String(r.status) as AccountStatus,
    lastPolledAt: r.last_polled_at === null ? null : String(r.last_polled_at),
  };
}

function toPushSubscription(r: Row): PushSubscriptionRow {
  return {
    endpointHash: String(r.endpoint_hash),
    memberId: String(r.member_id),
    subscriptionJson: String(r.subscription_json),
    createdAt: String(r.created_at),
    lastOkAt: r.last_ok_at === null ? null : String(r.last_ok_at),
    failedCount: Number(r.failed_count),
  };
}

function toConnection(r: Row): OAuthConnectionRow {
  return {
    accountId: String(r.account_id),
    provider: "indmoney",
    accessTokenEnc: String(r.access_token_enc),
    refreshTokenEnc: r.refresh_token_enc === null ? null : String(r.refresh_token_enc),
    expiresAt: r.expires_at === null ? null : String(r.expires_at),
    scope: r.scope === null ? null : String(r.scope),
    clientInfoJsonEnc: String(r.client_info_json_enc),
    authorizationServerMetaJson: String(r.authorization_server_meta_json),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    status: String(r.status) as OAuthConnectionStatus,
  };
}
