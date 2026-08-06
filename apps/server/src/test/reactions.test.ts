import assert from "node:assert/strict";
import { after as afterAll, before, describe, test } from "node:test";
import type { Hono } from "hono";
import { createApp } from "../api.js";
import type { SessionEnv } from "../auth/session.js";
import { Vault } from "../auth/vault.js";
import { reactionKey, REACTION_EMOJI } from "../chat.js";
import { loadConfig, type Config } from "../config.js";
import { toFeedEventRow } from "../diff/index.js";
import { createInvite } from "../invite.js";
import type { McpDeps } from "../mcp/oauth.js";
import type { TickResult } from "../poller/tick.js";
import { createStorage, type Storage } from "../storage/index.js";
import type { ChatPage, ReactionUpdate, TimelineItem } from "../types.js";

/**
 * Reactions end to end over the real Hono app: the toggle, the summary shape,
 * and — the part worth the most attention — how a cursor-based poll ever hears
 * about a 🚀 landing on a message it stopped asking about an hour ago.
 */

const APP_URL = "http://127.0.0.1:3005";

const BASE = Date.now() - 3 * 3_600_000;
const T = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();

let storage: Storage;
let config: Config;
let app: Hono<SessionEnv>;
/** Two signed-in friends, because half of this feature is "what B sees". */
let shubham = "";
let rahul = "";

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

async function chat(query = "", as = shubham): Promise<ChatPage> {
  const res = await app.request(`/api/chat${query}`, { headers: { cookie: as } });
  assert.equal(res.status, 200);
  return (await res.json()) as ChatPage;
}

