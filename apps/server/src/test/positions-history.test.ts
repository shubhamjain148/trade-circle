import assert from "node:assert/strict";
import { after as afterAll, before, describe, test } from "node:test";
import type { Hono } from "hono";
import { createApp } from "../api.js";
import type { SessionEnv } from "../auth/session.js";
import { Vault } from "../auth/vault.js";
import { loadConfig, type Config } from "../config.js";
import type { Position } from "../domain.js";
import { createInvite } from "../invite.js";
import type { McpDeps } from "../mcp/oauth.js";
import type { TickResult } from "../poller/tick.js";
import { toStoredPosition } from "../poller/tick.js";
import { HISTORY_DAYS } from "../positions.js";
import { createStorage, type Storage } from "../storage/index.js";
import type { HoldingsHistory } from "../types.js";

/**
 * GET /api/members/:id/positions/history over the real Hono app.
 *
 * Snapshots are written straight to storage, one or more per day, exactly as
 * the poller would: this route's job is thinning, projection and visibility.
 * What it must never do is turn a month of stored portfolios — every one of
 * which carries quantity, average cost and market value — into a month of
 * amounts on the wire, so the privacy assertion here is the same shape as the
 * one guarding the current-positions route, run over thirty days of payload.
 */

const APP_URL = "http://127.0.0.1:3009";
const DAY_MS = 86_400_000;

let storage: Storage;
let config: Config;
let app: Hono<SessionEnv>;
let cookie = "";

/**
 * Amounts chosen to be unmistakable in a byte-level search: if any of them ever
 * reaches the wire, the privacy test below has something to catch.
 */
function p(instrumentId: string, mktValue: number): Position {
  return {
    instrumentId,
    symbol: instrumentId.slice(3).toUpperCase(),
    name: `${instrumentId} Inc`,
    qty: 137,
    avgCost: 812.25,
    mktValue,
  };
}

/** N whole days before now, at a fixed hour so day keys are unambiguous. */
function daysAgo(days: number, hour = 13): string {
  const at = new Date(Date.now() - days * DAY_MS);
  at.setUTCHours(hour, 0, 0, 0);
  return at.toISOString();
}

function dayKey(days: number): string {
  return daysAgo(days).slice(0, 10);
}

async function pass(accountId: string, at: string, holdings: Position[]) {
  await storage.saveSnapshot(accountId, at, holdings);
  await storage.replaceCurrentPositions(
    accountId,
    holdings.map((h) => toStoredPosition(accountId, h, holdings, at)),
  );
}

async function signIn(memberId: string): Promise<string> {
  const url = await createInvite(storage, memberId, APP_URL);
  const token = new URL(url.replace("/#/", "/")).searchParams.get("token")!;
  const res = await app.request("/api/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inviteToken: token }),
  });
  assert.equal(res.status, 200);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

function historyRequest(memberId: string, as = cookie) {
  return app.request(`/api/members/${memberId}/positions/history`, {
    headers: as ? { cookie: as } : {},
  });
}

async function history(memberId: string, as = cookie): Promise<HoldingsHistory> {
  const res = await historyRequest(memberId, as);
  assert.equal(res.status, 200);
  return (await res.json()) as HoldingsHistory;
}

function seriesFor(body: HoldingsHistory, instrumentId: string) {
  return body.series.find((s) => s.instrumentId === instrumentId);
}

