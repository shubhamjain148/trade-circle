import assert from "node:assert/strict";
import { after as afterAll, before, describe, test } from "node:test";
import type { Hono } from "hono";
import { createApp } from "../api.js";
import type { SessionEnv } from "../auth/session.js";
import { Vault } from "../auth/vault.js";
import { loadConfig, type Config } from "../config.js";
import { createInvite } from "../invite.js";
import type { McpDeps } from "../mcp/oauth.js";
import { MockPortfolioSource } from "../poller/source.js";
import { runPollTick, type TickResult } from "../poller/tick.js";
import {
  noopNotifier,
  notifyFeedEvents,
  parseClientMessage,
  personaliseReactions,
  relayTypingAt,
  TYPING_MIN_GAP_MS,
  type Notifier,
  type ReactionBroadcastMap,
  type Room,
  type RoomMember,
} from "../room.js";
import { createStorage, type Storage } from "../storage/index.js";
import type { TimelineItem } from "../types.js";

/**
 * The room seam, tested where it can be tested under Node: the interface, the
 * projection, the throttle, and the two places the Worker is supposed to reach
 * for it. The Durable Object itself is not here — a hibernating WebSocket needs
 * workerd, and `wrangler dev` is where that gets exercised.
 */

const APP_URL = "http://127.0.0.1:3004";

const BASE = Date.now() - 3 * 3_600_000;
const T = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();

/** Records what the Worker would have pushed, and can be told to fail. */
class FakeRoom implements Room {
  readonly broadcasts: TimelineItem[][] = [];
  readonly reactionBroadcasts: ReactionBroadcastMap[] = [];
  readonly upgrades: { url: string; member: RoomMember }[] = [];
  fails = false;

  async broadcast(items: TimelineItem[]): Promise<void> {
    if (this.fails) throw new Error("room unreachable");
    this.broadcasts.push(items);
  }

  async broadcastReactions(reactions: ReactionBroadcastMap): Promise<void> {
    if (this.fails) throw new Error("room unreachable");
    this.reactionBroadcasts.push(reactions);
  }

  async upgrade(request: Request, member: RoomMember): Promise<Response> {
    this.upgrades.push({ url: request.url, member });
    // Not a real 101: undici refuses to construct one, and the handshake is
    // workerd's job anyway. What this asserts is that the request got here.
    return new Response(null, { status: 200, headers: { "x-fake-upgrade": "1" } });
  }
}

let storage: Storage;
let config: Config;
let room: FakeRoom;
let app: Hono<SessionEnv>;
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

