import assert from "node:assert/strict";
import { after as afterAll, before, describe, test } from "node:test";
import type { Hono } from "hono";
import { createApp } from "../api.js";
import type { SessionEnv } from "../auth/session.js";
import { Vault } from "../auth/vault.js";
import { loadConfig, type Config } from "../config.js";
import type { StoredPosition } from "../domain.js";
import { ANONYMOUS_NAME } from "../feed.js";
import { createInvite } from "../invite.js";
import type { McpDeps } from "../mcp/oauth.js";
import type { TickResult } from "../poller/tick.js";
import { createStorage, type Storage } from "../storage/index.js";
import type { GroupStats } from "../types.js";

// GET /api/group/stats over the real Hono app. Positions are written straight to
// storage — this route's job is arithmetic and visibility, and the poller has
// its own tests for how the rows got there.

const APP_URL = "http://127.0.0.1:3008";
const AT = new Date(Date.now() - 90 * 60_000).toISOString();
const NEWER = new Date(Date.now() - 20 * 60_000).toISOString();

let storage: Storage;
let config: Config;
let app: Hono<SessionEnv>;
let cookie = "";

/**
 * m1 Shubham  named      NVDA 45 · AAPL 30 · MSFT 25
 * m2 Rahul    named      NVDA 61 · TSLA 39
 * m3 Anjali   anonymous  NVDA 20 · AAPL 50 · GOOGL 20 · AMZN 10
 * m4 Vikram   paused     META 100          <- must not appear anywhere
 * m5 Neha     named      (member, no account)
 */
