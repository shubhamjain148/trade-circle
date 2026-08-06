import assert from "node:assert/strict";
import { after as afterAll, before, describe, test } from "node:test";
import type { Hono } from "hono";
import { createApp } from "../api.js";
import type { SessionEnv } from "../auth/session.js";
import { Vault } from "../auth/vault.js";
import { loadConfig, type Config } from "../config.js";
import { MAX_OUTSTANDING_DEVICE_LINKS } from "../device.js";
import { createInvite } from "../invite.js";
import type { McpDeps } from "../mcp/oauth.js";
import type { TickResult } from "../poller/tick.js";
import { createStorage, type Storage } from "../storage/index.js";
import type { Member } from "../types.js";

/**
 * "Link another device": a member minting themselves a way in on a second
 * screen. The thing under test is not really the endpoint — it is that the
 * first session survives the second one, because phone *and* laptop is the
 * whole feature, and that a device link and an invite stay distinguishable
 * both in what they do and in what they say when they fail.
 */

const APP_URL = "http://127.0.0.1:3003";

let storage: Storage;
let config: Config;
let app: Hono<SessionEnv>;
/** Rahul's first device — the one he mints from. */
let laptopCookie = "";

function tokenFrom(url: string): string {
  return new URL(url.replace("/#/", "/")).searchParams.get("token")!;
}

async function redeem(token: string): Promise<Response> {
  return app.request("/api/auth/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inviteToken: token }),
  });
}