before(async () => {
  storage = await createStorage(":memory:");
  config = loadConfig({
    NODE_ENV: "test",
    APP_SECRET: "room-test-secret",
    APP_URL,
  } as NodeJS.ProcessEnv);

  for (const [id, name, visibility, role] of [
    ["m1", "Shubham", "named", "admin"],
    ["m2", "Rahul", "anonymous", "member"],
    ["m3", "Anjali", "paused", "member"],
  ] as const) {
    await storage.upsertMember({ id, name, visibility, role, createdAt: T(-60) });
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
  room = new FakeRoom();
  app = createApp({ storage, poll, pollOne: poll, config, mcp, room });
  cookie = await signIn("m1");
});

afterAll(async () => {
  await storage.close();
});

describe("the typing throttle", () => {
  test("the first signal from a member always goes out", () => {
    assert.equal(relayTypingAt(undefined, 1_000), 1_000);
  });

  test("a second signal inside the gap is dropped", () => {
    assert.equal(relayTypingAt(1_000, 1_000 + TYPING_MIN_GAP_MS - 1), null);
  });

  test("the gap is inclusive at its own boundary", () => {
    const now = 1_000 + TYPING_MIN_GAP_MS;
    assert.equal(relayTypingAt(1_000, now), now);
  });

  test("relaying advances the clock, so a fast typist costs a fixed rate", () => {
    let last: number | undefined;
    let relayed = 0;
    // One keystroke every 100 ms for ten seconds — a hundred signals.
    for (let now = 0; now < 10_000; now += 100) {
      const at = relayTypingAt(last, now);
      if (at === null) continue;
      last = at;
      relayed += 1;
    }
    assert.equal(relayed, 10_000 / TYPING_MIN_GAP_MS);
  });
});

describe("client frames", () => {
  test("a typing frame is the only thing that parses", () => {
    assert.deepEqual(parseClientMessage('{"type":"typing"}'), { type: "typing" });
  });

  test("junk, binary, unknown types and oversized frames are all dropped", () => {
    assert.equal(parseClientMessage("not json"), undefined);
    assert.equal(parseClientMessage("null"), undefined);
    assert.equal(parseClientMessage('"typing"'), undefined);
    assert.equal(parseClientMessage('{"type":"message","body":"hi"}'), undefined);
    assert.equal(parseClientMessage(new ArrayBuffer(8)), undefined);
    assert.equal(
      parseClientMessage(`{"type":"typing","pad":"${"x".repeat(400)}"}`),
      undefined,
    );
  });
});

describe("notifyFeedEvents", () => {
  test("broadcasts wire-shaped items and applies visibility", async () => {
    const sent: TimelineItem[][] = [];
    const notifier: Notifier = {
      async broadcast(items) {
        sent.push(items);
      },
    };

    await notifyFeedEvents(storage, notifier, [
      row("a-m1", "AAPL", T(10)),
      row("a-m2", "MSFT", T(11)),
      row("a-m3", "SECRET", T(12)),
    ]);

    assert.equal(sent.length, 1);
    const items = sent[0];
    // m3 is paused: their move never reaches a socket, exactly as it never
    // reaches a poll.
    assert.deepEqual(
      items.map((i) => (i.kind === "event" ? i.symbol : i.id)),
      ["AAPL", "MSFT"],
    );
    assert.ok(items.every((i) => i.kind === "event"));
    const msft = items[1];
    assert.ok(msft.kind === "event");
    // m2 is anonymous: the row survives, the name does not.
    assert.equal(msft.accountName, "Someone in the group");
    assert.equal(msft.pctOfPortfolio, 12.5);
  });

  test("an empty batch never reaches the room", async () => {
    let called = false;
    await notifyFeedEvents(storage, {
      async broadcast() {
        called = true;
      },
    }, []);
    assert.equal(called, false);
  });

  test("the default notifier is inert", async () => {
    await noopNotifier.broadcast([]);
  });
});

describe("POST /api/chat", () => {
  test("hands the persisted row to the room, once", async () => {
    const before = room.broadcasts.length;
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ body: "anyone still in NVDA?" }),
    });
    assert.equal(res.status, 201);
    const saved = (await res.json()) as TimelineItem;

    assert.equal(room.broadcasts.length, before + 1);
    const pushed = room.broadcasts.at(-1)!;
    assert.equal(pushed.length, 1);
    // The same id and timestamp the author was told about, so every other tab
    // dedupes it against its own next poll rather than double-rendering it.
    assert.deepEqual(pushed[0], saved);
  });

  test("a rejected message is never broadcast", async () => {
    const before = room.broadcasts.length;
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ body: "   " }),
    });
    assert.equal(res.status, 400);
    assert.equal(room.broadcasts.length, before);
  });
});

describe("reaction broadcasts", () => {
  test("`mine` is decided per socket, not per broadcast", () => {
    const broadcast: ReactionBroadcastMap = {
      "message:m-1": [
        { emoji: "🚀", count: 2, who: ["Shubham", "Rahul"], memberIds: ["m1", "m2"] },
        { emoji: "💀", count: 1, who: ["Rahul"], memberIds: ["m2"] },
      ],
    };

    // The same frame, read by two different people in the same room.
    assert.deepEqual(personaliseReactions(broadcast, "m1"), {
      "message:m-1": [
        { emoji: "🚀", count: 2, mine: true, who: ["Shubham", "Rahul"] },
        { emoji: "💀", count: 1, mine: false, who: ["Rahul"] },
      ],
    });
    assert.deepEqual(personaliseReactions(broadcast, "m2"), {
      "message:m-1": [
        { emoji: "🚀", count: 2, mine: true, who: ["Shubham", "Rahul"] },
        { emoji: "💀", count: 1, mine: true, who: ["Rahul"] },
      ],
    });
    // Nobody: an unattached socket sees the counts and none of them as its own.
    assert.deepEqual(personaliseReactions(broadcast, ""), {
      "message:m-1": [
        { emoji: "🚀", count: 2, mine: false, who: ["Shubham", "Rahul"] },
        { emoji: "💀", count: 1, mine: false, who: ["Rahul"] },
      ],
    });
  });

  test("member ids never survive personalisation", () => {
    const out = personaliseReactions(
      { "event:e-1": [{ emoji: "🔥", count: 1, who: ["Rahul"], memberIds: ["m2"] }] },
      "m1",
    );
    assert.equal("memberIds" in out["event:e-1"][0], false);
  });
});

