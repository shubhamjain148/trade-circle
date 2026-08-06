import type {
  AccountRow,
  DeviceLinkRow,
  FeedEventRow,
  InviteTokenRow,
  MemberRow,
  MessageRow,
  OAuthConnectionRow,
  OAuthConnectionStatus,
  OAuthStateRow,
  Position,
  PushSubscriptionRow,
  RawArchiveRow,
  ReactionRow,
  ReactionTarget,
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
  /** Every link ever minted, oldest first. Hashes only — nothing here signs anyone in. */
  listInvites(): Promise<InviteTokenRow[]>;
  /** Voids a member's unspent links; returns how many. Spent ones are history and stay. */
  deletePendingInvites(memberId: string): Promise<number>;

  createDeviceLink(link: DeviceLinkRow): Promise<void>;
  /**
   * Single-use and time-boxed. "used" and "expired" are separate answers
   * because they are separate screens: one says "sign in on the device that
   * already worked", the other says "mint a fresh one".
   */
  consumeDeviceLink(
    tokenHash: string,
    now: string,
  ): Promise<DeviceLinkRow | "used" | "expired" | undefined>;
  /** One member's links, oldest first — the cap counts these. */
  listDeviceLinks(memberId: string): Promise<DeviceLinkRow[]>;
  deleteDeviceLink(tokenHash: string): Promise<void>;

  /**
   * Keyed on the endpoint hash, so a browser re-subscribing lands on its own
   * row rather than a second one — and re-subscribing clears the failure count,
   * because a browser that just handed us a live endpoint is not failing.
   */
  upsertPushSubscription(subscription: PushSubscriptionRow): Promise<void>;
  /** Every device the group has registered. The fan-out reads this once a tick. */
  listPushSubscriptions(): Promise<PushSubscriptionRow[]>;
  getPushSubscription(endpointHash: string): Promise<PushSubscriptionRow | undefined>;
  deletePushSubscription(endpointHash: string): Promise<void>;
  /** Success: stamps last_ok_at and forgives whatever went wrong before. */
  markPushSubscriptionOk(endpointHash: string, at: string): Promise<void>;
  /** Failure: returns the new consecutive-failure count so the caller can prune. */
  bumpPushSubscriptionFailure(endpointHash: string): Promise<number>;

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
  /**
   * One snapshot per UTC day — the last pass of each day — from `since`
   * onwards, oldest first, at most `limit` days.
   *
   * Daily, in SQL, because the alternative is shipping every poll of the last
   * month out of the database and thinning it in JavaScript: snapshots hold a
   * whole portfolio payload each, the poller runs hourly during US hours, and
   * a month of that is hundreds of rows and megabytes of JSON to parse for a
   * chart 44 pixels wide. The window and the cap are both enforced here so no
   * caller can ask for unbounded history by forgetting to.
   *
   * `limit` keeps the *newest* days when there are more buckets than asked for;
   * a truncated window that dropped today would be a lie about the present.
   */
  listDailySnapshots(
    accountId: string,
    since: string,
    limit: number,
  ): Promise<SnapshotRow[]>;

  getCurrentPositions(accountId: string): Promise<StoredPosition[]>;
  /**
   * Every account's current positions in one read. The group stats page needs
   * the whole table at once; doing it per account would be a query per friend
   * for a screen whose entire subject is the comparison between them.
   */
  listCurrentPositions(): Promise<StoredPosition[]>;
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

  /**
   * Add one reaction. Idempotent on the whole tuple — tapping 🚀 twice from two
   * tabs is one row, not an error — and stamps reaction_activity either way, so
   * a no-op write still tells other clients to re-read (they will see no change,
   * which is correct and costs one small row).
   */
  insertReaction(reaction: ReactionRow): Promise<void>;
  /** Remove one reaction. Idempotent: deleting what isn't there is not an error. */
  deleteReaction(
    key: ReactionTarget & { memberId: string; emoji: string },
    at: string,
  ): Promise<void>;
  /**
   * Every reaction on these items, oldest tap first — `who` reads as the order
   * people piled on. Chunked internally, so the caller may pass a whole page.
   */
  listReactionsFor(targets: ReactionTarget[]): Promise<ReactionRow[]>;
  /**
   * Items whose reactions changed at or after `since`, oldest touch first.
   *
   * Inclusive, matching listMessages/listFeedEvents, and safe to be inclusive
   * because what the caller does with the answer is recompute a whole summary:
   * re-delivering the boundary item costs one repeated (identical) summary and
   * removes any chance of stepping over a second item stamped in the same
   * millisecond. Without `since` this is the whole log — used by nothing but
   * tests, which is why it is capped like everything else.
   */
  listReactionActivity(opts?: {
    since?: string;
    limit?: number;
  }): Promise<{ target: ReactionTarget; touchedAt: string }[]>;
  /** The newest touch in the group, or undefined before anyone has ever reacted. */
  latestReactionActivityAt(): Promise<string | undefined>;

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
