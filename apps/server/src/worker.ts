import { createApp } from "./api.js";
import { Vault } from "./auth/vault.js";
import type { Config } from "./config.js";
import { seedStorage } from "./dev-seed.js";
import { McpPortfolioSource } from "./mcp/source.js";
import { runMinutesUtc } from "./poller/scheduler.js";
import { SnapshotEchoSource } from "./poller/source.js";
import { Backoff, runPollTick } from "./poller/tick.js";
import { D1Storage } from "./storage/d1.js";

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
  /** Keys the token vault. `wrangler secret put APP_SECRET`. */
  APP_SECRET: string;
  APP_URL?: string;
  MCP_BASE_URL?: string;
  MCP_CLIENT_NAME?: string;
  /** Escape hatch for the vault KDF cost; see docs/DEPLOYMENT.md. */
  VAULT_KDF_ITERATIONS?: string;
  /** "1" exposes POST /api/dev-seed. Never set this in production. */
  DEV_SEED?: string;
}

interface Wiring {
  app: ReturnType<typeof createApp>;
  storage: D1Storage;
  poll: (opts?: { force?: boolean }) => ReturnType<typeof runPollTick>;
}

/**
 * Per-isolate, keyed on the env object rather than a module-level `let`: no
 * request state is cached, only the wiring that env itself determines. Rebuilding
 * the Hono router on every request would be pure waste against a 10 ms CPU budget.
 */
const wiringCache = new WeakMap<Env, Wiring>();

/** Modest on purpose: sleeping is wall time, but the cron budget is not infinite. */
const STAGGER_MS = 5_000;

/** Cron granularity is coarse; accept a slot only within this much of it. */
const SLOT_TOLERANCE_MIN = 5;

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
    clientName: env.MCP_CLIENT_NAME ?? "indmoney-watcher",
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

  const poll = (opts?: { force?: boolean }) =>
    runPollTick(storage, source, { staggerMs: STAGGER_MS, backoff, ...opts });

  const wiring: Wiring = { app: createApp({ storage, poll, config, mcp }), storage, poll };
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
    _ctx: ExecutionContext,
  ): Promise<void> {
    const at = new Date(controller.scheduledTime);
    if (!isScheduledSlot(at)) {
      console.log(
        JSON.stringify({ msg: "poll skipped, outside market window", at: at.toISOString() }),
      );
      return;
    }
    const result = await wire(env).poll();
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
 * True when `at` lands on (or within a few minutes of) one of the slots
 * poller/scheduler.ts publishes — weekdays only, UTC, because the US session is
 * what defines the window.
 */
export function isScheduledSlot(at: Date): boolean {
  const weekday = at.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
  return runMinutesUtc().some((slot) => Math.abs(slot - minute) <= SLOT_TOLERANCE_MIN);
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

function stripSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
