import assert from "node:assert/strict";
import { after as afterAll, before, beforeEach, describe, test } from "node:test";
import type { Hono } from "hono";
import { createApp } from "../api.js";
import type { SessionEnv } from "../auth/session.js";
import { hashToken, Vault } from "../auth/vault.js";
import { loadConfig, type Config } from "../config.js";
import type { FeedEventRow } from "../domain.js";
import { createInvite } from "../invite.js";
import type { McpDeps } from "../mcp/oauth.js";
import type { TickResult } from "../poller/tick.js";
import {
  createPusher,
  fanOutFeedEvents,
  MAX_INDIVIDUAL_NOTIFICATIONS,
  MAX_PUSH_FAILURES,
  notificationsFor,
  type PushNotification,
} from "../push/notify.js";
import { generateVapidKeys, type VapidConfig } from "../push/webpush.js";
import { noopNotifier, notifyFeedEvents } from "../room.js";
import { createStorage, type Storage } from "../storage/index.js";
import type { FeedEvent } from "../types.js";

/**
 * Web Push above the crypto: who gets told, who deliberately doesn't, and what
 * happens to a subscription the push service has stopped accepting.
 * src/push/webpush.test.ts owns the RFC vectors; nothing here re-proves them.
 *
 * The push service is a function. That is the point — every branch of the
 * cleanup rules is reachable by returning a status, and none of it needs a
 * network, a real endpoint or a real device.
 */

const APP_URL = "http://127.0.0.1:3009";
const T = (minutes: number) => new Date(Date.UTC(2026, 7, 6, 20, minutes)).toISOString();

let storage: Storage;
let config: Config;
let app: Hono<SessionEnv>;
let vapid: VapidConfig;
/** Shubham (named, admin), Rahul (anonymous), Anjali (paused). */
const cookies: Record<string, string> = {};

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

/** A subscription that the encryption in webpush.ts will actually accept. */
function subscriptionFor(endpoint: string) {
  return {
    endpoint,
    keys: {
      // RFC 8291's receiver key — a real point on P-256, which is what the
      // encryption path insists on.
      p256dh:
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      auth: "BTBZMqHH6r4Tts7J_aSIgg",
    },
  };
}

async function register(memberId: string, endpoint: string): Promise<void> {
  await storage.upsertPushSubscription({
    endpointHash: hashToken(endpoint),
    memberId,
    subscriptionJson: JSON.stringify(subscriptionFor(endpoint)),
    createdAt: T(0),
    lastOkAt: null,
    failedCount: 0,
  });
}

const event = (
  over: Partial<FeedEvent> & Pick<FeedEvent, "id" | "accountId" | "accountName">,
): FeedEvent => ({
  type: "NEW_POSITION",
  symbol: "NVDA",
  instrumentName: "NVIDIA Corp",
  pctOfPortfolio: 12.4,
  detectedAt: T(1),
  ...over,
});

before(async () => {
  storage = await createStorage(":memory:");
  config = loadConfig({
    NODE_ENV: "test",
    APP_SECRET: "push-test-secret",
    APP_URL,
  } as NodeJS.ProcessEnv);
  vapid = { ...(await generateVapidKeys()), subject: "mailto:watcher@example.com" };

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
  app = createApp({
    storage,
    poll,
    pollOne: poll,
    config,
    mcp,
    vapidPublicKey: vapid.publicKey,
  });

  for (const id of ["m1", "m2", "m3"]) cookies[id] = await signIn(id);
});

afterAll(async () => {
  await storage.close();
});

beforeEach(async () => {
  for (const row of await storage.listPushSubscriptions()) {
    await storage.deletePushSubscription(row.endpointHash);
  }
});

// --- Who gets told what -----------------------------------------------------

