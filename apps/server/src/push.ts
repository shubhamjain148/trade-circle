import { Hono } from "hono";
import { requireSession, type SessionEnv } from "./auth/session.js";
import { hashToken } from "./auth/vault.js";
import type { Storage } from "./storage/index.js";

export interface PushDeps {
  storage: Storage;
  /**
   * The application server's public key, when one is configured. Absent is a
   * supported state and not a broken one: the settings row says so plainly and
   * nothing else in the app changes.
   */
  vapidPublicKey?: string;
}

/**
 * Subscription management: three small routes, all session-gated.
 *
 * There is deliberately nothing here on /api/me. Whether *this browser* has a
 * push subscription is a fact the browser already holds — `registration.push-
 * Manager.getSubscription()` — and a server-side flag would immediately be
 * wrong for the other device the same member is signed in on. The rows exist to
 * be sent to, not to be reported back.
 *
 * Mounted as its own Hono app, the same shape src/chat.ts and src/device.ts use.
 */
export function createPushApp({ storage, vapidPublicKey }: PushDeps): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();

  app.use("/api/push/key", requireSession(storage));
  app.use("/api/push/subscribe", requireSession(storage));

  /**
   * The applicationServerKey the browser needs before it can subscribe. Public
   * by nature — it travels in every push request's Authorization header — but
   * gated anyway, because nobody outside the group has any use for it.
   *
   * 404 when unset, which is what an undeployed VAPID config looks like: the
   * settings row reads "not configured" rather than offering a button that
   * could only fail.
   */
  app.get("/api/push/key", (c) => {
    if (!vapidPublicKey) return c.json({ error: "push_not_configured" }, 404);
    return c.json({ key: vapidPublicKey });
  });

  /**
   * Register this browser. Upsert on the endpoint hash: a browser that renews
   * its subscription, or a member who signs in on a device someone else used,
   * lands on the one row that endpoint can ever have.
   */
  app.post("/api/push/subscribe", async (c) => {
    const member = c.get("member");
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const subscription = parseSubscription(body.subscription);
    if (!subscription) return c.json({ error: "invalid_subscription" }, 400);

    await storage.upsertPushSubscription({
      endpointHash: hashToken(subscription.endpoint),
      memberId: member.id,
      // Stored whole: sending needs the endpoint and both keys, and re-deriving
      // any part of a structure the Push API already handed us is invention.
      subscriptionJson: JSON.stringify(subscription),
      createdAt: new Date().toISOString(),
      lastOkAt: null,
      failedCount: 0,
    });

    return c.json({ ok: true }, 201);
  });

  /**
   * Turn this browser off. Own rows only — and a row belonging to someone else
   * answers exactly as a row that never existed did, because the difference
   * between "not yours" and "not there" is not a fact this endpoint should be
   * willing to confirm.
   */
  app.delete("/api/push/subscribe", async (c) => {
    const member = c.get("member");
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    if (!endpoint) return c.json({ error: "endpoint_required" }, 400);

    const hash = hashToken(endpoint);
    const existing = await storage.getPushSubscription(hash);
    if (!existing || existing.memberId !== member.id) {
      return c.json({ error: "not_found" }, 404);
    }

    await storage.deletePushSubscription(hash);
    return c.json({ ok: true });
  });

  return app;
}

/** The shape `PushSubscription.toJSON()` produces, and nothing else. */
interface StoredSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Validated here rather than at send time. A malformed row is only discovered
 * when a friend's move fails to arrive, hours later and silently; a malformed
 * request is discovered by the browser that made it, immediately.
 */
function parseSubscription(value: unknown): StoredSubscription | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { endpoint, keys } = value as { endpoint?: unknown; keys?: unknown };
  if (typeof endpoint !== "string" || !endpoint) return undefined;
  // https only, and a real URL: this string becomes the target of a POST.
  try {
    if (new URL(endpoint).protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  if (typeof keys !== "object" || keys === null) return undefined;
  const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown };
  if (typeof p256dh !== "string" || typeof auth !== "string") return undefined;
  if (!p256dh || !auth) return undefined;
  return { endpoint, keys: { p256dh, auth } };
}
