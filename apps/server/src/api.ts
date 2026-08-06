import { Hono } from "hono";
import { logger } from "hono/logger";
import { createAdminApp } from "./admin.js";
import {
  clearSession,
  currentMember,
  issueSession,
  requireSession,
  type SessionEnv,
} from "./auth/session.js";
import { hashToken } from "./auth/vault.js";
import { createChatApp } from "./chat.js";
import type { Config } from "./config.js";
import type { AccountRow, MemberRow } from "./domain.js";
import { toFeedEvents } from "./feed.js";
import { captureToolCatalog } from "./mcp/client.js";
import {
  completeConnect,
  revokeConnection,
  startConnect,
  type McpDeps,
} from "./mcp/oauth.js";
import { nextRunAt } from "./poller/scheduler.js";
import type { TickResult } from "./poller/tick.js";
import type { Storage } from "./storage/index.js";
import type { Member } from "./types.js";

export interface ApiDeps {
  storage: Storage;
  /** One manual poll tick; wired to POST /api/poll. */
  poll: (opts?: { force?: boolean }) => Promise<TickResult>;
  config: Config;
  mcp: McpDeps;
}

export function createApp({ storage, poll, config, mcp }: ApiDeps): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();
  const cookieOpts = {
    ttlMs: config.sessionTtlMs,
    secure: config.appUrl.startsWith("https://"),
  };

  app.use(logger());

  app.get("/api/health", (c) => c.json({ ok: true }));

  // Invite → session. The token is single-use and only its hash was ever stored.
  app.post("/api/auth/session", async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const inviteToken = typeof body.inviteToken === "string" ? body.inviteToken : "";
    if (!inviteToken) return c.json({ error: "invite_token_required" }, 400);

    const invite = await storage.consumeInvite(
      hashToken(inviteToken),
      new Date().toISOString(),
    );
    if (invite === "used") return c.json({ error: "invite_used" }, 410);
    if (!invite) return c.json({ error: "invite_invalid" }, 400);

    const member = await storage.getMember(invite.memberId);
    if (!member) return c.json({ error: "unknown_member" }, 401);

    await issueSession(c, storage, member.id, cookieOpts);
    return c.json({ member: toMember(member) });
  });

  app.post("/api/auth/logout", async (c) => {
    await clearSession(c, storage);
    return c.json({ ok: true });
  });

  app.get("/api/me", async (c) => {
    const member = await currentMember(c, storage);
    if (!member) return c.json({ error: "unauthorized" }, 401);
    const account = await storage.getAccountByMember(member.id);
    const connection = account
      ? await storage.getOAuthConnection(account.id)
      : undefined;
    // "account" here means the INDmoney *link*: until an OAuth connection
    // exists the account row is just provisioning, and the UI should see null
    // ("not connected"), not the row's lifecycle status.
    return c.json({
      member: toMember(member),
      account:
        account && connection
          ? {
              connected: connection.status === "active",
              status: accountStatus(account, connection.status),
              lastPolledAt: account.lastPolledAt,
            }
          : null,
    });
  });

  // Visibility is the member's own dial (docs/RESEARCH.md decisions): named,
  // anonymous, or paused. Applies from the next feed read; history unchanged.
  app.patch("/api/me/visibility", async (c) => {
    const member = await currentMember(c, storage);
    if (!member) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const visibility = body.visibility;
    if (visibility !== "named" && visibility !== "anonymous" && visibility !== "paused") {
      return c.json({ error: "invalid_visibility" }, 400);
    }
    await storage.upsertMember({ ...member, visibility });
    return c.json({ member: toMember({ ...member, visibility }) });
  });

  app.use("/api/members", requireSession(storage));
  app.use("/api/feed", requireSession(storage));
  app.use("/api/accounts", requireSession(storage));
  app.use("/api/connect/indmoney/start", requireSession(storage));
  // The callback arrives from INDmoney's redirect; `state` is what binds it to a
  // member, so it deliberately does not require the cookie.
  app.use("/api/connect/indmoney", requireSession(storage));

  app.get("/api/members", async (c) => {
    const members = await storage.listMembers();
    return c.json(members.map(toMember));
  });

  // Group feed: everyone's events interleaved, newest first.
  // Individual feed: same log filtered by ?accountId= (member id or account id).
  app.get("/api/feed", async (c) => {
    const [members, accounts, rows] = await Promise.all([
      storage.listMembers(),
      storage.listAccounts(),
      storage.listFeedEvents({ limit: 500 }),
    ]);
    return c.json(
      toFeedEvents(rows, members, accounts, c.req.query("accountId")),
    );
  });

  // Poll status per account — what the scheduler did and when it goes again.
  app.get("/api/accounts", async (c) => {
    const [members, accounts, connections] = await Promise.all([
      storage.listMembers(),
      storage.listAccounts(),
      storage.listOAuthConnections(),
    ]);
    const memberById = new Map(members.map((m) => [m.id, m]));
    const connectionByAccount = new Map(connections.map((x) => [x.accountId, x]));
    const next = nextRunAt(new Date()).toISOString();
    const rows = await Promise.all(
      accounts.map(async (a) => {
        const connection = connectionByAccount.get(a.id);
        return {
          id: a.id,
          memberId: a.memberId,
          memberName: memberById.get(a.memberId)?.name ?? "unknown",
          provider: a.provider,
          status: connection ? accountStatus(a, connection.status) : "not_connected",
          connected: connection?.status === "active",
          lastPolledAt: a.lastPolledAt,
          nextPollAt: a.status === "active" ? next : null,
          positions: (await storage.getCurrentPositions(a.id)).length,
        };
      }),
    );
    return c.json(rows);
  });

  // Leg one of the OAuth flow: 302 the friend to INDmoney's own consent screen.
  app.get("/api/connect/indmoney/start", async (c) => {
    const member = c.get("member");
    try {
      const { authorizationUrl } = await startConnect(mcp, member.id);
      if (c.req.query("json") === "1") return c.json({ authorizationUrl });
      return c.redirect(authorizationUrl, 302);
    } catch (err) {
      return c.json({ error: "connect_start_failed", message: message(err) }, 502);
    }
  });

  // Leg two: redeem the code, vault the tokens, capture tools/list, bounce back.
  app.get("/api/connect/indmoney/callback", async (c) => {
    const error = c.req.query("error");
    if (error) return c.redirect(settingsUrl(config, { connect_error: error }), 302);

    const state = c.req.query("state");
    const code = c.req.query("code");
    if (!state || !code) {
      return c.redirect(settingsUrl(config, { connect_error: "missing_code" }), 302);
    }

    let accountId: string;
    try {
      ({ accountId } = await completeConnect(mcp, {
        state,
        code,
        iss: c.req.query("iss") ?? undefined,
      }));
    } catch (err) {
      return c.redirect(settingsUrl(config, { connect_error: message(err) }), 302);
    }

    // Schema capture, best-effort: a failure here must not undo a live grant.
    try {
      await captureToolCatalog(mcp, accountId);
    } catch (err) {
      console.warn(`tool catalog capture failed for ${accountId}: ${message(err)}`);
    }
    return c.redirect(settingsUrl(config, { connected: "1" }), 302);
  });

  app.delete("/api/connect/indmoney", async (c) => {
    const member = c.get("member");
    const account = await storage.getAccountByMember(member.id);
    if (!account) return c.json({ error: "no_account" }, 404);
    const result = await revokeConnection(mcp, account.id);
    return c.json({ ok: true, ...result });
  });

  // Manual tick. Also the hook an external cron calls (docs/DEPLOYMENT.md §1).
  // ?force=1 skips the cheap-probe gate and always pulls full holdings.
  app.post("/api/poll", async (c) => {
    const result = await poll({ force: c.req.query("force") === "1" });
    return c.json(result);
  });

  // Group chat + activity timeline. Session-gated inside; see src/chat.ts.
  app.route("/", createChatApp({ storage }));

  // Roster + invites. Session- and role-gated inside; see src/admin.ts.
  app.route("/", createAdminApp({ storage, config }));

  return app;
}

function settingsUrl(config: Config, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return `${config.appUrl}/#/settings?${query}`;
}

/** A live grant that needs re-auth outranks whatever the account row still says. */
function accountStatus(
  account: AccountRow,
  connectionStatus: string | undefined,
): string {
  if (connectionStatus === "needs_reauth") return "needs_reauth";
  if (connectionStatus === "revoked") return "revoked";
  return account.status;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toMember(m: MemberRow): Member {
  return { id: m.id, name: m.name, visibility: m.visibility, role: m.role };
}
