import type {
  AccountRow,
  FeedEventRow,
  MemberRow,
  Position,
  RawArchiveRow,
  SnapshotRow,
  StoredPosition,
} from "../domain.js";

// Async by design: the SQLite implementation is synchronous underneath, but
// Turso/D1 (see docs/DEPLOYMENT.md) are not, and both must fit this interface.
export interface Storage {
  init(): Promise<void>;
  close(): Promise<void>;

  upsertMember(member: MemberRow): Promise<void>;
  listMembers(): Promise<MemberRow[]>;

  upsertAccount(account: AccountRow): Promise<void>;
  listAccounts(): Promise<AccountRow[]>;
  getAccount(id: string): Promise<AccountRow | undefined>;
  markPolled(accountId: string, at: string): Promise<void>;

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
    limit?: number;
  }): Promise<FeedEventRow[]>;

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