function cookieOf(res: Response): string {
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

async function signIn(memberId: string): Promise<string> {
  const res = await redeem(tokenFrom(await createInvite(storage, memberId, APP_URL)));
  assert.equal(res.status, 200);
  return cookieOf(res);
}

async function mint(cookie: string): Promise<Response> {
  return app.request("/api/auth/device-link", {
    method: "POST",
    headers: { cookie },
  });
}

async function mintUrl(cookie = laptopCookie): Promise<string> {
  const res = await mint(cookie);
  assert.equal(res.status, 201);
  return ((await res.json()) as { url: string }).url;
}

/** Two milliseconds — enough that consecutive mints get distinct createdAt. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2));
}

async function meAs(cookie: string): Promise<Response> {
  return app.request("/api/me", { headers: { cookie } });
}

before(async () => {
  storage = await createStorage(":memory:");
  config = loadConfig({
    NODE_ENV: "test",
    APP_SECRET: "device-test-secret",
    APP_URL,
  } as NodeJS.ProcessEnv);

  const createdAt = new Date().toISOString();
  for (const [id, name] of [
    ["m1", "Rahul"],
    ["m2", "Priya"],
  ] as const) {
    await storage.upsertMember({
      id,
      name,
      visibility: "named",
      role: "member",
      createdAt,
    });
    await storage.upsertAccount({
      id: `a-${id}`,
      memberId: id,
      provider: "indmoney",
      status: "active",
      lastPolledAt: null,
    });
  }

  const poll = async (): Promise<TickResult> => ({
    at: createdAt,
    polled: [],
    unchanged: [],
    skipped: [],
    errors: [],
    events: 0,
    suppressed: 0,
  });
  const mcp: McpDeps = { storage, vault: new Vault(config.appSecret), config };
  app = createApp({ storage, poll, pollOne: poll, config, mcp });

  laptopCookie = await signIn("m1");
});

afterAll(async () => {
  await storage.close();
});

describe("minting a device link", () => {
  test("needs a session — there is no id in the request to name someone else", async () => {
    const res = await app.request("/api/auth/device-link", { method: "POST" });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
    assert.equal((await storage.listDeviceLinks("m1")).length, 0);
  });

  test("hands back a join URL, an expiry, and never the hash", async () => {
    const res = await mint(laptopCookie);
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      url: string;
      expiresAt: string;
      ttlMs: number;
    };

    assert.match(body.url, /^http:\/\/127\.0\.0\.1:3003\/#\/join\?token=.+&device=1$/);
    assert.equal(body.ttlMs, 15 * 60_000);

    const links = await storage.listDeviceLinks("m1");
    assert.equal(links.length, 1);
    assert.equal(links[0].usedAt, null);
    assert.equal(links[0].expiresAt, body.expiresAt);
    // Stored hashed: the token in the URL is nowhere in the database.
    assert.equal(
      links.some((l) => body.url.includes(l.tokenHash)),
      false,
    );
    // ~15 minutes out, not the session's 90 days.
    const ttl = Date.parse(body.expiresAt) - Date.parse(links[0].createdAt);
    assert.ok(Math.abs(ttl - 15 * 60_000) < 1_000, `ttl was ${ttl}ms`);

    await storage.deleteDeviceLink(links[0].tokenHash);
  });
});

describe("redeeming one", () => {
  test("signs in the same member on a new session, and the old one still works", async () => {
    const url = await mintUrl();

    const joined = await redeem(tokenFrom(url));
    assert.equal(joined.status, 200);
    const body = (await joined.json()) as { member: Member; device?: boolean };
    assert.equal(body.member.id, "m1");
    assert.equal(body.member.name, "Rahul");
    assert.equal(body.device, true, "the client needs to know which door this was");

    const phoneCookie = cookieOf(joined);
    assert.notEqual(phoneCookie, laptopCookie, "a new session, not the same one");

    // Both devices, at once, as the same person. This is the feature.
    for (const cookie of [laptopCookie, phoneCookie]) {
      const res = await meAs(cookie);
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as { member: Member }).member.id, "m1");
    }
  });

  test("single-use: the second redemption is 410, and says which 410", async () => {
    const url = await mintUrl();
    assert.equal((await redeem(tokenFrom(url))).status, 200);

    const again = await redeem(tokenFrom(url));
    assert.equal(again.status, 410);
    assert.deepEqual(await again.json(), { error: "link_used" });
  });

  test("expired is its own answer — mint a fresh one, not you already used it", async () => {
    const url = await mintUrl();
    const token = tokenFrom(url);

    // Backdate it rather than sleep fifteen minutes.
    const live = (await storage.listDeviceLinks("m1")).filter((l) => !l.usedAt).at(-1)!;
    await storage.deleteDeviceLink(live.tokenHash);
    await storage.createDeviceLink({
      ...live,
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const res = await redeem(token);
    assert.equal(res.status, 410);
    assert.deepEqual(await res.json(), { error: "link_expired" });

    // And it stayed unspent: expiry is not consumption.
    const after = (await storage.listDeviceLinks("m1")).find(
      (l) => l.tokenHash === live.tokenHash,
    );
    assert.equal(after?.usedAt, null);
  });

  test("a link only ever signs in the member who minted it", async () => {
    const priyaCookie = await signIn("m2");
    const url = await mintUrl(priyaCookie);

    const joined = await redeem(tokenFrom(url));
    assert.equal(joined.status, 200);
    assert.equal(((await joined.json()) as { member: Member }).member.id, "m2");
  });
});

describe("the cap", () => {
  test(`keeps ${MAX_OUTSTANDING_DEVICE_LINKS} outstanding, and the one it drops is the oldest`, async () => {
    // Clear the decks: earlier tests left spent and expired rows behind.
    for (const link of await storage.listDeviceLinks("m1")) {
      await storage.deleteDeviceLink(link.tokenHash);
    }

    // Spaced by a tick: "oldest" is created_at, and three mints inside one
    // millisecond are the same age — a real tie the eviction breaks by hash.
    const urls: string[] = [];
    for (let i = 0; i < MAX_OUTSTANDING_DEVICE_LINKS; i++) {
      urls.push(await mintUrl());
      await tick();
    }
    assert.equal(
      (await storage.listDeviceLinks("m1")).filter((l) => !l.usedAt).length,
      MAX_OUTSTANDING_DEVICE_LINKS,
      "three at once is normal — phone, tablet, the tap you repeated",
    );

    // One past the cap. The oldest dies; the rest are untouched.
    const fresh = await mintUrl();
    assert.equal(
      (await storage.listDeviceLinks("m1")).length,
      MAX_OUTSTANDING_DEVICE_LINKS,
    );

    assert.equal(
      (await redeem(tokenFrom(urls[0]))).status,
      400,
      "the oldest link is simply gone",
    );
    for (const url of [...urls.slice(1), fresh]) {
      const res = await redeem(tokenFrom(url));
      assert.equal(res.status, 200, "the newer ones still work");
    }
  });

  test("spent and expired links don't count against it", async () => {
    for (const link of await storage.listDeviceLinks("m2")) {
      await storage.deleteDeviceLink(link.tokenHash);
    }
    const cookie = await signIn("m2");

    // One spent, one expired, then a full cap's worth of live ones.
    await redeem(tokenFrom(await mintUrl(cookie)));
    const stale = (await storage.listDeviceLinks("m2")).filter((l) => !l.usedAt);
    for (const link of stale) await storage.deleteDeviceLink(link.tokenHash);
    await storage.createDeviceLink({
      tokenHash: "device-test-expired-hash",
      memberId: "m2",
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      usedAt: null,
    });

    const urls: string[] = [];
    for (let i = 0; i < MAX_OUTSTANDING_DEVICE_LINKS; i++) {
      urls.push(await mintUrl(cookie));
    }

    for (const url of urls) {
      assert.equal((await redeem(tokenFrom(url))).status, 200);
    }
    // The expired row survived, so its own screen still reads "expired".
    const res = await app.request("/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteToken: "whatever" }),
    });
    assert.equal(res.status, 400, "an unknown token is still the invite path's 400");
  });
});

describe("the invite flow, untouched", () => {
  test("an invite still joins, is still single-use, and still says invite_used", async () => {
    const createdAt = new Date().toISOString();
    await storage.upsertMember({
      id: "m3",
      name: "Anjali",
      visibility: "named",
      role: "member",
      createdAt,
    });

    const url = await createInvite(storage, "m3", APP_URL);
    assert.match(url, /^http:\/\/127\.0\.0\.1:3003\/#\/join\?token=[^&]+$/);

    const joined = await redeem(tokenFrom(url));
    assert.equal(joined.status, 200);
    const body = (await joined.json()) as { member: Member; device?: boolean };
    assert.equal(body.member.id, "m3");
    assert.equal(body.device, undefined, "an invite is not a device link");
    assert.equal((await meAs(cookieOf(joined))).status, 200);

    const again = await redeem(tokenFrom(url));
    assert.equal(again.status, 410);
    assert.deepEqual(
      await again.json(),
      { error: "invite_used" },
      "the device app must not have swallowed the invite path's own words",
    );
  });

  test("a missing or unknown token answers exactly as it always did", async () => {
    const empty = await app.request("/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);
    assert.deepEqual(await empty.json(), { error: "invite_token_required" });

    const unknown = await redeem("not-a-token-anyone-issued");
    assert.equal(unknown.status, 400);
    assert.deepEqual(await unknown.json(), { error: "invite_invalid" });
  });
});
