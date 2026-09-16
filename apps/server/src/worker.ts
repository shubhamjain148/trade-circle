import { createApp } from "./api.js";
import { Vault } from "./auth/vault.js";
import type { Config } from "./config.js";
import { seedStorage } from "./dev-seed.js";
import { McpPortfolioSource } from "./mcp/source.js";
import { isScheduledSlot } from "./poller/scheduler.js";
import { SnapshotEchoSource } from "./poller/source.js";
import { Backoff, runPollTick } from "./poller/tick.js";
import { createPusher } from "./push/notify.js";
import type { VapidConfig } from "./push/webpush.js";
import type { ChatRoom } from "./room-object.js";
import {
  ROOM_NAME,
  type ReactionBroadcastMap,
  type Room,
  type RoomMember,
} from "./room.js";
import { D1Storage } from "./storage/d1.js";
import type { TimelineItem } from "./types.js";

/**
 * The Durable Object class has to be exported from the entry module for the
 * `durable_objects` binding in wrangler.jsonc to resolve. It is the only thing
 * in this codebase that imports `cloudflare:workers`, which is why it lives in
 * its own file and why src/index.ts (Node) never sees it.
 */
export { ChatRoom } from "./room-object.js";

/**
 * Cloudflare Workers entry point. src/index.ts remains the Node entry point and
 * is unchanged — this is a second front door onto the same Hono app, not a
 * replacement.
 *
 * Three things differ from Node and only three:
 *   1. storage is D1Storage over env.DB instead of SqliteStorage over a file;
 *   2. config comes from Workers vars/secrets instead of process.env;
 *   3. there is no long-lived process, so poller/scheduler.ts's setTimeout loop
 *      is replaced by cron triggers plus the window check in `scheduled` below.
 *
 * Static assets are served by the platform (see the `assets` block in
 * wrangler.jsonc): `run_worker_first` routes only /api/* here, everything else
 * falls through to apps/web/dist with an index.html SPA fallback.
 */

export interface Env {
  DB: D1Database;
  /** Workers Assets. Only reached if a non-/api path somehow gets here. */
  ASSETS: Fetcher;
  /** The single group room — live chat delivery and typing. See src/room.ts. */
  CHAT_ROOM: DurableObjectNamespace<ChatRoom>;
  /** Keys the token vault. `wrangler secret put APP_SECRET`. */
  APP_SECRET: string;
  APP_URL?: string;
  MCP_BASE_URL?: string;
  MCP_CLIENT_NAME?: string;
  /** Escape hatch for the vault KDF cost; see docs/DEPLOYMENT.md. */
  VAULT_KDF_ITERATIONS?: string;
  /**
   * Web Push (RFC 8292). The public key is a var — the browser needs it to
   * subscribe, and it travels in every push request anyway; the private key is
   * a secret. Generate a pair with `pnpm --filter server vapid:generate`.
   *
   * All three unset is a supported state: /api/push/key 404s, the settings row
   * says the watcher has no notifications configured, and no tick tries to send.
   * Rotating the pair invalidates every stored subscription — see the note in
   * src/push/notify.ts and docs/DEPLOYMENT.md.
   */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  /** A `mailto:` the push services can complain to. RFC 8292 §2.1. */
  VAPID_SUBJECT?: string;
  /** "1" exposes POST /api/dev-seed. Never set this in production. */
  DEV_SEED?: string;
}

interface Wiring {
  app: ReturnType<typeof createApp>;
  storage: D1Storage;
  poll: (opts?: PollOptions) => ReturnType<typeof runPollTick>;
}

interface PollOptions {
  force?: boolean;
  /**
   * The invocation's context, when the caller has one and wants the push
   * fan-out to outlive the tick. `scheduled()` passes it; a caller already
   * inside a `waitUntil` (the post-connect first fetch) deliberately does not.
   */
  ctx?: ExecutionContext;
}

/**
 * Per-isolate, keyed on the env object rather than a module-level `let`: no
 * request state is cached, only the wiring that env itself determines. Rebuilding
 * the Hono router on every request would be pure waste against a 10 ms CPU budget.
 */
const wiringCache = new WeakMap<Env, Wiring>();

