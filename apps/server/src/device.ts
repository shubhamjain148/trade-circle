import { Hono } from "hono";
import {
  issueSession,
  requireSession,
  type SessionEnv,
} from "./auth/session.js";
import { hashToken, randomToken } from "./auth/vault.js";
import type { Config } from "./config.js";
import type { MemberRow } from "./domain.js";
import type { Storage } from "./storage/index.js";
import type { Member } from "./types.js";

export interface DeviceDeps {
  storage: Storage;
  config: Config;
}

/**
 * Long enough to walk a phone over and scan, short enough that a link left on a
 * screen is worthless by the time anyone else reads it. This is not an invite:
 * nobody is going to open it tomorrow.
 */
export const DEVICE_LINK_TTL_MS = 15 * 60_000;

/**
 * Phone, laptop, and one spare for the mint you tapped twice. A person needs a
 * couple of live links at once; a person needing ten is not a person.
 */
export const MAX_OUTSTANDING_DEVICE_LINKS = 3;

/**
 * "Link another device" — a member signing *themselves* in somewhere else.
 *
 * The distinction from src/invite.ts is the whole design. An invite is an admin
 * handing a stranger a way in, and it names someone who is not in the room. A
 * device link is minted by the person it signs in, from a live session, and
 * adds a device to an account they already hold: the session they minted it
 * from keeps working, because "phone *and* laptop" is the entire request.
 *
 * Mounted as its own Hono app so api.ts stays one import and one line, the same
 * shape src/chat.ts and src/admin.ts use. Unlike those two it has to sit
 * *before* the invite handler, because it extends /api/auth/session rather than
 * adding a route of its own — see createDeviceApp's session handler.
 */
export function createDeviceApp({ storage, config }: DeviceDeps): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();
  const cookieOpts = {
    ttlMs: config.sessionTtlMs,
    secure: config.appUrl.startsWith("https://"),
  };

  app.use("/api/auth/device-link", requireSession(storage));

  // Mint. Session-gated and self-service: the link can only ever name the
  // member who asked for it, so there is no id in the request to check.
  app.post("/api/auth/device-link", async (c) => {
    const member = c.get("member");
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + DEVICE_LINK_TTL_MS).toISOString();

    // Expired links are left alone: they can no longer sign anyone in, and
    // keeping the row is what lets the join screen say "this one expired —
    // mint a fresh one" instead of the flat "never heard of it".
    const outstanding = (await storage.listDeviceLinks(member.id)).filter(
      (link) => !link.usedAt && link.expiresAt > nowIso,
    );
    const doomed = outstanding.slice(
      0,
      Math.max(0, outstanding.length + 1 - MAX_OUTSTANDING_DEVICE_LINKS),
    );
    for (const link of doomed) await storage.deleteDeviceLink(link.tokenHash);

    const token = randomToken();
    await storage.createDeviceLink({
      tokenHash: hashToken(token),
      memberId: member.id,
      createdAt: nowIso,
      expiresAt,
      usedAt: null,
    });

    // Same screen as an invite, on purpose: one join path, one set of states to
    // get right. `device=1` marks the link for anyone reading it in a URL bar —
    // the client keys off the server's answer, not off this.
    return c.json(
      {
        url: `${config.appUrl}/#/join?token=${token}&device=1`,
        expiresAt,
        ttlMs: DEVICE_LINK_TTL_MS,
      },
      201,
    );
  });

  /**
   * The redemption leg, bolted onto the invite handshake rather than beside it.
   *
   * A token the friend pasted is just a token; which table it lives in is our
   * problem, not theirs. So this runs first, answers if the hash is a device
   * link, and calls next() otherwise — which lands on api.ts's invite handler
   * with the body already parsed and cached. Registration order is therefore
   * load-bearing, and api.ts mounts this app above that route.
   */
  app.post("/api/auth/session", async (c, next) => {
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const token = typeof body.inviteToken === "string" ? body.inviteToken : "";
    if (!token) return next();

    const link = await storage.consumeDeviceLink(
      hashToken(token),
      new Date().toISOString(),
    );
    // Not a device link — an invite, or nothing at all. Either way it is the
    // invite handler's answer to give.
    if (!link) return next();
    // Two different sentences on the other end: "you already used this" versus
    // "this one timed out, mint another".
    if (link === "used") return c.json({ error: "link_used" }, 410);
    if (link === "expired") return c.json({ error: "link_expired" }, 410);

    const member = await storage.getMember(link.memberId);
    if (!member) return c.json({ error: "unknown_member" }, 401);

    // A second session, not a moved one. Nothing here touches the sessions the
    // member already holds — that is the difference between linking a device
    // and migrating one.
    await issueSession(c, storage, member.id, cookieOpts);
    return c.json({ member: toMember(member), device: true });
  });

  return app;
}

function toMember(m: MemberRow): Member {
  return { id: m.id, name: m.name, visibility: m.visibility, role: m.role };
}
