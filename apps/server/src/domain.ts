import type { FeedEventType } from "./types.js";

// Internal row shapes. The wire shapes the web app depends on live in types.ts
// and are assembled from these — keep the two apart so storage can evolve.

export type Visibility = "named" | "anonymous" | "paused";
export type AccountStatus = "active" | "needs_reauth" | "paused" | "revoked";

/**
 * Everyone is a peer in the feed; "admin" only means "can hand out invites and
 * add members". It buys no extra sight of anyone's holdings — the group is
 * still a group of equals, and src/admin.ts is careful to stay that way.
 */
export type MemberRole = "admin" | "member";

export interface MemberRow {
  id: string;
  name: string;
  visibility: Visibility;
  role: MemberRole;
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

/**
 * One line of group chat. Deliberately thin: no threads, no edits — the
 * timeline it lands in is the feature, the message is just a row in it.
 * Reactions hang off it from the outside (ReactionRow), keyed by id, which is
 * how they reach feed events too without either table knowing about the other.
 */
export interface MessageRow {
  id: string;
  memberId: string;
  body: string;
  createdAt: string;
}

/** What a reaction can be attached to. Both halves of the merged timeline. */
export type ReactionItemKind = "message" | "event";

/** The identity of a timeline row, as reactions refer to it. */
export interface ReactionTarget {
  kind: ReactionItemKind;
  id: string;
}

/**
 * One tap. The whole row is the primary key, so inserting twice is a no-op and
 * deleting names exactly what was inserted — that is the entire toggle.
 */
export interface ReactionRow {
  itemKind: ReactionItemKind;
  itemId: string;
  memberId: string;
  emoji: string;
  createdAt: string;
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

/**
 * A member signing *themselves* in on a second device — phone alongside laptop.
 * Same single-use, hash-only shape as an invite, with one difference that
 * matters: it expires in minutes, because it is minted, read off a screen and
 * spent within one sitting. An invite is handed to someone else and may sit in
 * a chat app for a day; a device link that outlives the sitting is only risk.
 */
export interface DeviceLinkRow {
  tokenHash: string;
  memberId: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface SessionRow {
  tokenHash: string;
  memberId: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * One browser that asked to be told when a friend moves.
 *
 * Per-device, not per-member: the subscription is minted by that browser's
 * push service and dies with that installation, so a member with a phone and a
 * laptop has two rows and turning one off leaves the other alone. Same
 * assumption DeviceLinkRow already makes about how this group lives.
 *
 * `subscriptionJson` is the browser's own `PushSubscription.toJSON()` —
 * endpoint plus the p256dh and auth keys — kept whole because sending needs
 * all three and re-deriving any of it would be inventing structure the Push
 * API already gave us.
 */
export interface PushSubscriptionRow {
  /** SHA-256 of the endpoint. The endpoint itself is a capability URL. */
  endpointHash: string;
  memberId: string;
  subscriptionJson: string;
  createdAt: string;
  /** Last time the push service accepted a message for this device. */
  lastOkAt: string | null;
  /** Consecutive failures that were not an outright 404/410. Reset on success. */
  failedCount: number;
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
