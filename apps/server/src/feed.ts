import type { AccountRow, FeedEventRow, MemberRow } from "./domain.js";
import type { FeedEvent } from "./types.js";

/**
 * Row → wire projection for the feed, and the one place visibility is applied:
 * paused members are dropped entirely, anonymous ones lose their name. Shared
 * so /api/feed and /api/chat can never drift on who is allowed to be seen.
 */
/**
 * What an anonymous member is called on the wire. Exported because the push
 * notifier has to recognise it: a notification for an anonymous move carries no
 * name and no deep link, and this string is the only signal the projection
 * leaves behind that a member chose to be unnamed.
 */
export const ANONYMOUS_NAME = "Someone in the group";

/** How the group is allowed to see one member, once visibility has been applied. */
export interface VisibleMember {
  id: string;
  /** Their name, or ANONYMOUS_NAME. Never both, never the real one when hidden. */
  name: string;
  anonymous: boolean;
}

/**
 * The visibility rule itself, lifted out of `toFeedEvents` so anything else that
 * publishes per-member facts (see src/stats.ts) applies the same one rather than
 * writing its own `visibility === "paused"` check that can drift.
 *
 * `undefined` means "held back entirely" — a paused member is not a member with
 * a blank name, they are absent, and every caller has to handle that as absence.
 */
export function visibleAs(member: MemberRow): VisibleMember | undefined {
  if (member.visibility === "paused") return undefined;
  const anonymous = member.visibility === "anonymous";
  return { id: member.id, name: anonymous ? ANONYMOUS_NAME : member.name, anonymous };
}

export function toFeedEvents(
  rows: FeedEventRow[],
  members: MemberRow[],
  accounts: AccountRow[],
  filter?: string,
): FeedEvent[] {
  const memberById = new Map(members.map((m) => [m.id, m]));
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const wanted = filter ? resolveAccountIds(filter, accounts) : null;

  const events: FeedEvent[] = [];
  for (const row of rows) {
    if (wanted && !wanted.has(row.accountId)) continue;
    const account = accountById.get(row.accountId);
    const member = account && memberById.get(account.memberId);
    const visible = member && visibleAs(member);
    if (!visible) continue;
    events.push({
      id: row.id,
      accountId: visible.id,
      accountName: visible.name,
      type: row.type,
      symbol: row.symbol,
      instrumentName: row.instrumentName,
      pctOfPortfolio: row.pctOfPortfolio,
      ...(row.qtyChangePct === null ? {} : { qtyChangePct: row.qtyChangePct }),
      detectedAt: row.detectedAt,
    });
  }
  return events;
}

/** ?accountId= accepts a member id or an account id — friends only know the former. */
export function resolveAccountIds(
  filter: string,
  accounts: AccountRow[],
): Set<string> {
  const direct = accounts.filter((a) => a.id === filter);
  const byMember = accounts.filter((a) => a.memberId === filter);
  return new Set((direct.length ? direct : byMember).map((a) => a.id));
}
