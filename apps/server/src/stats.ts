import { Hono } from "hono";
import { requireSession, type SessionEnv } from "./auth/session.js";
import type { AccountRow, MemberRow, StoredPosition } from "./domain.js";
import { visibleAs, type VisibleMember } from "./feed.js";
import type { Storage } from "./storage/index.js";
import type {
  GroupInstrument,
  GroupStats,
  MemberConcentration,
  StatsHolder,
} from "./types.js";

export interface StatsDeps {
  storage: Storage;
}

/**
 * The group read across itself — what two people both hold, who is betting the
 * farm on one name, what nobody else has touched.
 *
 * Three reads, one per table, and the arithmetic happens here. It is deliberately
 * not SQL: the visibility rule lives in src/feed.ts as `visibleAs`, and a GROUP BY
 * that filtered on `visibility <> 'paused'` would be a second copy of that rule in
 * a language where nobody would think to look for it.
 *
 * The privacy boundary is the same one src/positions.ts draws, and it is under
 * more pressure here: `positions_current` carries qty, avg cost and market value,
 * and a stats page is exactly where someone would reach for "biggest portfolio".
 * Nothing in this file reads those three columns. Every number it publishes is a
 * percentage of the holder's own portfolio, which is a fact about a shape rather
 * than a size — and a test asserts the response bytes contain none of the others.
 */
export function createStatsApp({ storage }: StatsDeps): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();

  app.use("/api/group/stats", requireSession(storage));

  app.get("/api/group/stats", async (c) => {
    const [members, accounts, positions] = await Promise.all([
      storage.listMembers(),
      storage.listAccounts(),
      storage.listCurrentPositions(),
    ]);
    return c.json(computeGroupStats(members, accounts, positions));
  });

  return app;
}

/** How many positions "concentration" is measured over. */
const TOP_N = 3;

/**
 * Pure, and exported for the tests: everything interesting about this feature is
 * arithmetic over three lists, and none of it needs a request to be checked.
 */
export function computeGroupStats(
  members: MemberRow[],
  accounts: AccountRow[],
  positions: StoredPosition[],
): GroupStats {
  const memberById = new Map(members.map((m) => [m.id, m]));

  // account id → how the group may see its owner. An account whose member is
  // paused (or missing) simply never enters the map, so its positions are
  // dropped by the same lookup that names everyone else — there is no second
  // place where "paused" has to be remembered.
  const visibleByAccount = new Map<string, VisibleMember>();
  for (const account of accounts) {
    const member = memberById.get(account.memberId);
    const visible = member && visibleAs(member);
    if (visible) visibleByAccount.set(account.id, visible);
  }

  const byAccount = new Map<string, StoredPosition[]>();
  let asOf: string | null = null;
  for (const position of positions) {
    if (!visibleByAccount.has(position.accountId)) continue;
    const bucket = byAccount.get(position.accountId);
    if (bucket) bucket.push(position);
    else byAccount.set(position.accountId, [position]);
    if (!asOf || position.updatedAt > asOf) asOf = position.updatedAt;
  }

  const instruments = groupByInstrument(byAccount, visibleByAccount);

  const overlaps = instruments
    .filter((i) => i.holderCount > 1)
    .sort(byOverlap);
  const solo = instruments.filter((i) => i.holderCount === 1).sort(byWeightThenSymbol);
  const favorite = instruments.length
    ? [...instruments].sort(byWeightThenSymbol)[0]
    : null;

  return {
    // Every member the group can see, whether or not they have holdings — "held
    // by 3 of 4" has to count the friend who hasn't connected yet, or the
    // fraction quietly redefines itself as more people join.
    visibleMembers: countVisible(members),
    portfolios: byAccount.size,
    asOf,
    overlaps,
    solo,
    favorite,
    concentration: concentrations(byAccount, visibleByAccount),
  };
}

function countVisible(members: MemberRow[]): number {
  return members.reduce((n, m) => (visibleAs(m) ? n + 1 : n), 0);
}

function groupByInstrument(
  byAccount: Map<string, StoredPosition[]>,
  visibleByAccount: Map<string, VisibleMember>,
): GroupInstrument[] {
  const acc = new Map<string, GroupInstrument>();

  for (const [accountId, held] of byAccount) {
    const holder = visibleByAccount.get(accountId);
    if (!holder) continue;
    for (const position of held) {
      const existing = acc.get(position.instrumentId);
      const entry = existing ?? {
        instrumentId: position.instrumentId,
        symbol: position.symbol,
        name: position.name,
        holderCount: 0,
        totalWeight: 0,
        averageWeight: 0,
        holders: [],
      };
      entry.holderCount += 1;
      entry.totalWeight += position.pctOfPortfolio;
      entry.holders.push(toStatsHolder(holder, position.pctOfPortfolio));
      if (!existing) acc.set(position.instrumentId, entry);
    }
  }

  for (const entry of acc.values()) {
    entry.holders.sort(byHolderWeight);
    entry.averageWeight = round1(entry.totalWeight / entry.holderCount);
    entry.totalWeight = round1(entry.totalWeight);
  }

  return [...acc.values()];
}

function concentrations(
  byAccount: Map<string, StoredPosition[]>,
  visibleByAccount: Map<string, VisibleMember>,
): MemberConcentration[] {
  const rows: MemberConcentration[] = [];

  for (const [accountId, held] of byAccount) {
    const member = visibleByAccount.get(accountId);
    if (!member || held.length === 0) continue;
    const ranked = [...held].sort(
      (a, b) => b.pctOfPortfolio - a.pctOfPortfolio || compare(a.symbol, b.symbol),
    );
    const largest = ranked[0];
    rows.push({
      memberId: member.anonymous ? null : member.id,
      name: member.name,
      anonymous: member.anonymous,
      positionCount: ranked.length,
      topThreeWeight: round1(
        ranked.slice(0, TOP_N).reduce((sum, p) => sum + p.pctOfPortfolio, 0),
      ),
      largest: {
        symbol: largest.symbol,
        name: largest.name,
        pctOfPortfolio: largest.pctOfPortfolio,
      },
    });
  }

  return rows.sort(
    (a, b) => b.topThreeWeight - a.topThreeWeight || compare(a.name, b.name),
  );
}

/**
 * Field by field, never a spread — the same rule src/positions.ts states, for
 * the same reason: the row on the other side of this function carries amounts.
 */
function toStatsHolder(member: VisibleMember, pctOfPortfolio: number): StatsHolder {
  return {
    memberId: member.anonymous ? null : member.id,
    name: member.name,
    anonymous: member.anonymous,
    pctOfPortfolio,
  };
}

/** Most-held first; conviction, then symbol, break the ties so order is stable. */
function byOverlap(a: GroupInstrument, b: GroupInstrument): number {
  return b.holderCount - a.holderCount || byWeightThenSymbol(a, b);
}

function byWeightThenSymbol(a: GroupInstrument, b: GroupInstrument): number {
  return b.totalWeight - a.totalWeight || compare(a.symbol, b.symbol);
}

function byHolderWeight(a: StatsHolder, b: StatsHolder): number {
  return b.pctOfPortfolio - a.pctOfPortfolio || compare(a.name, b.name);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * One decimal, matching every other weight in the product. Summing floats is
 * how "61%" becomes "60.99999999999999" in a column that is meant to be scanned.
 */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
