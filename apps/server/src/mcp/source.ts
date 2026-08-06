import type { Position } from "../domain.js";
import { hashPositions, type PortfolioSource } from "../poller/source.js";
import { NeedsReauthError, RateLimitedError, withMcpClient } from "./client.js";
import { netWorthDigest, normalizeHoldings } from "./normalize.js";
import type { McpDeps } from "./oauth.js";
import { resolveToolMap, toolMapFromEnv, toolNames, type ToolMap } from "./toolmap.js";

const HOLDINGS_TTL_MS = 30_000;

export interface McpSourceOptions {
  toolMap?: ToolMap;
  /** Used for accounts without an active grant. */
  fallback?: PortfolioSource;
  /**
   * A tick asks for holdings twice (probe, then pull); this collapses that into
   * one call. Real ticks are minutes apart, so the window only ever covers one.
   */
  holdingsTtlMs?: number;
}

/**
 * Reads one friend's positions over their own MCP session. Accounts without an
 * active oauth_connection fall through to `fallback` (SnapshotEchoSource in
 * production), so a half-connected group still polls cleanly.
 */
export class McpPortfolioSource implements PortfolioSource {
  readonly name = "mcp";
  private readonly toolMap: ToolMap;
  private readonly fallback?: PortfolioSource;
  private readonly holdingsTtlMs: number;
  private readonly holdingsCache = new Map<string, { at: number; positions: Position[] }>();
  private readonly lastProbe = new Map<string, string>();

  constructor(
    private readonly deps: McpDeps,
    options: McpSourceOptions = {},
  ) {
    this.toolMap = options.toolMap ?? toolMapFromEnv();
    this.fallback = options.fallback;
    this.holdingsTtlMs = options.holdingsTtlMs ?? HOLDINGS_TTL_MS;
  }

  async fetchHoldings(accountId: string): Promise<Position[]> {
    if (!(await this.wantsMcp(accountId))) {
      return this.fallback?.fetchHoldings(accountId) ?? [];
    }
    const cached = this.holdingsCache.get(accountId);
    if (cached && Date.now() - cached.at < this.holdingsTtlMs) return cached.positions;

    const map = await this.mapFor(accountId);
    const result = await withMcpClient(this.deps, accountId, (client) =>
      client.callTool({ name: map.holdings, arguments: map.holdingsArgs }),
    );
    const positions = normalizeHoldings(result);
    this.holdingsCache.set(accountId, { at: Date.now(), positions });
    return positions;
  }

  /**
   * The interface contract is "a value comparable to hashPositions of the last
   * snapshot", so the cheap net-worth tool cannot be returned directly. Instead
   * it gates the expensive call: an unchanged probe replays the previous hash,
   * which the tick reads as "nothing happened".
   */
  async fetchNetWorthHash(accountId: string): Promise<string> {
    if (!(await this.wantsMcp(accountId))) {
      return this.fallback?.fetchNetWorthHash(accountId) ?? hashPositions([]);
    }

    const probe = await this.probe(accountId);
    if (probe) {
      const previous = await this.deps.storage.latestSnapshot(accountId);
      const last = this.lastProbe.get(accountId);
      this.lastProbe.set(accountId, probe);
      if (previous && last === probe) return hashPositions(previous.positions);
    }
    return hashPositions(await this.fetchHoldings(accountId));
  }

  private async probe(accountId: string): Promise<string | null> {
    const map = await this.mapFor(accountId);
    try {
      const result = await withMcpClient(this.deps, accountId, (client) =>
        client.callTool({ name: map.netWorth, arguments: map.netWorthArgs }),
      );
      return netWorthDigest(result);
    } catch (err) {
      // A missing or renamed probe tool is expected until the catalog is read;
      // an auth or rate-limit failure is not, and must reach the tick.
      if (err instanceof NeedsReauthError || err instanceof RateLimitedError) throw err;
      return null;
    }
  }

  /**
   * Only an active grant goes over MCP. No grant (or a revoked one) falls back;
   * a grant that needs re-auth raises, so the tick logs an error and backs off
   * rather than quietly replaying stale positions.
   */
  private async wantsMcp(accountId: string): Promise<boolean> {
    const connection = await this.deps.storage.getOAuthConnection(accountId);
    if (!connection || connection.status === "revoked") return false;
    if (connection.status === "needs_reauth") throw new NeedsReauthError(accountId);
    return true;
  }

  /** Guessed names, narrowed onto whatever the captured catalog really advertises. */
  private async mapFor(accountId: string): Promise<ToolMap> {
    const catalog = await this.deps.storage.latestToolCatalog(accountId);
    if (!catalog) return this.toolMap;
    return resolveToolMap(this.toolMap, toolNames(catalog.tools));
  }
}