describe("notification selection", () => {
  test("a member is never notified of their own move", () => {
    const events = [
      event({ id: "e1", accountId: "m1", accountName: "Shubham" }),
      event({ id: "e2", accountId: "m2", accountName: "Rahul" }),
    ];
    assert.deepEqual(
      notificationsFor(events, "m1").map((n) => n.tag),
      ["e2"],
    );
    assert.deepEqual(
      notificationsFor(events, "m2").map((n) => n.tag),
      ["e1"],
    );
  });

  test("a tick containing only your own move notifies you of nothing", () => {
    const events = [event({ id: "e1", accountId: "m1", accountName: "Shubham" })];
    assert.deepEqual(notificationsFor(events, "m1"), []);
  });

  test("a named move says who, what and how much — and never an amount", () => {
    const [notification] = notificationsFor(
      [
        event({
          id: "e1",
          accountId: "m1",
          accountName: "Shubham",
          type: "SIZE_DOWN",
          pctOfPortfolio: 4.25,
        }),
      ],
      "m2",
    );
    assert.deepEqual(notification, {
      title: "Shubham trimmed NVDA",
      body: "4.3% of portfolio",
      tag: "e1",
      url: "#/m/m1",
    } satisfies PushNotification);
  });

  test("every event type has its own verb", () => {
    const verbs = (["NEW_POSITION", "SIZE_UP", "SIZE_DOWN", "EXITED"] as const).map(
      (type) =>
        notificationsFor(
          [event({ id: type, accountId: "m1", accountName: "Shubham", type })],
          "m2",
        )[0].title,
    );
    assert.deepEqual(verbs, [
      "Shubham opened NVDA",
      "Shubham added to NVDA",
      "Shubham trimmed NVDA",
      "Shubham exited NVDA",
    ]);
  });

  test("an exit reports a closed position rather than a size of zero", () => {
    const [notification] = notificationsFor(
      [
        event({
          id: "e1",
          accountId: "m1",
          accountName: "Shubham",
          type: "EXITED",
          pctOfPortfolio: 0,
        }),
      ],
      "m2",
    );
    assert.equal(notification.body, "Position closed");
  });

  test("an anonymous member is named nowhere and linked nowhere", () => {
    const [notification] = notificationsFor(
      [
        event({
          id: "e1",
          accountId: "m2",
          accountName: "Someone in the group",
          type: "SIZE_DOWN",
        }),
      ],
      "m1",
    );
    assert.equal(notification.title, "Someone in the group trimmed a position");
    assert.ok(!notification.title.includes("NVDA"));
    assert.ok(!notification.title.includes("Rahul"));
    // No feed of their own to open, so the group timeline is the destination.
    assert.equal(notification.url, "#/");
  });

  test("an investment code is replaced by the instrument's name", () => {
    const [notification] = notificationsFor(
      [
        event({
          id: "e1",
          accountId: "m1",
          accountName: "Shubham",
          symbol: "120723",
          instrumentName: "Invesco NASDAQ 100 ETF",
        }),
      ],
      "m2",
    );
    assert.equal(notification.title, "Shubham opened Invesco NASDAQ 100 ETF");
  });

  test(`up to ${MAX_INDIVIDUAL_NOTIFICATIONS} moves arrive one by one`, () => {
    const events = Array.from({ length: MAX_INDIVIDUAL_NOTIFICATIONS }, (_, i) =>
      event({ id: `e${i}`, accountId: "m1", accountName: "Shubham" }),
    );
    assert.equal(notificationsFor(events, "m2").length, MAX_INDIVIDUAL_NOTIFICATIONS);
  });

  test("past the cap they collapse into one count, naming only who moved", () => {
    const events = [
      event({ id: "e1", accountId: "m1", accountName: "Shubham" }),
      event({ id: "e2", accountId: "m1", accountName: "Shubham" }),
      event({ id: "e3", accountId: "m2", accountName: "Someone in the group" }),
      event({ id: "e4", accountId: "m2", accountName: "Someone in the group" }),
    ];
    const notifications = notificationsFor(events, "m3");
    assert.equal(notifications.length, 1);
    assert.deepEqual(notifications[0], {
      title: "4 moves in the group",
      body: "From Shubham and someone",
      tag: "group-moves",
      url: "#/",
    } satisfies PushNotification);
  });

  test("the collapse counts only what that member would have been sent", () => {
    // Five events, four of them Shubham's own: he is over the cap only if his
    // own moves count, and they must not.
    const events = [
      ...Array.from({ length: 4 }, (_, i) =>
        event({ id: `own${i}`, accountId: "m1", accountName: "Shubham" }),
      ),
      event({ id: "e5", accountId: "m2", accountName: "Someone in the group" }),
    ];
    const notifications = notificationsFor(events, "m1");
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].tag, "e5");
  });
});

// --- Visibility comes from the projection, not from here --------------------

