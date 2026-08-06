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
import { Backoff, runPollTick } from "../poller/tick.js";
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
  app = createApp({ storage, poll, config, mcp });
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
  test("a tick pulls positions over MCP and writes feed events", async () => {
    const result = await poll();
    assert.deepEqual(result.polled, ["a-m1"]);
    assert.equal(result.errors.length, 0);
    assert.equal(result.events, 2);

    const positions = await storage.getCurrentPositions("a-m1");
    assert.deepEqual(
      positions.map((p) => p.symbol).sort(),
      ["DABUR", "EMMBI"],
    );
    const dabur = positions.find((p) => p.symbol === "DABUR")!;
    assert.equal(dabur.qty, 40);
    assert.equal(Math.round(dabur.mktValue), Math.round(40 * 548.2));
    assert.ok(fake.toolCalls.includes("networth_holdings"));
  });

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
