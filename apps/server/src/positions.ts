import { Hono } from "hono";
import { requireSession, type SessionEnv } from "./auth/session.js";
import { pctOfPortfolio } from "./diff/index.js";
import type { AccountRow, SnapshotRow, StoredPosition } from "./domain.js";
import type { Storage } from "./storage/index.js";
import type { Holding, HoldingHistory, HoldingsHistory } from "./types.js";

export interface PositionsDeps {
  storage: Storage;
}

/**
 * How far back a sparkline looks. Thirty days is the shape of the story the
 * panel tells ("he's been building this for three weeks") and also the honest
 * limit of a daily series: at one point per day, a wider window would draw more
 * ink than a 44px mark can distinguish.
 */
export const HISTORY_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * The window's lower bound: midnight UTC, `HISTORY_DAYS - 1` days back, so the
 * window is thirty whole calendar days ending with today rather than a rolling
 * "now minus 720 hours" whose first day is a partial one. Day-aligned because
 * the buckets are days: a bound that landed mid-afternoon would include or drop
 * the oldest day depending on what time the request arrived.
 */
export function historyWindowStart(now = Date.now()): string {
  const start = new Date(now - (HISTORY_DAYS - 1) * DAY_MS);
  start.setUTCHours(0, 0, 0, 0);
  return start.toISOString();
}

/**
 * What a friend is holding *now*, as opposed to what they did (the feed).
 *
 * Mounted as its own Hono app so api.ts stays one import and one line; the
 * session gate below applies to this route only.
 *
 * The wire shape is the whole point of this file. `positions_current` carries
 * qty, avg cost and market value — the three facts this product has never
 * published and must not start publishing because a panel made it convenient.
 * `toHolding` is the only projection, it is exhaustive by construction (it
 * names every field it copies rather than spreading the row), and a test asserts
 * the response JSON contains none of the amount keys. `toHistory` answers to the
 * same rule from the other direction: it is handed whole stored snapshots — qty,
 * cost and value for every instrument on every day — and emits percentages.
 */
export function createPositionsApp({ storage }: PositionsDeps): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();

  app.use("/api/members/:memberId/positions", requireSession(storage));
  app.use("/api/members/:memberId/positions/history", requireSession(storage));

  app.get("/api/members/:memberId/positions", async (c) => {
    const visible = await resolveAccount(storage, c.req.param("memberId"), c.get("member").id);
    if (visible === "unknown") return c.json({ error: "unknown_member" }, 404);
    if (!visible) return c.json([]);

    const positions = await storage.getCurrentPositions(visible.id);
    return c.json(positions.map(toHolding).sort(byWeight));
  });

  /**
   * The same holdings, over time — a sibling route rather than `?history=1` on
   * the one above.
   *
   * Two reasons. A member page's first read has to stay cheap: current
   * positions is one indexed row-scan of a small table, and folding a month of
   * JSON payloads into it would make every page load pay for a chart that
   * renders a beat later. And a query parameter that changes the response from
   * an array to an object is a second endpoint wearing the first one's name —
   * every client then branches on a flag it passed itself.
   *
   * So the panel fires both in parallel and the rows land without waiting for
   * the sparklines. Visibility is resolved by the same helper, deliberately:
   * two routes over one person's portfolio that disagree about who may read it
   * is exactly the bug this shape is meant to make impossible.
   */
  app.get("/api/members/:memberId/positions/history", async (c) => {
    const visible = await resolveAccount(storage, c.req.param("memberId"), c.get("member").id);
    if (visible === "unknown") return c.json({ error: "unknown_member" }, 404);
    if (!visible) return c.json(EMPTY_HISTORY);

    const [snapshots, current] = await Promise.all([
      storage.listDailySnapshots(visible.id, historyWindowStart(), HISTORY_DAYS),
      storage.getCurrentPositions(visible.id),
    ]);

    return c.json(
      toHistory(
        snapshots,
        current.map((p) => p.instrumentId),
      ),
    );
  });

  return app;
}

const EMPTY_HISTORY: HoldingsHistory = { days: [], series: [] };

