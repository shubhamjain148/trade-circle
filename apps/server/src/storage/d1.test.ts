import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { D1Storage } from "./d1.js";
import type { Storage } from "./index.js";

/**
 * D1Storage against migrations/0001_init.sql, driven through a shim that puts
 * the D1 client surface on top of node:sqlite.
 *
 * The shim is honest about what it does and does not prove. D1 *is* SQLite, so
 * every statement in d1.ts, every column name and every row mapping is really
 * executed here — that is where the bugs live. What it cannot prove is the
 * wire behaviour of the binding itself (rejecting `undefined` parameters, the
 * batch transaction boundary on the server side), so the shim deliberately
 * enforces the parameter rule the real binding enforces, and `batch` really
 * does wrap its statements in a transaction.
 *
 * The migration file is read rather than re-declared: if it drifts from what
 * d1.ts expects, these tests break, which is the point.
 */

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
);
// Every migration in order, so tables added later (device_links, …) are
// exercised here too, not just whatever 0001 happened to contain.
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => join(MIGRATIONS_DIR, f));

class ShimResult {
  constructor(
    readonly results: unknown[],
    readonly meta: { changes: number; last_row_id: number },
  ) {}
  readonly success = true;
}

class ShimStatement {
  private params: unknown[] = [];
  constructor(
    private readonly stmt: StatementSync,
    private readonly db: DatabaseSync,
  ) {}

  bind(...params: unknown[]): ShimStatement {
    for (const p of params) {
      // The real binding throws on undefined; catching it here is the whole
      // reason d1.ts coerces every nullable column through `nul()`.
      if (p === undefined) throw new TypeError("D1: undefined is not a bindable value");
      if (typeof p === "boolean") throw new TypeError("D1: booleans are not bindable");
    }
    const next = new ShimStatement(this.stmt, this.db);
    next.params = params;
    return next;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.stmt.all(...(this.params as never[])) as T[] };
  }

  async first<T>(): Promise<T | null> {
    return (this.stmt.get(...(this.params as never[])) as T | undefined) ?? null;
  }

  async run(): Promise<ShimResult> {
    const res = this.stmt.run(...(this.params as never[]));
    return new ShimResult([], {
      changes: Number(res.changes),
      last_row_id: Number(res.lastInsertRowid),
    });
  }
}

