import { Hono } from "hono";
import { requireSession, type SessionEnv } from "./auth/session.js";
import type { StoredPosition } from "./domain.js";
import type { Storage } from "./storage/index.js";
import type { Holding } from "./types.js";

export interface PositionsDeps {
  storage: Storage;
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
 * the response JSON contains none of the amount keys.
 */
export function createPositionsApp({ storage }: PositionsDeps): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();

  app.use("/api/members/:memberId/positions", requireSession(storage));

  app.get("/api/members/:memberId/positions", async (c) => {
    const viewer = c.get("member");
    const memberId = c.req.param("memberId");

    const member = await storage.getMember(memberId);
    if (!member) return c.json({ error: "unknown_member" }, 404);

    // Visibility, exactly as src/feed.ts applies it, with one addition: your
    // own page is your own data. Pausing hides you from the group — it is not
    // a mode where the app refuses to tell you what you hold. The feed drops
    // paused rows for every reader including their author, which is right for
    // a shared log (a paused member reading their own moves in the group
    // timeline would misread what everyone else can see) and wrong here: this
    // panel is on one person's page and shows only that person.
    if (member.visibility === "paused" && member.id !== viewer.id) {
      return c.json([]);
    }

    // Anonymous is untouched: the panel carries no identity of its own — the
    // page it sits on already names (or declines to name) whose page it is,
    // the same way the feed's `accountName` does for its rows.
    const account = await storage.getAccountByMember(member.id);
    if (!account) return c.json([]);

    const positions = await storage.getCurrentPositions(account.id);
    return c.json(positions.map(toHolding).sort(byWeight));
  });

  return app;
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

/** Largest first; symbol breaks ties so the order is stable across reads. */
export function byWeight(a: Holding, b: Holding): number {
  if (a.pctOfPortfolio !== b.pctOfPortfolio) {
    return b.pctOfPortfolio - a.pctOfPortfolio;
  }
  return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
}
