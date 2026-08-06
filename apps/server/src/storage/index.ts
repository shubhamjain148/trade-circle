import type {
  AccountRow,
  FeedEventRow,
  InviteTokenRow,
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
} from "../domain.js";

// Async by design: the SQLite implementation is synchronous underneath, but
// Turso/D1 (see docs/DEPLOYMENT.md) are not, and both must fit this interface.
export interface Storage {
  init(): Promise<void>;
  close(): Promise<void>;

  upsertMember(member: MemberRow): Promise<void>;
  listMembers(): Promise<MemberRow[]>;
  getMember(id: string): Promise<MemberRow | undefined>;

  upsertAccount(account: AccountRow): Promise<void>;
  listAccounts(): Promise<AccountRow[]>;
  getAccount(id: string): Promise<AccountRow | undefined>;
  getAccountByMember(memberId: string): Promise<AccountRow | undefined>;
  setAccountStatus(accountId: string, status: AccountRow["status"]): Promise<void>;
  markPolled(accountId: string, at: string): Promise<void>;

  createInvite(invite: InviteTokenRow): Promise<void>;
  /** Single-use: returns the invite and stamps `used_at`; "used" if spent, undefined if unknown. */
  consumeInvite(
    tokenHash: string,
    at: string,
  ): Promise<InviteTokenRow | "used" | undefined>;

  createSession(session: SessionRow): Promise<void>;
  getSession(tokenHash: string, now: string): Promise<SessionRow | undefined>;
  deleteSession(tokenHash: string): Promise<void>;

  upsertOAuthConnection(connection: OAuthConnectionRow): Promise<void>;
  getOAuthConnection(accountId: string): Promise<OAuthConnectionRow | undefined>;
  listOAuthConnections(): Promise<OAuthConnectionRow[]>;
  setOAuthConnectionStatus(
    accountId: string,
    status: OAuthConnectionStatus,
    updatedAt: string,
  ): Promise<void>;
  deleteOAuthConnection(accountId: string): Promise<void>;
  /**
   * DCR credentials are per authorization server, not per friend (appendix 1 §3.2) —
   * reuse an existing registration rather than minting a client per connect.
   */
  findClientInfoForIssuer(issuer: string): Promise<string | undefined>;

  createOAuthState(state: OAuthStateRow): Promise<void>;
  consumeOAuthState(state: string, now: string): Promise<OAuthStateRow | undefined>;

  saveToolCatalog(accountId: string, capturedAt: string, tools: unknown): Promise<void>;
  latestToolCatalog(accountId: string): Promise<ToolCatalogRow | undefined>;

  saveSnapshot(
    accountId: string,
    takenAt: string,
    positions: Position[],
  ): Promise<void>;
  latestSnapshot(accountId: string): Promise<SnapshotRow | undefined>;

  getCurrentPositions(accountId: string): Promise<StoredPosition[]>;
  replaceCurrentPositions(
    accountId: string,
    positions: StoredPosition[],
  ): Promise<void>;

  /** Idempotent on FeedEventRow.id (a content hash) — re-running a tick is safe. */
  insertFeedEvents(events: FeedEventRow[]): Promise<void>;
  listFeedEvents(opts?: {
    accountId?: string;
    includeSuppressed?: boolean;
    /** Inclusive lower bound on detectedAt — the chat cursor's cheap poll. */
    since?: string;
    limit?: number;
  }): Promise<FeedEventRow[]>;

  insertMessage(message: MessageRow): Promise<void>;
  /** Newest first, matching listFeedEvents; `since` is an inclusive lower bound. */
  listMessages(opts?: { since?: string; limit?: number }): Promise<MessageRow[]>;

  archiveRaw(
    accountId: string,
    fetchedAt: string,
    tool: string,
    payload: unknown,
  ): Promise<void>;
  listRawArchive(accountId: string): Promise<RawArchiveRow[]>;
  /** 90-day retention helper; returns rows deleted. */
  pruneRawArchive(olderThan: string): Promise<number>;
}

export { SqliteStorage, createStorage, defaultDbPath } from "./sqlite.js";