/** Modest on purpose: sleeping is wall time, but the cron budget is not infinite. */
const STAGGER_MS = 5_000;

function wire(env: Env): Wiring {
  const cached = wiringCache.get(env);
  if (cached) return cached;

  if (!env.APP_SECRET) {
    throw new Error(
      "APP_SECRET is unset — it keys the token vault. Run `wrangler secret put APP_SECRET`.",
    );
  }

  const config: Config = {
    appUrl: stripSlash(env.APP_URL ?? "http://localhost:8787"),
    mcpBaseUrl: env.MCP_BASE_URL ?? "https://mcp.indmoney.com/mcp",
    // Unused on Workers — storage is the D1 binding — but part of the shape.
    dbPath: "",
    port: 0,
    appSecret: env.APP_SECRET,
    sessionTtlMs: 90 * 86_400_000,
    oauthStateTtlMs: 10 * 60_000,
    clientName: env.MCP_CLIENT_NAME ?? "trade-circle",
  };

  const storage = new D1Storage(env.DB);
  const iterations = env.VAULT_KDF_ITERATIONS
    ? Number(env.VAULT_KDF_ITERATIONS)
    : undefined;
  const mcp = { storage, vault: new Vault(config.appSecret, { iterations }), config };

  // Accounts with an active grant go over MCP; everyone else replays their last
  // snapshot, so the group polls cleanly while friends are still joining.
  const source = new McpPortfolioSource(mcp, {
    fallback: new SnapshotEchoSource(storage),
  });
  // Backoff lives as long as the isolate does, which is shorter than a Node
  // process — a cold start forgives a throttled account early. Acceptable: the
  // account's own rate limit is the real backstop.
  const backoff = new Backoff();

  const room = new DurableRoom(env.CHAT_ROOM);
  const vapid = vapidConfig(env);

  /**
   * Built per call rather than per isolate, because the only thing that varies
   * is where the fan-out gets parked: a cron hands it to `waitUntil` so the
   * tick's own result is logged without waiting on Apple and Google, while a
   * caller already inside a `waitUntil` just awaits it.
   */
  const pusher = (ctx?: ExecutionContext) =>
    vapid
      ? createPusher({
          storage,
          vapid,
          defer: ctx ? (work) => ctx.waitUntil(work) : undefined,
        })
      : undefined;

  const poll = (opts?: PollOptions) =>
    runPollTick(storage, source, {
      staggerMs: STAGGER_MS,
      backoff,
      notifier: room,
      pusher: pusher(opts?.ctx),
      force: opts?.force,
    });

  // One account, right now: the first fetch after a connect, handed to
  // ctx.waitUntil by the callback handler. No stagger (there is nothing to
  // spread, and the redirect is already gone) and no backoff (a fresh grant
  // has no failure history to honour).
  const pollOne = (accountId: string) =>
    runPollTick(storage, source, {
      staggerMs: 0,
      accountIds: [accountId],
      notifier: room,
      // No ctx: this whole call is already inside the connect handler's
      // waitUntil, so deferring again would only hide the fan-out from it.
      pusher: pusher(),
    });

  const wiring: Wiring = {
    app: createApp({
      storage,
      poll,
      pollOne,
      config,
      mcp,
      room,
      vapidPublicKey: vapid?.publicKey,
    }),
    storage,
    poll,
  };
  wiringCache.set(env, wiring);
  return wiring;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Belt and braces: `run_worker_first: ["/api/*"]` means the platform should
    // already have served these, but a misconfigured deploy should show the app
    // rather than a bare 404 from the router.
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      const { storage } = wire(env);

      if (url.pathname === "/api/dev-seed") {
        if (env.DEV_SEED !== "1") return json({ error: "not_found" }, 404);
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        return json(await seedStorage(storage));
      }

      return await wire(env).app.fetch(request, env, ctx);
    } catch (err) {
      console.error(
        JSON.stringify({ msg: "unhandled request error", path: url.pathname, err: message(err) }),
      );
      return json({ error: "internal_error" }, 500);
    }
  },

  /**
   * Cron triggers fire at the slots poller/scheduler.ts would have picked (see
   * `triggers.crons` in wrangler.jsonc). The window check repeats the decision
   * in code because cron is coarse, a trigger list can drift from the schedule,
   * and a poll outside US market hours is a wasted round trip to INDmoney.
   *
   * Wall-clock budget is 15 minutes per cron invocation; CPU is 10 ms on the
   * free plan and 30 s on paid (see docs/DEPLOYMENT.md). The staggered sleeps
   * are wall time, not CPU, so the stagger is not what puts this at risk.
   */
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const at = new Date(controller.scheduledTime);
    if (!isScheduledSlot(at)) {
      console.log(
        JSON.stringify({ msg: "poll skipped, outside market window", at: at.toISOString() }),
      );
      return;
    }
    const result = await wire(env).poll({ ctx });
    console.log(
      JSON.stringify({
        msg: "poll tick",
        cron: controller.cron,
        at: result.at,
        polled: result.polled.length,
        unchanged: result.unchanged.length,
        skipped: result.skipped.length,
        errors: result.errors.length,
        events: result.events,
        suppressed: result.suppressed,
      }),
    );
  },
};

