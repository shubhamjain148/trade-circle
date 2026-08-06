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
 * GET /api/members/:id/positions — one line of what someone holds right now,
 * as opposed to what they did (FeedEvent). Sorted largest first by the server.
 *
 * Weight and identity only, and that is a boundary rather than a convenience:
 * the server's stored row carries quantity, average cost and market value, and
 * none of the three may ever appear here.
 */
export interface Holding {
  /** INDmoney's internal key — stable across ticker renames. */
  instrumentId: string
  symbol: string
  name: string
  /** Position size as % of that friend's portfolio — never rupee amounts. */
  pctOfPortfolio: number
  /** When the last poll wrote this row. */
  updatedAt: string
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

/**
 * Frames on /api/chat/ws. Mirrors RoomServerMessage/RoomClientMessage in
 * apps/server/src/room.ts.
 *
 * "items" carries exactly what a poll would have carried, which is the whole
 * trick: the socket is a delivery mechanism, not a second protocol, so the
 * client merges it through the same reconcile path and dedupes by id.
 */
export type RoomServerMessage =
  | { type: "items"; items: TimelineItem[] }
  /** Ephemeral, never stored, never echoed back to its own author. */
  | { type: "typing"; memberId: string; name: string }

/** The only thing the browser sends up the socket. Messages still go by POST. */
export type RoomClientMessage = { type: "typing" }

export type Visibility = "named" | "anonymous" | "paused"

/**
 * "admin" unlocks the group roster and invites in Settings. It grants no extra
 * sight of anyone's holdings — the feed treats every member identically.
 */
export type MemberRole = "admin" | "member"

export interface Member {
  id: string
  name: string
  visibility: Visibility
  role: MemberRole
}

/**
 * GET /api/admin/members — one row of the roster. `status` is the server's
 * account/connection state and may carry values the feed never renders, so it
 * is a plain string here and is narrowed by rosterKey() in lib/account.ts.
 */
export interface AdminMember {
  id: string
  name: string
  role: MemberRole
  visibility: Visibility
  connected: boolean
  status: string
  lastPolledAt: string | null
  /** "pending" — a link is out there unspent. "used" — they came in through one. */
  invite: { status: "pending" | "used"; at: string } | null
}

/**
 * POST /api/poll — what one manual tick did. Mirrors TickResult on the server.
 * Counts only: the admin control reports a shape of work, not a portfolio.
 */
export interface PollResult {
  at: string
  polled: string[]
  /** The cheap probe said nothing had moved. */
  unchanged: string[]
  /** Backed off, or not in a state the poller touches. */
  skipped: string[]
  errors: { accountId: string; message: string }[]
  events: number
  suppressed: number
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

/**
 * POST /api/auth/session — the invite handshake returns just the member.
 * `device` is set only when the token was a device link rather than an invite:
 * same handshake, same shape, different sentence on the other side ("device
 * linked" rather than "you're in", and no push to connect INDmoney).
 */
export interface SessionResponse {
  member: Member
  device?: boolean
}

/**
 * POST /api/auth/device-link — the link exists in this response and nowhere
 * else. The server stored a hash; nothing can hand the URL back a second time.
 */
export interface DeviceLink {
  url: string
  expiresAt: string
  ttlMs: number
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
