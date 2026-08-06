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

/**
 * One line of group chat. Always attributed by name: visibility governs what
 * the watcher publishes about a portfolio, not what a friend says out loud.
 */
export interface ChatMessage {
  id: string
  memberId: string
  authorName: string
  body: string
  createdAt: string
}

/** The group view is one list: what people said and what people did. */
export type TimelineItem =
  | ({ kind: "message" } & ChatMessage)
  | ({ kind: "event" } & FeedEvent)

/**
 * GET /api/chat — oldest first, unlike /api/feed, because the composer sits at
 * the bottom of it. `cursor` is the ordering key of the last item; hand it back
 * as ?after= and an idle poll costs one empty page.
 */
export interface ChatPage {
  items: TimelineItem[]
  cursor: string
}

export type Visibility = "named" | "anonymous" | "paused"

export interface Member {
  id: string
  name: string
  visibility: Visibility
}

/**
 * The state of one member's INDmoney link. `connected` and `status` are
 * separate on purpose: a revoked account is still on file (we know its last
 * pass) but is no longer feeding the group.
 */
export type AccountStatus = "active" | "needs_reauth" | "revoked" | "pending"

export interface Account {
  connected: boolean
  status: AccountStatus
  /** ISO timestamp of the last successful poll, or null before the first one. */
  lastPolledAt: string | null
}

/** GET /api/me — `account` is null until the member connects INDmoney. */
export interface Me {
  member: Member
  account: Account | null
}

/** POST /api/auth/session — the invite handshake returns just the member. */
export interface SessionResponse {
  member: Member
}

/**
 * Which feed is on screen. Modelled as a value (not a boolean) so swapping
 * local state for a router later is a one-line change in App.
 */
export type FeedView = { kind: "group" } | { kind: "member"; memberId: string }

export const GROUP_VIEW: FeedView = { kind: "group" }

/**
 * The whole app in one value. Join and settings are peers of the feed rather
 * than a nested router: there are three screens, and a union keeps the
 * signed-out/signed-in branching in App readable.
 */
export type Route =
  | { kind: "feed"; view: FeedView }
  | { kind: "join"; token: string | null }
  | { kind: "settings"; connected: boolean; connectError: string | null }
