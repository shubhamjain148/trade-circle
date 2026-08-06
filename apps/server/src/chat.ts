import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { requireSession, type SessionEnv } from "./auth/session.js";
import { background } from "./background.js";
import type { MemberRow, ReactionItemKind, ReactionRow, ReactionTarget } from "./domain.js";
import { toFeedEvents } from "./feed.js";
import type { ReactionBroadcastMap, Room } from "./room.js";
import type { Storage } from "./storage/index.js";
import type {
  ChatPage,
  ReactionMap,
  ReactionUpdate,
  TimelineItem,
} from "./types.js";

/** Long enough for a real thought, short enough that a row stays a row. */
export const MAX_BODY_LENGTH = 2000;

/** One page of history on a cold open; polls after that carry a cursor. */
const PAGE_LIMIT = 200;

/**
 * The whole vocabulary. Not a picker — a picker is a search box, a skin-tone
 * modifier and a scroll region for a group of five who will use six of them,
 * and it turns one tap into three. A fixed row is one tap, and a fixed row can
 * be *read*: 🚀 means the same thing every time it appears in this thread.
 *
 * Chosen for what this group actually says about a trade. 🚀 and 📉 are the
 * pair — the call went well, the call did not; 🔥 is conviction, 💀 is a
 * disaster nobody is being polite about, 💎 is "still holding", 🧠 is "good
 * call, I didn't see it", 👀 is "I'm watching this one", and 😂 is 😂.
 *
 * Order is the order they render in the quick-react row, and it is deliberate:
 * the two most common sit under the thumb on the left.
 */
export const REACTION_EMOJI = ["🚀", "🔥", "😂", "👀", "💎", "🧠", "📉", "💀"] as const;

const ALLOWED_EMOJI = new Set<string>(REACTION_EMOJI);

/**
 * How many stale items one poll may learn about at once. Far beyond anything
 * five friends can generate between two four-second polls; it exists so a
 * corrupted or ancient `reactedAfter` degrades into "a big page, then caught
 * up" rather than "the whole table, every four seconds".
 */
const REACTION_DELTA_LIMIT = 200;

/** The key both sides of the wire use for a reaction map entry. */
export function reactionKey(kind: ReactionItemKind, id: string): string {
  return `${kind}:${id}`;
}

function targetOf(item: TimelineItem): ReactionTarget {
  return { kind: item.kind, id: item.id };
}

function nameOf(memberById: Map<string, MemberRow>, id: string): string {
  // Names, never the visibility projection: a reaction is speech, and speech in
  // this product is always attributed (see the ChatMessage doc comment).
  return memberById.get(id)?.name ?? "Someone";
}

/**
 * Rows → summaries, per emoji, in the order the emoji first appeared on the
 * item. `targets` seeds the map so an item with no reactions left comes back as
 * an explicit empty array rather than a missing key — that is how a removal
 * reaches a client whose pills are still on screen.
 */
export function toReactionMap(
  targets: ReactionTarget[],
  rows: ReactionRow[],
  memberById: Map<string, MemberRow>,
  viewerId: string,
): ReactionMap {
  const map: ReactionMap = {};
  for (const target of targets) map[reactionKey(target.kind, target.id)] = [];

  for (const row of rows) {
    const key = reactionKey(row.itemKind, row.itemId);
    const entries = (map[key] ??= []);
    let entry = entries.find((e) => e.emoji === row.emoji);
    if (!entry) {
      entry = { emoji: row.emoji, count: 0, mine: false, who: [] };
      entries.push(entry);
    }
    entry.count += 1;
    entry.who.push(nameOf(memberById, row.memberId));
    if (row.memberId === viewerId) entry.mine = true;
  }
  return map;
}

/**
 * The same summaries with reactor ids instead of a viewer's `mine`, for the
 * room to personalise per socket. Built here rather than in room.ts because
 * this is where the member names are already loaded.
 */
