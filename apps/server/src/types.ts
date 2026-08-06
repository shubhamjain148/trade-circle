export type FeedEventType =
  | "NEW_POSITION"
  | "EXITED"
  | "SIZE_UP"
  | "SIZE_DOWN";

export interface FeedEvent {
  id: string;
  accountId: string;
  accountName: string;
  type: FeedEventType;
  symbol: string;
  instrumentName: string;
  /** Position size as % of that friend's portfolio — never rupee amounts. */
  pctOfPortfolio: number;
  /** For SIZE_UP/SIZE_DOWN: relative change in quantity, e.g. 0.25 = +25%. */
  qtyChangePct?: number;
  detectedAt: string;
}

/**
 * One line of GET /api/members/:id/positions — what someone holds right now,
 * as opposed to what they did (FeedEvent).
 *
 * Weight and identity only. The stored row this is projected from carries qty,
 * avg cost and market value; none of them may ever appear here. A holdings
 * panel is the most tempting place in the product to leak a portfolio's size,
 * which is why the projection is hand-written in src/positions.ts and pinned
 * by a test.
 */
export interface Holding {
  /** INDmoney's internal key — stable across ticker renames. */
  instrumentId: string;
  symbol: string;
  name: string;
  /** Position size as % of that friend's portfolio — never rupee amounts. */
  pctOfPortfolio: number;
  /** When the last poll wrote this row. */
  updatedAt: string;
}

/**
 * One member's stake in an instrument, as the group is allowed to see it.
 *
 * `memberId` is null for an anonymous holder and that is the whole point: the
 * feed already publishes an id alongside "Someone in the group", but an overlap
 * row is a much smaller haystack — three holders, one unnamed — and an id there
 * would be a link straight to the page that names them.
 */
export interface StatsHolder {
  memberId: string | null;
  /** Their name, or ANONYMOUS_NAME. */
  name: string;
  anonymous: boolean;
  /** Their weight in their *own* portfolio — never a share of anything else. */
  pctOfPortfolio: number;
}

/** One instrument, and who in the group holds it. */
export interface GroupInstrument {
  instrumentId: string;
  symbol: string;
  name: string;
  holderCount: number;
  /** Sum of each holder's weight in their own portfolio. Not a group total. */
  totalWeight: number;
  /** Mean of the same — "3 of 4, about 12% each". */
  averageWeight: number;
  /** Heaviest conviction first. */
  holders: StatsHolder[];
}

/** How much of one member's portfolio sits in their biggest few positions. */
export interface MemberConcentration {
  memberId: string | null;
  name: string;
  anonymous: boolean;
  positionCount: number;
  /** Share of their portfolio in their three largest positions. */
  topThreeWeight: number;
  /**
   * Their single largest holding, so the number has a subject. Always present:
   * a portfolio with no positions is not a row in this list at all.
   */
  largest: { symbol: string; name: string; pctOfPortfolio: number };
}

/**
 * GET /api/group/stats — the group read across itself.
 *
 * Same privacy boundary as Holding, one step further out: these numbers are
 * built from `positions_current`, whose rows carry qty, average cost and market
 * value, and none of the three may appear here in any form — not summed, not
 * ranked, not implied. Every number below is a percentage of somebody's own
 * portfolio, which says nothing about how large that portfolio is.
 */
export interface GroupStats {
  /** Members the group can see at all. Paused members are not counted. */
  visibleMembers: number;
  /** How many of those have any positions on file. */
  portfolios: number;
  /** Newest `updatedAt` across every counted row, or null when there are none. */
  asOf: string | null;
  /** Held by two or more, most-held first. */
  overlaps: GroupInstrument[];
  /** Held by exactly one — the conversation starters. */
  solo: GroupInstrument[];
  /** Highest summed weight in the group. May be a solo pick. */
  favorite: GroupInstrument | null;
  /** Every visible portfolio, most concentrated first. */
  concentration: MemberConcentration[];
}

/**
 * One reading in a holding's weight-over-time series.
 *
 * Short keys because this shape repeats ~30 times per instrument per response
 * and the panel fetches it for a whole portfolio: `{"d":"2026-08-06","pct":41.5}`
 * is half the bytes of the spelled-out version for a payload nobody reads by eye.
 */
export interface HoldingHistoryPoint {
  /** The UTC day this reading is from, "YYYY-MM-DD". */
  d: string;
  /** Weight on that day as % of portfolio, 2dp. Never an amount. */
  pct: number;
}