/**
 * Who may read whose portfolio, in one place — both routes call it.
 *
 * "unknown" is a member id nobody has; `undefined` is "there is nothing to show
 * you", which covers three different situations that all deserve the same
 * silence: a paused member seen by anyone else, a member who never connected,
 * and a member whose account exists but has no rows.
 *
 * Visibility, exactly as src/feed.ts applies it, with one addition: your own
 * page is your own data. Pausing hides you from the group — it is not a mode
 * where the app refuses to tell you what you hold. The feed drops paused rows
 * for every reader including their author, which is right for a shared log (a
 * paused member reading their own moves in the group timeline would misread
 * what everyone else can see) and wrong here: this panel is on one person's
 * page and shows only that person.
 *
 * Anonymous is untouched: the panel carries no identity of its own — the page
 * it sits on already names (or declines to name) whose page it is, the same way
 * the feed's `accountName` does for its rows.
 */
async function resolveAccount(
  storage: Storage,
  memberId: string,
  viewerId: string,
): Promise<AccountRow | undefined | "unknown"> {
  const member = await storage.getMember(memberId);
  if (!member) return "unknown";
  if (member.visibility === "paused" && member.id !== viewerId) return undefined;
  return await storage.getAccountByMember(member.id);
}

/**
 * Row → wire, field by field. Never spread a StoredPosition into a response:
 * every amount this product refuses to publish is on that row.
 */
export function toHolding(position: StoredPosition): Holding {
  return {
    instrumentId: position.instrumentId,
    symbol: position.symbol,
    name: position.name,
    pctOfPortfolio: position.pctOfPortfolio,
    updatedAt: position.updatedAt,
  };
}

/**
 * Daily snapshots (oldest first) → one weight series per instrument still held.
 *
 * Only currently-held instruments get a series: the panel draws a line inside a
 * row, and a row only exists for something the member holds now. An instrument
 * that was sold during the window has already been told as a feed event.
 *
 * The weight is recomputed from each snapshot's own payload rather than read
 * from anywhere — a snapshot is a portfolio, and a share of a portfolio is only
 * meaningful against the portfolio it was taken with. This is the same call
 * `toStoredPosition` makes at poll time, through the same function.
 */
export function toHistory(
  snapshots: SnapshotRow[],
  heldNow: string[],
): HoldingsHistory {
  const days = snapshots.map((s) => s.takenAt.slice(0, 10));

  // instrumentId → weight per day index. One pass over the snapshots rather
  // than one pass per instrument: a concentrated portfolio is small, but the
  // payloads are not, and nothing here should scale by rows × days.
  const weights = new Map<string, Map<number, number>>();
  for (const id of heldNow) weights.set(id, new Map());

  snapshots.forEach((snapshot, day) => {
    for (const position of snapshot.positions) {
      const series = weights.get(position.instrumentId);
      if (!series) continue;
      series.set(day, round2(pctOfPortfolio(position, snapshot.positions)));
    }
  });

  const series: HoldingHistory[] = [];
  for (const [instrumentId, byDay] of weights) {
    // Held now but absent from every snapshot in the window: bought since the
    // last daily pass. No line — the panel says "new" instead of drawing one
    // point and calling it a trend.
    if (byDay.size === 0) continue;
    const first = Math.min(...byDay.keys());

    series.push({
      instrumentId,
      points: days.slice(first).map((d, offset) => ({
        d,
        // Absent on a day inside the span is a real zero, not a missing
        // reading: they were out of it that day.
        pct: byDay.get(first + offset) ?? 0,
      })),
      // Only claim a start date when we watched it start. `first === 0` means
      // the position predates our window and its true age is unknown.
      openedAt: first > 0 ? days[first] : null,
    });
  }

  return { days, series };
}

/** Largest first; symbol breaks ties so the order is stable across reads. */
export function byWeight(a: Holding, b: Holding): number {
  if (a.pctOfPortfolio !== b.pctOfPortfolio) {
    return b.pctOfPortfolio - a.pctOfPortfolio;
  }
  return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
}

/** Two decimals, matching the precision the feed already publishes weights at. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
