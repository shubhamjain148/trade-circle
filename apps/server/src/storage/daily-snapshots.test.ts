import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Position } from "../domain.js";
import { D1Storage } from "./d1.js";
import { createStorage, type Storage } from "./index.js";

/**
 * `listDailySnapshots` — the read behind the holdings sparkline — held to the
 * same behaviour on both drivers.
 *
 * Worth its own file because the thinning is done in SQL, which is the part
 * that would otherwise only ever be exercised through the HTTP route. Three
 * promises are made here and depended on by src/positions.ts: one row per UTC
 * day (the day's *last* pass), a hard cap that keeps the newest days, and
 * oldest-first output. A driver that quietly disagreed about any of them would
 * draw a subtly wrong chart rather than fail.
 *
 * The D1 half runs against migrations/*.sql through the same node:sqlite shim
 * d1.test.ts uses; D1 *is* SQLite, so the window function and the substr day
 * key really execute here.
 */

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
);

class ShimStatement {
  private params: unknown[] = [];
  constructor(private readonly stmt: StatementSync) {}

  bind(...params: unknown[]): ShimStatement {
    for (const p of params) {
      if (p === undefined) throw new TypeError("D1: undefined is not a bindable value");
    }
    const next = new ShimStatement(this.stmt);
    next.params = params;
    return next;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.stmt.all(...(this.params as never[])) as T[] };
  }

  async first<T>(): Promise<T | null> {
    return (this.stmt.get(...(this.params as never[])) as T | undefined) ?? null;
  }

  async run(): Promise<{ success: boolean }> {
    this.stmt.run(...(this.params as never[]));
    return { success: true };
  }
}

class ShimDatabase {
  constructor(private readonly db: DatabaseSync) {}
  prepare(sql: string): ShimStatement {
    return new ShimStatement(this.db.prepare(sql));
  }
}

const MEMBER = {
  id: "m1",
  name: "Shubham",
  visibility: "named" as const,
  role: "admin" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function holding(mktValue: number, instrumentId = "us_nvda"): Position {
  return {
    instrumentId,
    symbol: instrumentId.slice(3).toUpperCase(),
    name: `${instrumentId} Inc`,
    qty: 1,
    avgCost: mktValue,
    mktValue,
  };
}

/** Every pass the fixture writes, in insertion order. */
const PASSES: [takenAt: string, mktValue: number][] = [
  // Outside any 3-day window — the `since` bound has to drop these.
  ["2026-07-01T13:00:00.000Z", 1],
  ["2026-07-02T13:00:00.000Z", 2],
  // Three passes on one day: only the 20:00 one may survive.
  ["2026-08-01T13:00:00.000Z", 10],
  ["2026-08-01T20:00:00.000Z", 11],
  ["2026-08-01T16:00:00.000Z", 12],
  ["2026-08-02T14:00:00.000Z", 20],
  ["2026-08-03T14:00:00.000Z", 30],
  ["2026-08-04T14:00:00.000Z", 40],
];

async function fill(storage: Storage): Promise<void> {
  await storage.upsertMember(MEMBER);
  await storage.upsertAccount({
    id: "a-m1",
    memberId: "m1",
    provider: "indmoney",
    status: "active",
    lastPolledAt: null,
  });
  for (const [takenAt, mktValue] of PASSES) {
    await storage.saveSnapshot("a-m1", takenAt, [holding(mktValue)]);
  }
}

/** The value written by whichever pass a day resolved to — the assertion hook. */
function values(rows: { positions: Position[] }[]): number[] {
  return rows.map((r) => r.positions[0].mktValue);
}

const SINCE = "2026-08-01T00:00:00.000Z";

function contract(name: string, open: () => Promise<Storage>) {
  describe(`listDailySnapshots · ${name}`, () => {
    let storage: Storage;

    before(async () => {
      storage = await open();
      await fill(storage);
    });

    after(async () => {
      await storage.close();
    });

    test("one row per UTC day — the day's last pass, oldest day first", async () => {
      const rows = await storage.listDailySnapshots("a-m1", SINCE, 31);
      assert.deepEqual(
        rows.map((r) => r.takenAt),
        [
          // 20:00 beats 16:00 beats 13:00, and the later *insert* does not win.
          "2026-08-01T20:00:00.000Z",
          "2026-08-02T14:00:00.000Z",
          "2026-08-03T14:00:00.000Z",
          "2026-08-04T14:00:00.000Z",
        ],
      );
      assert.deepEqual(values(rows), [11, 20, 30, 40]);
    });

    test("`since` is the window: older passes are never read, let alone parsed", async () => {
      const rows = await storage.listDailySnapshots("a-m1", SINCE, 31);
      assert.equal(
        rows.some((r) => r.takenAt < SINCE),
        false,
      );
      // Widen it and July reappears — proof the bound, not a filter downstream,
      // is what dropped those two days.
      const wide = await storage.listDailySnapshots("a-m1", "2026-01-01T00:00:00.000Z", 31);
      assert.equal(wide.length, 6);
      assert.equal(wide[0].takenAt, "2026-07-01T13:00:00.000Z");
    });

    test("the cap keeps the newest days, not the first ones it happens to read", async () => {
      const rows = await storage.listDailySnapshots("a-m1", SINCE, 2);
      // A cap that truncated the recent end would drop today, which is the one
      // day a "what are they holding now" chart cannot do without.
      assert.deepEqual(
        rows.map((r) => r.takenAt),
        ["2026-08-03T14:00:00.000Z", "2026-08-04T14:00:00.000Z"],
      );
    });

    test("another account's history is not this account's", async () => {
      assert.deepEqual(await storage.listDailySnapshots("a-nobody", SINCE, 31), []);
    });
  });
}

contract("sqlite", () => createStorage(":memory:"));

contract("d1", async () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  const storage = new D1Storage(new ShimDatabase(raw) as never);
  // The shim owns the handle; close() is a no-op on D1, so hang the cleanup here.
  storage.close = async () => raw.close();
  return storage;
});