function toggle(
  method: "PUT" | "DELETE",
  body: Record<string, unknown>,
  as = shubham,
) {
  return app.request("/api/chat/reactions", {
    method,
    headers: { cookie: as, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function react(
  method: "PUT" | "DELETE",
  itemKind: string,
  itemId: string,
  emoji: string,
  as = shubham,
): Promise<ReactionUpdate> {
  const res = await toggle(method, { itemKind, itemId, emoji }, as);
  assert.equal(res.status, 200);
  return (await res.json()) as ReactionUpdate;
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

/** An old message and an old event, both far behind any live cursor. */
const OLD_MESSAGE = "old-msg";
let oldEventId = "";

before(async () => {
  storage = await createStorage(":memory:");
  config = loadConfig({
    NODE_ENV: "test",
    APP_SECRET: "reactions-test-secret",
    APP_URL,
  } as NodeJS.ProcessEnv);

  for (const [id, name, visibility, role] of [
    ["m1", "Shubham", "named", "admin"],
    ["m2", "Rahul", "named", "member"],
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

  await storage.insertMessage({
    id: OLD_MESSAGE,
    memberId: "m2",
    body: "opened NVDA",
    createdAt: T(10),
  });
  const row = event("a-m2", "NVDA", T(11));
  oldEventId = row.id;
  await storage.insertFeedEvents([row]);

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
  app = createApp({ storage, poll, pollOne: poll, config, mcp });
  shubham = await signIn("m1");
  rahul = await signIn("m2");
});

afterAll(async () => {
  await storage.close();
});

describe("auth", () => {
  test("both verbs need a session", async () => {
    for (const method of ["PUT", "DELETE"] as const) {
      const res = await app.request("/api/chat/reactions", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          itemKind: "message",
          itemId: OLD_MESSAGE,
          emoji: "🚀",
        }),
      });
      assert.equal(res.status, 401);
    }
  });

  test("a reaction is attributed to the session, never to the body", async () => {
    // There is no memberId field to spoof — the only member a request can name
    // is the one holding the cookie. Rahul's tap is Rahul's, whatever it says.
    const res = await toggle(
      "PUT",
      { itemKind: "message", itemId: OLD_MESSAGE, emoji: "🔥", memberId: "m1" },
      rahul,
    );
    assert.equal(res.status, 200);
    const update = (await res.json()) as ReactionUpdate;
    assert.deepEqual(
      update.reactions.find((r) => r.emoji === "🔥")?.who,
      ["Rahul"],
    );
    await react("DELETE", "message", OLD_MESSAGE, "🔥", rahul);
  });
});

describe("the request boundary", () => {
  test("only the curated emoji are writable", async () => {
    const res = await toggle("PUT", {
      itemKind: "message",
      itemId: OLD_MESSAGE,
      emoji: "🦄",
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "unsupported_emoji" });

    // Not a picker, and not a free-text column: eight, and they all work.
    assert.equal(new Set(REACTION_EMOJI).size, REACTION_EMOJI.length);
    for (const emoji of REACTION_EMOJI) {
      const ok = await toggle("PUT", {
        itemKind: "message",
        itemId: OLD_MESSAGE,
        emoji,
      });
      assert.equal(ok.status, 200, `${emoji} should be allowed`);
      await react("DELETE", "message", OLD_MESSAGE, emoji);
    }
  });

  test("the item kind is a closed set", async () => {
    const res = await toggle("PUT", {
      itemKind: "holding",
      itemId: OLD_MESSAGE,
      emoji: "🚀",
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "invalid_item_kind" });
  });

  test("an empty item id is not an item", async () => {
    const res = await toggle("PUT", {
      itemKind: "message",
      itemId: "   ",
      emoji: "🚀",
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "invalid_item_id" });
  });
});

describe("the toggle", () => {
  test("adding twice is adding once", async () => {
    const first = await react("PUT", "message", OLD_MESSAGE, "🚀");
    assert.deepEqual(first.reactions, [
      { emoji: "🚀", count: 1, mine: true, who: ["Shubham"] },
    ]);

    // The same tap replayed — a double tap, a retry, a second tab.
    const again = await react("PUT", "message", OLD_MESSAGE, "🚀");
    assert.deepEqual(again.reactions, first.reactions);
  });

  test("removing twice is removing once", async () => {
    await react("PUT", "message", OLD_MESSAGE, "👀");
    const gone = await react("DELETE", "message", OLD_MESSAGE, "👀");
    assert.equal(
      gone.reactions.some((r) => r.emoji === "👀"),
      false,
    );
    const stillGone = await react("DELETE", "message", OLD_MESSAGE, "👀");
    assert.deepEqual(stillGone.reactions, gone.reactions);
  });

  test("one member may hold several different emoji on one item", async () => {
    await react("PUT", "message", OLD_MESSAGE, "💎");
    const update = await react("PUT", "message", OLD_MESSAGE, "🧠");
    const mine = update.reactions.filter((r) => r.mine).map((r) => r.emoji);
    // 🚀 from the test above, plus the two just added: different emoji from the
    // same member on the same item are different rows, on purpose.
    assert.deepEqual([...mine].sort(), ["🚀", "💎", "🧠"].sort());

    await react("DELETE", "message", OLD_MESSAGE, "💎");
    await react("DELETE", "message", OLD_MESSAGE, "🧠");
  });

  test("a trade band reacts exactly like a sentence does", async () => {
    const update = await react("PUT", "event", oldEventId, "🚀");
    assert.equal(update.itemKind, "event");
    assert.deepEqual(update.reactions, [
      { emoji: "🚀", count: 1, mine: true, who: ["Shubham"] },
    ]);
  });
});

describe("the summary shape", () => {
  test("counts aggregate, `mine` is per reader, `who` names everyone", async () => {
    await react("PUT", "event", oldEventId, "🚀", rahul);

    const asShubham = await react("PUT", "event", oldEventId, "🚀");
    assert.deepEqual(asShubham.reactions, [
      // Shubham reacted first (in the test above), so he leads the pile-on.
      { emoji: "🚀", count: 2, mine: true, who: ["Shubham", "Rahul"] },
    ]);

    // Same item, different reader: only `mine` moves.
    const page = await chat("", rahul);
    const summary = page.reactions[reactionKey("event", oldEventId)];
    assert.deepEqual(summary, [
      { emoji: "🚀", count: 2, mine: true, who: ["Shubham", "Rahul"] },
    ]);
  });

  test("reactions are named even when the reactor's trades are not", async () => {
    // Rahul goes anonymous: his *moves* lose his name, his 🚀 does not.
    await storage.upsertMember({
      id: "m2",
      name: "Rahul",
      visibility: "anonymous",
      role: "member",
      createdAt: T(-60),
    });

    const page = await chat();
    const summary = page.reactions[reactionKey("event", oldEventId)];
    assert.deepEqual(summary?.[0].who, ["Shubham", "Rahul"]);

    const band = page.items.find((i) => i.kind === "event" && i.id === oldEventId);
    assert.ok(band && band.kind === "event");
    assert.equal(band.accountName, "Someone in the group");

    await storage.upsertMember({
      id: "m2",
      name: "Rahul",
      visibility: "named",
      role: "member",
      createdAt: T(-60),
    });
  });

  test("an item nobody has touched carries an empty array, not a hole", async () => {
    const posted = await app.request("/api/chat", {
      method: "POST",
      headers: { cookie: shubham, "content-type": "application/json" },
      body: JSON.stringify({ body: "quiet one" }),
    });
    const message = (await posted.json()) as TimelineItem;

    const page = await chat();
    const key = reactionKey("message", message.id);
    assert.ok(key in page.reactions, "every item on the page has an entry");
    assert.deepEqual(page.reactions[key], []);
  });
});

describe("the poll delta for stale items", () => {
  test("a cold open carries the reactions of everything on its page", async () => {
    const page = await chat();
    assert.ok(page.reactionCursor, "a group that has reacted has a cursor");
    assert.deepEqual(
      page.reactions[reactionKey("message", OLD_MESSAGE)]?.map((r) => r.emoji),
      ["🚀"],
    );
    // Every item on the page is represented, reacted-to or not.
    for (const item of page.items) {
      assert.ok(reactionKey(item.kind, item.id) in page.reactions);
    }
  });

  test("an idle poll is idle in both dimensions", async () => {
    const first = await chat();
    const idle = await chat(
      `?after=${encodeURIComponent(first.cursor)}` +
        `&reactedAfter=${encodeURIComponent(first.reactionCursor)}`,
    );
    assert.deepEqual(idle.items, []);
    assert.equal(idle.cursor, first.cursor);
    assert.equal(idle.reactionCursor, first.reactionCursor);
    // Inclusive bound, so the boundary item comes back once — identical, and
    // therefore a no-op when the client merges it.
    assert.ok(Object.keys(idle.reactions).length <= 1);
  });

  test("a reaction on an item long past the cursor still arrives", async () => {
    // Rahul is caught up: no items after this cursor, no reactions after that one.
    const caughtUp = await chat("", rahul);
    const query =
      `?after=${encodeURIComponent(caughtUp.cursor)}` +
      `&reactedAfter=${encodeURIComponent(caughtUp.reactionCursor)}`;

    // Shubham reacts to the oldest message in the thread — an item that will
    // never appear in Rahul's page again.
    await react("PUT", "message", OLD_MESSAGE, "😂");

    const poll = await chat(query, rahul);
    assert.deepEqual(poll.items, [], "no new items, and that is the point");
    const summary = poll.reactions[reactionKey("message", OLD_MESSAGE)];
    assert.ok(summary, "the stale item rode in on the delta");
    assert.deepEqual(
      summary.map((r) => [r.emoji, r.count, r.mine]),
      [
        ["🚀", 1, false],
        ["😂", 1, false],
      ],
    );
    assert.notEqual(poll.reactionCursor, caughtUp.reactionCursor);
  });

  test("a removal on a stale item arrives too — as a shorter summary", async () => {
    const caughtUp = await chat("", rahul);
    const query =
      `?after=${encodeURIComponent(caughtUp.cursor)}` +
      `&reactedAfter=${encodeURIComponent(caughtUp.reactionCursor)}`;

    await react("DELETE", "message", OLD_MESSAGE, "😂");

    const poll = await chat(query, rahul);
    const summary = poll.reactions[reactionKey("message", OLD_MESSAGE)];
    assert.deepEqual(
      summary?.map((r) => r.emoji),
      ["🚀"],
      "the deleted row leaves nothing to replay; the whole summary does the work",
    );
  });

  test("the last reaction leaving an item is an explicit empty array", async () => {
    const caughtUp = await chat("", rahul);
    const query =
      `?after=${encodeURIComponent(caughtUp.cursor)}` +
      `&reactedAfter=${encodeURIComponent(caughtUp.reactionCursor)}`;

    await react("DELETE", "message", OLD_MESSAGE, "🚀");

    const poll = await chat(query, rahul);
    const key = reactionKey("message", OLD_MESSAGE);
    assert.ok(key in poll.reactions, "present…");
    assert.deepEqual(poll.reactions[key], [], "…and empty, which is the signal");

    // Put it back for whatever runs next.
    await react("PUT", "message", OLD_MESSAGE, "🚀");
  });

  test("the delta advances so the same change is not replayed forever", async () => {
    const first = await chat("", rahul);
    const second = await chat(
      `?after=${encodeURIComponent(first.cursor)}` +
        `&reactedAfter=${encodeURIComponent(first.reactionCursor)}`,
      rahul,
    );
    const third = await chat(
      `?after=${encodeURIComponent(second.cursor)}` +
        `&reactedAfter=${encodeURIComponent(second.reactionCursor)}`,
      rahul,
    );
    // Nothing changed between the two polls, so the cursor holds its place.
    assert.equal(third.reactionCursor, second.reactionCursor);
    assert.deepEqual(third.items, []);
  });

  test("an unreadable reaction cursor self-heals rather than 400ing", async () => {
    const page = await chat("?reactedAfter=garbage");
    assert.equal(page.items.length > 0, true);
    // "garbage" sorts after every ISO string, so the delta is empty and the
    // page's own reactions still land — a client that sent nonsense sees a
    // correct screen, which is the same forgiveness parseCursor already grants.
    assert.ok(reactionKey("message", OLD_MESSAGE) in page.reactions);
  });

  test("the old wire shape still answers, field for field", async () => {
    // A client that has never heard of reactions asks exactly as before.
    const page = await chat();
    assert.ok(Array.isArray(page.items));
    assert.equal(typeof page.cursor, "string");
    // …and the two new fields are additions, not replacements.
    assert.equal(typeof page.reactions, "object");
    assert.equal(typeof page.reactionCursor, "string");
  });
});

describe("storage keeps its own promises", () => {
  test("the touch log records both directions and the reaction table only one", async () => {
    const before = (await storage.listReactionActivity()).length;

    await storage.insertReaction({
      itemKind: "message",
      itemId: "solo",
      memberId: "m1",
      emoji: "🔥",
      createdAt: T(20),
    });
    await storage.insertReaction({
      itemKind: "message",
      itemId: "solo",
      memberId: "m1",
      emoji: "🔥",
      createdAt: T(21),
    });

    const rows = await storage.listReactionsFor([{ kind: "message", id: "solo" }]);
    assert.equal(rows.length, 1);
    // The first tap owns created_at, so `who` keeps the real pile-on order.
    assert.equal(rows[0].createdAt, T(20));

    const activity = await storage.listReactionActivity();
    assert.equal(activity.length, before + 1, "one item, one row, however many taps");
    assert.equal(
      activity.find((a) => a.target.id === "solo")?.touchedAt,
      T(21),
      "…stamped by the most recent one",
    );

    await storage.deleteReaction(
      { kind: "message", id: "solo", memberId: "m1", emoji: "🔥" },
      T(22),
    );
    const afterDelete = await storage.listReactionActivity();
    assert.equal(
      afterDelete.find((a) => a.target.id === "solo")?.touchedAt,
      T(22),
      "a removal is a change, and the log has to say so",
    );
    assert.deepEqual(
      await storage.listReactionsFor([{ kind: "message", id: "solo" }]),
      [],
    );
  });

  test("listReactionsFor reads past a single bound-parameter chunk", async () => {
    const targets = Array.from({ length: 95 }, (_, i) => ({
      kind: "message" as const,
      id: `bulk-${i}`,
    }));
    for (const target of targets) {
      await storage.insertReaction({
        itemKind: target.kind,
        itemId: target.id,
        memberId: "m1",
        emoji: "🚀",
        createdAt: T(30),
      });
    }
    // 95 targets is 190 bound parameters — three chunks, one answer.
    const rows = await storage.listReactionsFor(targets);
    assert.equal(rows.length, 95);
  });

  test("latestReactionActivityAt is the newest touch in the group", async () => {
    const activity = await storage.listReactionActivity({ limit: 1000 });
    const newest = activity.map((a) => a.touchedAt).sort().at(-1);
    assert.equal(await storage.latestReactionActivityAt(), newest);
  });
});
