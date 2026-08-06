import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Hono } from "hono";
import { createApp } from "../api.js";
import type { SessionEnv } from "../auth/session.js";
import { Vault } from "../auth/vault.js";
import { loadConfig, type Config } from "../config.js";
import { createInvite } from "../invite.js";
import type { McpDeps } from "../mcp/oauth.js";
import { McpPortfolioSource } from "../mcp/source.js";
import { SnapshotEchoSource } from "../poller/source.js";
import { Backoff, runPollTick, type TickResult } from "../poller/tick.js";
import { createStorage, type Storage } from "../storage/index.js";
import { startFakeMcpServer, type FakeMcpServer } from "./fake-mcp-server.js";

// End-to-end against the local fake only. Nothing here resolves mcp.indmoney.com.

const APP_URL = "http://127.0.0.1:3002";

let fake: FakeMcpServer;
let storage: Storage;
let config: Config;
let vault: Vault;
let mcp: McpDeps;
let source: McpPortfolioSource;
let app: Hono<SessionEnv>;
let cookie = "";

async function poll() {
  return runPollTick(storage, source, { staggerMs: 0, backoff: new Backoff() });
}

/**
 * The connect handler fires the first fetch and forgets it, which is exactly
 * what a test cannot observe. So the injected `pollOne` hands back a promise
 * gated on a barrier the test releases: the window where the account is
 * connected but unpolled — the one the UI calls "fetching your positions" —
 * is held open for as long as the assertions need it.
 */
interface FirstFetch {
  accountId: string;
  release: () => void;
  done: Promise<TickResult>;
}

const firstFetches: FirstFetch[] = [];

function pollOne(accountId: string): Promise<TickResult> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = gate.then(() =>
    runPollTick(storage, source, { staggerMs: 0, accountIds: [accountId] }),
  );
  firstFetches.push({ accountId, release, done });
  return done;
}

/** The first fetch kicked off by the most recent connect callback. */
function lastFirstFetch(): FirstFetch {
  const fetched = firstFetches.at(-1);
  assert.ok(fetched, "the callback kicked off a first fetch");
  return fetched;
}

before(async () => {
  fake = await startFakeMcpServer();
  storage = await createStorage(":memory:");
  await storage.upsertMember({
    id: "m1",
    name: "Shubham",
    visibility: "named",
    role: "admin",
    createdAt: new Date().toISOString(),
  });
  config = loadConfig({
    NODE_ENV: "test",
    APP_SECRET: "integration-test-secret",
    APP_URL,
    MCP_BASE_URL: fake.mcpUrl,
  } as NodeJS.ProcessEnv);
  vault = new Vault(config.appSecret);
  mcp = { storage, vault, config };
  // No holdings cache: the tests script portfolio changes milliseconds apart.
  source = new McpPortfolioSource(mcp, {
    fallback: new SnapshotEchoSource(storage),
    holdingsTtlMs: 0,
  });
  app = createApp({ storage, poll, pollOne, config, mcp });
});

after(async () => {
  await storage.close();
  await fake.close();
});

describe("invite and session", () => {
  test("protected endpoints 401 without a session", async () => {
    for (const path of ["/api/feed", "/api/members", "/api/accounts", "/api/me"]) {
      assert.equal((await app.request(path)).status, 401, path);
    }
  });

  test("an invite link exchanges for a session cookie", async () => {
    const url = await createInvite(storage, "m1", APP_URL);
    assert.match(url, /^http:\/\/127\.0\.0\.1:3002\/#\/join\?token=/);
    const token = new URL(url.replace("/#/", "/")).searchParams.get("token")!;

    const res = await app.request("/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteToken: token }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      member: { id: "m1", name: "Shubham", visibility: "named", role: "admin" },
    });

    const setCookie = res.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    cookie = setCookie.split(";")[0];

    // Single-use.
    const replay = await app.request("/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteToken: token }),
    });
    assert.equal(replay.status, 410);
  });

  test("a bogus invite is rejected", async () => {
    const res = await app.request("/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteToken: "nope" }),
    });
    assert.equal(res.status, 400);
  });

  test("/api/me reports no account before connecting", async () => {
    const res = await app.request("/api/me", { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { account: unknown };
    assert.equal(body.account, null);
  });
});

