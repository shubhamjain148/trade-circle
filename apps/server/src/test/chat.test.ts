import assert from "node:assert/strict";
import { after as afterAll, before, describe, test } from "node:test";
import type { Hono } from "hono";
import { createApp } from "../api.js";
import type { SessionEnv } from "../auth/session.js";
import { Vault } from "../auth/vault.js";
import { MAX_BODY_LENGTH } from "../chat.js";
import { loadConfig, type Config } from "../config.js";
import { toFeedEventRow } from "../diff/index.js";
import { createInvite } from "../invite.js";
import type { McpDeps } from "../mcp/oauth.js";
import type { TickResult } from "../poller/tick.js";
import { createStorage, type Storage } from "../storage/index.js";
import type { ChatPage, FeedEvent, TimelineItem } from "../types.js";

// The chat timeline end to end over the real Hono app. No poller, no MCP: the
// feed events are written straight to storage so their timestamps can be
// interleaved with messages to the millisecond.

const APP_URL = "http://127.0.0.1:3002";

/**
 * Backdated clock: every hand-written row lands in the past, so a message
 * POSTed during the run (stamped with the real clock) is always the newest
 * thing in the timeline. Ordering here is arithmetic, not a race.
 */
const BASE = Date.now() - 3 * 3_600_000;
const T = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();
const secondsAfter = (iso: string, seconds: number) =>
  new Date(Date.parse(iso) + seconds * 1000).toISOString();

let storage: Storage;
let config: Config;
let app: Hono<SessionEnv>;
let cookie = "";
/** Timestamps the cursor tests hand forward to each other. */
let eventAt = "";
let tieAt = "";

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

async function chat(query = ""): Promise<ChatPage> {
  const res = await app.request(`/api/chat${query}`, { headers: { cookie } });
  assert.equal(res.status, 200);
  return (await res.json()) as ChatPage;
}

async function say(body: string, as = cookie) {
  return app.request("/api/chat", {
    method: "POST",
    headers: { cookie: as, "content-type": "application/json" },
    body: JSON.stringify({ body }),
  });
}

function event(accountId: string, symbol: string, detectedAt: string) {
  return toFeedEventRow({
    accountId,
    type: "NEW_POSITION",
    instrumentId: symbol.toLowerCase(),
    symbol,
    instrumentName: `${symbol} Inc`,
    pctOfPortfolio: 12.5,
    qtyChangePct: null,
    detectedAt,
    qtyBefore: 0,
    qtyAfter: 10,
    avgCostBefore: null,
    avgCostAfter: 100,
    mktValueBefore: null,
    mktValueAfter: 1000,
    ratio: null,
    suppressed: false,
    suppressReason: null,
  });
}

before(async () => {
  storage = await createStorage(":memory:");
  config = loadConfig({
    NODE_ENV: "test",
    APP_SECRET: "chat-test-secret",
    APP_URL,
  } as NodeJS.ProcessEnv);

  for (const [id, name, visibility] of [
    ["m1", "Shubham", "named"],
    ["m2", "Rahul", "named"],
    ["m3", "Anjali", "paused"],
  ] as const) {
    await storage.upsertMember({ id, name, visibility, createdAt: T(-60) });
    await storage.upsertAccount({
      id: `a-${id}`,
      memberId: id,
      provider: "indmoney",
      status: "active",
      lastPolledAt: null,
    });
  }

  const poll = async (): Promise<TickResult> => ({
    at: T(0),
    polled: [],
    unchanged: [],
    skipped: [],
    errors: [],
    events: 0,
    suppressed: 0,
  });
  const mcp: McpDeps = { storage, vault: new Vault(config.appSecret), config };
  app = createApp({ storage, poll, config, mcp });
  cookie = await signIn("m1");
});

afterAll(async () => {
  await storage.close();
});

describe("chat auth", () => {
  test("reading and posting both need a session", async () => {
    assert.equal((await app.request("/api/chat")).status, 401);
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hi" }),
    });
    assert.equal(res.status, 401);
  });
});

describe("posting", () => {
  test("a message comes back and then reads back", async () => {
    const res = await say("nvda into earnings, anyone else?");
    assert.equal(res.status, 201);
    const item = (await res.json()) as TimelineItem;
    assert.equal(item.kind, "message");
    assert.equal(item.memberId, "m1");
    assert.equal(item.authorName, "Shubham");
    assert.equal(item.body, "nvda into earnings, anyone else?");

    const page = await chat();
    const last = page.items.at(-1)!;
    assert.equal(last.kind, "message");
    assert.equal(last.id, item.id);
    assert.equal(page.cursor, `${item.createdAt}|${item.id}`);
  });

  test("bodies are trimmed, and empty ones are not messages", async () => {
    const res = await say("   spaces   ");
    const item = (await res.json()) as TimelineItem;
    assert.equal(item.kind === "message" && item.body, "spaces");

    assert.equal((await say("")).status, 400);
    assert.equal((await say("   \n  ")).status, 400);
  });

  test("the length cap is enforced at the boundary", async () => {
    const atCap = await say("x".repeat(MAX_BODY_LENGTH));
    assert.equal(atCap.status, 201);

    const overCap = await say("x".repeat(MAX_BODY_LENGTH + 1));
    assert.equal(overCap.status, 400);
    assert.deepEqual(await overCap.json(), {
      error: "body_too_long",
      max: MAX_BODY_LENGTH,
    });
  });
});

