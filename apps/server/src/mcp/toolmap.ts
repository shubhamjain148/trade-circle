// Verified against a real capture, 2026-08-06 (tool_catalog): 15 tools;
// `networth_holdings` requires asset_type ∈ IND_STOCK | MF | US_STOCK | BOND |
// EPF | NPS | SA | FD | CRYPTO | INSURANCE | VEHICLE | RE | RD | AIF | PMS |
// PPF, and `networth_snapshot` takes no arguments. An unknown asset_type
// returns an empty list rather than an error. Names may still drift with
// INDmoney releases — resolveToolMap narrows onto the captured catalog, and a
// missing tool is an alert, not a crash.

export interface ToolMap {
  /** Positions with quantity, cost and value. The expensive call. */
  holdings: string;
  holdingsArgs: Record<string, unknown>;
  /** Cheap change probe — one number that moves when the portfolio moves. */
  netWorth: string;
  netWorthArgs: Record<string, unknown>;
}

export const defaultToolMap: ToolMap = {
  holdings: "networth_holdings",
  // The product watches US-stock portfolios (docs/RESEARCH.md decisions log).
  holdingsArgs: { asset_type: "US_STOCK" },
  netWorth: "networth_snapshot",
  netWorthArgs: {},
};

/** Fallbacks, most-likely first, used when the captured catalog lacks the primary. */
export const toolAliases: Record<keyof Pick<ToolMap, "holdings" | "netWorth">, string[]> =
  {
    holdings: ["networth_holdings", "holdings", "get_user_networth_v2"],
    netWorth: ["networth_snapshot", "get_user_networth_v2", "networth_allocation_breakdown"],
  };

export function toolMapFromEnv(env: NodeJS.ProcessEnv = process.env): ToolMap {
  return {
    ...defaultToolMap,
    holdings: env.MCP_TOOL_HOLDINGS ?? defaultToolMap.holdings,
    netWorth: env.MCP_TOOL_NETWORTH ?? defaultToolMap.netWorth,
    holdingsArgs: parseArgs(env.MCP_TOOL_HOLDINGS_ARGS) ?? defaultToolMap.holdingsArgs,
    netWorthArgs: parseArgs(env.MCP_TOOL_NETWORTH_ARGS) ?? defaultToolMap.netWorthArgs,
  };
}

/** Narrows a guessed map onto the names a server actually advertises. */
export function resolveToolMap(map: ToolMap, available: string[]): ToolMap {
  const have = new Set(available);
  return {
    ...map,
    holdings: pick(map.holdings, toolAliases.holdings, have),
    netWorth: pick(map.netWorth, toolAliases.netWorth, have),
  };
}

/** Tool names present in a raw `tools/list` payload, however it is shaped. */
export function toolNames(catalog: unknown): string[] {
  const tools = (catalog as { tools?: unknown })?.tools ?? catalog;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => (t as { name?: unknown })?.name)
    .filter((n): n is string => typeof n === "string");
}

function pick(preferred: string, aliases: string[], have: Set<string>): string {
  if (have.size === 0 || have.has(preferred)) return preferred;
  return aliases.find((a) => have.has(a)) ?? preferred;
}

function parseArgs(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  return JSON.parse(raw) as Record<string, unknown>;
}
