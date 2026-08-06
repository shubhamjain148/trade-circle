import assert from "node:assert/strict";
import { test } from "node:test";
import type { Position } from "../domain.js";
import {
  applyCrossAccountSimultaneity,
  applyValueContinuity,
  candidateId,
  diffPositions,
  isSimpleFraction,
  suppressCorporateActions,
} from "./index.js";

const AT = "2026-08-06T20:00:00.000Z";

function p(
  instrumentId: string,
  qty: number,
  avgCost: number,
  price: number,
): Position {
  return {
    instrumentId,
    symbol: instrumentId.toUpperCase(),
    name: `${instrumentId} Inc`,
    qty,
    avgCost,
    mktValue: qty * price,
  };
}

test("new instrument becomes NEW_POSITION", () => {
  const events = diffPositions("a1", [p("nvda", 10, 780, 900)], [
    p("nvda", 10, 780, 900),
    p("aapl", 20, 190, 200),
  ], AT);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "NEW_POSITION");
  assert.equal(events[0].instrumentId, "aapl");
  assert.equal(events[0].qtyChangePct, null);
  // 4000 of 13000
  assert.ok(Math.abs(events[0].pctOfPortfolio - 30.77) < 0.01);
});

test("vanished instrument becomes EXITED", () => {
  const events = diffPositions(
    "a1",
    [p("nvda", 10, 780, 900), p("tsla", 8, 240, 260)],
    [p("nvda", 10, 780, 900)],
    AT,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "EXITED");
  assert.equal(events[0].instrumentId, "tsla");
  assert.equal(events[0].pctOfPortfolio, 0);
});

test("quantity going to zero also becomes EXITED", () => {
  const events = diffPositions(
    "a1",
    [p("tsla", 8, 240, 260)],
    [p("tsla", 0, 240, 260)],
    AT,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "EXITED");
});

test("resize emits SIZE_UP / SIZE_DOWN with relative change", () => {
  const up = diffPositions("a1", [p("aapl", 20, 190, 200)], [
    p("aapl", 25, 194, 200),
  ], AT);
  assert.equal(up.length, 1);
  assert.equal(up[0].type, "SIZE_UP");
  assert.equal(up[0].qtyChangePct, 0.25);

  const down = diffPositions("a1", [p("aapl", 20, 190, 200)], [
    p("aapl", 15, 190, 200),
  ], AT);
  assert.equal(down[0].type, "SIZE_DOWN");
  assert.equal(down[0].qtyChangePct, -0.25);
});

test("fractional drift below the threshold is ignored", () => {
  // US holdings are fractional; a 0.5% wobble is not a trade.
  const events = diffPositions("a1", [p("aapl", 20, 190, 200)], [
    p("aapl", 20.1, 190, 200),
  ], AT);
  assert.equal(events.length, 0);

  const tighter = diffPositions(
    "a1",
    [p("aapl", 20, 190, 200)],
    [p("aapl", 20.1, 190, 200)],
    AT,
    { qtyThreshold: 0.001 },
  );
  assert.equal(tighter.length, 1);
  assert.equal(tighter[0].type, "SIZE_UP");
});

test("H1 suppresses a 4:1 split and leaves a real buy alone", () => {
  // qty x4, avg cost /4, market value flat -> corporate action.
  const split = diffPositions("a1", [p("nvda", 14, 812, 910)], [
    p("nvda", 56, 203, 227.5),
  ], AT);
  const filtered = applyValueContinuity(split);
  assert.equal(filtered[0].suppressed, true);
  assert.equal(filtered[0].suppressReason, "corp_action_h1");

  // Same ratio, but capital was actually added: cost basis rises 4x.
  const buy = diffPositions("a1", [p("nvda", 14, 812, 910)], [
    p("nvda", 56, 850, 910),
  ], AT);
  assert.equal(applyValueContinuity(buy)[0].suppressed, false);
});

test("H1 does not touch opens or closes", () => {
  const events = diffPositions("a1", [], [p("aapl", 20, 190, 200)], AT);
  assert.equal(applyValueContinuity(events)[0].suppressed, false);
});

test("H2 suppresses the same ratio across two accounts in one tick", () => {
  // Neither account's numbers trip H1 (cost basis moves), but two friends
  // changing the same name by the same ratio in the same tick is a corp action.
  const a = diffPositions("a1", [p("nvda", 10, 780, 900)], [
    p("nvda", 20, 800, 450),
  ], AT);
  const b = diffPositions("a2", [p("nvda", 5, 640, 900)], [
    p("nvda", 10, 700, 450),
  ], AT);
  assert.equal(applyValueContinuity([...a, ...b]).every((c) => !c.suppressed), true);

  const filtered = applyCrossAccountSimultaneity([...a, ...b]);
  assert.equal(filtered.length, 2);
  assert.equal(
    filtered.every((c) => c.suppressed && c.suppressReason === "corp_action_h2"),
    true,
  );
});

test("H2 leaves a single account's change alone", () => {
  const a = diffPositions("a1", [p("nvda", 10, 780, 900)], [
    p("nvda", 20, 800, 450),
  ], AT);
  const b = diffPositions("a2", [p("aapl", 10, 180, 200)], [
    p("aapl", 20, 190, 200),
  ], AT);
  const filtered = applyCrossAccountSimultaneity([...a, ...b]);
  assert.equal(filtered.every((c) => !c.suppressed), true);
});

test("suppressCorporateActions runs H1 then H2", () => {
  const split = diffPositions("a1", [p("nvda", 14, 812, 910)], [
    p("nvda", 56, 203, 227.5),
  ], AT);
  const buy = diffPositions("a2", [p("aapl", 10, 180, 200)], [
    p("aapl", 20, 190, 200),
  ], AT);
  const filtered = suppressCorporateActions([...split, ...buy]);
  assert.equal(filtered[0].suppressReason, "corp_action_h1");
  assert.equal(filtered[1].suppressed, false);
});

test("isSimpleFraction accepts split ratios and rejects odd ones", () => {
  assert.equal(isSimpleFraction(4), true);
  assert.equal(isSimpleFraction(0.5), true);
  assert.equal(isSimpleFraction(1.5), true);
  assert.equal(isSimpleFraction(1.373), false);
});

test("candidate ids are stable, so replaying a tick is idempotent", () => {
  const [a] = diffPositions("a1", [p("aapl", 20, 190, 200)], [
    p("aapl", 25, 194, 200),
  ], AT);
  const [b] = diffPositions("a1", [p("aapl", 20, 190, 200)], [
    p("aapl", 25, 194, 200),
  ], "2026-08-06T21:00:00.000Z");
  assert.equal(candidateId(a), candidateId(b));
});