describe("PUT/DELETE /api/chat/reactions", () => {
  test("a toggle reaches the room with reactor ids attached", async () => {
    const posted = await app.request("/api/chat", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ body: "TSLA looks done" }),
    });
    const message = (await posted.json()) as TimelineItem;

    const before = room.reactionBroadcasts.length;
    const res = await app.request("/api/chat/reactions", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ itemKind: "message", itemId: message.id, emoji: "💀" }),
    });
    assert.equal(res.status, 200);

    assert.equal(room.reactionBroadcasts.length, before + 1);
    const pushed = room.reactionBroadcasts.at(-1)!;
    assert.deepEqual(pushed, {
      [`message:${message.id}`]: [
        { emoji: "💀", count: 1, who: ["Shubham"], memberIds: ["m1"] },
      ],
    });
  });

  test("removing broadcasts the empty summary, not silence", async () => {
    const posted = await app.request("/api/chat", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ body: "or not" }),
    });
    const message = (await posted.json()) as TimelineItem;
    const body = JSON.stringify({
      itemKind: "message",
      itemId: message.id,
      emoji: "👀",
    });

    await app.request("/api/chat/reactions", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body,
    });
    const before = room.reactionBroadcasts.length;
    await app.request("/api/chat/reactions", {
      method: "DELETE",
      headers: { cookie, "content-type": "application/json" },
      body,
    });

    assert.equal(room.reactionBroadcasts.length, before + 1);
    // An explicit empty array is the message: "clear the pills you are showing".
    assert.deepEqual(room.reactionBroadcasts.at(-1), {
      [`message:${message.id}`]: [],
    });
  });

  test("a rejected toggle is never broadcast", async () => {
    const before = room.reactionBroadcasts.length;
    const res = await app.request("/api/chat/reactions", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ itemKind: "message", itemId: "x", emoji: "🦄" }),
    });
    assert.equal(res.status, 400);
    assert.equal(room.reactionBroadcasts.length, before);
  });
});

describe("GET /api/chat/ws", () => {
  test("needs a session before it needs anything else", async () => {
    const res = await app.request("/api/chat/ws", {
      headers: { upgrade: "websocket" },
    });
    assert.equal(res.status, 401);
    assert.equal(room.upgrades.length, 0);
  });

  test("a plain GET is told to upgrade rather than handed to the room", async () => {
    const res = await app.request("/api/chat/ws", { headers: { cookie } });
    assert.equal(res.status, 426);
    assert.equal(room.upgrades.length, 0);
  });

  test("a signed-in upgrade reaches the room with the member attached", async () => {
    const res = await app.request("/api/chat/ws", {
      headers: { cookie, upgrade: "WebSocket" },
    });
    assert.equal(res.headers.get("x-fake-upgrade"), "1");
    assert.equal(room.upgrades.length, 1);
    assert.deepEqual(room.upgrades[0].member, { id: "m1", name: "Shubham" });
  });

  test("without a room it is 501, not 500 — the client falls back to polling", async () => {
    const mcp: McpDeps = { storage, vault: new Vault(config.appSecret), config };
    const poll = async (): Promise<TickResult> => ({
      at: T(0),
      polled: [],
      unchanged: [],
      skipped: [],
      errors: [],
      events: 0,
      suppressed: 0,
    });
    const node = createApp({ storage, poll, pollOne: poll, config, mcp });

    const res = await node.request("/api/chat/ws", {
      headers: { cookie, upgrade: "websocket" },
    });
    assert.equal(res.status, 501);
    assert.deepEqual(await res.json(), { error: "websocket_unsupported" });

    // And the rest of chat is untouched by the room's absence.
    const posted = await node.request("/api/chat", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ body: "polling is fine" }),
    });
    assert.equal(posted.status, 201);
  });
});

