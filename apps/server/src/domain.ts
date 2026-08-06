import type { FeedEventType } from "./types.js";

// Internal row shapes. The wire shapes the web app depends on live in types.ts
// and are assembled from these — keep the two apart so storage can evolve.

export type Visibility = "named" | "anonymous" | "paused";
export type AccountStatus = "active" | "needs_reauth" | "paused" | "revoked";

export interface MemberRow {
  id: string;
  name: string;
  visibility: Visibility;
  createdAt: string;
}

export interface AccountRow {
  id: string;
  memberId: string;
  provider: "indmoney";
  status: AccountStatus;
  lastPolledAt: string | null;
}

/** One holdings row as returned by a PortfolioSource. */
export interface Position {
  /** INDmoney internal key, never the ticker — tickers get renamed. */
  instrumentId: string;
  symbol: string;
  name: string;
  qty: number;
  avgCost: number;
  mktValue: number;
}

export interface StoredPosition extends Position {
  accountId: string;
  pctOfPortfolio: number;
  updatedAt: string;
}

export interface SnapshotRow {
  id: number;
  accountId: string;
  takenAt: string;
  positions: Position[];
}

export interface FeedEventRow {
  id: string;
  accountId: string;
  type: FeedEventType;
  instrumentId: string;
  symbol: string;
  instrumentName: string;
  pctOfPortfolio: number;
  qtyChangePct: number | null;
  detectedAt: string;
  suppressed: boolean;
  suppressReason: string | null;
}

export interface RawArchiveRow {
  id: number;
  accountId: string;
  fetchedAt: string;
  tool: string;
  payload: unknown;
}
