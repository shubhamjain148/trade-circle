import { DurableObject } from "cloudflare:workers";
import {
  parseClientMessage,
  personaliseReactions,
  relayTypingAt,
  type ReactionBroadcastMap,
  type RoomMember,
  type RoomServerMessage,
} from "./room.js";
import type { TimelineItem } from "./types.js";

/**
 * The group room: one Durable Object, pure fan-out, zero durable state.
 *
 * Built on the WebSocket Hibernation API, which is the whole reason this is
 * affordable. `ctx.acceptWebSocket()` plus `webSocketMessage`/`webSocketClose`
 * handlers on the class means the runtime can evict this object from memory
 * while the sockets stay connected — and duration (GB-s) is not billed while it
 * is hibernating. The same room built with `server.accept()` and
 * `addEventListener` would bill wall-clock time for every second anyone had the
 * tab open, which for an evening-use app is most of the evening.
 *
 * Consequence, and the reason nothing below reaches for `this.something`: any
 * in-memory field can vanish between two messages. The socket list comes from
 * `ctx.getWebSockets()` (the runtime's, not ours) and per-connection identity
 * comes from the socket's own attachment. `lastTypingAt` is the one exception,
 * and it is a throttle whose worst failure mode is one extra relayed keystroke.
 */
export class ChatRoom extends DurableObject {
  /**
   * Per-member typing throttle. Deliberately not an attachment and not storage:
   * losing it costs at most one redundant broadcast, and a hibernating room is
   * by definition a room where nobody is typing.
   */
  private lastTypingAt = new Map<string, number>();

  /**
   * The upgrade. The session was validated by the Worker before this was ever
   * called — the room trusts the headers because nothing else can reach it.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const member = readMember(request);
    if (!member) return new Response("missing member", { status: 400 });

    const [client, server] = Object.values(new WebSocketPair());

    // Hibernatable: no addEventListener here, deliberately.
    this.ctx.acceptWebSocket(server);
    // Survives hibernation, so a typing signal after an eviction is still
    // attributed to the right person. Two short strings, far inside the 16 KiB cap.
    server.serializeAttachment(member satisfies RoomMember);

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Fan out rows the Worker has already committed to D1. Called over RPC from
   * the Worker — one billed request per call regardless of how many sockets it
   * reaches, and outgoing messages are free.
   */
  async broadcast(items: TimelineItem[]): Promise<void> {
    if (items.length === 0) return;
    this.send({ type: "items", items });
  }

  /**
   * Fan out reaction summaries. The one broadcast in here that cannot be
   * serialised once, because `mine` is a fact about the reader rather than
   * about the item — so this loops the sockets, reads each one's attachment,
   * and stamps the flag per person. Five friends and a handful of emoji: the
   * cost of being correct here is a few string concatenations.
   *
   * A socket whose attachment is missing still gets the frame with `mine`
   * false. Wrong pill fill beats a silently dropped update, and the next poll
   * corrects it within the minute.
   */
  async broadcastReactions(reactions: ReactionBroadcastMap): Promise<void> {
    if (Object.keys(reactions).length === 0) return;
    for (const socket of this.ctx.getWebSockets()) {
      const member = socket.deserializeAttachment() as RoomMember | null;
      const payload: RoomServerMessage = {
        type: "reactions",
        reactions: personaliseReactions(reactions, member?.id ?? ""),
      };
      try {
        socket.send(JSON.stringify(payload));
      } catch {
        // Same as send(): a socket that died mid-loop is the runtime's problem.
      }
    }
  }

  /**
   * The only thing a client is allowed to say. Sends go over HTTP POST, so
   * there is no message path here that can create a row — which keeps the
   * failure story for sending a message exactly as simple as it was.
   */
  override webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    const message = parseClientMessage(raw);
    if (message?.type !== "typing") return;

    const member = ws.deserializeAttachment() as RoomMember | null;
    if (!member) return;

    const at = relayTypingAt(this.lastTypingAt.get(member.id), Date.now());
    if (at === null) return;
    this.lastTypingAt.set(member.id, at);

    this.send({ type: "typing", memberId: member.id, name: member.name }, ws);
  }

  /**
   * Defined so the runtime has somewhere to deliver the event rather than
   * waking a handler that does not exist. The compatibility date is past
   * 2026-04-07, so the runtime replies to the Close frame itself; there is
   * nothing to clean up because the socket list is not ours to keep.
   */
  override webSocketClose(ws: WebSocket): void {
    const member = ws.deserializeAttachment() as RoomMember | null;
    if (member) this.lastTypingAt.delete(member.id);
  }

  override webSocketError(_ws: WebSocket, error: unknown): void {
    console.warn(
      JSON.stringify({
        msg: "room socket error",
        err: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  /** One serialisation, N sends. `except` is how typing skips its own author. */
  private send(message: RoomServerMessage, except?: WebSocket): void {
    const payload = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === except) continue;
      try {
        socket.send(payload);
      } catch {
        // A socket that died between getWebSockets() and send() is the
        // runtime's problem, not a reason to drop the rest of the room.
      }
    }
  }
}

/** Headers, not query string: the member is the Worker's assertion, not the URL's. */
function readMember(request: Request): RoomMember | undefined {
  const id = request.headers.get("x-room-member-id");
  const name = request.headers.get("x-room-member-name");
  if (!id || !name) return undefined;
  try {
    return { id, name: decodeURIComponent(name) };
  } catch {
    return undefined;
  }
}
