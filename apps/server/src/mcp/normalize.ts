import { createHash } from "node:crypto";
import type { Position } from "../domain.js";

// The adapter between whatever INDmoney returns and the watcher's Position shape.
// Deliberately forgiving: field names are guesses (see toolmap.ts), so every one
// is looked up through a candidate list and anything unusable is dropped rather
// than turned into a fake zero — a dropped row shows up as "no change", an
// invented zero would show up as a false EXITED event in someone's feed.

// First-choice keys verified against a real networth_holdings capture
// (2026-08-06): rows carry investment_code / investment / total_units /
// unit_price / market_value / invested_amount / holding_percent, no ticker.
const ID_KEYS = ["investment_code", "ind_key", "indKey", "instrument_id", "instrumentId", "isin", "id"];
const SYMBOL_KEYS = ["symbol", "ticker", "trading_symbol", "tradingSymbol", "scrip"];
const NAME_KEYS = ["investment", "name", "instrument_name", "instrumentName", "company_name", "display_name"];
const QTY_KEYS = ["total_units", "qty", "quantity", "units", "holding_qty", "shares"];
const AVG_KEYS = ["avg_cost", "avgCost", "average_price", "avg_price", "buy_avg", "avg_buy_price"];
const INVESTED_KEYS = ["invested_amount", "invested", "total_invested", "cost_value"];
const VALUE_KEYS = ["mkt_value", "market_value", "current_value", "marketValue", "value"];
const PRICE_KEYS = ["unit_price", "ltp", "last_price", "current_price", "price", "nav"];
const LIST_KEYS = ["holdings", "positions", "items", "data", "results", "rows"];

/** Unwraps a CallToolResult into the JSON the tool meant to return. */
export function toolPayload(result: unknown): unknown {
  if (result === null || typeof result !== "object") return result;
  const r = result as { structuredContent?: unknown; content?: unknown };
  // FastMCP (INDmoney's stack, verified live 2026-08-06) wraps a string return
  // as structuredContent: { result: "<json>" } — unwrap and parse it.
  if (r.structuredContent !== null && r.structuredContent !== undefined) {
    return unwrapResult(r.structuredContent);
  }
  if (Array.isArray(r.content)) {
    for (const block of r.content) {
      const b = block as { type?: string; text?: string };
      if (b?.type === "text" && typeof b.text === "string") {
        try {
          return JSON.parse(b.text) as unknown;
        } catch {
          return b.text;
        }
      }
    }
  }
  return result;
}

export function normalizeHoldings(result: unknown): Position[] {
  const rows = findRows(toolPayload(result));
  const positions: Position[] = [];
  for (const row of rows) {
    const position = toPosition(row);
    if (position) positions.push(position);
  }
  return positions;
}

/**
 * Stable digest of a cheap net-worth payload. Only ever compared against another
 * digest from the same tool — never against a positions hash.
 */
export function netWorthDigest(result: unknown): string | null {
  const payload = toolPayload(result);
  if (payload === null || payload === undefined) return null;
  return createHash("sha256")
    .update(typeof payload === "string" ? payload : stableStringify(payload))
    .digest("hex")
    .slice(0, 16);
}

function unwrapResult(structured: unknown): unknown {
  if (isRecord(structured) && Object.keys(structured).length === 1 && "result" in structured) {
    const inner = structured.result;
    if (typeof inner === "string") {
      try {
        return JSON.parse(inner) as unknown;
      } catch {
        return inner;
      }
    }
    return inner;
  }
  return structured;
}

function findRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  for (const key of LIST_KEYS) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isRecord);
    if (isRecord(value)) {
      const nested = findRows(value);
      if (nested.length) return nested;
    }
  }
  return [];
}

function toPosition(row: Record<string, unknown>): Position | null {
  const qty = num(row, QTY_KEYS);
  if (qty === null || qty === 0) return null;

  const symbol = str(row, SYMBOL_KEYS);
  const instrumentId = str(row, ID_KEYS) ?? symbol;
  if (!instrumentId) return null;

  const price = num(row, PRICE_KEYS);
  const mktValue = num(row, VALUE_KEYS) ?? (price === null ? null : qty * price);
  if (mktValue === null) return null;

  // INDmoney gives total invested_amount, not per-unit cost; derive it — the
  // H1 split heuristic depends on a real cost basis, not a placeholder zero.
  const invested = num(row, INVESTED_KEYS);
  const avgCost = num(row, AVG_KEYS) ?? (invested === null ? 0 : invested / qty);

  return {
    instrumentId,
    symbol: symbol ?? instrumentId,
    name: str(row, NAME_KEYS) ?? symbol ?? instrumentId,
    qty,
    avgCost,
    mktValue,
  };
}

function str(row: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function num(row: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "") {
      const parsed = Number(v.replace(/,/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
