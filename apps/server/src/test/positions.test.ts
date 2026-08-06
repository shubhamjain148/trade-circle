import assert from "node:assert/strict";
import { after as afterAll, before, describe, test } from "node:test";
import type { Hono } from "hono";
import { createApp } from "../api.js";
import type { SessionEnv } from "../auth/session.js";
import { Vault } from "../auth/vault.js";
import { loadConfig, type Config } from "../config.js";
import type { StoredPosition } from "../domain.js";
import { createInvite } from "../invite.js";
import type { McpDeps } from "../mcp/oauth.js";
import type { TickResult } from "../poller/tick.js";
import { createStorage, type Storage } from "../storage/index.js";
import type { Holding } from "../types.js";

// GET /api/members/:id/positions over the real Hono app. Positions are written
// straight to storage: this route's job is projection and visibility, and the
// poller has its own tests for how the rows got there.

const APP_URL = "http://127.0.0.1:3007";
const AT = new Date(Date.now() - 90 * 60_000).toISOString();

let storage: Storage;
let config: Config;
let app: Hono<SessionEnv>;
/** m1: named, holdings. m2: paused, holdings. m3: anonymous, holdings. m4: named, none. */
let cookie = "";

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

function positionsRequest(memberId: string, as = cookie) {
  return app.request(`/api/members/${memberId}/positions`, {
    headers: as ? { cookie: as } : {},
  });
}

async function positions(memberId: string, as = cookie): Promise<Holding[]> {
  const res = await positionsRequest(memberId, as);
  assert.equal(res.status, 200);
  return (await res.json()) as Holding[];
}

function held(
  accountId: string,
  symbol: string,
  name: string,
  pctOfPortfolio: number,
): StoredPosition {
  return {
    accountId,
    instrumentId: `us_${symbol.toLowerCase()}`,
    symbol,
    name,
    // Deliberately non-trivial: if any of these three ever reach the wire the
    // privacy test below has something unmistakable to catch.
    qty: 137,
    avgCost: 812.25,
    mktValue: 111_278.5,
    pctOfPortfolio,
    updatedAt: AT,
  };
}

before(async () => {
  storage = await createStorage(":memory:");
  config = loadConfig({
    NODE_ENV: "test",
    APP_SECRET: "positions-test-secret",
    APP_URL,
  } as NodeJS.ProcessEnv);

  for (const [id, name, visibility, role] of [
    ["m1", "Shubham", "named", "admin"],
    ["m2", "Rahul", "paused", "member"],
    ["m3", "Anjali", "anonymous", "member"],
    ["m4", "Vikram", "named", "member"],
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
  // m5 exists as a member but has never been provisioned an account.
  await storage.upsertMember({
    id: "m5",
    name: "Neha",
    visibility: "named",
    role: "member",
    createdAt: AT,
  });

  await storage.replaceCurrentPositions("a-m1", [
    held("a-m1", "AAPL", "Apple Inc", 18.2),
    held("a-m1", "NVDA", "NVIDIA Corp", 41.5),
    held("a-m1", "MSFT", "Microsoft Corp", 18.2),
    held("a-m1", "GOOGL", "Alphabet Inc", 22.1),
  ]);
  await storage.replaceCurrentPositions("a-m2", [
    held("a-m2", "TSLA", "Tesla Inc", 60),
    held("a-m2", "AMZN", "Amazon.com Inc", 40),
  ]);
  await storage.replaceCurrentPositions("a-m3", [
    held("a-m3", "MSFT", "Microsoft Corp", 100),
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

describe("the positions gate", () => {
  test("reading anyone's holdings needs a session", async () => {
    const res = await positionsRequest("m1", "");
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  });

  test("a member who does not exist is a 404, not an empty portfolio", async () => {
    const res = await positionsRequest("nobody");
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "unknown_member" });
  });
});

describe("the wire shape", () => {
  test("identity and weight, largest first", async () => {
    const rows = await positions("m1");
    assert.deepEqual(
      rows.map((r) => [r.symbol, r.pctOfPortfolio]),
      [
        ["NVDA", 41.5],
        ["GOOGL", 22.1],
        // Equal weights: symbol breaks the tie, so the order is stable.
        ["AAPL", 18.2],
        ["MSFT", 18.2],
      ],
    );
    assert.deepEqual(rows[0], {
      instrumentId: "us_nvda",
      symbol: "NVDA",
      name: "NVIDIA Corp",
      pctOfPortfolio: 41.5,
      updatedAt: AT,
    } satisfies Holding);
  });

  /**
   * The privacy boundary, asserted against the raw response text rather than
   * the parsed rows: a key added by a careless spread would still be there in
   * the bytes even if nothing in the type system noticed.
   */
  test("no quantity, no cost, no value — not in the keys, not in the bytes", async () => {
    const res = await positionsRequest("m1");
    const body = await res.text();

    for (const forbidden of ["qty", "avgCost", "avg_cost", "mktValue", "mkt_value", "accountId"]) {
      assert.equal(
        body.includes(forbidden),
        false,
        `${forbidden} reached the wire`,
      );
    }
    for (const amount of ["137", "812.25", "111278.5"]) {
      assert.equal(body.includes(amount), false, `${amount} reached the wire`);
    }

    const allowed = new Set([
      "instrumentId",
      "symbol",
      "name",
      "pctOfPortfolio",
      "updatedAt",
    ]);
    for (const row of JSON.parse(body) as Record<string, unknown>[]) {
      assert.deepEqual(
        Object.keys(row).filter((key) => !allowed.has(key)),
        [],
      );
    }
  });
});

describe("visibility", () => {
  test("a paused member's holdings are empty to the group, like their feed", async () => {
    assert.deepEqual(await positions("m2"), []);

    // Same treatment the feed gives them, from the same reader.
    const feed = await app.request("/api/feed?accountId=m2", {
      headers: { cookie },
    });
    assert.deepEqual(await feed.json(), []);
  });

  test("a paused member still sees their own holdings", async () => {
    const own = await signIn("m2");
    const rows = await positions("m2", own);
    assert.deepEqual(
      rows.map((r) => r.symbol),
      ["TSLA", "AMZN"],
    );
  });

  test("an anonymous member's holdings are visible; the panel carries no name", async () => {
    const rows = await positions("m3");
    assert.deepEqual(
      rows.map((r) => r.symbol),
      ["MSFT"],
    );
    // Nothing in this payload attributes anything to anybody — naming is the
    // member page's job, exactly as it is for that member's feed.
    assert.equal(JSON.stringify(rows).includes("Anjali"), false);
  });

  test("empty is empty: connected with nothing held, and no account at all", async () => {
    assert.deepEqual(await positions("m4"), []);
    assert.deepEqual(await positions("m5"), []);
  });
});
