import type { FeedEventRow } from "./domain.js";
import { toFeedEvents } from "./feed.js";
import type { Pusher } from "./push/notify.js";
import type { Storage } from "./storage/index.js";
import type { ReactionMap, TimelineItem } from "./types.js";

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

/** Room → browser. Every arm is additive: a client that ignores one still works. */
export type RoomServerMessage =
  | { type: "items"; items: TimelineItem[] }
  /** Ephemeral. Never stored, never replayed, never sent back to its author. */
  | { type: "typing"; memberId: string; name: string }
  /**
   * Whole current summaries for the items whose reactions just changed — the
   * same shape and the same semantics as the `reactions` field of a poll
   * response, so the client has one merge path for both. Never a diff, so a
   * frame that arrives twice, out of order, or alongside a poll carrying the
   * same fact all settle on the same pills.
   */
  | { type: "reactions"; reactions: ReactionMap };

/**
 * One emoji's standing, as the *room* carries it — before `mine` exists.
 *
 * `mine` is the one field in a reaction summary that is not a fact about the
 * item but a fact about the reader, and a fan-out has five readers. So the
 * broadcast carries the reactor ids instead and the room stamps `mine` per
 * socket on the way out (see room-object.ts). Nothing is leaked by doing it
 * this way: member ids are already public to every signed-in client via
 * /api/members, and the names in `who` are the same names the poll sends.
 */
export interface ReactionBroadcastEntry {
  emoji: string;
  count: number;
  who: string[];
  memberIds: string[];
}

/** Keyed "<kind>:<id>", exactly like ReactionMap. See reactionKey() in chat.ts. */
export type ReactionBroadcastMap = Record<string, ReactionBroadcastEntry[]>;

/** Drop the ids, decide `mine`: one reader's view of one broadcast. */
export function personaliseReactions(
  reactions: ReactionBroadcastMap,
  memberId: string,
): ReactionMap {
  const out: ReactionMap = {};
  for (const [key, entries] of Object.entries(reactions)) {
    out[key] = entries.map((entry) => ({
      emoji: entry.emoji,
      count: entry.count,
      mine: entry.memberIds.includes(memberId),
      who: entry.who,
    }));
  }
  return out;
}

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

/** The Notifier plus the halves only the HTTP layer needs. */
export interface Room extends Notifier {
  /**
   * Hand a validated upgrade request to the room. The caller has already proven
   * the session; `member` is what the room will attribute typing signals to.
   */
  upgrade(request: Request, member: RoomMember): Promise<Response>;
  /**
   * Fan out reaction summaries. Not on Notifier, deliberately: the poll tick
   * publishes trades and has no reactions to send, and widening the interface it
   * depends on to carry something it can never produce would be noise.
   *
   * Same contract as broadcast(): swallow failures. A reaction that is in the
   * database has succeeded whether or not a socket was listening — the next
   * poll carries it either way, which is the whole point of the delta below.
   */
  broadcastReactions(reactions: ReactionBroadcastMap): Promise<void>;
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
