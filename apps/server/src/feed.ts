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
    if (!member || member.visibility === "paused") continue;
    events.push({
      id: row.id,
      accountId: member.id,
      accountName: member.visibility === "anonymous" ? ANONYMOUS_NAME : member.name,
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
