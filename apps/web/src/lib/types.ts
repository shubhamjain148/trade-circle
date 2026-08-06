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
 * One member's stake in an instrument, as the group is allowed to see it.
 *
 * `memberId` is null when the holder is anonymous, and the UI depends on that:
 * a named holder's row links to their page, an anonymous one is plain text. The
 * client never has to decide who may be linked — the server already did.
 */
export interface StatsHolder {
  memberId: string | null
  /** Their name, or ANONYMOUS_NAME. */
  name: string
  anonymous: boolean
  /** Their weight in their *own* portfolio. Never a share of anything else. */
  pctOfPortfolio: number
}

/** One instrument, and who in the group holds it. */
export interface GroupInstrument {
  instrumentId: string
  symbol: string
  name: string
  holderCount: number
  /** Sum of each holder's weight in their own portfolio. Not a group total. */
  totalWeight: number
  /** Mean of the same — "3 of 4, about 12% each". */
  averageWeight: number
  /** Heaviest conviction first. */
  holders: StatsHolder[]
}

/** How much of one member's portfolio sits in their biggest few positions. */
export interface MemberConcentration {
  memberId: string | null
  name: string
  anonymous: boolean
  positionCount: number
  /** Share of their portfolio in their three largest positions. */
  topThreeWeight: number
  largest: { symbol: string; name: string; pctOfPortfolio: number }
}

/**
 * GET /api/group/stats — the group read across itself.
 *
 * The same boundary Holding draws, one step further out: every number here is a
 * percentage of somebody's own portfolio, which says nothing about how large
 * that portfolio is. Paused members are absent entirely, exactly as they are
 * from the feed; anonymous ones are present and unnamed.
 */
export interface GroupStats {
  /** Members the group can see at all. Paused members are not counted. */
  visibleMembers: number
  /** How many of those have any positions on file. */
  portfolios: number
  /** Newest reading across every counted row, or null when there are none. */
  asOf: string | null
  /** Held by two or more, most-held first. */
  overlaps: GroupInstrument[]
  /** Held by exactly one — the conversation starters. */
  solo: GroupInstrument[]
  /** Highest summed weight in the group. May be a solo pick. */
  favorite: GroupInstrument | null
  /** Every visible portfolio, most concentrated first. */
  concentration: MemberConcentration[]
}

/**
 * One reading in a holding's weight-over-time series. Short keys because the
 * shape repeats ~30 times per instrument for a whole portfolio — see
 * HoldingHistoryPoint in apps/server/src/types.ts.
 */
export interface HoldingHistoryPoint {
  /** The UTC day this reading is from, "YYYY-MM-DD". */
  d: string
  /** Weight on that day as % of portfolio, 2dp. Never an amount. */
  pct: number
}

/**
 * One instrument's weight over the window — the sparkline behind a holdings row.
 *
 * Points start on the day the instrument first appears and run to the end of the
 * window; a day inside that span where it was absent is an explicit 0.
 */
export interface HoldingHistory {
  /** Joins to Holding.instrumentId. */
  instrumentId: string
  points: HoldingHistoryPoint[]
  /**
   * The day the position appeared, when the watcher saw it appear. null when it
   * was already held on the oldest day on file — its true age is unknown, and
   * the panel says nothing rather than guessing.
   */
  openedAt: string | null
}

/**
 * GET /api/members/:id/positions/history — every sparkline in one read.
 *
 * `days` is the shared x-axis: every day the watcher has a pass for, oldest
 * first. Series are drawn against it, not against their own length, so a
 * three-week-old position occupies three weeks of the width.
 */
export interface HoldingsHistory {
  days: string[]
  series: HoldingHistory[]
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

/** What a reaction can be attached to: either half of the merged timeline. */
export type ReactionItemKind = "message" | "event"

/**
 * The curated set, mirroring REACTION_EMOJI in apps/server/src/chat.ts — the
 * server rejects anything else, so this list and that one have to agree.
 *
 * Order is render order in the quick-react row, and it is deliberate: the two
 * this group reaches for most sit under the left thumb.
 */
export const REACTION_EMOJI = [
  "🚀",
  "🔥",
  "😂",
  "👀",
  "💎",
  "🧠",
  "📉",
  "💀",
] as const

/**
 * One emoji's standing on one timeline item. `who` is names, always: visibility
 * governs what the watcher publishes about a portfolio, not who is speaking —
 * and a reaction is speech.
 */
export interface ReactionSummary {
  emoji: string
  count: number
  /** True when you are one of the reactors. Decided per reader, server-side. */
  mine: boolean
  /** Reactor names, oldest tap first. */
  who: string[]
}

/**
 * Reactions for a set of items, keyed by reactionKey() below. A present-but-
 * empty array is the signal that an item's last reaction just went away, so it
 * must be applied, not skipped.
 */
export type ReactionMap = Record<string, ReactionSummary[]>

/** Mirrors reactionKey() in apps/server/src/chat.ts. The two must agree. */
export const reactionKey = (kind: ReactionItemKind, id: string) =>
  `${kind}:${id}`

/** PUT/DELETE /api/chat/reactions — the touched item's whole new summary. */
export interface ReactionUpdate {
  itemKind: ReactionItemKind
  itemId: string
  reactions: ReactionSummary[]
}

/**
 * GET /api/chat — oldest first, unlike /api/feed, because the composer sits at
 * the bottom of it. `cursor` is the ordering key of the last item; hand it back
 * as ?after= and an idle poll costs one empty page.
 *
 * `reactions` covers every item on this page *plus* every older item whose
 * reactions changed since `?reactedAfter=` — which is how a poll that has long
 * since scrolled past a message still hears that someone put a 🚀 on it. Hand
 * `reactionCursor` back as `?reactedAfter=` next time.
 */
export interface ChatPage {
  items: TimelineItem[]
  cursor: string
  reactions: ReactionMap
  reactionCursor: string
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
  /**
   * Whole summaries for the items whose reactions just changed — the same shape
   * the poll's `reactions` carries, so both go through one merge. `mine` is
   * already resolved for this socket's member by the room.
   */
  | { type: "reactions"; reactions: ReactionMap }

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
  | { kind: "stats" }
  | { kind: "join"; token: string | null }
  | { kind: "settings"; connected: boolean; connectError: string | null }
