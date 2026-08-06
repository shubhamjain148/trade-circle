import type { FeedEventRow } from "./domain.js";
import { toFeedEvents } from "./feed.js";
import type { Pusher } from "./push/notify.js";
import type { Storage } from "./storage/index.js";
import type { TimelineItem } from "./types.js";

/**
 * The live-delivery seam, and everything about it that is runtime-agnostic.
 *
 * There is exactly one room — five friends in one thread — so the Durable
 * Object is addressed by a constant name rather than by anything derived from a
 * request. The class that implements it lives in room-object.ts and is imported
 * only by the Workers entry point; nothing here touches `cloudflare:workers`,
 * so api.ts, chat.ts and poller/tick.ts stay loadable under plain Node.
 *
 * The room stores nothing. D1 is the source of truth and polling is still the
 * reconciliation layer; this is a nudge that says "look now" with the rows
 * already attached, and typing signals that were never meant to outlive the
 * keystroke.
 */

/** The single group room. `idFromName`/`getByName` takes this and nothing else. */
export const ROOM_NAME = "group";

/**
 * Server-side floor on typing relays, under the client's 2.5 s throttle so a
 * client that is merely a little fast is not punished for it. A tab that lies
 * about the interval still cannot cost the room more than one broadcast per
 * member per two seconds.
 */
export const TYPING_MIN_GAP_MS = 2_000;

/** Nothing a client legitimately sends comes near this. */
export const MAX_CLIENT_MESSAGE_BYTES = 256;

/** Room → browser. Both arms are additive: a client that ignores one still works. */
export type RoomServerMessage =
  | { type: "items"; items: TimelineItem[] }
  /** Ephemeral. Never stored, never replayed, never sent back to its author. */
  | { type: "typing"; memberId: string; name: string };

/** Browser → room. Sends still go over HTTP POST; this carries presence-of-thought only. */
export type RoomClientMessage = { type: "typing" };

/** Who is on the other end of a socket, as the Worker vouched for them. */
export interface RoomMember {
  id: string;
  name: string;
}

/**
 * Fan-out of newly-persisted timeline rows. Implementations must swallow their
 * own failures: a chat message that was written to D1 has succeeded whether or
 * not anyone was listening, and a poll tick must never fail over a broadcast.
 */
export interface Notifier {
  broadcast(items: TimelineItem[]): Promise<void>;
}

/** The Notifier plus the half only the HTTP layer needs: the upgrade itself. */
export interface Room extends Notifier {
  /**
   * Hand a validated upgrade request to the room. The caller has already proven
   * the session; `member` is what the room will attribute typing signals to.
   */
  upgrade(request: Request, member: RoomMember): Promise<Response>;
}

/** What both entry points get when there is no room: Node, and every test. */
export const noopNotifier: Notifier = {
  async broadcast() {},
};

/**
 * Row → wire → room, with visibility applied by exactly the same projection
 * /api/chat and /api/feed use. A paused member's move must not reach a socket
 * any more than it reaches a poll.
 *
 * Reads members and accounts, so it is only worth calling when there is
 * something to say — poller/tick.ts checks that before it calls.
 *
 * Web Push rides the *same* projection rather than repeating it. That is the
 * whole reason the pusher is handed in here instead of being called separately
 * from the tick: a socket and a lock screen cannot disagree about who is
 * paused or who is named, because there is only one list.
 */
export async function notifyFeedEvents(
  storage: Storage,
  notifier: Notifier,
  rows: FeedEventRow[],
  pusher?: Pusher,
): Promise<void> {
  if (rows.length === 0) return;
  const [members, accounts] = await Promise.all([
    storage.listMembers(),
    storage.listAccounts(),
  ]);
  const events = toFeedEvents(rows, members, accounts);
  const items = events.map((event): TimelineItem => ({ kind: "event", ...event }));
  await notifier.broadcast(items);
  // After the broadcast: the tab that is already open should not wait behind a
  // fan-out of HTTPS requests to Apple and Google.
  if (pusher) await pusher.feedEvents(events);
}

/**
 * The typing rate limit, as a function so it can be tested without a socket.
 * `lastAt` is when this member last had a signal relayed (undefined = never).
 * Returns the new `lastAt` to record, or null to drop the signal on the floor.
 *
 * Deliberately not sliding-window or token-bucket: the client already throttles,
 * this is the backstop, and a backstop that needs a data structure is too clever
 * for a room that holds five people.
 */
export function relayTypingAt(
  lastAt: number | undefined,
  now: number,
  minGapMs = TYPING_MIN_GAP_MS,
): number | null {
  if (lastAt !== undefined && now - lastAt < minGapMs) return null;
  return now;
}

/**
 * Parse a frame from a client. Anything unrecognised, oversized or not an
 * object is undefined — the room drops it silently rather than closing the
 * socket, because a client one version ahead is not a misbehaving client.
 */
export function parseClientMessage(
  raw: string | ArrayBuffer,
): RoomClientMessage | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw.length > MAX_CLIENT_MESSAGE_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const type = (parsed as { type?: unknown }).type;
  return type === "typing" ? { type: "typing" } : undefined;
}
