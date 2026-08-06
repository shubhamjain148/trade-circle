import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { runMinutesUtc } from "./poller/scheduler.js";
import { isScheduledSlot } from "./worker.js";

/**
 * The cron triggers in wrangler.jsonc and `isScheduledSlot` say the same thing
 * twice, on purpose: cron is coarse and a trigger list is easy to edit without
 * noticing. These tests pin the agreement, and pin it to the same source the
 * Node scheduler uses (poller/scheduler.ts), so the two runtimes cannot drift.
 */

// Thursday and Saturday in UTC.
const weekday = (h: number, m: number) => new Date(Date.UTC(2026, 7, 6, h, m));
const weekend = (h: number, m: number) => new Date(Date.UTC(2026, 7, 8, h, m));

describe("isScheduledSlot", () => {
  test("accepts every slot the Node scheduler would have fired", () => {
    for (const minute of runMinutesUtc()) {
      const at = weekday(Math.floor(minute / 60), minute % 60);
      assert.ok(isScheduledSlot(at), `expected slot at ${at.toISOString()}`);
    }
  });

  test("rejects the middle of the night and the gaps between slots", () => {
    assert.equal(isScheduledSlot(weekday(3, 0)), false);
    assert.equal(isScheduledSlot(weekday(11, 0)), false);
    assert.equal(isScheduledSlot(weekday(23, 45)), false);
    // 14:00 sits between the 13:30 and 14:30 passes.
    assert.equal(isScheduledSlot(weekday(14, 0)), false);
  });

  test("never fires at the weekend", () => {
    for (const minute of runMinutesUtc()) {
      const at = weekend(Math.floor(minute / 60), minute % 60);
      assert.equal(isScheduledSlot(at), false, `fired at ${at.toISOString()}`);
    }
  });

  test("tolerates cron drift of a few minutes either side", () => {
    assert.ok(isScheduledSlot(weekday(13, 33)));
    assert.ok(isScheduledSlot(weekday(13, 27)));
    assert.equal(isScheduledSlot(weekday(13, 40)), false);
  });

  test("the cron triggers in wrangler.jsonc cover exactly these slots", () => {
    // 0 13 * * 1-5 | 30 13-20 * * 1-5 | 15 21 * * 1-5
    const fromCron = [13 * 60, ...Array.from({ length: 8 }, (_, i) => (13 + i) * 60 + 30), 21 * 60 + 15];
    assert.deepEqual(runMinutesUtc().slice().sort((a, b) => a - b), fromCron.slice().sort((a, b) => a - b));
  });
});
