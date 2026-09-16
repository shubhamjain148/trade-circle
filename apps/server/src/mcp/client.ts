import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type AuthProvider,
} from "@modelcontextprotocol/client";
import { isExpired, refreshConnection, type McpDeps } from "./oauth.js";

const CLIENT_INFO = { name: "trade-circle", version: "0.0.1" };

/** Raised when refresh is impossible; the caller flips the account to needs_reauth. */
export class NeedsReauthError extends Error {
  constructor(readonly accountId: string, cause?: unknown) {
    super(`account ${accountId} needs re-authentication`);
    this.name = "NeedsReauthError";
    this.cause = cause;
  }
}

export class RateLimitedError extends Error {
  constructor(readonly accountId: string) {
    super(`account ${accountId} is rate limited`);
    this.name = "RateLimitedError";
  }
}

/**
 * One provider per account — never share (appendix 1 §3.2: shared providers
 * cross-contaminate credentials). `token()` refreshes proactively just before
 * expiry; `onUnauthorized()` catches the case where the server disagrees with us.
 */
export function createAuthProvider(deps: McpDeps, accountId: string): AuthProvider {
  return {
    async token() {
      const connection = await deps.storage.getOAuthConnection(accountId);
      if (!connection || connection.status === "revoked") return undefined;
      if (isExpired(connection) && connection.refreshTokenEnc) {
        return refreshConnection(deps, accountId);
      }
      return await deps.vault.decrypt(connection.accessTokenEnc);
    },
    async onUnauthorized() {
      try {
        await refreshConnection(deps, accountId);
      } catch (err) {
        await markNeedsReauth(deps, accountId);
        throw new NeedsReauthError(accountId, err);
      }
    },
  };
}

/** Opens an isolated MCP session for one account and always closes it. */
export async function withMcpClient<T>(
  deps: McpDeps,
  accountId: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(
    new URL(deps.config.mcpBaseUrl),
    {
      authProvider: createAuthProvider(deps, accountId),
      fetch: deps.fetchFn,
    },
  );
  const client = new Client(CLIENT_INFO);
  try {
    await client.connect(transport);
    return await fn(client);
  } catch (err) {
    if (err instanceof NeedsReauthError) throw err;
    if (err instanceof UnauthorizedError) {
      await markNeedsReauth(deps, accountId);
      throw new NeedsReauthError(accountId, err);
    }
    if (isRateLimit(err)) throw new RateLimitedError(accountId);
    throw err;
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Schema capture. INDmoney's tool schemas are unpublished and drift, so the raw
 * listing is stored verbatim on every connect — this is the only ground truth
 * src/mcp/toolmap.ts will ever get.
 */
export async function captureToolCatalog(
  deps: McpDeps,
  accountId: string,
): Promise<unknown> {
  const tools = await withMcpClient(deps, accountId, (client) => client.listTools());
  await deps.storage.saveToolCatalog(accountId, new Date().toISOString(), tools);
  return tools;
}

export async function markNeedsReauth(
  deps: McpDeps,
  accountId: string,
): Promise<void> {
  await deps.storage.setOAuthConnectionStatus(
    accountId,
    "needs_reauth",
    new Date().toISOString(),
  );
  await deps.storage.setAccountStatus(accountId, "needs_reauth");
}

function isRateLimit(err: unknown): boolean {
  const status = (err as { status?: unknown; code?: unknown })?.status;
  if (status === 429) return true;
  return /\b429\b|too many requests|rate.?limit/i.test(String(err));
}
