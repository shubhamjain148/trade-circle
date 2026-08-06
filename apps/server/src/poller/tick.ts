import { createHash } from "node:crypto";
import type { Position, StoredPosition } from "../domain.js";
import {
  type Candidate,
  type DiffOptions,
  diffPositions,
  pctOfPortfolio,
  suppressCorporateActions,
  toFeedEventRow,
} from "../diff/index.js";
import type { Storage } from "../storage/index.js";
import { hashPositions, type PortfolioSource } from "./source.js";

export interface TickOptions {
  now?: Date;
  /** Window across which accounts are spread; 0 disables (tests, seed). */
  staggerMs?: number;
  diff?: DiffOptions;
  backoff?: Backoff;
  /** Skip the cheap-probe gate and always pull full holdings. */
  force?: boolean;
  /**
   * Restrict the pass to these accounts. Omitted = every active account, which
   * is what the cron does. The post-connect first fetch passes exactly one id:
   * a friend who just linked must not drag the whole group into a pass.
   */
  accountIds?: string[];
}

export interface TickResult {
  at: string;
  polled: string[];
  /** Cheap probe said nothing changed. */
  unchanged: string[];
  /** Backed off or not in an active state. */
  skipped: string[];
  errors: { accountId: string; message: string }[];
  events: number;
  suppressed: number;
}

/**
 * Per-account backoff, never global — INDmoney rate-limits per user, so one
 * friend's throttle must not stall the group (appendix 2 §1.2). Stub: in-memory,
 * exponential with a 30-minute ceiling. No jitter, no Retry-After, no auth-state
 * machine yet — those land with the real MCP client.
 */
export class Backoff {
  private state = new Map<string, { failures: number; nextAt: number }>();

  constructor(
    private readonly baseMs = 30_000,
    private readonly maxMs = 30 * 60_000,
  ) {}

  eligible(accountId: string, now: Date): boolean {
    const entry = this.state.get(accountId);
    return !entry || entry.nextAt <= now.getTime();
  }

  fail(accountId: string, now: Date): void {
    const failures = (this.state.get(accountId)?.failures ?? 0) + 1;
    const delay = Math.min(this.baseMs * 2 ** (failures - 1), this.maxMs);
    this.state.set(accountId, { failures, nextAt: now.getTime() + delay });
  }

  succeed(accountId: string): void {
    this.state.delete(accountId);
  }
}

/**
 * One poll pass over every active account (or just `options.accountIds` when
 * the caller names them): cheap probe, full pull on change,
 * per-account diff, then corporate-action suppression across the whole tick
 * (H2 needs all accounts in hand before it can decide anything).
 */
export async function runPollTick(
  storage: Storage,
  source: PortfolioSource,
  options: TickOptions = {},
): Promise<TickResult> {
  const now = options.now ?? new Date();
  const at = now.toISOString();
  const staggerMs = options.staggerMs ?? 0;
  const backoff = options.backoff;

  const result: TickResult = {
    at,
    polled: [],
    unchanged: [],
    skipped: [],
    errors: [],
    events: 0,
    suppressed: 0,
  };

  const only = options.accountIds ? new Set(options.accountIds) : undefined;
  const accounts = (await storage.listAccounts()).filter(
    (a) => a.status === "active" && (!only || only.has(a.id)),
  );
  const candidates: Candidate[] = [];
  const pulled = new Map<string, Position[]>();

  for (const account of accounts) {
    if (backoff && !backoff.eligible(account.id, now)) {
      result.skipped.push(account.id);
      continue;
    }
    if (staggerMs > 0) await sleep(offsetFor(account.id, staggerMs));

    try {
      const probe = options.force
        ? undefined
        : await source.fetchNetWorthHash(account.id);
      const previous = await storage.latestSnapshot(account.id);
      if (previous && probe && hashPositions(previous.positions) === probe) {
        await storage.markPolled(account.id, at);
        backoff?.succeed(account.id);
        result.unchanged.push(account.id);
        continue;
      }

      const holdings = await source.fetchHoldings(account.id);
      await storage.archiveRaw(account.id, at, "networth_holdings", holdings);
      pulled.set(account.id, holdings);
      candidates.push(
        ...diffPositions(
          account.id,
          previous?.positions ?? [],
          holdings,
          at,
          options.diff,
        ),
      );
      backoff?.succeed(account.id);
      result.polled.push(account.id);
    } catch (err) {
      backoff?.fail(account.id, now);
      result.errors.push({
        accountId: account.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const filtered = suppressCorporateActions(candidates, options.diff);
  await storage.insertFeedEvents(filtered.map(toFeedEventRow));
  result.events = filtered.filter((c) => !c.suppressed).length;
  result.suppressed = filtered.filter((c) => c.suppressed).length;

  for (const [accountId, holdings] of pulled) {
    await storage.saveSnapshot(accountId, at, holdings);
    await storage.replaceCurrentPositions(
      accountId,
      holdings.map((p) => toStoredPosition(accountId, p, holdings, at)),
    );
    await storage.markPolled(accountId, at);
  }

  return result;
}

export function toStoredPosition(
  accountId: string,
  position: Position,
  all: Position[],
  updatedAt: string,
): StoredPosition {
  return {
    ...position,
    accountId,
    pctOfPortfolio: pctOfPortfolio(position, all),
    updatedAt,
  };
}

/** Deterministic spread so N accounts never fire simultaneously. */
export function offsetFor(accountId: string, windowMs: number): number {
  const digest = createHash("sha256").update(accountId).digest();
  return digest.readUInt32BE(0) % windowMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
