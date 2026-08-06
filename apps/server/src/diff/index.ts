import { createHash } from "node:crypto";
import type { FeedEventRow, Position } from "../domain.js";
import type { FeedEventType } from "../types.js";

// Diff engine — pure functions, no storage and no clock of its own.
// Design: docs/appendix-2-watcher-architecture.md §1.3 (diff) and §2 (suppression).

export interface DiffOptions {
  /**
   * Ignore |Δqty| below this fraction of the previous quantity. INDmoney US
   * holdings are fractional, so exact equality is never a safe test.
   */
  qtyThreshold?: number;
  /** H1 tolerances. */
  valueDriftMax?: number;
  costDriftMax?: number;
}

export interface Candidate {
  accountId: string;
  type: FeedEventType;
  instrumentId: string;
  symbol: string;
  instrumentName: string;
  pctOfPortfolio: number;
  qtyChangePct: number | null;
  detectedAt: string;
  qtyBefore: number;
  qtyAfter: number;
  avgCostBefore: number | null;
  avgCostAfter: number | null;
  mktValueBefore: number | null;
  mktValueAfter: number | null;
  /** qtyAfter / qtyBefore, null for open/close. */
  ratio: number | null;
  suppressed: boolean;
  suppressReason: string | null;
}

const DEFAULTS: Required<DiffOptions> = {
  qtyThreshold: 0.01,
  valueDriftMax: 0.02,
  costDriftMax: 0.01,
};

/** Position size as a share of the portfolio it belongs to, in percent. */
export function pctOfPortfolio(position: Position, all: Position[]): number {
  const total = all.reduce((sum, p) => sum + p.mktValue, 0);
  return total > 0 ? (position.mktValue / total) * 100 : 0;
}

/**
 * Candidate events for one account between two holdings snapshots.
 * Keyed on instrument_id — never the ticker, which gets renamed on rebrands.
 */
export function diffPositions(
  accountId: string,
  prev: Position[],
  next: Position[],
  detectedAt: string,
  options: DiffOptions = {},
): Candidate[] {
  const opts = { ...DEFAULTS, ...options };
  const prevByKey = new Map(prev.map((p) => [p.instrumentId, p]));
  const nextByKey = new Map(next.map((p) => [p.instrumentId, p]));
  const candidates: Candidate[] = [];

  for (const after of next) {
    const before = prevByKey.get(after.instrumentId);
    if (!before) {
      if (after.qty <= 0) continue;
      candidates.push(
        base(accountId, "NEW_POSITION", after, detectedAt, {
          pctOfPortfolio: pctOfPortfolio(after, next),
          qtyChangePct: null,
          qtyBefore: 0,
          qtyAfter: after.qty,
          avgCostBefore: null,
          avgCostAfter: after.avgCost,
          mktValueBefore: null,
          mktValueAfter: after.mktValue,
          ratio: null,
        }),
      );
      continue;
    }
    if (before.qty <= 0) continue;
    const delta = after.qty - before.qty;
    const relative = Math.abs(delta) / before.qty;
    if (relative < opts.qtyThreshold) continue;
    if (after.qty <= 0) {
      candidates.push(exitCandidate(accountId, before, detectedAt));
      continue;
    }
    candidates.push(
      base(accountId, delta > 0 ? "SIZE_UP" : "SIZE_DOWN", after, detectedAt, {
        pctOfPortfolio: pctOfPortfolio(after, next),
        qtyChangePct: delta / before.qty,
        qtyBefore: before.qty,
        qtyAfter: after.qty,
        avgCostBefore: before.avgCost,
        avgCostAfter: after.avgCost,
        mktValueBefore: before.mktValue,
        mktValueAfter: after.mktValue,
        ratio: after.qty / before.qty,
      }),
    );
  }

  for (const before of prev) {
    if (nextByKey.has(before.instrumentId)) continue;
    candidates.push(exitCandidate(accountId, before, detectedAt));
  }

  return candidates;
}

function exitCandidate(
  accountId: string,
  before: Position,
  detectedAt: string,
): Candidate {
  return base(accountId, "EXITED", before, detectedAt, {
    pctOfPortfolio: 0,
    qtyChangePct: null,
    qtyBefore: before.qty,
    qtyAfter: 0,
    avgCostBefore: before.avgCost,
    avgCostAfter: null,
    mktValueBefore: before.mktValue,
    mktValueAfter: 0,
    ratio: null,
  });
}

function base(
  accountId: string,
  type: FeedEventType,
  instrument: Position,
  detectedAt: string,
  rest: Omit<
    Candidate,
    | "accountId"
    | "type"
    | "instrumentId"
    | "symbol"
    | "instrumentName"
    | "detectedAt"
    | "suppressed"
    | "suppressReason"
  >,
): Candidate {
  return {
    accountId,
    type,
    instrumentId: instrument.instrumentId,
    symbol: instrument.symbol,
    instrumentName: instrument.name,
    detectedAt,
    suppressed: false,
    suppressReason: null,
    ...rest,
  };
}

