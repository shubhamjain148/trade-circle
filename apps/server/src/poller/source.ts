import { createHash } from "node:crypto";
import type { Position } from "../domain.js";
import type { Storage } from "../storage/index.js";

/**
 * The one seam between the watcher and INDmoney. `fetchNetWorthHash` is the
 * cheap probe (networth_snapshot); `fetchHoldings` is the expensive confirm
 * (networth_holdings). See src/poller/sources/mcp.todo.md.
 */
export interface PortfolioSource {
  readonly name: string;
  fetchHoldings(accountId: string): Promise<Position[]>;
  fetchNetWorthHash(accountId: string): Promise<string>;
}

export function hashPositions(positions: Position[]): string {
  const normalized = [...positions]
    .sort((a, b) => a.instrumentId.localeCompare(b.instrumentId))
    .map((p) => `${p.instrumentId}:${p.qty}:${p.mktValue}`)
    .join("|");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Stand-in until the MCP client lands: echoes back whatever was last stored, so
 * the scheduler and POST /api/poll are exercisable no-ops that never invent —
 * or, worse, erase — positions.
 */
export class SnapshotEchoSource implements PortfolioSource {
  readonly name = "snapshot-echo";

  constructor(private readonly storage: Storage) {}

  async fetchHoldings(accountId: string): Promise<Position[]> {
    return (await this.storage.latestSnapshot(accountId))?.positions ?? [];
  }

  async fetchNetWorthHash(accountId: string): Promise<string> {
    return hashPositions(await this.fetchHoldings(accountId));
  }
}

/** One scripted portfolio state for one account. */
export type Frame = Position[];

/**
 * Deterministic, scriptable source. Each account gets a list of frames; the
 * source serves frame[cursor] and `advance()` moves every account forward one
 * step, so a test can drive the whole pipeline tick by tick.
 */
export class MockPortfolioSource implements PortfolioSource {
  readonly name = "mock";
  private cursor = 0;

  constructor(private readonly frames: Record<string, Frame[]>) {}

  get step(): number {
    return this.cursor;
  }

  get length(): number {
    return Math.max(0, ...Object.values(this.frames).map((f) => f.length));
  }

  advance(): boolean {
    if (this.cursor >= this.length - 1) return false;
    this.cursor += 1;
    return true;
  }

  reset(): void {
    this.cursor = 0;
  }

  async fetchHoldings(accountId: string): Promise<Position[]> {
    const frames = this.frames[accountId];
    if (!frames || frames.length === 0) return [];
    const frame = frames[Math.min(this.cursor, frames.length - 1)];
    return frame.map((p) => ({ ...p }));
  }

  async fetchNetWorthHash(accountId: string): Promise<string> {
    return hashPositions(await this.fetchHoldings(accountId));
  }
}
