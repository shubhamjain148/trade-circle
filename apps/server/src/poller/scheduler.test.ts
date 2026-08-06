import assert from "node:assert/strict";
import { test } from "node:test";
import { isMarketWindow, nextRunAt } from "./scheduler.js";

test("pre-open, hourly and post-close passes on a weekday", () => {
  // Thursday 2026-08-06, 12:00 UTC — before the pre-open pass.
  const slots: string[] = [];
  let at = new Date("2026-08-06T12:00:00.000Z");
  for (let i = 0; i < 10; i++) {
    at = nextRunAt(at);
    slots.push(at.toISOString().slice(11, 16));
  }
  assert.deepEqual(slots, [
    "13:00",
    "13:30",
    "14:30",
    "15:30",
    "16:30",
    "17:30",
    "18:30",
    "19:30",
    "20:30",
    "21:15",
  ]);
  // Next day's pre-open follows.
  assert.equal(nextRunAt(at).toISOString(), "2026-08-07T13:00:00.000Z");
});

test("weekends are skipped", () => {
  // Friday after the last pass -> next slot is Monday's pre-open.
  const next = nextRunAt(new Date("2026-08-07T22:00:00.000Z"));
  assert.equal(next.toISOString(), "2026-08-10T13:00:00.000Z");
});

test("market window is 13:30-21:00 UTC (19:00-02:30 IST) on weekdays", () => {
  assert.equal(isMarketWindow(new Date("2026-08-06T15:00:00.000Z")), true);
  assert.equal(isMarketWindow(new Date("2026-08-06T12:00:00.000Z")), false);
  assert.equal(isMarketWindow(new Date("2026-08-08T15:00:00.000Z")), false);
});