describe("connect flow", () => {
  test("start -> authorize -> callback stores encrypted tokens and a tool catalog", async () => {
    const startRes = await app.request("/api/connect/indmoney/start?json=1", {
      headers: { cookie },
    });
    assert.equal(startRes.status, 200);
    const { authorizationUrl } = (await startRes.json()) as { authorizationUrl: string };

    const authUrl = new URL(authorizationUrl);
    assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
    assert.ok(authUrl.searchParams.get("code_challenge"));
    assert.equal(authUrl.searchParams.get("resource"), fake.mcpUrl);
    assert.equal(fake.registrations, 1, "DCR happens once");

    const authRes = await fetch(authorizationUrl, { redirect: "manual" });
    assert.equal(authRes.status, 302);
    const back = new URL(authRes.headers.get("location")!);
    assert.ok(back.searchParams.get("code"));

    const cbRes = await app.request(
      `/api/connect/indmoney/callback${back.search}`,
      { headers: { cookie } },
    );
    assert.equal(cbRes.status, 302);
    assert.equal(cbRes.headers.get("location"), `${APP_URL}/#/settings?connected=1`);

    const connection = await storage.getOAuthConnection("a-m1");
    assert.ok(connection);
    assert.equal(connection.status, "active");
    assert.match(connection.accessTokenEnc, /^v2\./);
    assert.ok(connection.refreshTokenEnc);
    assert.ok((await vault.decrypt(connection.accessTokenEnc)).length > 0);
    await assert.rejects(() => new Vault("wrong-secret").decrypt(connection.accessTokenEnc));

    // client_info must be persisted or the SDK cannot refresh (appendix 1 §1.3).
    const clientInfo = await vault.decryptJson<{ client_id: string; client_secret: string }>(
      connection.clientInfoJsonEnc,
    );
    assert.ok(clientInfo.client_id);
    assert.ok(clientInfo.client_secret);

    const catalog = await storage.latestToolCatalog("a-m1");
    assert.ok(catalog, "tools/list captured on connect");
    const names = (catalog.tools as { tools: { name: string }[] }).tools.map((t) => t.name);
    assert.deepEqual(names.sort(), [
      "lookup_ind_keys",
      "networth_holdings",
      "networth_snapshot",
    ]);
  });

  test("the callback reports 'pending' until the first fetch lands", async () => {
    // The redirect did not wait on the fetch — it is still gated here.
    assert.equal(lastFirstFetch().accountId, "a-m1");
    assert.equal((await storage.getAccount("a-m1"))!.lastPolledAt, null);

    const me = (await (
      await app.request("/api/me", { headers: { cookie } })
    ).json()) as { account: { connected: boolean; status: string; lastPolledAt: string | null } };
    // Connected, but not yet synced: the UI shows "fetching your positions".
    assert.equal(me.account.status, "pending");
    assert.equal(me.account.connected, true);
    assert.equal(me.account.lastPolledAt, null);

    const accounts = (await (
      await app.request("/api/accounts", { headers: { cookie } })
    ).json()) as { id: string; status: string }[];
    assert.equal(accounts.find((a) => a.id === "a-m1")?.status, "pending");
  });

  test("connecting kicks off a first fetch, unprompted", async () => {
    const first = lastFirstFetch();
    first.release();
    const result = await first.done;

    assert.deepEqual(result.polled, ["a-m1"]);
    assert.equal(result.errors.length, 0);
    assert.equal(result.events, 2);
    assert.ok(fake.toolCalls.includes("networth_holdings"));

    const positions = await storage.getCurrentPositions("a-m1");
    assert.deepEqual(positions.map((p) => p.symbol).sort(), ["DABUR", "EMMBI"]);
    const dabur = positions.find((p) => p.symbol === "DABUR")!;
    assert.equal(dabur.qty, 40);
    assert.equal(Math.round(dabur.mktValue), Math.round(40 * 548.2));

    assert.ok((await storage.getAccount("a-m1"))!.lastPolledAt);
    assert.equal((await storage.listFeedEvents({ accountId: "a-m1" })).length, 2);
  });

  test("/api/me and /api/accounts report the live connection", async () => {
    const me = (await (
      await app.request("/api/me", { headers: { cookie } })
    ).json()) as { account: { connected: boolean; status: string } };
    assert.equal(me.account.connected, true);
    assert.equal(me.account.status, "active");

    const accounts = (await (
      await app.request("/api/accounts", { headers: { cookie } })
    ).json()) as { id: string; connected: boolean }[];
    assert.equal(accounts.find((a) => a.id === "a-m1")?.connected, true);
  });

  test("a second connect reuses the existing DCR registration", async () => {
    await app.request("/api/connect/indmoney/start?json=1", { headers: { cookie } });
    assert.equal(fake.registrations, 1);
  });
});