function held(
  accountId: string,
  symbol: string,
  name: string,
  pctOfPortfolio: number,
  updatedAt = AT,
): StoredPosition {
  return {
    accountId,
    instrumentId: `us_${symbol.toLowerCase()}`,
    symbol,
    name,
    // Deliberately unmistakable: if any of the three ever reaches the wire, the
    // privacy test below has a literal to catch rather than a shape to guess at.
    qty: 137,
    avgCost: 812.25,
    mktValue: 111_278.5,
    pctOfPortfolio,
    updatedAt,
  };
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

function statsRequest(as = cookie) {
  return app.request("/api/group/stats", { headers: as ? { cookie: as } : {} });
}

async function stats(as = cookie): Promise<GroupStats> {
  const res = await statsRequest(as);
  assert.equal(res.status, 200);
  return (await res.json()) as GroupStats;
}

before(async () => {
  storage = await createStorage(":memory:");
  config = loadConfig({
    NODE_ENV: "test",
    APP_SECRET: "stats-test-secret",
    APP_URL,
  } as NodeJS.ProcessEnv);

  for (const [id, name, visibility, role] of [
    ["m1", "Shubham", "named", "admin"],
    ["m2", "Rahul", "named", "member"],
    ["m3", "Anjali", "anonymous", "member"],
    ["m4", "Vikram", "paused", "member"],
  ] as const) {
    await storage.upsertMember({ id, name, visibility, role, createdAt: AT });
    await storage.upsertAccount({
      id: `a-${id}`,
      memberId: id,
      provider: "indmoney",
      status: "active",
      lastPolledAt: AT,
    });
  }
  await storage.upsertMember({
    id: "m5",
    name: "Neha",
    visibility: "named",
    role: "member",
    createdAt: AT,
  });

  await storage.replaceCurrentPositions("a-m1", [
    held("a-m1", "NVDA", "NVIDIA Corp", 45),
    held("a-m1", "AAPL", "Apple Inc", 30),
    held("a-m1", "MSFT", "Microsoft Corp", 25),
  ]);
  await storage.replaceCurrentPositions("a-m2", [
    held("a-m2", "NVDA", "NVIDIA Corp", 61, NEWER),
    held("a-m2", "TSLA", "Tesla Inc", 39, NEWER),
  ]);
  await storage.replaceCurrentPositions("a-m3", [
    held("a-m3", "AAPL", "Apple Inc", 50),
    held("a-m3", "NVDA", "NVIDIA Corp", 20),
    held("a-m3", "GOOGL", "Alphabet Inc", 20),
    held("a-m3", "AMZN", "Amazon.com Inc", 10),
  ]);
  await storage.replaceCurrentPositions("a-m4", [
    held("a-m4", "META", "Meta Platforms Inc", 100),
  ]);

  const poll = async (): Promise<TickResult> => ({
    at: AT,
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

describe("the stats gate", () => {
  test("group stats need a session", async () => {
    const res = await statsRequest("");
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  });
});

describe("who is counted", () => {
  test("the group is everyone the feed would show — paused excluded, no account included", async () => {
    const body = await stats();
    // m1, m2, m3, m5. Not m4, who is paused.
    assert.equal(body.visibleMembers, 4);
    // Neha has no account, so she is a member without a portfolio.
    assert.equal(body.portfolios, 3);
  });

  test("a paused member's holdings are absent from every list", async () => {
    const text = await (await statsRequest()).text();
    assert.equal(text.includes("META"), false);
    assert.equal(text.includes("Vikram"), false);
    assert.equal(text.includes("a-m4"), false);
  });

  test("asOf is the newest row across the group", async () => {
    assert.equal((await stats()).asOf, NEWER);
  });
});

describe("overlap", () => {
  test("held by 2+, most-held first, with each holder's own weight", async () => {
    const { overlaps } = await stats();
    assert.deepEqual(
      overlaps.map((o) => [o.symbol, o.holderCount]),
      [
        ["NVDA", 3],
        ["AAPL", 2],
      ],
    );

    const nvda = overlaps[0];
    assert.equal(nvda.totalWeight, 126);
    assert.equal(nvda.averageWeight, 42);
    assert.deepEqual(
      nvda.holders.map((h) => [h.name, h.pctOfPortfolio]),
      [
        ["Rahul", 61],
        ["Shubham", 45],
        [ANONYMOUS_NAME, 20],
      ],
    );
  });

  test("an anonymous holder is named by the feed's word for them, and carries no id", async () => {
    const { overlaps } = await stats();
    const anonymous = overlaps
      .flatMap((o) => o.holders)
      .filter((h) => h.anonymous);

    assert.equal(anonymous.length, 2); // NVDA and AAPL
    for (const holder of anonymous) {
      assert.equal(holder.name, ANONYMOUS_NAME);
      // The one thing that would turn "someone" back into a name: a link.
      assert.equal(holder.memberId, null);
    }
    assert.equal(JSON.stringify(overlaps).includes("Anjali"), false);
    assert.equal(JSON.stringify(overlaps).includes("m3"), false);
  });
});

describe("solo picks and the group favourite", () => {
  test("held by exactly one, heaviest conviction first", async () => {
    const { solo } = await stats();
    assert.deepEqual(
      solo.map((s) => [s.symbol, s.totalWeight]),
      [
        ["TSLA", 39],
        ["MSFT", 25],
        ["GOOGL", 20],
        ["AMZN", 10],
      ],
    );
    for (const pick of solo) assert.equal(pick.holderCount, 1);
  });

  test("the favourite is the highest summed weight in the group", async () => {
    const { favorite } = await stats();
    assert.equal(favorite?.symbol, "NVDA");
    assert.equal(favorite?.totalWeight, 126);
  });
});

describe("concentration", () => {
  test("top three as a share of each member's own portfolio, most concentrated first", async () => {
    const { concentration } = await stats();
    assert.deepEqual(
      concentration.map((c) => [c.name, c.topThreeWeight, c.positionCount]),
      [
        // Two positions, so the "top three" is the whole portfolio.
        ["Rahul", 100, 2],
        ["Shubham", 100, 3],
        // Four positions: 50 + 20 + 20, with AMZN's 10 left out.
        [ANONYMOUS_NAME, 90, 4],
      ],
    );
    assert.deepEqual(concentration[0].largest, {
      symbol: "NVDA",
      name: "NVIDIA Corp",
      pctOfPortfolio: 61,
    });
  });

  test("an anonymous member is ranked but never named", async () => {
    const anonymous = (await stats()).concentration.find((c) => c.anonymous)!;
    assert.equal(anonymous.name, ANONYMOUS_NAME);
    assert.equal(anonymous.memberId, null);
  });
});

/**
 * The privacy boundary, asserted against the raw response text rather than the
 * parsed shape: a key added by a careless spread would still be in the bytes
 * even if nothing in the type system noticed. Same test src/positions.ts has,
 * because this endpoint reads the same table and is a far more tempting place
 * to reach for "who has the biggest portfolio".
 */
describe("no amounts, anywhere", () => {
  test("not in the keys, not in the bytes", async () => {
    const body = await (await statsRequest()).text();

    for (const forbidden of [
      "qty",
      "avgCost",
      "avg_cost",
      "mktValue",
      "mkt_value",
      "accountId",
      "account_id",
    ]) {
      assert.equal(body.includes(forbidden), false, `${forbidden} reached the wire`);
    }
    for (const amount of ["137", "812.25", "111278.5", "111,278.5"]) {
      assert.equal(body.includes(amount), false, `${amount} reached the wire`);
    }

    const parsed = JSON.parse(body) as GroupStats;
    const holderKeys = new Set(["memberId", "name", "anonymous", "pctOfPortfolio"]);
    for (const instrument of [...parsed.overlaps, ...parsed.solo]) {
      assert.deepEqual(
        Object.keys(instrument).filter(
          (key) =>
            ![
              "instrumentId",
              "symbol",
              "name",
              "holderCount",
              "totalWeight",
              "averageWeight",
              "holders",
            ].includes(key),
        ),
        [],
      );
      for (const holder of instrument.holders) {
        assert.deepEqual(
          Object.keys(holder).filter((key) => !holderKeys.has(key)),
          [],
        );
      }
    }
  });
});

describe("a group of one", () => {
  test("nothing overlaps with itself: empty lists, honest counts", async () => {
    const solo = await createStorage(":memory:");
    await solo.upsertMember({
      id: "only",
      name: "Shubham",
      visibility: "named",
      role: "admin",
      createdAt: AT,
    });
    await solo.upsertAccount({
      id: "a-only",
      memberId: "only",
      provider: "indmoney",
      status: "active",
      lastPolledAt: AT,
    });
    await solo.replaceCurrentPositions("a-only", [
      held("a-only", "NVDA", "NVIDIA Corp", 70),
      held("a-only", "AAPL", "Apple Inc", 30),
    ]);

    const poll = async (): Promise<TickResult> => ({
      at: AT,
      polled: [],
      unchanged: [],
      skipped: [],
      errors: [],
      events: 0,
      suppressed: 0,
    });
    const mcp: McpDeps = {
      storage: solo,
      vault: new Vault(config.appSecret),
      config,
    };
    const lonely = createApp({
      storage: solo,
      poll,
      pollOne: poll,
      config,
      mcp,
    });

    const url = await createInvite(solo, "only", APP_URL);
    const token = new URL(url.replace("/#/", "/")).searchParams.get("token")!;
    const session = await lonely.request("/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteToken: token }),
    });
    const only = (session.headers.get("set-cookie") ?? "").split(";")[0];

    const res = await lonely.request("/api/group/stats", {
      headers: { cookie: only },
    });
    const body = (await res.json()) as GroupStats;

    assert.equal(body.visibleMembers, 1);
    assert.equal(body.portfolios, 1);
    assert.deepEqual(body.overlaps, []);
    // Their own holdings are still "solo picks" — one person's whole portfolio
    // is held by exactly one person, which is arithmetic, not a bug. The empty
    // state the UI shows is keyed on visibleMembers, not on this list.
    assert.deepEqual(
      body.solo.map((s) => s.symbol),
      ["NVDA", "AAPL"],
    );
    assert.equal(body.favorite?.symbol, "NVDA");
    assert.equal(body.concentration.length, 1);

    await solo.close();
  });

  test("an empty group is empty, not a crash", async () => {
    const empty = await createStorage(":memory:");
    await empty.upsertMember({
      id: "only",
      name: "Shubham",
      visibility: "named",
      role: "admin",
      createdAt: AT,
    });
    const poll = async (): Promise<TickResult> => ({
      at: AT,
      polled: [],
      unchanged: [],
      skipped: [],
      errors: [],
      events: 0,
      suppressed: 0,
    });
    const mcp: McpDeps = {
      storage: empty,
      vault: new Vault(config.appSecret),
      config,
    };
    const app0 = createApp({ storage: empty, poll, pollOne: poll, config, mcp });

    const url = await createInvite(empty, "only", APP_URL);
    const token = new URL(url.replace("/#/", "/")).searchParams.get("token")!;
    const session = await app0.request("/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteToken: token }),
    });
    const only = (session.headers.get("set-cookie") ?? "").split(";")[0];

    const body = (await (
      await app0.request("/api/group/stats", { headers: { cookie: only } })
    ).json()) as GroupStats;

    assert.deepEqual(body, {
      visibleMembers: 1,
      portfolios: 0,
      asOf: null,
      overlaps: [],
      solo: [],
      favorite: null,
      concentration: [],
    } satisfies GroupStats);

    await empty.close();
  });
});
