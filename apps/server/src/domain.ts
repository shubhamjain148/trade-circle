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

export interface InviteTokenRow {
  tokenHash: string;
  memberId: string;
  createdAt: string;
  usedAt: string | null;
}

export interface SessionRow {
  tokenHash: string;
  memberId: string;
  createdAt: string;
  expiresAt: string;
}

export type OAuthConnectionStatus = "active" | "needs_reauth" | "revoked";

/**
 * One friend's grant. Everything secret is AES-256-GCM at rest; `clientInfoJsonEnc`
 * is not optional — the SDK refuses to refresh without the DCR client information
 * (appendix 1 §1.3, "the #1 way to build the nags-everyone-daily version").
 */
export interface OAuthConnectionRow {
  accountId: string;
  provider: "indmoney";
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  expiresAt: string | null;
  scope: string | null;
  clientInfoJsonEnc: string;
  authorizationServerMetaJson: string;
  createdAt: string;
  updatedAt: string;
  status: OAuthConnectionStatus;
}

/** In-flight authorization: state → member, PKCE verifier and the AS we started with. */
export interface OAuthStateRow {
  state: string;
  memberId: string;
  codeVerifierEnc: string;
  issuer: string;
  authorizationServerUrl: string;
  authorizationServerMetaJson: string;
  clientInfoJsonEnc: string;
  resource: string | null;
  createdAt: string;
  expiresAt: string;
}

/** Raw `tools/list` output, captured on connect — INDmoney publishes no schemas. */
export interface ToolCatalogRow {
  id: number;
  accountId: string;
  capturedAt: string;
  tools: unknown;
}