describe("polling through McpPortfolioSource", () => {
  // The first pull over MCP is the connect-time fetch above; a scheduled tick
  // arrives at an account that already has a baseline.
  test("an unchanged net-worth probe skips the expensive call", async () => {
    const before = fake.toolCalls.filter((t) => t === "networth_holdings").length;
    const result = await poll();
    assert.deepEqual(result.unchanged, ["a-m1"]);
    assert.equal(
      fake.toolCalls.filter((t) => t === "networth_holdings").length,
      before,
    );
  });

  test("a changed portfolio produces a new event", async () => {
    fake.setHoldings([
      { ind_key: "INDS00577", symbol: "DABUR", name: "Dabur India Ltd", qty: 60, avg_cost: 512.5, ltp: 548.2 },
      { ind_key: "INDS01960", symbol: "EMMBI", name: "Emmbi Industries Ltd", qty: 120, avg_cost: 88, ltp: 94.75 },
    ]);
    const result = await poll();
    assert.deepEqual(result.polled, ["a-m1"]);
    const events = await storage.listFeedEvents({ accountId: "a-m1" });
    assert.equal(events[0].type, "SIZE_UP");
    assert.equal(events[0].symbol, "DABUR");
  });
});

describe("refresh", () => {
  test("an expired access token is refreshed and the rotated refresh token persisted", async () => {
    const before = (await storage.getOAuthConnection("a-m1"))!;
    const oldRefresh = await vault.decrypt(before.refreshTokenEnc!);

    // Backdate the stored expiry so token() refreshes proactively.
    await storage.upsertOAuthConnection({
      ...before,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    fake.setHoldings([
      { ind_key: "INDS00577", symbol: "DABUR", name: "Dabur India Ltd", qty: 61, avg_cost: 512.5, ltp: 548.2 },
    ]);
    const result = await poll();
    assert.equal(result.errors.length, 0);

    const after = (await storage.getOAuthConnection("a-m1"))!;
    assert.equal(after.status, "active");
    const newRefresh = await vault.decrypt(after.refreshTokenEnc!);
    assert.notEqual(newRefresh, oldRefresh, "rotation persisted");
    assert.ok(fake.tokenGrants.some((g) => g.grant === "refresh_token"));
    assert.ok(after.expiresAt && Date.parse(after.expiresAt) > Date.now());
  });

  test("a 401 recovered by onUnauthorized keeps the account active", async () => {
    fake.expireAccessTokens();
    fake.setHoldings([
      { ind_key: "INDS00577", symbol: "DABUR", name: "Dabur India Ltd", qty: 62, avg_cost: 512.5, ltp: 548.2 },
    ]);
    const result = await poll();
    assert.equal(result.errors.length, 0);
    assert.equal((await storage.getOAuthConnection("a-m1"))!.status, "active");
  });
});

describe("revocation", () => {
  test("a revoked grant flips the account to needs_reauth", async () => {
    fake.revokeAll();
    fake.setHoldings([
      { ind_key: "INDS00577", symbol: "DABUR", name: "Dabur India Ltd", qty: 63, avg_cost: 512.5, ltp: 548.2 },
    ]);
    const result = await poll();
    assert.equal(result.errors.length, 1);

    assert.equal((await storage.getOAuthConnection("a-m1"))!.status, "needs_reauth");
    assert.equal((await storage.getAccount("a-m1"))!.status, "needs_reauth");

    const me = (await (
      await app.request("/api/me", { headers: { cookie } })
    ).json()) as { account: { connected: boolean; status: string } };
    assert.equal(me.account.status, "needs_reauth");
    assert.equal(me.account.connected, false);
  });

  test("DELETE /api/connect/indmoney calls the revocation endpoint and wipes the vault", async () => {
    const res = await app.request("/api/connect/indmoney", {
      method: "DELETE",
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, revokedRemotely: true });
    assert.equal(fake.revocations.length, 1);
    assert.equal(await storage.getOAuthConnection("a-m1"), undefined);
    assert.equal((await storage.getAccount("a-m1"))!.status, "revoked");
  });

  test("logout clears the session", async () => {
    const res = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(res.status, 200);
    assert.equal((await app.request("/api/me", { headers: { cookie } })).status, 401);
  });
});

describe("visibility", () => {
  test("a member can switch their own visibility", async () => {
    // The logout test above invalidated the shared cookie; start a new session.
    const url = await createInvite(storage, "m1", APP_URL);
    const token = new URL(url.replace("/#/", "/")).searchParams.get("token")!;
    const join = await app.request("/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteToken: token }),
    });
    cookie = (join.headers.get("set-cookie") ?? "").split(";")[0];

    const res = await app.request("/api/me/visibility", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ visibility: "anonymous" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { member: { visibility: string } };
    assert.equal(body.member.visibility, "anonymous");

    const bad = await app.request("/api/me/visibility", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ visibility: "invisible" }),
    });
    assert.equal(bad.status, 400);

    // Restore for later tests.
    const back = await app.request("/api/me/visibility", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ visibility: "named" }),
    });
    assert.equal(back.status, 200);
  });
});