describe("visibility, inherited from the feed projection", () => {
  test("a paused member's move reaches no notification at all", async () => {
    const rows: FeedEventRow[] = [
      {
        id: "r-paused",
        accountId: "a-m3",
        type: "NEW_POSITION",
        instrumentId: "us_nvda",
        symbol: "NVDA",
        instrumentName: "NVIDIA Corp",
        pctOfPortfolio: 30,
        qtyChangePct: null,
        detectedAt: T(2),
        suppressed: false,
        suppressReason: null,
      },
    ];

    const seen: FeedEvent[][] = [];
    await notifyFeedEvents(storage, noopNotifier, rows, {
      async feedEvents(events) {
        seen.push(events);
      },
    });

    // The projection dropped it before the pusher ever saw it — which is the
    // guarantee: there is no second visibility check to get wrong.
    assert.deepEqual(seen, [[]]);
  });

  test("an anonymous member's move arrives already unnamed", async () => {
    const rows: FeedEventRow[] = [
      {
        id: "r-anon",
        accountId: "a-m2",
        type: "SIZE_DOWN",
        instrumentId: "us_nvda",
        symbol: "NVDA",
        instrumentName: "NVIDIA Corp",
        pctOfPortfolio: 8,
        qtyChangePct: -0.3,
        detectedAt: T(3),
        suppressed: false,
        suppressReason: null,
      },
    ];

    let seen: FeedEvent[] = [];
    await notifyFeedEvents(storage, noopNotifier, rows, {
      async feedEvents(events) {
        seen = events;
      },
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].accountName, "Someone in the group");
    assert.equal(notificationsFor(seen, "m1")[0].url, "#/");
  });
});

// --- The fan-out ------------------------------------------------------------

