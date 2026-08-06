// Every environment knob in one place. Nothing here ever contacts INDmoney —
// MCP_BASE_URL is config only, and the tests point it at a local fake.

const DEV_SECRET = "dev-only-insecure-app-secret";

export interface Config {
  appUrl: string;
  mcpBaseUrl: string;
  dbPath: string;
  port: number;
  appSecret: string;
  /** Session cookie lifetime. */
  sessionTtlMs: number;
  /** How long an in-flight OAuth authorization is allowed to sit unanswered. */
  oauthStateTtlMs: number;
  clientName: string;
  /**
   * Web Push signing identity (RFC 8292), when the environment carries one.
   * All three or nothing — see `resolveVapid`. Absent is a supported state:
   * /api/push/key 404s and the settings row says so.
   */
  vapid?: { publicKey: string; privateKey: string; subject: string };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    appUrl: stripSlash(env.APP_URL ?? "http://localhost:5173"),
    mcpBaseUrl: env.MCP_BASE_URL ?? "https://mcp.indmoney.com/mcp",
    dbPath: env.DB_PATH ?? "./data/watcher.db",
    port: Number(env.PORT ?? 3001),
    appSecret: resolveSecret(env),
    sessionTtlMs: 90 * 86_400_000,
    oauthStateTtlMs: 10 * 60_000,
    clientName: env.MCP_CLIENT_NAME ?? "indmoney-watcher",
    vapid: resolveVapid(env),
  };
}

/**
 * All three or nothing. A public key without a private one gives the settings
 * screen a working Enable button whose every send then fails silently — the
 * one failure mode a friend has no way to notice. src/worker.ts enforces the
 * same rule against Workers vars.
 */
function resolveVapid(env: NodeJS.ProcessEnv): Config["vapid"] {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = env;
  if (!VAPID_PUBLIC_KEY && !VAPID_PRIVATE_KEY && !VAPID_SUBJECT) return undefined;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
    throw new Error(
      "VAPID is half-configured — set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and " +
        "VAPID_SUBJECT together, or none of them. Generate a pair with " +
        "`pnpm --filter server vapid:generate`.",
    );
  }
  return {
    publicKey: VAPID_PUBLIC_KEY,
    privateKey: VAPID_PRIVATE_KEY,
    subject: VAPID_SUBJECT,
  };
}

/** Required in production; in dev it falls back loudly so nobody ships the fallback. */
function resolveSecret(env: NodeJS.ProcessEnv): string {
  if (env.APP_SECRET) return env.APP_SECRET;
  if (env.NODE_ENV === "production") {
    throw new Error("APP_SECRET is required in production — it keys the token vault");
  }
  if (env.NODE_ENV !== "test") {
    console.warn(
      "!! APP_SECRET unset — using the built-in dev key. Tokens encrypted now " +
        "are readable by anyone with this source. Set APP_SECRET before connecting a real account.",
    );
  }
  return DEV_SECRET;
}

function stripSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export const config = loadConfig();