/**
 * The scope of the connect-time fetch. Left as a full sweep it would mean every
 * friend gets pulled every time anyone links their account — INDmoney rate-limits
 * per user, and a new joiner must not spend everyone else's budget.
 */
describe("the first fetch touches one account only", () => {
  test("connecting a second member leaves the first account's last pass alone", async () => {
    // The revocation tests above left a-m1 revoked; put it back to active so a
    // full sweep genuinely would have polled it, and the filter is what didn't.
    await storage.setAccountStatus("a-m1", "active");
    const before = (await storage.getAccount("a-m1"))!.lastPolledAt;
    assert.ok(before, "a-m1 has a baseline to protect");

    await storage.upsertMember({
      id: "m2",
      name: "Priya",
      visibility: "named",
      role: "member",
      createdAt: new Date().toISOString(),
    });
    const invite = await createInvite(storage, "m2", APP_URL);
    const token = new URL(invite.replace("/#/", "/")).searchParams.get("token")!;
    const join = await app.request("/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteToken: token }),
    });
    const cookie2 = (join.headers.get("set-cookie") ?? "").split(";")[0];

    const startRes = await app.request("/api/connect/indmoney/start?json=1", {
      headers: { cookie: cookie2 },
    });
    const { authorizationUrl } = (await startRes.json()) as { authorizationUrl: string };
    const authRes = await fetch(authorizationUrl, { redirect: "manual" });
    const back = new URL(authRes.headers.get("location")!);
    const cbRes = await app.request(`/api/connect/indmoney/callback${back.search}`, {
      headers: { cookie: cookie2 },
    });
    assert.equal(cbRes.status, 302);

    const first = lastFirstFetch();
    assert.equal(first.accountId, "a-m2");
    first.release();
    const result = await first.done;

    assert.deepEqual(result.polled, ["a-m2"], "only the new account was pulled");
    assert.ok((await storage.getAccount("a-m2"))!.lastPolledAt);
    assert.equal(
      (await storage.getAccount("a-m1"))!.lastPolledAt,
      before,
      "the other friend's account was not touched",
    );
  });
});

describe("POST /api/poll is an admin control", () => {
  test("no session is 401, a plain member is 403, an admin gets the tick", async () => {
    const anon = await app.request("/api/poll", { method: "POST" });
    assert.equal(anon.status, 401);

    // m2 joined as a plain member in the describe above; m1 is the admin.
    const invite = await createInvite(storage, "m2", APP_URL);
    const token = new URL(invite.replace("/#/", "/")).searchParams.get("token")!;
    const join = await app.request("/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteToken: token }),
    });
    const memberCookie = (join.headers.get("set-cookie") ?? "").split(";")[0];

    const forbidden = await app.request("/api/poll", {
      method: "POST",
      headers: { cookie: memberCookie },
    });
    assert.equal(forbidden.status, 403);
    assert.deepEqual(await forbidden.json(), { error: "forbidden" });

    const allowed = await app.request("/api/poll", {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(allowed.status, 200);
    const result = (await allowed.json()) as TickResult;
    // A full sweep, unlike the connect-time fetch: every active account.
    assert.deepEqual(
      [...result.polled, ...result.unchanged].sort(),
      ["a-m1", "a-m2"],
    );
  });
});
