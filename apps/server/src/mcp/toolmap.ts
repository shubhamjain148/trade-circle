// ⚠️ EVERYTHING HERE IS A GUESS.
//
// INDmoney publishes no tool schemas (appendix 1 §2.5); the names and argument
// shapes below are reverse-engineered from third-party clients and are known to
// drift — one client calls the holdings tool `networth_holdings`, another
// `get_user_networth_v2`. The first genuine connect writes the real `tools/list`
// output into the tool_catalog table; read it, then correct this file.
//
// Until then: prefer whichever alias the captured catalog actually contains
// (`resolveToolMap`), and treat a missing tool as an alert, not a crash.

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
  // Seen in the wild as MF | IND_STOCK | INDIAN_STOCK | US_STOCK.
  holdingsArgs: { asset_type: "INDIAN_STOCK" },
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
