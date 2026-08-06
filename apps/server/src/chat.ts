import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { requireSession, type SessionEnv } from "./auth/session.js";
import { toFeedEvents } from "./feed.js";
import type { Storage } from "./storage/index.js";
import type { ChatPage, TimelineItem } from "./types.js";

/** Long enough for a real thought, short enough that a row stays a row. */
export const MAX_BODY_LENGTH = 2000;

/** One page of history on a cold open; polls after that carry a cursor. */
const PAGE_LIMIT = 200;

export interface ChatDeps {
  storage: Storage;
}

/**
 * The group's chat and the watcher's feed are the same timeline — this is the
 * product surface now (docs/RESEARCH.md decisions log), so the merge happens
 * server-side rather than leaving the client to zip two lists.
 *
 * Mounted as its own Hono app so api.ts stays one import and one line: the
 * session gate below applies to these routes only.
 */
export function createChatApp({ storage }: ChatDeps): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();

  app.use("/api/chat", requireSession(storage));

  // Oldest → newest, unlike /api/feed: this reads as a conversation, and the
  // composer sits at the bottom of it.
  app.get("/api/chat", async (c) => {
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

    return c.json({ items: fresh, cursor } satisfies ChatPage);
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

    // Echo the stored row: the client posted optimistically and needs the real
    // id and timestamp to reconcile against the next poll.
    return c.json(
      {
        kind: "message",
        id: row.id,
        memberId: row.memberId,
        authorName: member.name,
        body: row.body,
        createdAt: row.createdAt,
      } satisfies TimelineItem,
      201,
    );
  });

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