before(async () => {
  storage = await createStorage(":memory:");
  config = loadConfig({
    NODE_ENV: "test",
    APP_SECRET: "positions-history-test-secret",
    APP_URL,
  } as NodeJS.ProcessEnv);

  for (const [id, name, visibility, role] of [
    ["m1", "Shubham", "named", "admin"],
    ["m2", "Rahul", "paused", "member"],
    ["m3", "Anjali", "named", "member"],
    ["m4", "Vikram", "named", "member"],
  ] as const) {
    await storage.upsertMember({ id, name, visibility, role, createdAt: daysAgo(40) });
    await storage.upsertAccount({
      id: `a-${id}`,
      memberId: id,
      provider: "indmoney",
      status: "active",
      lastPolledAt: null,
    });
  }
  // A member with no account at all.
  await storage.upsertMember({
    id: "m5",
    name: "Neha",
    visibility: "named",
    role: "member",
    createdAt: daysAgo(40),
  });

  // m1 — the storyboard the sparkline exists for:
  //   NVDA held the whole window, weight climbing (a build).
  //   AAPL held the whole window, weight flat (a hold).
  //   GOOGL absent for the first three days, then bought (a new position).
  //   TSLA held on day 5 only, then sold — not held now, so no series.
  //   MSFT bought after the last daily pass — held now, no history at all.
  await pass("a-m1", daysAgo(45), [p("us_nvda", 999), p("us_aapl", 1)]); // outside window
  await pass("a-m1", daysAgo(5), [p("us_nvda", 20), p("us_aapl", 40), p("us_tsla", 40)]);
  await pass("a-m1", daysAgo(4), [p("us_nvda", 30), p("us_aapl", 70)]);
  await pass("a-m1", daysAgo(3), [p("us_nvda", 40), p("us_aapl", 60)]);
  // Two passes on the same day: the later one is the day's reading.
  await pass("a-m1", daysAgo(2, 9), [p("us_nvda", 1), p("us_aapl", 99), p("us_googl", 1)]);
  await pass("a-m1", daysAgo(2, 21), [p("us_nvda", 50), p("us_aapl", 30), p("us_googl", 20)]);
  await pass("a-m1", daysAgo(1), [p("us_nvda", 60), p("us_aapl", 20), p("us_googl", 20)]);
  // Today's pass, plus a holding with no snapshot behind it.
  await pass("a-m1", daysAgo(0), [
    p("us_nvda", 60),
    p("us_aapl", 20),
    p("us_googl", 20),
  ]);
  const current = await storage.getCurrentPositions("a-m1");
  await storage.replaceCurrentPositions("a-m1", [
    ...current,
    toStoredPosition("a-m1", p("us_msft", 0), [], daysAgo(0)),
  ]);

  // m2 — paused, with history to hide.
  await pass("a-m2", daysAgo(2), [p("us_tsla", 60), p("us_amzn", 40)]);
  await pass("a-m2", daysAgo(1), [p("us_tsla", 50), p("us_amzn", 50)]);

  // m3 — one pass per day for well over the window, to prove the cap.
  for (let day = HISTORY_DAYS + 12; day >= 0; day--) {
    await pass("a-m3", daysAgo(day), [p("us_msft", 100)]);
  }

  const poll = async (): Promise<TickResult> => ({
    at: daysAgo(0),
    polled: [],
    unchanged: [],
    skipped: [],
    errors: [],
    events: 0,
    suppressed: 0,
  });
  const mcp: McpDeps = { storage, vault: new Vault(config.appSecret), config };
  app = createApp({ storage, poll, pollOne: poll, config, mcp });
  cookie = await signIn("m1");
});

afterAll(async () => {
  await storage.close();
});

describe("the history gate", () => {
  test("reading anyone's history needs a session", async () => {
    const res = await historyRequest("m1", "");
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  });

  test("a member who does not exist is a 404, not an empty window", async () => {
    const res = await historyRequest("nobody");
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "unknown_member" });
  });
});

