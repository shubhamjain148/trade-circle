/**
 * Mirrors apps/server/src/types.ts. Kept as a hand-written copy for now; when
 * the poller lands these should move into a shared workspace package.
 */

export type FeedEventType = "NEW_POSITION" | "EXITED" | "SIZE_UP" | "SIZE_DOWN"

export interface FeedEvent {
  id: string
  accountId: string
  accountName: string
  type: FeedEventType
  symbol: string
  instrumentName: string
  /** Position size as % of that friend's portfolio — never rupee amounts. */
  pctOfPortfolio: number
  /** For SIZE_UP/SIZE_DOWN: relative change in quantity, e.g. 0.25 = +25%. */
  qtyChangePct?: number
  detectedAt: string
}

export interface Member {
  id: string
  name: string
  visibility: "named" | "anonymous" | "paused"
}

/**
 * Which feed is on screen. Modelled as a value (not a boolean) so swapping
 * local state for a router later is a one-line change in App.
 */
export type FeedView = { kind: "group" } | { kind: "member"; memberId: string }

export const GROUP_VIEW: FeedView = { kind: "group" }
