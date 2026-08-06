import { rmSync } from "node:fs";
import type { Position } from "./domain.js";
import { MockPortfolioSource } from "./poller/source.js";
import { runPollTick, toStoredPosition } from "./poller/tick.js";
import { createStorage, defaultDbPath } from "./storage/index.js";

// Replaces the old src/mock.ts: instead of hand-written response bodies, drive
// the real diff engine over a scripted portfolio history so the web app sees
// data that came out of the same code path production will use.

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
// not emit six "new position" events for pre-existing holdings.
const frames: Record<string, Position[][]> = {
  "a-m1": [
    [p(...NVDA, 10, 780, 900), p(...AAPL, 20, 190, 214)],
    [p(...NVDA, 10, 780, 905), p(...AAPL, 20, 190, 216)],
    [p(...NVDA, 14, 812, 910), p(...AAPL, 20, 190, 215)],
    // 4:1 NVDA split, same tick as Rahul's — H2 should suppress both.
    [p(...NVDA, 56, 203, 227.5), p(...AAPL, 20, 190, 215)],
    // 2:1 AAPL split held by Shubham alone — only H1 can catch this one.
    [p(...NVDA, 56, 203, 228), p(...AAPL, 40, 95, 107.5)],
    [p(...NVDA, 56, 203, 231), p(...AAPL, 40, 95, 108), p(...GOOGL, 12, 168, 175)],
  ],
  "a-m2": [
    [p(...NVDA, 5, 640, 900), p(...TSLA, 8, 240, 262)],
    [p(...NVDA, 5, 640, 905), p(...TSLA, 8, 240, 258), p(...AMZN, 4, 186, 191)],
    [p(...NVDA, 5, 640, 910), p(...AMZN, 4, 186, 194)],
    [p(...NVDA, 20, 160, 227.5), p(...AMZN, 4, 186, 193)],
    [p(...NVDA, 20, 160, 228), p(...AMZN, 4, 186, 196)],
    [p(...NVDA, 20, 160, 231), p(...AMZN, 7, 190, 198)],
  ],
  "a-m3": [
    [p(...MSFT, 12, 402, 431), p(...AAPL, 15, 188, 214)],
    [p(...MSFT, 12, 402, 428), p(...AAPL, 20, 194, 216)],
    [p(...MSFT, 12, 402, 435), p(...AAPL, 20, 194, 215)],
    [p(...MSFT, 12, 402, 433), p(...AAPL, 20, 194, 215)],
    [p(...MSFT, 9, 402, 436), p(...AAPL, 20, 194, 215)],
    [p(...MSFT, 9, 402, 439), p(...AAPL, 20, 194, 216)],
  ],
};

// m1 is the admin: someone has to be able to hand out the first invite from
// the UI, and a seeded group with no admin can only be fixed from a shell.
const members = [
  { id: "m1", name: "Shubham", visibility: "named" as const, role: "admin" as const },
  { id: "m2", name: "Rahul", visibility: "named" as const, role: "member" as const },
  { id: "m3", name: "Anjali", visibility: "named" as const, role: "member" as const },
];

const DAY_MS = 86_400_000;

/** The last frame lands now; earlier frames one day apart before it. */
function tickTime(index: number, total: number): Date {
  return new Date(Date.now() - (total - 1 - index) * DAY_MS);
}

/**
 * membersOnly: create members + accounts but no fake portfolio history — the
 * right starting point before connecting real INDmoney accounts, where demo
 * positions would otherwise diff against real holdings as a storm of events.
 */
export async function seed(
  dbPath = defaultDbPath,
  membersOnly = process.argv.includes("--members-only"),
): Promise<void> {
  if (dbPath !== ":memory:") {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  }

  const storage = await createStorage(dbPath);
  const source = new MockPortfolioSource(frames);
  const total = source.length;
  const createdAt = tickTime(0, total).toISOString();

  for (const m of members) {
    await storage.upsertMember({ ...m, createdAt });
    await storage.upsertAccount({
      id: `a-${m.id}`,
      memberId: m.id,
      provider: "indmoney",
      status: "active",
      lastPolledAt: null,
    });
  }

  if (membersOnly) {
    await storage.close();
    console.log(`seeded ${dbPath}: ${members.length} members, no demo history`);
    return;
  }

  // Baseline, no events.
  const baselineAt = tickTime(0, total).toISOString();
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

  await storage.close();
  console.log(
    `seeded ${dbPath}: ${members.length} members, ${events} events, ${suppressed} suppressed`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await seed();
}
