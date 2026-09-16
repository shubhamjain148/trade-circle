import { hashToken, randomToken } from "./auth/vault.js";
import type { Position } from "./domain.js";
import { MockPortfolioSource } from "./poller/source.js";
import { runPollTick, toStoredPosition } from "./poller/tick.js";
import type { Storage } from "./storage/index.js";

/**
 * The Workers-side equivalent of `pnpm seed`. src/seed.ts cannot be reused
 * verbatim: it opens a SQLite file by path and `rmSync`s it first, neither of
 * which exists on Workers. This drives the same code path — MockPortfolioSource
 * through the real diff engine — against whatever Storage it is handed, so the
 * data a local `wrangler dev` shows came out of the production pipeline.
 *
 * Reached only through POST /api/dev-seed with DEV_SEED=1 in the environment.
 * It also mints one invite link per member, because there is no CLI on Workers
 * to run src/invite.ts with.
 */

function p(
  instrumentId: string,
  symbol: string,
  name: string,
  qty: number,
  avgCost: number,
  price: number,
): Position {
  return { instrumentId, symbol, name, qty, avgCost, mktValue: qty * price };
}

const NVDA = ["us_nvda", "NVDA", "NVIDIA Corp"] as const;
const AAPL = ["us_aapl", "AAPL", "Apple Inc"] as const;
const TSLA = ["us_tsla", "TSLA", "Tesla Inc"] as const;
const MSFT = ["us_msft", "MSFT", "Microsoft Corp"] as const;
const AMZN = ["us_amzn", "AMZN", "Amazon.com Inc"] as const;
const GOOGL = ["us_googl", "GOOGL", "Alphabet Inc"] as const;

// Frame 0 is the baseline — written straight to storage so the first tick does
// not emit a storm of "new position" events for pre-existing holdings.
const frames: Record<string, Position[][]> = {
  "a-m1": [
    [p(...NVDA, 10, 780, 900), p(...AAPL, 20, 190, 214)],
    [p(...NVDA, 14, 812, 910), p(...AAPL, 20, 190, 215)],
    // 4:1 NVDA split, same tick as Rahul's — H2 should suppress both.
    [p(...NVDA, 56, 203, 227.5), p(...AAPL, 20, 190, 215)],
    [p(...NVDA, 56, 203, 231), p(...AAPL, 40, 95, 108), p(...GOOGL, 12, 168, 175)],
  ],
  "a-m2": [
    [p(...NVDA, 5, 640, 900), p(...TSLA, 8, 240, 262)],
    [p(...NVDA, 5, 640, 910), p(...AMZN, 4, 186, 194)],
    [p(...NVDA, 20, 160, 227.5), p(...AMZN, 4, 186, 193)],
    [p(...NVDA, 20, 160, 231), p(...AMZN, 7, 190, 198)],
  ],
  "a-m3": [
    [p(...MSFT, 12, 402, 431), p(...AAPL, 15, 188, 214)],
    [p(...MSFT, 12, 402, 435), p(...AAPL, 20, 194, 215)],
    [p(...MSFT, 9, 402, 436), p(...AAPL, 20, 194, 215)],
    [p(...MSFT, 9, 402, 439), p(...AAPL, 20, 194, 216)],
  ],
};

const members = [
  { id: "m1", name: "Priya", visibility: "named" as const, role: "admin" as const },
  { id: "m2", name: "Rahul", visibility: "named" as const, role: "member" as const },
  { id: "m3", name: "Anjali", visibility: "named" as const, role: "member" as const },
];

const DAY_MS = 86_400_000;

export interface SeedResult {
  members: number;
  events: number;
  suppressed: number;
  /** Plaintext, shown once — only the hash reaches the database. */
  invites: { memberId: string; name: string; token: string }[];
}

/** The last frame lands now; earlier frames one day apart before it. */
function tickTime(index: number, total: number): Date {
  return new Date(Date.now() - (total - 1 - index) * DAY_MS);
}

export async function seedStorage(
  storage: Storage,
  options: { membersOnly?: boolean } = {},
): Promise<SeedResult> {
  const source = new MockPortfolioSource(frames);
  const total = source.length;
  const createdAt = tickTime(0, total).toISOString();
  const invites: SeedResult["invites"] = [];

  for (const m of members) {
    await storage.upsertMember({ ...m, createdAt });
    await storage.upsertAccount({
      id: `a-${m.id}`,
      memberId: m.id,
      provider: "indmoney",
      status: "active",
      lastPolledAt: null,
    });
    const token = randomToken();
    await storage.createInvite({
      tokenHash: hashToken(token),
      memberId: m.id,
      createdAt,
      usedAt: null,
    });
    invites.push({ memberId: m.id, name: m.name, token });
  }

  if (options.membersOnly) {
    return { members: members.length, events: 0, suppressed: 0, invites };
  }

  const baselineAt = createdAt;
  for (const [accountId, accountFrames] of Object.entries(frames)) {
    const holdings = accountFrames[0];
    await storage.saveSnapshot(accountId, baselineAt, holdings);
    await storage.replaceCurrentPositions(
      accountId,
      holdings.map((h) => toStoredPosition(accountId, h, holdings, baselineAt)),
    );
    await storage.markPolled(accountId, baselineAt);
  }

  let events = 0;
  let suppressed = 0;
  while (source.advance()) {
    const result = await runPollTick(storage, source, {
      now: tickTime(source.step, total),
    });
    events += result.events;
    suppressed += result.suppressed;
  }

  return { members: members.length, events, suppressed, invites };
}
