import { Hono } from "hono";
import { requireSession, type SessionEnv } from "./auth/session.js";
import type { Config } from "./config.js";
import type { AccountRow, MemberRow } from "./domain.js";
import { createInvite } from "./invite.js";
import type { Storage } from "./storage/index.js";
import type { AdminMember } from "./types.js";

export interface AdminDeps {
  storage: Storage;
  config: Config;
}

/**
 * The group's front door. Until now the only way in was a shell on the box the
 * watcher runs on (`pnpm --filter server invite <memberId>`), which meant one
 * person with a terminal was the bottleneck for the whole friend group.
 *
 * "admin" is a small role on purpose: add a member, mint them a link, void a
 * link. It reads no holdings and grants no extra sight of anyone's portfolio —
 * everything below is roster metadata the admin could already see in the feed.
 *
 * Mounted as its own Hono app so api.ts stays one import and one line, the same
 * shape src/chat.ts uses; the session + role gate applies to these routes only.
 */
export function createAdminApp({ storage, config }: AdminDeps): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();

  app.use("/api/admin/*", requireSession(storage));
  // 403, not 404: a member who lands here is signed in and known, and pretending
  // the route doesn't exist would only make a real bug harder to read.
  app.use("/api/admin/*", async (c, next) => {
    if (c.get("member").role !== "admin") {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  });

  // The roster: who's in, whether their INDmoney link is live, and whether a
  // join link is still outstanding.
  app.get("/api/admin/members", async (c) => {
    return c.json(await roster(storage));
  });

  // Create a member (and the account row the connect flow later fills in).
  // No invite yet — minting the link is a separate, deliberate second tap.
  app.post("/api/admin/members", async (c) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ error: "name_required" }, 400);
    if (name.length > MAX_NAME_LENGTH) {
      return c.json({ error: "name_too_long", max: MAX_NAME_LENGTH }, 400);
    }

    const existing = await storage.listMembers();
    const id = uniqueId(
      slugify(name),
      new Set(existing.map((m) => m.id)),
    );
    const createdAt = new Date().toISOString();

    const member: MemberRow = { id, name, visibility: "named", role: "member", createdAt };
    await storage.upsertMember(member);
    await storage.upsertAccount({
      id: `a-${id}`,
      memberId: id,
      provider: "indmoney",
      status: "paused",
      lastPolledAt: null,
    });

    return c.json({ member: toAdminMember(member, undefined, []) }, 201);
  });

  // Mint a single-use join link. Any link already outstanding for this member is
  // voided first: two live links for one person is two ways in, and the whole
  // point of single-use is that there is exactly one.
  app.post("/api/admin/members/:id/invite", async (c) => {
    const member = await storage.getMember(c.req.param("id"));
    if (!member) return c.json({ error: "unknown_member" }, 404);

    await storage.deletePendingInvites(member.id);
    const url = await createInvite(storage, member.id, config.appUrl);
    return c.json({ url }, 201);
  });

  app.delete("/api/admin/members/:id/invite", async (c) => {
    const member = await storage.getMember(c.req.param("id"));
    if (!member) return c.json({ error: "unknown_member" }, 404);

    const voided = await storage.deletePendingInvites(member.id);
    if (!voided) return c.json({ error: "no_pending_invite" }, 404);
    return c.json({ voided });
  });

  return app;
}

/** Long enough for a full name, short enough that a row stays a row. */
export const MAX_NAME_LENGTH = 60;

async function roster(storage: Storage): Promise<AdminMember[]> {
  const [members, accounts, connections, invites] = await Promise.all([
    storage.listMembers(),
    storage.listAccounts(),
    storage.listOAuthConnections(),
    storage.listInvites(),
  ]);

  const accountByMember = new Map(accounts.map((a) => [a.memberId, a]));
  const connectionByAccount = new Map(connections.map((x) => [x.accountId, x]));

  return members.map((m) => {
    const account = accountByMember.get(m.id);
    const connection = account ? connectionByAccount.get(account.id) : undefined;
    return toAdminMember(
      m,
      account && connection
        ? { account, status: accountStatus(account, connection.status), connected: connection.status === "active" }
        : account
          ? { account, status: "not_connected", connected: false }
          : undefined,
      invites.filter((i) => i.memberId === m.id),
    );
  });
}

interface LinkState {
  account: AccountRow;
  status: string;
  connected: boolean;
}

function toAdminMember(
  member: MemberRow,
  link: LinkState | undefined,
  invites: { createdAt: string; usedAt: string | null }[],
): AdminMember {
  // An outstanding link outranks a spent one: "they can still get in" is the
  // fact an admin is scanning for, and a used link is only ever context.
  const pending = invites.filter((i) => !i.usedAt).at(-1);
  const used = invites.filter((i) => i.usedAt).at(-1);

  return {
    id: member.id,
    name: member.name,
    role: member.role,
    visibility: member.visibility,
    connected: link?.connected ?? false,
    status: link?.status ?? "not_connected",
    lastPolledAt: link?.account.lastPolledAt ?? null,
    invite: pending
      ? { status: "pending", at: pending.createdAt }
      : used
        ? { status: "used", at: used.usedAt! }
        : null,
  };
}

/** Mirrors api.ts: a live grant that needs re-auth outranks the account row. */
function accountStatus(account: AccountRow, connectionStatus: string): string {
  if (connectionStatus === "needs_reauth") return "needs_reauth";
  if (connectionStatus === "revoked") return "revoked";
  return account.status;
}

/**
 * "Priya Sharma" → "priya-sharma". Ids are typed into CLI commands and read in
 * logs, so a readable slug beats a UUID; uniqueness is settled by the caller.
 */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  // A name with no ASCII letters at all still needs an id.
  return slug || "member";
}

export function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