/**
 * H1 — value continuity. A split/bonus/consolidation rescales qty and avg cost
 * by exact reciprocals and leaves market value and total cost basis flat. A real
 * buy injects capital, so the cost basis must move materially.
 */
export function applyValueContinuity(
  candidates: Candidate[],
  options: DiffOptions = {},
): Candidate[] {
  const opts = { ...DEFAULTS, ...options };
  return candidates.map((c) => {
    if (c.suppressed) return c;
    if (c.ratio === null) return c;
    if (
      c.avgCostBefore === null ||
      c.avgCostAfter === null ||
      c.mktValueBefore === null ||
      c.mktValueAfter === null
    ) {
      return c;
    }
    if (c.mktValueBefore === 0) return c;
    const valueDrift =
      Math.abs(c.mktValueAfter - c.mktValueBefore) / c.mktValueBefore;
    const costBefore = c.avgCostBefore * c.qtyBefore;
    if (costBefore === 0) return c;
    const costDrift =
      Math.abs(c.avgCostAfter * c.qtyAfter - costBefore) / costBefore;
    if (
      valueDrift < opts.valueDriftMax &&
      costDrift < opts.costDriftMax &&
      isSimpleFraction(c.ratio)
    ) {
      return { ...c, suppressed: true, suppressReason: "corp_action_h1" };
    }
    return c;
  });
}

/**
 * H2 — cross-account simultaneity. Friends do not coincidentally change the same
 * instrument by the same ratio in the same tick; that is a corporate action.
 * Runs over every account polled in one tick, so it is an override on H1's misses.
 */
export function applyCrossAccountSimultaneity(
  candidates: Candidate[],
  minAccounts = 2,
): Candidate[] {
  const groups = new Map<string, Set<string>>();
  for (const c of candidates) {
    if (c.ratio === null) continue;
    const key = `${c.instrumentId}|${c.ratio.toFixed(3)}`;
    const accounts = groups.get(key) ?? new Set<string>();
    accounts.add(c.accountId);
    groups.set(key, accounts);
  }
  return candidates.map((c) => {
    if (c.ratio === null) return c;
    const key = `${c.instrumentId}|${c.ratio.toFixed(3)}`;
    const accounts = groups.get(key);
    if (!accounts || accounts.size < minAccounts) return c;
    return { ...c, suppressed: true, suppressReason: "corp_action_h2" };
  });
}

/** H1 then H2 — H2 overrides, per appendix 2 §2.2. */
export function suppressCorporateActions(
  candidates: Candidate[],
  options: DiffOptions = {},
): Candidate[] {
  return applyCrossAccountSimultaneity(
    applyValueContinuity(candidates, options),
  );
}

/**
 * Close to p/q for small integers — a split ratio, not a trade. Appendix 2
 * suggests 0.5% with p,q ≤ 20, but at that denominator the Farey gaps are
 * narrower than the tolerance and the test accepts everything, so it is
 * tightened to 0.1%. Corporate-action ratios are exact anyway.
 */
export function isSimpleFraction(
  ratio: number,
  maxDenominator = 20,
  tolerance = 0.001,
): boolean {
  if (!Number.isFinite(ratio) || ratio <= 0) return false;
  for (let q = 1; q <= maxDenominator; q++) {
    for (let p = 1; p <= maxDenominator; p++) {
      if (Math.abs(ratio - p / q) / ratio < tolerance) return true;
    }
  }
  return false;
}

/**
 * Content-addressed id, so replaying the same tick collides on the primary key
 * instead of duplicating the event (appendix 2 §3.2 dedup_key).
 */
export function candidateId(c: Candidate): string {
  const tradingDay = c.detectedAt.slice(0, 10);
  return createHash("sha256")
    .update(
      [
        c.accountId,
        c.instrumentId,
        c.type,
        c.qtyBefore.toFixed(6),
        c.qtyAfter.toFixed(6),
        tradingDay,
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 24);
}

export function toFeedEventRow(c: Candidate): FeedEventRow {
  return {
    id: candidateId(c),
    accountId: c.accountId,
    type: c.type,
    instrumentId: c.instrumentId,
    symbol: c.symbol,
    instrumentName: c.instrumentName,
    pctOfPortfolio: round(c.pctOfPortfolio, 2),
    qtyChangePct: c.qtyChangePct === null ? null : round(c.qtyChangePct, 4),
    detectedAt: c.detectedAt,
    suppressed: c.suppressed,
    suppressReason: c.suppressReason,
  };
}

function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}
