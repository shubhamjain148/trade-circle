import assert from "node:assert/strict";
import { after as afterAll, before, describe, test } from "node:test";
import type { Hono } from "hono";
import { slugify, uniqueId } from "../admin.js";
import { createApp } from "../api.js";
import type { SessionEnv } from "../auth/session.js";
import { Vault } from "../auth/vault.js";
import { loadConfig, type Config } from "../config.js";
import { createInvite } from "../invite.js";
import type { McpDeps } from "../mcp/oauth.js";
import type { TickResult } from "../poller/tick.js";
import { setRole } from "../promote.js";
import { createStorage, type Storage } from "../storage/index.js";
import type { AdminMember, Member } from "../types.js";

/** The /api/me wire shape; the server has no name for it, the web app does. */
interface Me {
  member: Member;
  account: { connected: boolean } | null;
}

// The admin surface end to end over the real Hono app. No poller, no MCP: this
// is about who may hand out a way in, and what a way in is worth once handed.

const APP_URL = "http://127.0.0.1:3002";

let storage: Storage;
let config: Config;
let app: Hono<SessionEnv>;
/** m1, the admin. */
let adminCookie = "";
/** m2, a plain member. */
let memberCookie = "";

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

async function signIn(memberId: string): Promise<string> {
  const res = await redeem(tokenFrom(await createInvite(storage, memberId, APP_URL)));
  assert.equal(res.status, 200);
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

async function roster(cookie = adminCookie): Promise<AdminMember[]> {
  const res = await app.request("/api/admin/members", { headers: { cookie } });
  assert.equal(res.status, 200);
  return (await res.json()) as AdminMember[];
}

function find(rows: AdminMember[], id: string): AdminMember {
  const row = rows.find((r) => r.id === id);
  assert.ok(row, `no member ${id} in the roster`);
  return row;
}

before(async () => {
  storage = await createStorage(":memory:");
  config = loadConfig({
    NODE_ENV: "test",
    APP_SECRET: "admin-test-secret",
    APP_URL,
  } as NodeJS.ProcessEnv);

  const createdAt = new Date().toISOString();
  for (const [id, name, role] of [
    ["m1", "Shubham", "admin"],
    ["m2", "Rahul", "member"],
  ] as const) {
    await storage.upsertMember({ id, name, visibility: "named", role, createdAt });
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

  adminCookie = await signIn("m1");
  memberCookie = await signIn("m2");
});

afterAll(async () => {
  await storage.close();
});

describe("the role gate", () => {
  const routes = [
    ["GET", "/api/admin/members"],
    ["POST", "/api/admin/members"],
    ["POST", "/api/admin/members/m2/invite"],
    ["DELETE", "/api/admin/members/m2/invite"],
  ] as const;

  test("no session is 401, not 403 — signing in is the first question", async () => {
    for (const [method, path] of routes) {
      assert.equal((await app.request(path, { method })).status, 401, path);
    }
  });

  test("a plain member is 403 on every admin route", async () => {
    for (const [method, path] of routes) {
      const res = await app.request(path, {
        method,
        headers: { cookie: memberCookie, "content-type": "application/json" },
        body: method === "POST" ? JSON.stringify({ name: "Sneaky" }) : undefined,
      });
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.deepEqual(await res.json(), { error: "forbidden" });
    }

    // And the 403 was a refusal, not a half-done write.
    assert.equal((await storage.listMembers()).length, 2);
  });
});

describe("/api/me", () => {
  test("carries the role, so the client can hide what it must not offer", async () => {
    const asAdmin = (await (
      await app.request("/api/me", { headers: { cookie: adminCookie } })
    ).json()) as Me;
    assert.equal(asAdmin.member.role, "admin");

    const asMember = (await (
      await app.request("/api/me", { headers: { cookie: memberCookie } })
    ).json()) as Me;
    assert.equal(asMember.member.role, "member");
  });
});

describe("the roster", () => {
  test("reports role, connection and invite state per member", async () => {
    const rows = await roster();
    assert.deepEqual(
      rows.map((r) => r.id),
      ["m1", "m2"],
    );

    const admin = find(rows, "m1");
    assert.equal(admin.role, "admin");
    assert.equal(admin.name, "Shubham");
    // Nobody has an OAuth grant in this fixture — an account row alone is not
    // a connection, exactly as /api/me reads it.
    assert.equal(admin.connected, false);
    assert.equal(admin.status, "not_connected");
    assert.equal(admin.lastPolledAt, null);
    // Both signed in through a link in `before`, so both read as used.
    assert.equal(admin.invite?.status, "used");
  });

  test("lastPolledAt follows the account row", async () => {
    const at = new Date().toISOString();
    await storage.markPolled("a-m2", at);
    assert.equal(find(await roster(), "m2").lastPolledAt, at);
  });
});

describe("adding a member", () => {
  test("a name is required, and a very long one is refused", async () => {
    for (const body of [{}, { name: "   " }, { name: "x".repeat(61) }]) {
      const res = await app.request("/api/admin/members", {
        method: "POST",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
    }
  });

  test("creates the member, an account row, and no invite yet", async () => {
    const res = await app.request("/api/admin/members", {
      method: "POST",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "  Priya Sharma  " }),
    });
    assert.equal(res.status, 201);
    const { member } = (await res.json()) as { member: AdminMember };

    assert.equal(member.id, "priya-sharma");
    assert.equal(member.name, "Priya Sharma", "the name is trimmed, not slugged");
    assert.equal(member.role, "member", "new members are never admins");
    assert.equal(member.invite, null, "minting a link is a separate decision");

    const stored = await storage.getMember("priya-sharma");
    assert.equal(stored?.visibility, "named");
    assert.equal((await storage.getAccountByMember("priya-sharma"))?.id, "a-priya-sharma");

    // And they show up in the roster, still with no way in.
    assert.equal(find(await roster(), "priya-sharma").invite, null);
  });

  test("a colliding name gets a suffixed id, not a clobbered member", async () => {
    const res = await app.request("/api/admin/members", {
      method: "POST",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "Priya Sharma" }),
    });
    assert.equal(res.status, 201);
    const { member } = (await res.json()) as { member: AdminMember };
    assert.equal(member.id, "priya-sharma-2");
    assert.equal((await storage.getMember("priya-sharma"))?.name, "Priya Sharma");
  });

  test("slugs are readable, and a name with no ascii still gets an id", () => {
    assert.equal(slugify("Priya Sharma"), "priya-sharma");
    assert.equal(slugify("  O'Neill—Jr. "), "o-neill-jr");
    assert.equal(slugify("अंजलि"), "member");
    assert.equal(uniqueId("priya", new Set(["priya", "priya-2"])), "priya-3");
  });
});