export function toReactionBroadcast(
  targets: ReactionTarget[],
  rows: ReactionRow[],
  memberById: Map<string, MemberRow>,
): ReactionBroadcastMap {
  const map: ReactionBroadcastMap = {};
  for (const target of targets) map[reactionKey(target.kind, target.id)] = [];

  for (const row of rows) {
    const key = reactionKey(row.itemKind, row.itemId);
    const entries = (map[key] ??= []);
    let entry = entries.find((e) => e.emoji === row.emoji);
    if (!entry) {
      entry = { emoji: row.emoji, count: 0, who: [], memberIds: [] };
      entries.push(entry);
    }
    entry.count += 1;
    entry.who.push(nameOf(memberById, row.memberId));
    entry.memberIds.push(row.memberId);
  }
  return map;
}

/** What a PUT/DELETE body has to be before it is allowed to touch a row. */
export function parseReactionRequest(
  payload: Record<string, unknown>,
): { kind: ReactionItemKind; id: string; emoji: string } | { error: string } {
  const kind = payload.itemKind;
  if (kind !== "message" && kind !== "event") return { error: "invalid_item_kind" };

  const id = typeof payload.itemId === "string" ? payload.itemId.trim() : "";
  if (!id) return { error: "invalid_item_id" };

  const emoji = typeof payload.emoji === "string" ? payload.emoji : "";
  // The curated set is the validation. Without it this column is a free-text
  // field that any client can write arbitrary strings into, and the pills that
  // render it would be rendering whatever a tab felt like sending.
  if (!ALLOWED_EMOJI.has(emoji)) return { error: "unsupported_emoji" };

  return { kind, id, emoji };
}

export interface ChatDeps {
  storage: Storage;
  /** Live delivery, where the runtime has one. See src/room.ts. */
  room?: Room;
}

/**
 * The group's chat and the watcher's feed are the same timeline — this is the
 * product surface now (docs/RESEARCH.md decisions log), so the merge happens
 * server-side rather than leaving the client to zip two lists.
 *
 * Mounted as its own Hono app so api.ts stays one import and one line: the
 * session gate below applies to these routes only.
 */
