import assert from "node:assert/strict";
import { test } from "node:test";
import type { Position } from "../domain.js";
import { toFeedEventRow } from "../diff/index.js";
import { MockPortfolioSource } from "../poller/source.js";
import { runPollTick, toStoredPosition } from "../poller/tick.js";
import { createStorage } from "./index.js";

const AT = "2026-08-06T20:00:00.000Z";

function p(instrumentId: string, qty: number, price: number): Position {
  return {
    instrumentId,
    symbol: instrumentId.toUpperCase(),
    name: `${instrumentId} Inc`,
    qty,
    avgCost: price * 0.9,
    mktValue: qty * price,
  };
}

async function fixture() {
  const storage = await createStorage(":memory:");
  await storage.upsertMember({
    id: "m1",
    name: "Shubham",
    visibility: "named",
    createdAt: AT,
  });
  await storage.upsertAccount({
    id: "a-m1",
    memberId: "m1",
    provider: "indmoney",
    status: "active",
    lastPolledAt: null,
  });
  return storage;
}

test("storage round-trips members, accounts, snapshots, positions and events", async () => {
  const storage = await fixture();

  assert.deepEqual(await storage.listMembers(), [
    { id: "m1", name: "Shubham", visibility: "named", createdAt: AT },
  ]);

  const holdings = [p("nvda", 10, 900), p("aapl", 20, 200)];
  await storage.saveSnapshot("a-m1", AT, holdings);
  const snapshot = await storage.latestSnapshot("a-m1");
  assert.deepEqual(snapshot?.positions, holdings);

  await storage.replaceCurrentPositions(
    "a-m1",
    holdings.map((h) => toStoredPosition("a-m1", h, holdings, AT)),
  );
  const current = await storage.getCurrentPositions("a-m1");
  assert.equal(current.length, 2);
  assert.ok(
    Math.abs(current.reduce((s, c) => s + c.pctOfPortfolio, 0) - 100) < 1e-9,
  );

  // Replacing is a full swap, not a merge.
  await storage.replaceCurrentPositions("a-m1", [
    toStoredPosition("a-m1", holdings[0], [holdings[0]], AT),
  ]);
  assert.equal((await storage.getCurrentPositions("a-m1")).length, 1);

  const rows = [
    toFeedEventRow({
      accountId: "a-m1",
      type: "NEW_POSITION",
      instrumentId: "aapl",
      symbol: "AAPL",
      instrumentName: "Apple Inc",
      pctOfPortfolio: 30.77,
      qtyChangePct: null,
      detectedAt: AT,
      qtyBefore: 0,
      qtyAfter: 20,
      avgCostBefore: null,
      avgCostAfter: 190,
      mktValueBefore: null,
      mktValueAfter: 4000,
      ratio: null,
      suppressed: false,
      suppressReason: null,
    }),
    toFeedEventRow({
      accountId: "a-m1",
      type: "SIZE_UP",
      instrumentId: "nvda",
      symbol: "NVDA",
      instrumentName: "NVIDIA Corp",
      pctOfPortfolio: 69.23,
      qtyChangePct: 3,
      detectedAt: AT,
      qtyBefore: 14,
      qtyAfter: 56,
      avgCostBefore: 812,
      avgCostAfter: 203,
      mktValueBefore: 12740,
      mktValueAfter: 12740,
      ratio: 4,
      suppressed: true,
      suppressReason: "corp_action_h1",
    }),
  ];
  await storage.insertFeedEvents(rows);
  // Re-inserting is a no-op: the id is a content hash.
  await storage.insertFeedEvents(rows);

  const visible = await storage.listFeedEvents();
  assert.equal(visible.length, 1);
  assert.equal(visible[0].type, "NEW_POSITION");
  assert.equal(visible[0].qtyChangePct, null);

  const all = await storage.listFeedEvents({ includeSuppressed: true });
  assert.equal(all.length, 2);
  assert.equal(
    all.find((e) => e.suppressed)?.suppressReason,
    "corp_action_h1",
  );

  await storage.archiveRaw("a-m1", AT, "networth_holdings", holdings);
  await storage.archiveRaw(
    "a-m1",
    "2026-01-01T00:00:00.000Z",
    "networth_holdings",
    [],
  );
  assert.equal((await storage.listRawArchive("a-m1")).length, 2);
  assert.equal(await storage.pruneRawArchive("2026-06-01T00:00:00.000Z"), 1);
  assert.equal((await storage.listRawArchive("a-m1")).length, 1);

  await storage.markPolled("a-m1", AT);
  assert.equal((await storage.getAccount("a-m1"))?.lastPolledAt, AT);

  await storage.close();
});

test("a poll tick writes events, positions and a snapshot", async () => {
  const storage = await fixture();
  const source = new MockPortfolioSource({
    "a-m1": [[p("nvda", 10, 900)], [p("nvda", 10, 900), p("aapl", 20, 200)]],
  });

  const first = await runPollTick(storage, source, { now: new Date(AT) });
  assert.deepEqual(first.polled, ["a-m1"]);
  assert.equal(first.events, 1); // baseline import

  // Nothing moved: the cheap probe short-circuits the full pull.
  const idle = await runPollTick(storage, source, { now: new Date(AT) });
  assert.deepEqual(idle.unchanged, ["a-m1"]);
  assert.equal(idle.events, 0);

  source.advance();
  const second = await runPollTick(storage, source, { now: new Date(AT) });
  assert.equal(second.events, 1);
  assert.equal((await storage.getCurrentPositions("a-m1")).length, 2);
  assert.equal((await storage.listFeedEvents()).length, 2);
  assert.equal((await storage.latestSnapshot("a-m1"))?.positions.length, 2);

  await storage.close();
});