describe("invites", () => {
  test("minting one, then joining with it, puts a real member in the group", async () => {
    const res = await app.request("/api/admin/members/priya-sharma/invite", {
      method: "POST",
      headers: { cookie: adminCookie },
    });
    assert.equal(res.status, 201);
    const { url } = (await res.json()) as { url: string };
    assert.match(url, /^http:\/\/127\.0\.0\.1:3002\/#\/join\?token=/);

    // The roster now says there's a live way in.
    assert.equal(find(await roster(), "priya-sharma").invite?.status, "pending");

    // Priya opens it on her own device — a fresh request, no admin cookie.
    const joined = await redeem(tokenFrom(url));
    assert.equal(joined.status, 200);
    const { member } = (await joined.json()) as { member: { id: string; role: string } };
    assert.equal(member.id, "priya-sharma");
    assert.equal(member.role, "member");

    const priyaCookie = (joined.headers.get("set-cookie") ?? "").split(";")[0];
    const me = (await (
      await app.request("/api/me", { headers: { cookie: priyaCookie } })
    ).json()) as Me;
    assert.equal(me.member.id, "priya-sharma");
    assert.equal(me.account, null, "she still has to connect INDmoney herself");

    // Her session is a member's session: the door she came through isn't hers.
    assert.equal(
      (await app.request("/api/admin/members", { headers: { cookie: priyaCookie } }))
        .status,
      403,
    );

    // Single-use: the same link is spent.
    assert.equal((await redeem(tokenFrom(url))).status, 410);

    // And the roster has caught up.
    const row = find(await roster(), "priya-sharma");
    assert.equal(row.invite?.status, "used");
    assert.equal(row.connected, false, "joining is not connecting");
  });

  test("minting a second link voids the first — one member, one live way in", async () => {
    const first = (await (
      await app.request("/api/admin/members/priya-sharma-2/invite", {
        method: "POST",
        headers: { cookie: adminCookie },
      })
    ).json()) as { url: string };

    const second = (await (
      await app.request("/api/admin/members/priya-sharma-2/invite", {
        method: "POST",
        headers: { cookie: adminCookie },
      })
    ).json()) as { url: string };
    assert.notEqual(first.url, second.url);

    assert.equal((await redeem(tokenFrom(first.url))).status, 400, "the first is gone");
    assert.equal(
      (await storage.listInvites()).filter(
        (i) => i.memberId === "priya-sharma-2" && !i.usedAt,
      ).length,
      1,
    );
  });

  test("voiding an unused invite closes the door", async () => {
    const { url } = (await (
      await app.request("/api/admin/members/priya-sharma-2/invite", {
        method: "POST",
        headers: { cookie: adminCookie },
      })
    ).json()) as { url: string };
    assert.equal(find(await roster(), "priya-sharma-2").invite?.status, "pending");

    const voided = await app.request("/api/admin/members/priya-sharma-2/invite", {
      method: "DELETE",
      headers: { cookie: adminCookie },
    });
    assert.equal(voided.status, 200);
    assert.deepEqual(await voided.json(), { voided: 1 });

    // The link in someone's chat app is now worth nothing.
    assert.equal((await redeem(tokenFrom(url))).status, 400);
    assert.equal(find(await roster(), "priya-sharma-2").invite, null);

    // Voiding again is a 404, not a silent success.
    assert.equal(
      (
        await app.request("/api/admin/members/priya-sharma-2/invite", {
          method: "DELETE",
          headers: { cookie: adminCookie },
        })
      ).status,
      404,
    );
  });

  test("a spent invite survives a void — it's the record of how they got in", async () => {
    const before = (await storage.listInvites()).filter(
      (i) => i.memberId === "priya-sharma" && i.usedAt,
    ).length;
    assert.equal(before, 1);

    await app.request("/api/admin/members/priya-sharma/invite", {
      method: "POST",
      headers: { cookie: adminCookie },
    });
    await app.request("/api/admin/members/priya-sharma/invite", {
      method: "DELETE",
      headers: { cookie: adminCookie },
    });

    assert.equal(
      (await storage.listInvites()).filter(
        (i) => i.memberId === "priya-sharma" && i.usedAt,
      ).length,
      before,
    );
    assert.equal(find(await roster(), "priya-sharma").invite?.status, "used");
  });

  test("an unknown member is a 404 on both invite routes", async () => {
    for (const method of ["POST", "DELETE"] as const) {
      const res = await app.request("/api/admin/members/nobody/invite", {
        method,
        headers: { cookie: adminCookie },
      });
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: "unknown_member" });
    }
  });
});

describe("promote", () => {
  test("hands an existing member the roster, and can take it back", async () => {
    await setRole(storage, "m2", "admin");
    assert.equal(
      (await app.request("/api/admin/members", { headers: { cookie: memberCookie } }))
        .status,
      200,
      "the live session picks up the new role without re-authing",
    );
    assert.equal(find(await roster(memberCookie), "m2").role, "admin");

    await setRole(storage, "m2", "member");
    assert.equal(
      (await app.request("/api/admin/members", { headers: { cookie: memberCookie } }))
        .status,
      403,
    );

    await assert.rejects(() => setRole(storage, "nobody", "admin"), /no such member/);
  });
});