describe("the merged timeline", () => {
  test("messages and events interleave in chronological order", async () => {
    await storage.insertMessage({
      id: "msg-a",
      memberId: "m1",
      body: "watching AAPL",
      createdAt: T(10),
    });
    await storage.insertMessage({
      id: "msg-b",
      memberId: "m2",
      body: "in on TSLA",
      createdAt: T(30),
    });
    await storage.insertFeedEvents([
      event("a-m2", "TSLA", T(20)),
      event("a-m1", "AAPL", T(40)),
    ]);

    const page = await chat();
    const window = page.items.filter((i) => {
      const at = i.kind === "message" ? i.createdAt : i.detectedAt;
      return at >= T(10) && at <= T(40);
    });
    assert.deepEqual(
      window.map((i) => [i.kind, i.kind === "message" ? i.body : i.symbol]),
      [
        ["message", "watching AAPL"],
        ["event", "TSLA"],
        ["message", "in on TSLA"],
        ["event", "AAPL"],
      ],
    );

    // Events keep the /api/feed wire shape, so the same row renders either way.
    const tsla = window[1] as { kind: "event" } & FeedEvent;
    assert.equal(tsla.accountId, "m2");
    assert.equal(tsla.accountName, "Rahul");
    assert.equal(tsla.pctOfPortfolio, 12.5);
  });

  test("a paused member's moves stay out, their words do not", async () => {
    await storage.insertFeedEvents([event("a-m3", "SECRET", T(50))]);
    await storage.insertMessage({
      id: "msg-c",
      memberId: "m3",
      body: "no comment",
      createdAt: T(51),
    });

    const page = await chat();
    assert.equal(
      page.items.some((i) => i.kind === "event" && i.symbol === "SECRET"),
      false,
      "a paused member publishes no moves",
    );
    const said = page.items.find((i) => i.kind === "message" && i.id === "msg-c");
    assert.ok(said && said.kind === "message");
    assert.equal(said.authorName, "Anjali");
  });

  test("an anonymous member's moves lose the name but keep the row", async () => {
    await storage.upsertMember({
      id: "m2",
      name: "Rahul",
      visibility: "anonymous",
      createdAt: T(-60),
    });
    await storage.insertFeedEvents([event("a-m2", "MSFT", T(60))]);

    const msft = (await chat()).items.find(
      (i) => i.kind === "event" && i.symbol === "MSFT",
    );
    assert.ok(msft && msft.kind === "event");
    assert.equal(msft.accountName, "Someone in the group");

    await storage.upsertMember({
      id: "m2",
      name: "Rahul",
      visibility: "named",
      createdAt: T(-60),
    });
  });
});

describe("the cursor", () => {
  test("an idle poll returns nothing and holds its place", async () => {
    const { cursor } = await chat();
    const idle = await chat(`?after=${encodeURIComponent(cursor)}`);
    assert.deepEqual(idle.items, []);
    assert.equal(idle.cursor, cursor);
  });

  test("a poll returns only what landed after it", async () => {
    const { cursor } = await chat();

    const posted = (await (await say("bought some GOOGL too")).json()) as TimelineItem;
    assert.equal(posted.kind, "message");
    // A minute later, the watcher notices the trade behind that message.
    eventAt = secondsAfter(posted.createdAt, 60);
    await storage.insertFeedEvents([event("a-m1", "GOOGL", eventAt)]);

    const page = await chat(`?after=${encodeURIComponent(cursor)}`);
    assert.deepEqual(
      page.items.map((i) => (i.kind === "event" ? i.symbol : i.id)),
      [posted.id, "GOOGL"],
    );
    assert.notEqual(page.cursor, cursor);

    // And the poll after that is idle again.
    const next = await chat(`?after=${encodeURIComponent(page.cursor)}`);
    assert.deepEqual(next.items, []);
  });

  test("same-timestamp items are ordered by id, and neither is skipped", async () => {
    const { cursor } = await chat();
    tieAt = secondsAfter(eventAt, 60);
    await storage.insertMessage({
      id: "tie-b",
      memberId: "m1",
      body: "second",
      createdAt: tieAt,
    });
    await storage.insertMessage({
      id: "tie-a",
      memberId: "m1",
      body: "first",
      createdAt: tieAt,
    });

    const page = await chat(`?after=${encodeURIComponent(cursor)}`);
    assert.deepEqual(
      page.items.map((i) => i.id),
      ["tie-a", "tie-b"],
    );

    // Poll from between the two: the later one must still arrive exactly once.
    const between = await chat(`?after=${encodeURIComponent(`${tieAt}|tie-a`)}`);
    assert.deepEqual(
      between.items.map((i) => i.id),
      ["tie-b"],
    );
  });

  test("an unreadable cursor self-heals into a full page", async () => {
    const page = await chat("?after=garbage");
    assert.ok(page.items.length > 1);
    assert.equal(page.cursor, `${tieAt}|tie-b`);
  });
});

describe("the feed is untouched", () => {
  test("/api/feed still answers with its own newest-first array", async () => {
    const res = await app.request("/api/feed", { headers: { cookie } });
    assert.equal(res.status, 200);
    const events = (await res.json()) as FeedEvent[];
    assert.ok(Array.isArray(events));
    assert.equal(events[0].symbol, "GOOGL", "newest first");
    assert.equal(
      events.some((e) => e.symbol === "SECRET"),
      false,
    );

    const mine = (await (
      await app.request("/api/feed?accountId=m1", { headers: { cookie } })
    ).json()) as FeedEvent[];
    assert.ok(mine.length > 0);
    assert.ok(mine.every((e) => e.accountId === "m1"));
  });
});