/** A push service that answers with whatever the test tells it to. */
function service(reply: (endpoint: string, call: number) => number | Error) {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    const answer = reply(url, calls.filter((c) => c === url).length);
    calls.push(url);
    if (answer instanceof Error) throw answer;
    return new Response(null, { status: answer });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe("fan-out", () => {
  const move = [event({ id: "e1", accountId: "m1", accountName: "Shubham" })];

  test("sends to everyone else's devices and to none of the author's", async () => {
    await register("m1", "https://push.example.net/shubham-phone");
    await register("m2", "https://push.example.net/rahul-phone");
    await register("m2", "https://push.example.net/rahul-laptop");

    const { fetcher, calls } = service(() => 201);
    const result = await fanOutFeedEvents(move, { storage, vapid, fetch: fetcher });

    assert.deepEqual(result, { sent: 2, removed: 0, failed: 0 });
    assert.deepEqual(calls.sort(), [
      "https://push.example.net/rahul-laptop",
      "https://push.example.net/rahul-phone",
    ]);
  });

  test("a success stamps last_ok_at and forgives earlier failures", async () => {
    const endpoint = "https://push.example.net/rahul";
    await register("m2", endpoint);
    await storage.bumpPushSubscriptionFailure(hashToken(endpoint));

    const { fetcher } = service(() => 201);
    await fanOutFeedEvents(move, { storage, vapid, fetch: fetcher });

    const row = await storage.getPushSubscription(hashToken(endpoint));
    assert.equal(row?.failedCount, 0);
    assert.ok(row?.lastOkAt);
  });

  for (const status of [404, 410]) {
    test(`${status} deletes the subscription on the spot`, async () => {
      await register("m2", "https://push.example.net/dead");
      const { fetcher } = service(() => status);
      const result = await fanOutFeedEvents(move, { storage, vapid, fetch: fetcher });

      assert.deepEqual(result, { sent: 0, removed: 1, failed: 0 });
      assert.equal(await storage.listPushSubscriptions().then((r) => r.length), 0);
    });
  }

  test("a soft failure counts down, and the fifth is fatal", async () => {
    const endpoint = "https://push.example.net/flaky";
    await register("m2", endpoint);
    const { fetcher } = service(() => 500);

    for (let attempt = 1; attempt < MAX_PUSH_FAILURES; attempt++) {
      const result = await fanOutFeedEvents(move, { storage, vapid, fetch: fetcher });
      assert.deepEqual(result, { sent: 0, removed: 0, failed: 1 });
      const row = await storage.getPushSubscription(hashToken(endpoint));
      assert.equal(row?.failedCount, attempt, `after attempt ${attempt}`);
    }

    const last = await fanOutFeedEvents(move, { storage, vapid, fetch: fetcher });
    assert.deepEqual(last, { sent: 0, removed: 1, failed: 1 });
    assert.equal(await storage.getPushSubscription(hashToken(endpoint)), undefined);
  });

  test("a transport failure counts the same as a rejection", async () => {
    const endpoint = "https://push.example.net/unreachable";
    await register("m2", endpoint);
    const { fetcher } = service(() => new Error("connect ECONNREFUSED"));

    const result = await fanOutFeedEvents(move, { storage, vapid, fetch: fetcher });
    assert.deepEqual(result, { sent: 0, removed: 0, failed: 1 });
    assert.equal(
      (await storage.getPushSubscription(hashToken(endpoint)))?.failedCount,
      1,
    );
  });

  test("one dead device does not stop the others being told", async () => {
    await register("m2", "https://push.example.net/dead");
    await register("m2", "https://push.example.net/alive");
    const { fetcher } = service((url) => (url.endsWith("dead") ? 410 : 201));

    const result = await fanOutFeedEvents(move, { storage, vapid, fetch: fetcher });
    assert.deepEqual(result, { sent: 1, removed: 1, failed: 0 });
  });

  test("an unparseable row is dropped rather than retried forever", async () => {
    await storage.upsertPushSubscription({
      endpointHash: "corrupt",
      memberId: "m2",
      subscriptionJson: "{not json",
      createdAt: T(0),
      lastOkAt: null,
      failedCount: 0,
    });
    const { fetcher, calls } = service(() => 201);

    const result = await fanOutFeedEvents(move, { storage, vapid, fetch: fetcher });
    assert.deepEqual(result, { sent: 0, removed: 1, failed: 0 });
    assert.deepEqual(calls, []);
    assert.equal(await storage.getPushSubscription("corrupt"), undefined);
  });

  test("a collapsed batch is one request per device, not four", async () => {
    await register("m2", "https://push.example.net/rahul");
    const events = Array.from({ length: 4 }, (_, i) =>
      event({ id: `e${i}`, accountId: "m1", accountName: "Shubham" }),
    );
    const { fetcher, calls } = service(() => 201);

    const result = await fanOutFeedEvents(events, { storage, vapid, fetch: fetcher });
    assert.deepEqual(result, { sent: 1, removed: 0, failed: 0 });
    assert.equal(calls.length, 1);
  });

  test("nothing to say to anyone means no requests at all", async () => {
    await register("m1", "https://push.example.net/shubham");
    const { fetcher, calls } = service(() => 201);
    const result = await fanOutFeedEvents(move, { storage, vapid, fetch: fetcher });
    assert.deepEqual(result, { sent: 0, removed: 0, failed: 0 });
    assert.deepEqual(calls, []);
  });
});

describe("the pusher seam", () => {
  test("a failing push service never surfaces as a thrown error", async () => {
    await register("m2", "https://push.example.net/rahul");
    const pusher = createPusher({
      storage,
      vapid,
      fetch: (async () => {
        throw new Error("the internet is closed");
      }) as unknown as typeof fetch,
    });
    // A poll tick calls this; it must be incapable of failing the tick.
    await pusher.feedEvents([event({ id: "e1", accountId: "m1", accountName: "S" })]);
  });

  test("`defer` hands the work to the runtime instead of awaiting it", async () => {
    await register("m2", "https://push.example.net/rahul");
    const deferred: Promise<unknown>[] = [];
    let sent = 0;
    const pusher = createPusher({
      storage,
      vapid,
      defer: (work) => deferred.push(work),
      fetch: (async () => {
        sent += 1;
        return new Response(null, { status: 201 });
      }) as unknown as typeof fetch,
    });

    await pusher.feedEvents([event({ id: "e1", accountId: "m1", accountName: "S" })]);
    // Returned before the send happened — that is the whole point of waitUntil.
    assert.equal(sent, 0);
    assert.equal(deferred.length, 1);
    await deferred[0];
    assert.equal(sent, 1);
  });

  test("an empty tick is not worth a database read", async () => {
    const pusher = createPusher({
      storage,
      vapid,
      fetch: (async () => {
        throw new Error("should not be reached");
      }) as unknown as typeof fetch,
    });
    await pusher.feedEvents([]);
  });
});

// --- The endpoints ----------------------------------------------------------

describe("GET /api/push/key", () => {
  test("hands back the configured public key to a signed-in member", async () => {
    const res = await app.request("/api/push/key", { headers: { cookie: cookies.m1 } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { key: vapid.publicKey });
  });

  test("401s without a session", async () => {
    assert.equal((await app.request("/api/push/key")).status, 401);
  });

  test("404s when the deploy has no keypair", async () => {
    const bare = createApp({
      storage,
      poll: async () => ({
        at: T(0),
        polled: [],
        unchanged: [],
        skipped: [],
        errors: [],
        events: 0,
        suppressed: 0,
      }),
      pollOne: async () => ({
        at: T(0),
        polled: [],
        unchanged: [],
        skipped: [],
        errors: [],
        events: 0,
        suppressed: 0,
      }),
      config,
      mcp: { storage, vault: new Vault(config.appSecret), config },
    });
    const res = await bare.request("/api/push/key", { headers: { cookie: cookies.m1 } });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "push_not_configured" });
  });
});