describe("the series", () => {
  test("one point per day, on the window's shared day axis", async () => {
    const body = await history("m1");
    // Six passes over five distinct days inside the window; the 45-day-old one
    // is out, and the two on the same day are one.
    assert.deepEqual(body.days, [dayKey(5), dayKey(4), dayKey(3), dayKey(2), dayKey(1), dayKey(0)]);

    const nvda = seriesFor(body, "us_nvda");
    assert.deepEqual(
      nvda?.points.map((pt) => pt.pct),
      // 20/100, 30/100, 40/100, 50/100, 60/100, 60/100 — a build.
      [20, 30, 40, 50, 60, 60],
    );
    assert.deepEqual(
      nvda?.points.map((pt) => pt.d),
      body.days,
    );
  });

  test("the day's *last* pass is the day's reading", async () => {
    const body = await history("m1");
    const nvda = seriesFor(body, "us_nvda");
    // The 09:00 pass that day put NVDA at 1%; the 21:00 one put it at 50%.
    assert.equal(nvda?.points[3].pct, 50);
  });

  test("a flat weight is a flat series, not a missing one", async () => {
    const body = await history("m1");
    const aapl = seriesFor(body, "us_aapl");
    assert.equal(aapl?.points.length, 6);
    assert.equal(new Set(aapl?.points.map((pt) => pt.pct)).size > 1, true);
  });

  test("a position bought inside the window starts where it started, and says when", async () => {
    const body = await history("m1");
    const googl = seriesFor(body, "us_googl");
    // Absent for the first three days: the line begins on the day it appeared,
    // rather than three days of zero pretending to be a position.
    assert.deepEqual(
      googl?.points.map((pt) => pt.d),
      [dayKey(2), dayKey(1), dayKey(0)],
    );
    assert.equal(googl?.openedAt, dayKey(2));
  });

  test("a position older than the window claims no start date", async () => {
    const body = await history("m1");
    assert.equal(seriesFor(body, "us_nvda")?.openedAt, null);
    assert.equal(seriesFor(body, "us_aapl")?.openedAt, null);
  });

  test("only what is held now gets a line", async () => {
    const body = await history("m1");
    // Sold four days ago. Its exit is a feed event; it is not a holdings row,
    // so it has no sparkline.
    assert.equal(seriesFor(body, "us_tsla"), undefined);
    // Held now, but bought since the last daily pass: no line at all, which is
    // what tells the panel to say "new" instead of drawing a single point.
    assert.equal(seriesFor(body, "us_msft"), undefined);
  });

  test("the window is capped at 30 days however much history exists", async () => {
    const body = await history("m3");
    // Forty-three days of passes on file; thirty whole days come back, and the
    // window is day-aligned so the count does not drift with the wall clock.
    assert.equal(body.days.length, HISTORY_DAYS);
    // The cap keeps the recent end: today is always in.
    assert.equal(body.days.at(-1), dayKey(0));
    assert.equal(body.days[0], dayKey(HISTORY_DAYS - 1));
    for (const s of body.series) {
      assert.equal(s.points.length <= HISTORY_DAYS, true);
    }
  });

  test("no history is an empty window, not an error", async () => {
    assert.deepEqual(await history("m4"), { days: [], series: [] });
    assert.deepEqual(await history("m5"), { days: [], series: [] });
  });
});

describe("visibility", () => {
  test("a paused member's history is empty to the group, like their holdings", async () => {
    assert.deepEqual(await history("m2"), { days: [], series: [] });

    // Same answer the sibling route gives the same reader.
    const positions = await app.request("/api/members/m2/positions", {
      headers: { cookie },
    });
    assert.deepEqual(await positions.json(), []);
  });

  test("a paused member still sees their own history", async () => {
    const own = await signIn("m2");
    const body = await history("m2", own);
    assert.deepEqual(
      body.series.map((s) => s.instrumentId).sort(),
      ["us_amzn", "us_tsla"],
    );
    assert.equal(body.days.length, 2);
  });
});

describe("the wire shape", () => {
  /**
   * The privacy boundary, asserted against the raw response text rather than
   * the parsed series: this route is handed whole stored snapshots — qty, avg
   * cost and market value for every instrument on every day — and a careless
   * spread would put a month of them on the wire. Bytes, not keys, because a
   * leak nobody typed a name for would still be in the bytes.
   */
  test("thirty days of portfolios, and not one amount", async () => {
    const res = await historyRequest("m1");
    const body = await res.text();

    for (const forbidden of [
      "qty",
      "avgCost",
      "avg_cost",
      "mktValue",
      "mkt_value",
      "accountId",
      "account_id",
      "payload",
      "takenAt",
    ]) {
      assert.equal(body.includes(forbidden), false, `${forbidden} reached the wire`);
    }
    for (const amount of ["137", "812.25"]) {
      assert.equal(body.includes(amount), false, `${amount} reached the wire`);
    }

    const parsed = JSON.parse(body) as HoldingsHistory;
    assert.deepEqual(Object.keys(parsed).sort(), ["days", "series"]);
    for (const s of parsed.series) {
      assert.deepEqual(Object.keys(s).sort(), ["instrumentId", "openedAt", "points"]);
      for (const point of s.points) {
        assert.deepEqual(Object.keys(point).sort(), ["d", "pct"]);
        // A percentage, always — never a value that could be a currency amount.
        assert.equal(point.pct >= 0 && point.pct <= 100, true);
      }
    }
  });

  test("nothing here names anybody", async () => {
    const body = await (await historyRequest("m1")).text();
    for (const name of ["Shubham", "Rahul", "Anjali", "NVIDIA", "Apple"]) {
      assert.equal(body.includes(name), false, `${name} reached the wire`);
    }
  });
});