export function createChatApp({ storage, room }: ChatDeps): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();

  app.use("/api/chat", requireSession(storage));
  // Hono's `use` with a literal path matches that path exactly, so the socket
  // needs its own line — and needs it before the handler below reads `member`.
  app.use("/api/chat/ws", requireSession(storage));
  // Same rule, same reason: reactions are writes attributed to a member, so the
  // gate has to be named explicitly rather than inherited from /api/chat.
  app.use("/api/chat/reactions", requireSession(storage));

  /**
   * The live channel. Session is validated here, in the Worker, against D1 —
   * the room itself has no idea what a cookie is, and by the time the stub sees
   * this request the only claim left is a header the Worker wrote.
   *
   * 501 on Node, and that is a real answer rather than a failure: the client's
   * poll loop never stopped, so a runtime without a room is a runtime where
   * chat is four seconds behind instead of instant.
   */
  app.get("/api/chat/ws", async (c) => {
    if (!room) return c.json({ error: "websocket_unsupported" }, 501);
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return c.json({ error: "upgrade_required" }, 426);
    }
    const member = c.get("member");
    return room.upgrade(c.req.raw, { id: member.id, name: member.name });
  });

  // Oldest → newest, unlike /api/feed: this reads as a conversation, and the
  // composer sits at the bottom of it.
  app.get("/api/chat", async (c) => {
    // Read here rather than only in the writes: `mine` on every pill below is a
    // fact about whoever is holding this session, not about the item.
    const member = c.get("member");
    const after = parseCursor(c.req.query("after"));
    // Inclusive `since` on both reads — the cursor breaks ties on id, so the
    // boundary row has to come back and be dropped in the filter below.
    const since = after?.at;
    const [members, accounts, eventRows, messageRows] = await Promise.all([
      storage.listMembers(),
      storage.listAccounts(),
      storage.listFeedEvents({ since, limit: PAGE_LIMIT }),
      storage.listMessages({ since, limit: PAGE_LIMIT }),
    ]);

    const memberById = new Map(members.map((m) => [m.id, m]));
    const items: TimelineItem[] = [
      ...toFeedEvents(eventRows, members, accounts).map(
        (event): TimelineItem => ({ kind: "event", ...event }),
      ),
      ...messageRows.map(
        (row): TimelineItem => ({
          kind: "message",
          id: row.id,
          memberId: row.memberId,
          authorName: memberById.get(row.memberId)?.name ?? "Someone",
          body: row.body,
          createdAt: row.createdAt,
        }),
      ),
    ];

    items.sort((a, b) => compareKeys(orderKey(a), orderKey(b)));

    const fresh = after
      ? items.filter((item) => compareKeys(orderKey(item), after) > 0)
      : // No cursor: the tail is what a chat opens on, not the first page ever.
        items.slice(-PAGE_LIMIT);

    // An empty page hands back the cursor the client already had, so an idle
    // poll is genuinely idempotent.
    const cursor = fresh.length
      ? formatCursor(orderKey(fresh[fresh.length - 1]))
      : (c.req.query("after") ?? "");

    /**
     * Reactions on a cursor poll, which is the interesting half of this route.
     *
     * The item cursor advances past everything the client has seen, so an hour
     * from now that message is never in a page again — and somebody putting a
     * 🚀 on it still has to reach every other phone in the group. Two sources,
     * merged into one map:
     *
     *   1. every item *on this page* — the cold open is entirely this, and it
     *      is what makes a first load arrive with its pills already drawn;
     *   2. every item, however old, whose reactions changed at or after
     *      `?reactedAfter=` — the delta, read from the touch log written by
     *      every PUT and DELETE (migrations/0004_reactions.sql).
     *
     * The delta carries whole summaries, never diffs, which is what lets a
     * *removal* travel at all: there is no deleted row left to replay, but the
     * item was touched, and its recomputed summary is simply shorter. It also
     * makes the bound safe to leave inclusive, matching listMessages and
     * listFeedEvents: re-reading the boundary item costs one identical summary
     * and removes any chance of stepping over a second item stamped in the same
     * millisecond.
     */
    const reactedAfter = c.req.query("reactedAfter") ?? "";
    const activity = reactedAfter
      ? await storage.listReactionActivity({
          since: reactedAfter,
          limit: REACTION_DELTA_LIMIT,
        })
      : [];

    const pageTargets = fresh.map(targetOf);
    const seen = new Set(pageTargets.map((t) => reactionKey(t.kind, t.id)));
    const targets = [
      ...pageTargets,
      ...activity
        .map((a) => a.target)
        .filter((t) => !seen.has(reactionKey(t.kind, t.id))),
    ];

    const rows = targets.length ? await storage.listReactionsFor(targets) : [];
    const reactions = toReactionMap(targets, rows, memberById, member.id);

    /**
     * Where the client should resume the delta from.
     *
     * A truncated delta must resume at its own last touch, not at "now", or the
     * items past the limit would be skipped forever. An empty delta hands back
     * exactly what it was given, so an idle poll is idempotent in this
     * dimension too. And a cold open takes the newest touch in the group: the
     * page it just returned already carries every reaction it could possibly
     * know about, so there is nothing older to catch up on.
     */
    const reactionCursor = activity.length
      ? activity[activity.length - 1].touchedAt
      : reactedAfter || ((await storage.latestReactionActivityAt()) ?? "");

    return c.json({
      items: fresh,
      cursor,
      reactions,
      reactionCursor,
    } satisfies ChatPage);
  });

  app.post("/api/chat", async (c) => {
    const member = c.get("member");
    const payload = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const body = typeof payload.body === "string" ? payload.body.trim() : "";

    if (!body) return c.json({ error: "empty_body" }, 400);
    if (body.length > MAX_BODY_LENGTH) {
      return c.json({ error: "body_too_long", max: MAX_BODY_LENGTH }, 400);
    }

    const row = {
      id: randomUUID(),
      memberId: member.id,
      body,
      createdAt: new Date().toISOString(),
    };
    await storage.insertMessage(row);

    const item: TimelineItem = {
      kind: "message",
      id: row.id,
      memberId: row.memberId,
      authorName: member.name,
      body: row.body,
      createdAt: row.createdAt,
    };

    // After the write, never instead of it: D1 has the message whether or not
    // anyone is listening. Off the response path because the author is already
    // looking at their own optimistic row — the fan-out is for everybody else.
    if (room) background(c, room.broadcast([item]));

    // Echo the stored row: the client posted optimistically and needs the real
    // id and timestamp to reconcile against the next poll.
    return c.json(item, 201);
  });

  /**
   * The toggle. PUT adds, DELETE removes, and both are idempotent because the
   * primary key is the whole tuple — which is exactly the property an
   * optimistic UI needs: a double tap, a retry after a flaky connection and two
   * tabs racing all converge on the same row.
   *
   * PUT rather than POST for the same reason: this is "make it so that I have
   * reacted with 🚀", not "append a reaction". One body shape, two verbs, one
   * response — the item's whole recomputed summary, never a delta, so the
   * client replaces its entry rather than trying to reconcile a count it
   * already moved optimistically.
   *
   * What is deliberately *not* checked: whether the item exists. Confirming it
   * would cost a read per tap on the hot path, and the failure it prevents is a
   * row nothing ever selects — reactions are only ever read for items that are
   * already on a page, so a reaction on an unknown id renders nowhere. The
   * writers are five signed-in friends, not the open internet.
   */
  const toggle = async (c: Context<SessionEnv>, add: boolean) => {
    const member = c.get("member");
    const payload = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const parsed = parseReactionRequest(payload);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);

    const at = new Date().toISOString();
    const target: ReactionTarget = { kind: parsed.kind, id: parsed.id };

    if (add) {
      await storage.insertReaction({
        itemKind: parsed.kind,
        itemId: parsed.id,
        memberId: member.id,
        emoji: parsed.emoji,
        createdAt: at,
      });
    } else {
      await storage.deleteReaction(
        { ...target, memberId: member.id, emoji: parsed.emoji },
        at,
      );
    }

    // Re-read rather than compute: the row that just landed is not necessarily
    // the only one, and the summary has to name everybody.
    const [members, rows] = await Promise.all([
      storage.listMembers(),
      storage.listReactionsFor([target]),
    ]);
    const memberById = new Map(members.map((m) => [m.id, m]));
    const key = reactionKey(parsed.kind, parsed.id);

    // Same fan-out discipline as POST /api/chat: after the write, never instead
    // of it, and off the response path — the person who tapped is already
    // looking at their own optimistic pill.
    if (room) {
      background(
        c,
        room.broadcastReactions(toReactionBroadcast([target], rows, memberById)),
      );
    }

    return c.json({
      itemKind: parsed.kind,
      itemId: parsed.id,
      reactions: toReactionMap([target], rows, memberById, member.id)[key],
    } satisfies ReactionUpdate);
  };

  app.put("/api/chat/reactions", (c) => toggle(c, true));
  app.delete("/api/chat/reactions", (c) => toggle(c, false));

  return app;
}

/** Ordering key: timestamp first, id as the tie-break. Both sides are ISO/opaque. */
export interface OrderKey {
  at: string;
  id: string;
}

export function orderKey(item: TimelineItem): OrderKey {
  return {
    at: item.kind === "message" ? item.createdAt : item.detectedAt,
    id: item.id,
  };
}

export function compareKeys(a: OrderKey, b: OrderKey): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export function formatCursor(key: OrderKey): string {
  return `${key.at}|${key.id}`;
}

/**
 * Forgiving on purpose: a cursor the server can't read means the client gets a
 * full tail and self-heals, which beats a poll loop that 400s forever.
 */
export function parseCursor(raw: string | undefined): OrderKey | undefined {
  if (!raw) return undefined;
  const split = raw.indexOf("|");
  if (split <= 0) return undefined;
  const at = raw.slice(0, split);
  const id = raw.slice(split + 1);
  if (!id || Number.isNaN(Date.parse(at))) return undefined;
  return { at, id };
}