/**
 * The Workers half of the room seam: a stub, and the two things the rest of the
 * codebase is allowed to ask of it. Everything above this line is written
 * against the `Room` interface in src/room.ts and would run unchanged with no
 * room at all.
 *
 * Stateless and cheap to construct — the namespace is the binding, and
 * `getByName` resolves the same object every time from any isolate, which is
 * the whole reason a single group room works without a coordinator.
 */
class DurableRoom implements Room {
  constructor(private readonly namespace: DurableObjectNamespace<ChatRoom>) {}

  /**
   * One RPC call, one billed request, however many sockets are on the other
   * side — outgoing WebSocket messages are free. Never throws: callers are
   * either mid-response or mid-cron and have already done the durable work.
   */
  async broadcast(items: TimelineItem[]): Promise<void> {
    if (items.length === 0) return;
    try {
      await this.namespace.getByName(ROOM_NAME).broadcast(items);
    } catch (err) {
      console.warn(
        JSON.stringify({ msg: "room broadcast failed", err: message(err) }),
      );
    }
  }

  /**
   * The same one-call fan-out for reaction summaries. Separate from broadcast()
   * because the room has to personalise `mine` per socket and therefore cannot
   * reuse the single-serialisation path; see room-object.ts.
   */
  async broadcastReactions(reactions: ReactionBroadcastMap): Promise<void> {
    if (Object.keys(reactions).length === 0) return;
    try {
      await this.namespace.getByName(ROOM_NAME).broadcastReactions(reactions);
    } catch (err) {
      console.warn(
        JSON.stringify({ msg: "room reaction broadcast failed", err: message(err) }),
      );
    }
  }

  /**
   * Forward the upgrade. The original headers carry the WebSocket handshake, so
   * they are copied rather than rebuilt — minus the cookie, which has done its
   * job at the session check and has no business travelling any further.
   */
  upgrade(request: Request, member: RoomMember): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    headers.set("x-room-member-id", member.id);
    // Names are free text and headers are not: percent-encode, decode in the room.
    headers.set("x-room-member-name", encodeURIComponent(member.name));

    return this.namespace
      .getByName(ROOM_NAME)
      .fetch(new Request(request.url, { method: "GET", headers }));
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * All three or nothing. A half-configured VAPID is the failure mode worth
 * refusing loudly: a public key without a private one gives the settings screen
 * a working Enable button whose every send then fails silently, and the friend
 * who tapped it has no way to know.
 */
function vapidConfig(env: Env): VapidConfig | undefined {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = env;
  if (!VAPID_PUBLIC_KEY && !VAPID_PRIVATE_KEY && !VAPID_SUBJECT) return undefined;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
    throw new Error(
      "VAPID is half-configured — set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and " +
        "VAPID_SUBJECT together, or none of them. See docs/DEPLOYMENT.md.",
    );
  }
  return {
    publicKey: VAPID_PUBLIC_KEY,
    privateKey: VAPID_PRIVATE_KEY,
    subject: VAPID_SUBJECT,
  };
}

function stripSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