describe("a poll tick", () => {
  test("publishes its new events and nothing else", async () => {
    const account = await freshAccount();
    const notifier = new FakeRoom();
    const source = new MockPortfolioSource({
      [account]: [[], [position("aapl", "AAPL", 10)]],
    });

    // Frame 0: an empty baseline against no history, so nothing diffs.
    await runPollTick(storage, source, { accountIds: [account], notifier });
    assert.equal(notifier.broadcasts.length, 0);

    source.advance();
    const result = await runPollTick(storage, source, {
      accountIds: [account],
      notifier,
    });

    assert.equal(result.events, 1);
    assert.equal(notifier.broadcasts.length, 1);
    const items = notifier.broadcasts[0];
    assert.equal(items.length, 1);
    assert.ok(items[0].kind === "event");
    assert.equal(items[0].symbol, "AAPL");
    // The id the room saw is the id D1 stored — the client dedupes on it.
    const stored = await storage.listFeedEvents({ limit: 500 });
    assert.ok(stored.some((r) => r.id === items[0].id));
  });

  test("an idle tick says nothing at all", async () => {
    const account = await freshAccount();
    const notifier = new FakeRoom();
    const source = new MockPortfolioSource({
      [account]: [[position("aapl", "AAPL", 10)]],
    });

    await runPollTick(storage, source, { accountIds: [account], notifier });
    notifier.broadcasts.length = 0;

    // Same frame, second pass: the cheap probe short-circuits and nothing moved,
    // so there is nothing worth waking the room for.
    await runPollTick(storage, source, { accountIds: [account], notifier });
    assert.deepEqual(notifier.broadcasts, []);
  });

  test("a dead room does not fail a tick that already wrote to D1", async () => {
    const account = await freshAccount();
    const notifier = new FakeRoom();
    notifier.fails = true;
    const source = new MockPortfolioSource({
      [account]: [[position("aapl", "AAPL", 10)], [position("aapl", "AAPL", 25)]],
    });

    await runPollTick(storage, source, { accountIds: [account], notifier });
    source.advance();
    const result = await runPollTick(storage, source, {
      accountIds: [account],
      notifier,
    });

    assert.deepEqual(result.errors, []);
    assert.equal(result.events, 1);
    const stored = await storage.listFeedEvents({ limit: 500 });
    assert.ok(stored.some((r) => r.accountId === account && r.type === "SIZE_UP"));
  });
});

/** A member and account nobody else in this file has a history with. */
let ticker = 0;
async function freshAccount(): Promise<string> {
  ticker += 1;
  const id = `t${ticker}`;
  await storage.upsertMember({
    id,
    name: `Tester ${ticker}`,
    visibility: "named",
    role: "member",
    createdAt: T(-60),
  });
  await storage.upsertAccount({
    id: `a-${id}`,
    memberId: id,
    provider: "indmoney",
    status: "active",
    lastPolledAt: null,
  });
  return `a-${id}`;
}

function position(instrumentId: string, symbol: string, qty: number) {
  return {
    instrumentId,
    symbol,
    name: `${symbol} Inc`,
    qty,
    avgCost: 100,
    mktValue: qty * 100,
  };
}

function row(accountId: string, symbol: string, detectedAt: string) {
  return {
    id: `evt-${accountId}-${symbol}`,
    accountId,
    type: "NEW_POSITION" as const,
    instrumentId: symbol.toLowerCase(),
    symbol,
    instrumentName: `${symbol} Inc`,
    pctOfPortfolio: 12.5,
    qtyChangePct: null,
    detectedAt,
    suppressed: false,
    suppressReason: null,
  };
}