describe("POST /api/push/subscribe", () => {
  const post = (body: unknown, cookie?: string) =>
    app.request("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  test("401s without a session — a subscription always belongs to someone", async () => {
    assert.equal(
      (await post({ subscription: subscriptionFor("https://push.example.net/a") }))
        .status,
      401,
    );
    assert.equal((await storage.listPushSubscriptions()).length, 0);
  });

  test("stores the subscription against the member holding the session", async () => {
    const endpoint = "https://push.example.net/rahul-phone";
    const res = await post({ subscription: subscriptionFor(endpoint) }, cookies.m2);
    assert.equal(res.status, 201);

    const row = await storage.getPushSubscription(hashToken(endpoint));
    assert.equal(row?.memberId, "m2");
    assert.equal(JSON.parse(row!.subscriptionJson).endpoint, endpoint);
    // The endpoint is a capability URL; the key is a hash of it, not it.
    assert.notEqual(row?.endpointHash, endpoint);
  });

  test("two devices for one member are two rows", async () => {
    await post({ subscription: subscriptionFor("https://push.example.net/p") }, cookies.m2);
    await post({ subscription: subscriptionFor("https://push.example.net/l") }, cookies.m2);
    assert.equal((await storage.listPushSubscriptions()).length, 2);
  });

  test("re-subscribing the same browser upserts and clears its failures", async () => {
    const endpoint = "https://push.example.net/renewed";
    await post({ subscription: subscriptionFor(endpoint) }, cookies.m2);
    await storage.bumpPushSubscriptionFailure(hashToken(endpoint));
    await post({ subscription: subscriptionFor(endpoint) }, cookies.m2);

    const rows = await storage.listPushSubscriptions();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].failedCount, 0);
  });

  test("a device changing hands moves to the member now signed in on it", async () => {
    const endpoint = "https://push.example.net/shared-laptop";
    await post({ subscription: subscriptionFor(endpoint) }, cookies.m2);
    await post({ subscription: subscriptionFor(endpoint) }, cookies.m1);

    const rows = await storage.listPushSubscriptions();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].memberId, "m1");
  });

  test("rejects anything that isn't a usable https subscription", async () => {
    for (const body of [
      {},
      { subscription: null },
      { subscription: { endpoint: "https://push.example.net/x" } },
      { subscription: { endpoint: "", keys: { p256dh: "a", auth: "b" } } },
      { subscription: { endpoint: "not a url", keys: { p256dh: "a", auth: "b" } } },
      { subscription: { endpoint: "http://push.example.net/x", keys: { p256dh: "a", auth: "b" } } },
      { subscription: { endpoint: "https://push.example.net/x", keys: { p256dh: "a" } } },
    ]) {
      const res = await post(body, cookies.m2);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(await res.json(), { error: "invalid_subscription" });
    }
    assert.equal((await storage.listPushSubscriptions()).length, 0);
  });
});

describe("DELETE /api/push/subscribe", () => {
  const del = (body: unknown, cookie?: string) =>
    app.request("/api/push/subscribe", {
      method: "DELETE",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  test("removes your own device", async () => {
    const endpoint = "https://push.example.net/rahul-phone";
    await register("m2", endpoint);
    const res = await del({ endpoint }, cookies.m2);
    assert.equal(res.status, 200);
    assert.equal(await storage.getPushSubscription(hashToken(endpoint)), undefined);
  });

  test("cannot remove someone else's, and cannot tell it exists", async () => {
    const endpoint = "https://push.example.net/rahul-phone";
    await register("m2", endpoint);

    const mine = await del({ endpoint: "https://push.example.net/never" }, cookies.m1);
    const theirs = await del({ endpoint }, cookies.m1);

    assert.equal(theirs.status, 404);
    assert.equal(mine.status, theirs.status);
    assert.deepEqual(await theirs.json(), await mine.json());
    // And it is still there.
    assert.ok(await storage.getPushSubscription(hashToken(endpoint)));
  });

  test("401s without a session", async () => {
    assert.equal((await del({ endpoint: "https://push.example.net/x" })).status, 401);
  });

  test("400s without an endpoint to name", async () => {
    const res = await del({}, cookies.m2);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "endpoint_required" });
  });
});
