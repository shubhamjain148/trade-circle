import { Hono } from "hono";
import { logger } from "hono/logger";
import type { AccountRow, MemberRow } from "./domain.js";
import { nextRunAt } from "./poller/scheduler.js";
import type { TickResult } from "./poller/tick.js";
import type { Storage } from "./storage/index.js";
import type { FeedEvent, Member } from "./types.js";

export interface ApiDeps {
  storage: Storage;
  /** One manual poll tick; wired to POST /api/poll. */
  poll: () => Promise<TickResult>;
}

export function createApp({ storage, poll }: ApiDeps): Hono {
  const app = new Hono();

  app.use(logger());

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/members", async (c) => {
    const members = await storage.listMembers();
    return c.json(members.map(toMember));
  });

  // Group feed: everyone's events interleaved, newest first.
  // Individual feed: same log filtered by ?accountId= (member id or account id).
  app.get("/api/feed", async (c) => {
    const filter = c.req.query("accountId");
    const [members, accounts, rows] = await Promise.all([
      storage.listMembers(),
      storage.listAccounts(),
      storage.listFeedEvents({ limit: 500 }),
    ]);
    const memberById = new Map(members.map((m) => [m.id, m]));
    const accountById = new Map(accounts.map((a) => [a.id, a]));
    const wanted = filter ? resolveAccountIds(filter, accounts) : null;

    const events: FeedEvent[] = [];
    for (const row of rows) {
      if (wanted && !wanted.has(row.accountId)) continue;
      const account = accountById.get(row.accountId);
      const member = account && memberById.get(account.memberId);
      if (!member || member.visibility === "paused") continue;
      events.push({
        id: row.id,
        accountId: member.id,
        accountName:
          member.visibility === "anonymous" ? "Someone in the group" : member.name,
        type: row.type,
        symbol: row.symbol,
        instrumentName: row.instrumentName,
        pctOfPortfolio: row.pctOfPortfolio,
        ...(row.qtyChangePct === null ? {} : { qtyChangePct: row.qtyChangePct }),
        detectedAt: row.detectedAt,
      });
    }
    return c.json(events);
  });

  // Poll status per account — what the scheduler did and when it goes again.
  app.get("/api/accounts", async (c) => {
    const [members, accounts] = await Promise.all([
      storage.listMembers(),
      storage.listAccounts(),
    ]);
    const memberById = new Map(members.map((m) => [m.id, m]));
    const next = nextRunAt(new Date()).toISOString();
    const rows = await Promise.all(
      accounts.map(async (a) => ({
        id: a.id,
        memberId: a.memberId,
        memberName: memberById.get(a.memberId)?.name ?? "unknown",
        provider: a.provider,
        status: a.status,
        lastPolledAt: a.lastPolledAt,
        nextPollAt: a.status === "active" ? next : null,
        positions: (await storage.getCurrentPositions(a.id)).length,
      })),
    );
    return c.json(rows);
  });

  // Manual tick. Also the hook an external cron calls (docs/DEPLOYMENT.md §1).
  app.post("/api/poll", async (c) => {
    const result = await poll();
    return c.json(result);
  });

  return app;
}

function resolveAccountIds(
  filter: string,
  accounts: AccountRow[],
): Set<string> {
  const direct = accounts.filter((a) => a.id === filter);
  const byMember = accounts.filter((a) => a.memberId === filter);
  return new Set((direct.length ? direct : byMember).map((a) => a.id));
}

function toMember(m: MemberRow): Member {
  return { id: m.id, name: m.name, visibility: m.visibility };
}