class ShimDatabase {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): ShimStatement {
    return new ShimStatement(this.db.prepare(sql), this.db);
  }

  /** One implicit transaction, sequential, all-or-nothing — as D1 documents. */
  async batch(statements: ShimStatement[]): Promise<ShimResult[]> {
    this.db.exec("BEGIN");
    try {
      const out: ShimResult[] = [];
      for (const s of statements) out.push(await s.run());
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

let raw: DatabaseSync;
let storage: Storage;

before(() => {
  raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const m of MIGRATIONS) raw.exec(readFileSync(m, "utf8"));
  storage = new D1Storage(new ShimDatabase(raw) as never);
});

after(() => raw.close());

const NOW = "2026-01-02T03:04:05.000Z";

describe("D1Storage", () => {
  test("the migration matches what the code expects", async () => {
    await storage.init();
    await storage.upsertMember({
      id: "m1",
      name: "Shubham",
      visibility: "named",
      role: "admin",
      createdAt: NOW,
    });
    await storage.upsertAccount({
      id: "a-m1",
      memberId: "m1",
      provider: "indmoney",
      status: "active",
      // null, not undefined: the shim rejects undefined exactly as D1 does.
      lastPolledAt: null,
    });
    assert.deepEqual(await storage.getMember("m1"), {
      id: "m1",
      name: "Shubham",
      visibility: "named",
      role: "admin",
      createdAt: NOW,
    });
    assert.equal((await storage.getAccountByMember("m1"))?.id, "a-m1");
  });

  test("upsertMember updates rather than duplicating", async () => {
    await storage.upsertMember({
      id: "m1",
      name: "Shubham J",
      visibility: "anonymous",
      role: "admin",
      createdAt: NOW,
    });
    const members = await storage.listMembers();
    assert.equal(members.length, 1);
    assert.equal(members[0].name, "Shubham J");
    assert.equal(members[0].visibility, "anonymous");
  });

  test("snapshots round-trip through the JSON column", async () => {
    const positions = [
      { instrumentId: "us_nvda", symbol: "NVDA", name: "NVIDIA", qty: 10, avgCost: 780, mktValue: 9000 },
    ];
    await storage.saveSnapshot("a-m1", NOW, positions);
    const latest = await storage.latestSnapshot("a-m1");
    assert.equal(latest?.takenAt, NOW);
    assert.deepEqual(latest?.positions, positions);
  });

  test("replaceCurrentPositions is atomic and replaces wholesale", async () => {
    const p = (instrumentId: string, qty: number) => ({
      accountId: "a-m1",
      instrumentId,
      symbol: instrumentId.toUpperCase(),
      name: instrumentId,
      qty,
      avgCost: 1,
      mktValue: qty,
      pctOfPortfolio: 50,
      updatedAt: NOW,
    });
    await storage.replaceCurrentPositions("a-m1", [p("a", 1), p("b", 2)]);
    assert.equal((await storage.getCurrentPositions("a-m1")).length, 2);
    await storage.replaceCurrentPositions("a-m1", [p("c", 3)]);
    const rows = await storage.getCurrentPositions("a-m1");
    assert.deepEqual(
      rows.map((r) => r.instrumentId),
      ["c"],
    );
    assert.equal(rows[0].qty, 3);
  });

  test("feed events are idempotent on the content-hash id", async () => {
    const event = {
      id: "hash-1",
      accountId: "a-m1",
      type: "NEW_POSITION" as const,
      instrumentId: "us_nvda",
      symbol: "NVDA",
      instrumentName: "NVIDIA",
      pctOfPortfolio: 40,
      qtyChangePct: null,
      detectedAt: NOW,
      suppressed: false,
      suppressReason: null,
    };
    await storage.insertFeedEvents([event]);
    await storage.insertFeedEvents([event, { ...event, id: "hash-2", suppressed: true, suppressReason: "corporate_action" }]);

    const visible = await storage.listFeedEvents();
    assert.deepEqual(
      visible.map((e) => e.id),
      ["hash-1"],
    );
    assert.equal(visible[0].qtyChangePct, null);
    assert.equal(visible[0].suppressed, false);

    const all = await storage.listFeedEvents({ includeSuppressed: true });
    assert.equal(all.length, 2);
    assert.equal(all.find((e) => e.id === "hash-2")?.suppressReason, "corporate_action");
  });

  test("listFeedEvents filters by account and an inclusive since", async () => {
    assert.equal((await storage.listFeedEvents({ accountId: "a-nobody" })).length, 0);
    assert.equal((await storage.listFeedEvents({ since: NOW })).length, 1);
    assert.equal((await storage.listFeedEvents({ since: "2027-01-01T00:00:00.000Z" })).length, 0);
  });

  test("messages come back newest first", async () => {
    await storage.insertMessage({ id: "x1", memberId: "m1", body: "one", createdAt: "2026-01-01T00:00:00.000Z" });
    await storage.insertMessage({ id: "x2", memberId: "m1", body: "two", createdAt: "2026-01-02T00:00:00.000Z" });
    assert.deepEqual(
      (await storage.listMessages()).map((m) => m.id),
      ["x2", "x1"],
    );
    assert.deepEqual(
      (await storage.listMessages({ since: "2026-01-02T00:00:00.000Z" })).map((m) => m.id),
      ["x2"],
    );
  });

  test("invites are single-use and distinguish unknown from spent", async () => {
    await storage.createInvite({ tokenHash: "h1", memberId: "m1", createdAt: NOW, usedAt: null });
    assert.equal(await storage.consumeInvite("nope", NOW), undefined);
    const first = await storage.consumeInvite("h1", NOW);
    assert.notEqual(first, "used");
    assert.equal((first as { memberId: string }).memberId, "m1");
    assert.equal(await storage.consumeInvite("h1", NOW), "used");
  });

  test("pending invites can be listed and voided; spent ones survive", async () => {
    await storage.createInvite({ tokenHash: "h2", memberId: "m1", createdAt: NOW, usedAt: null });
    await storage.createInvite({ tokenHash: "h3", memberId: "m1", createdAt: NOW, usedAt: null });
    assert.equal((await storage.listInvites()).length, 3);
    assert.equal(await storage.deletePendingInvites("m1"), 2);
    const left = await storage.listInvites();
    assert.deepEqual(
      left.map((i) => i.tokenHash),
      ["h1"],
    );
    assert.equal(left[0].usedAt, NOW);
  });

  test("sessions expire on read", async () => {
    await storage.createSession({
      tokenHash: "s1",
      memberId: "m1",
      createdAt: NOW,
      expiresAt: "2026-01-03T00:00:00.000Z",
    });
    assert.ok(await storage.getSession("s1", NOW));
    assert.equal(await storage.getSession("s1", "2026-02-01T00:00:00.000Z"), undefined);
    await storage.deleteSession("s1");
    assert.equal(await storage.getSession("s1", NOW), undefined);
  });

  test("oauth connections upsert, and json_extract finds the issuer's DCR client", async () => {
    const meta = JSON.stringify({ issuer: "https://as.example/" });
    await storage.upsertOAuthConnection({
      accountId: "a-m1",
      provider: "indmoney",
      accessTokenEnc: "v2.a",
      refreshTokenEnc: null,
      expiresAt: null,
      scope: null,
      clientInfoJsonEnc: "v2.client",
      authorizationServerMetaJson: meta,
      createdAt: NOW,
      updatedAt: NOW,
      status: "active",
    });
    const stored = await storage.getOAuthConnection("a-m1");
    assert.equal(stored?.refreshTokenEnc, null);
    assert.equal(stored?.status, "active");

    await storage.upsertOAuthConnection({
      ...stored!,
      accessTokenEnc: "v2.b",
      refreshTokenEnc: "v2.r",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
    const updated = await storage.getOAuthConnection("a-m1");
    assert.equal(updated?.accessTokenEnc, "v2.b");
    assert.equal(updated?.refreshTokenEnc, "v2.r");
    assert.equal((await storage.listOAuthConnections()).length, 1);

    // The whole point of the column: reuse one DCR registration per AS.
    assert.equal(await storage.findClientInfoForIssuer("https://as.example/"), "v2.client");
    assert.equal(await storage.findClientInfoForIssuer("https://other/"), undefined);

    await storage.setOAuthConnectionStatus("a-m1", "needs_reauth", NOW);
    assert.equal((await storage.getOAuthConnection("a-m1"))?.status, "needs_reauth");
    await storage.deleteOAuthConnection("a-m1");
    assert.equal(await storage.getOAuthConnection("a-m1"), undefined);
  });

  test("oauth states are single-use and sweep their own expiries", async () => {
    const row = {
      state: "st-1",
      memberId: "m1",
      codeVerifierEnc: "v2.cv",
      issuer: "https://as.example/",
      authorizationServerUrl: "https://as.example/",
      authorizationServerMetaJson: "{}",
      clientInfoJsonEnc: "v2.client",
      resource: null,
      createdAt: NOW,
      expiresAt: "2026-01-02T03:14:05.000Z",
    };
    await storage.createOAuthState(row);
    await storage.createOAuthState({ ...row, state: "st-stale", expiresAt: NOW });

    assert.deepEqual(await storage.consumeOAuthState("st-1", NOW), row);
    // Spent, and the expired sibling went with it.
    assert.equal(await storage.consumeOAuthState("st-1", NOW), undefined);
    assert.equal(await storage.consumeOAuthState("st-stale", NOW), undefined);
  });

  test("raw archive stores payloads and prunes by age", async () => {
    await storage.archiveRaw("a-m1", "2026-01-01T00:00:00.000Z", "networth_holdings", { a: 1 });
    await storage.archiveRaw("a-m1", "2026-06-01T00:00:00.000Z", "networth_holdings", { b: 2 });
    const rows = await storage.listRawArchive("a-m1");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0].payload, { b: 2 });
    assert.equal(await storage.pruneRawArchive("2026-03-01T00:00:00.000Z"), 1);
    assert.equal((await storage.listRawArchive("a-m1")).length, 1);
  });

  test("tool catalog keeps the newest capture", async () => {
    await storage.saveToolCatalog("a-m1", NOW, { tools: [{ name: "old" }] });
    await storage.saveToolCatalog("a-m1", "2026-02-01T00:00:00.000Z", { tools: [{ name: "new" }] });
    const latest = await storage.latestToolCatalog("a-m1");
    assert.deepEqual(latest?.tools, { tools: [{ name: "new" }] });
  });

  test("push subscriptions upsert per endpoint and count their own failures", async () => {
    const row = {
      endpointHash: "h-phone",
      memberId: "m1",
      subscriptionJson: '{"endpoint":"https://push.example.net/phone"}',
      createdAt: NOW,
      // null, not undefined: the shim rejects undefined exactly as D1 does.
      lastOkAt: null,
      failedCount: 0,
    };
    await storage.upsertPushSubscription(row);
    await storage.upsertPushSubscription({ ...row, endpointHash: "h-laptop" });
    // Two devices, one member — the whole reason the endpoint is the key.
    assert.equal((await storage.listPushSubscriptions()).length, 2);
    assert.deepEqual(await storage.getPushSubscription("h-phone"), row);

    assert.equal(await storage.bumpPushSubscriptionFailure("h-phone"), 1);
    assert.equal(await storage.bumpPushSubscriptionFailure("h-phone"), 2);

    // A success forgives the count; a re-subscribe would too.
    await storage.markPushSubscriptionOk("h-phone", NOW);
    const ok = await storage.getPushSubscription("h-phone");
    assert.equal(ok?.failedCount, 0);
    assert.equal(ok?.lastOkAt, NOW);

    await storage.bumpPushSubscriptionFailure("h-laptop");
    await storage.upsertPushSubscription({ ...row, endpointHash: "h-laptop" });
    assert.equal((await storage.getPushSubscription("h-laptop"))?.failedCount, 0);

    await storage.deletePushSubscription("h-phone");
    assert.equal(await storage.getPushSubscription("h-phone"), undefined);
    assert.equal((await storage.listPushSubscriptions()).length, 1);
  });

  test("markPolled and setAccountStatus land on the account row", async () => {
    await storage.markPolled("a-m1", NOW);
    await storage.setAccountStatus("a-m1", "needs_reauth");
    const account = await storage.getAccount("a-m1");
    assert.equal(account?.lastPolledAt, NOW);
    assert.equal(account?.status, "needs_reauth");
    await storage.close();
  });
});