/**
 * One instrument's weight over the history window — the sparkline behind a
 * holdings row.
 *
 * Points begin at the day the instrument first appears and run to the end of
 * the window; a day inside that span where the instrument was absent is an
 * explicit 0, so an exit-and-re-entry draws as a dip rather than as a gap.
 *
 * Same privacy boundary as Holding, for the same reason and one more: a series
 * of market values over thirty days would let a reader recover both the size of
 * a portfolio and its P&L. Weights only, computed per snapshot exactly as the
 * poller computes them (diff/index.ts `pctOfPortfolio`).
 */
export interface HoldingHistory {
  /** Joins to Holding.instrumentId. No symbol or name — the panel already has both. */
  instrumentId: string;
  points: HoldingHistoryPoint[];
  /**
   * The day the position appeared, when the watcher actually saw it appear —
   * i.e. it was absent on an earlier day inside the window. null when it was
   * already held on the oldest day we have, because then "since" is unknown and
   * "held 30 days" would be a guess dressed as a fact.
   */
  openedAt: string | null;
}

/**
 * GET /api/members/:id/positions/history — the whole panel's series in one read.
 *
 * `days` is the window's shared x-axis: every UTC day the watcher has a pass
 * for, oldest first. Series are positioned against it rather than against their
 * own point count, so a three-week-old position draws as three weeks of line
 * next to a neighbour's full month instead of being stretched to match it.
 */
export interface HoldingsHistory {
  days: string[];
  series: HoldingHistory[];
}

export interface Member {
  id: string;
  name: string;
  visibility: "named" | "anonymous" | "paused";
  /** "admin" unlocks the group roster and invites; it grants no extra sight. */
  role: "admin" | "member";
}

/**
 * One row of the admin roster. Deliberately the same facts an admin would read
 * off /api/accounts plus whether a link is outstanding — no holdings, no
 * positions, nothing the feed wouldn't already show them.
 */
export interface AdminMember {
  id: string;
  name: string;
  role: "admin" | "member";
  visibility: "named" | "anonymous" | "paused";
  connected: boolean;
  /** Account/connection state, or "not_connected" before the first grant. */
  status: string;
  lastPolledAt: string | null;
  /** "pending" — a link is out there unspent. "used" — they came in through one. */
  invite: { status: "pending" | "used"; at: string } | null;
}

/**
 * One line of group chat. Always attributed by name: visibility is a dial on
 * what the *watcher* publishes about your portfolio, not on your own speech —
 * an anonymous chat in a five-person WhatsApp replacement is just confusing.
 */
export interface ChatMessage {
  id: string;
  memberId: string;
  authorName: string;
  body: string;
  createdAt: string;
}

/** The group timeline is one list: what people said and what people did. */
export type TimelineItem =
  | ({ kind: "message" } & ChatMessage)
  | ({ kind: "event" } & FeedEvent);

/**
 * One emoji's standing on one timeline item.
 *
 * `who` carries names, always, and that is the same rule chat already follows:
 * visibility is a dial on what the *watcher* publishes about your portfolio,
 * not on your own speech — and a reaction is speech. An anonymous member's
 * trade loses their name; their 🚀 does not.
 */
export interface ReactionSummary {
  emoji: string;
  count: number;
  /** True when the signed-in member is one of the reactors. */
  mine: boolean;
  /** Reactor names, oldest tap first. */
  who: string[];
}

/**
 * Reactions for a set of items, keyed "<kind>:<id>" — see reactionKey() in
 * src/chat.ts, which both sides of the wire use to build and read it.
 *
 * An entry that is present but empty is meaningful and must not be pruned: it
 * is how "the last reaction was just removed" reaches a client whose pills are
 * still on screen.
 */
export type ReactionMap = Record<string, ReactionSummary[]>;

/**
 * `cursor` is the ordering key of the newest item on the page ("<iso>|<id>").
 * Hand it back as ?after= and the next read is just the tail — an idle poll
 * returns `items: []` and the same cursor.
 *
 * `reactions` and `reactionCursor` are additive: a client that has never heard
 * of them reads exactly the page it always read. `reactions` covers every item
 * on this page plus every *older* item whose reactions have changed since
 * `?reactedAfter=` — the cursor poll's only way of learning that someone put a
 * 🚀 on a message it stopped asking about an hour ago. Hand `reactionCursor`
 * back as `?reactedAfter=` on the next poll.
 */
export interface ChatPage {
  items: TimelineItem[];
  cursor: string;
  reactions: ReactionMap;
  /** ISO timestamp; "" when nothing in the group has ever been reacted to. */
  reactionCursor: string;
}

/**
 * PUT/DELETE /api/chat/reactions — the one item the toggle touched, with its
 * whole recomputed summary. Never a diff: the client replaces its entry, which
 * is the same operation a poll and a socket frame perform.
 */
export interface ReactionUpdate {
  itemKind: "message" | "event";
  itemId: string;
  reactions: ReactionSummary[];
}
