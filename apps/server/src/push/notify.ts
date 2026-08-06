import { ANONYMOUS_NAME } from "../feed.js";
import type { Storage } from "../storage/index.js";
import type { FeedEvent } from "../types.js";
import {
  audienceFor,
  sendWebPush,
  vapidAuthorization,
  type VapidConfig,
  type WebPushSubscription,
} from "./webpush.js";

/**
 * The send half of Web Push: who gets told what, and what happens to a
 * subscription that stops answering.
 *
 * Two rules shape everything here, and both are inherited rather than invented:
 *
 *   Visibility is already applied. The events this receives came out of
 *   toFeedEvents — the same projection /api/feed and /api/chat use — so a
 *   paused member's move never reaches this file at all, and an anonymous
 *   member's arrives with the name already stripped. There is deliberately no
 *   second visibility check: a second implementation of a privacy rule is a
 *   second chance to get it wrong.
 *
 *   Nobody is notified of their own move. That check lives here because it is
 *   per-recipient, which is the one thing a projection cannot know.
 *
 * Chat messages do not push. The seam for it is `Pusher` — a second method
 * alongside `feedEvents` — and src/chat.ts would call it after its insert, the
 * same way it already calls `room.broadcast`.
 */

/** Beyond this many events for one person in one tick, they get a count instead. */
export const MAX_INDIVIDUAL_NOTIFICATIONS = 3;

/**
 * Consecutive soft failures before a subscription is dropped. A 404/410 is
 * decisive and drops immediately; this is for the 500s and the timeouts, where
 * the honest reading is "the push service is having an evening", and five of
 * them in a row is the point at which it stops being an evening.
 */
export const MAX_PUSH_FAILURES = 5;

/** What crosses the wire to apps/web/public/sw.js. Kept flat and small. */
export interface PushNotification {
  title: string;
  /** Size as % of portfolio, or that the position is closed. Never an amount. */
  body: string;
  /** Per event, so a redelivery replaces rather than stacks. */
  tag: string;
  /** Where notificationclick lands: the member's feed, or the group. */
  url: string;
}

/**
 * The live-push seam, mirroring `Notifier` in src/room.ts. Absent on Node and
 * whenever VAPID is unconfigured, and absence is a supported state: the feed
 * and the room carry on exactly as before.
 */
export interface Pusher {
  /** Never throws. A failed notification must not fail a poll tick. */
  feedEvents(events: FeedEvent[]): Promise<void>;
}

export const noopPusher: Pusher = {
  async feedEvents() {},
};

// --- What each person gets --------------------------------------------------

const VERBS: Record<FeedEvent["type"], string> = {
  NEW_POSITION: "opened",
  SIZE_UP: "added to",
  SIZE_DOWN: "trimmed",
  EXITED: "exited",
};

/**
 * One tick's events, as one member should see them.
 *
 * Their own moves are dropped first — a notification telling you what you just
 * did is the fastest way to get the whole feature turned off. What is left is
 * either a handful of notifications or, past the cap, a single line saying how
 * many; a phone that buzzes eight times for one poll is a phone that gets
 * silenced.
 */
export function notificationsFor(
  events: FeedEvent[],
  memberId: string,
): PushNotification[] {
  // FeedEvent.accountId is the *member* id after projection, not the account's.
  const theirs = events.filter((event) => event.accountId !== memberId);
  if (theirs.length === 0) return [];
  if (theirs.length > MAX_INDIVIDUAL_NOTIFICATIONS) return [collapse(theirs)];
  return theirs.map(toNotification);
}

function toNotification(event: FeedEvent): PushNotification {
  const anonymous = event.accountName === ANONYMOUS_NAME;
  return {
    // An anonymous move names neither the person nor the instrument. A lock
    // screen is read by whoever is standing near it, which is a wider audience
    // than the app the same fact sits in — and someone who chose to be unnamed
    // did not choose that. The feed still shows them everything.
    title: anonymous
      ? `${ANONYMOUS_NAME} ${VERBS[event.type]} a position`
      : `${event.accountName} ${VERBS[event.type]} ${instrumentLabel(event)}`,
    body: describeSize(event),
    tag: event.id,
    // Nowhere to deep-link an anonymous member: they have no feed of their own
    // to open, so the group timeline is the honest destination.
    url: anonymous ? "#/" : `#/m/${encodeURIComponent(event.accountId)}`,
  };
}

/**
 * The collapsed line. Names who moved rather than what they moved: at four
 * events the useful fact is "the group was busy", and listing instruments
 * would put an anonymous member's symbols on a lock screen one notification
 * after the rule above kept them off it.
 */
function collapse(events: FeedEvent[]): PushNotification {
  const names = [...new Set(events.map((e) => e.accountName))].map((name) =>
    name === ANONYMOUS_NAME ? "someone" : name,
  );
  return {
    title: `${events.length} moves in the group`,
    body: joinNames(names),
    // A stable tag, so a second busy tick replaces the first rather than
    // leaving a shelf of counts nobody will read.
    tag: "group-moves",
    url: "#/",
  };
}

function joinNames(names: string[]): string {
  if (names.length === 1) return `From ${names[0]}`;
  if (names.length === 2) return `From ${names[0]} and ${names[1]}`;
  return `From ${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

function describeSize(event: FeedEvent): string {
  if (event.type === "EXITED") return "Position closed";
  return `${event.pctOfPortfolio.toFixed(1)}% of portfolio`;
}

/**
 * INDmoney hands us an investment code where a ticker would be, so a title
 * saying "opened 120723" reads as a bug. Same rule the feed row applies in
 * apps/web/src/lib/instrument.ts, kept deliberately shorter: this is one line
 * on a lock screen, not a row with a detail line under it.
 */
const CODE_LIKE = /^(?:\d{3,}|INDS[A-Za-z0-9]*)$/;

function instrumentLabel(event: FeedEvent): string {
  const symbol = event.symbol.trim();
  if (symbol && !CODE_LIKE.test(symbol)) return symbol;
  const name = event.instrumentName.trim();
  if (!name) return symbol || "a position";
  return name.length > 40 ? `${name.slice(0, 39)}…` : name;
}

// --- Sending ----------------------------------------------------------------

export interface PusherOptions {
  storage: Storage;
  vapid: VapidConfig;
  /** Injected in tests; the real one is the runtime's. */
  fetch?: typeof fetch;
  /**
   * Hands the fan-out to the runtime so it outlives the response — `waitUntil`
   * on Workers. Omitted means "await it here", which is what Node wants and
   * what a caller already inside a waitUntil wants.
   */
  defer?: (work: Promise<unknown>) => void;
  now?: () => Date;
}

export interface FanOutResult {
  /** Notifications the push service accepted. */
  sent: number;
  /** Subscriptions deleted — gone at the service, or out of second chances. */
  removed: number;
  /** Sends that failed without being decisive. */
  failed: number;
}

export function createPusher(options: PusherOptions): Pusher {
  return {
    async feedEvents(events: FeedEvent[]): Promise<void> {
      if (events.length === 0) return;
      const work = fanOutFeedEvents(events, options).then(
        (result) => {
          if (result.sent || result.removed || result.failed) {
            console.log(JSON.stringify({ msg: "push fan-out", ...result }));
          }
        },
        (err) => {
          // The events are in D1 and already in the room. Push is the least
          // important of the three deliveries and must never be the one that
          // turns a good tick into a failed one.
          console.warn(
            JSON.stringify({ msg: "push fan-out failed", err: message(err) }),
          );
        },
      );
      if (options.defer) {
        options.defer(work);
        return;
      }
      await work;
    },
  };
}

/**
 * Every registered device, one pass. Reads subscriptions once for the whole
 * tick and caches one VAPID token per push service — five friends behind two
 * or three services means two or three signatures, not one per device.
 */
export async function fanOutFeedEvents(
  events: FeedEvent[],
  options: PusherOptions,
): Promise<FanOutResult> {
  const { storage, vapid } = options;
  const now = options.now ?? (() => new Date());
  const result: FanOutResult = { sent: 0, removed: 0, failed: 0 };

  const subscriptions = await storage.listPushSubscriptions();
  if (subscriptions.length === 0) return result;

  const tokens = new Map<string, Promise<string>>();
  const authorizationFor = (endpoint: string): Promise<string> => {
    const audience = audienceFor(endpoint);
    let token = tokens.get(audience);
    if (!token) {
      token = vapidAuthorization(vapid, audience, now());
      tokens.set(audience, token);
    }
    return token;
  };

  for (const row of subscriptions) {
    const notifications = notificationsFor(events, row.memberId);
    if (notifications.length === 0) continue;

    let subscription: WebPushSubscription;
    try {
      subscription = JSON.parse(row.subscriptionJson) as WebPushSubscription;
      if (!subscription?.endpoint || !subscription.keys?.p256dh) {
        throw new Error("subscription is missing an endpoint or keys");
      }
    } catch {
      // Unparseable means a row we can never send to. Nothing to count down.
      await storage.deletePushSubscription(row.endpointHash);
      result.removed += 1;
      continue;
    }

    let alive = true;
    let delivered = 0;
    for (const notification of notifications) {
      if (!alive) break;
      try {
        const outcome = await sendWebPush(
          subscription,
          JSON.stringify(notification),
          vapid,
          {
            fetch: options.fetch,
            authorization: await authorizationFor(subscription.endpoint),
            now: now(),
          },
        );
        if (outcome.gone) {
          // The push service is telling us this device is gone. Believe it the
          // first time: retrying a 410 is how a table fills with corpses.
          await storage.deletePushSubscription(row.endpointHash);
          result.removed += 1;
          alive = false;
        } else if (outcome.ok) {
          delivered += 1;
          result.sent += 1;
        } else {
          alive = false;
          result.failed += 1;
          if (await recordFailure(storage, row.endpointHash)) result.removed += 1;
        }
      } catch {
        // A transport failure, not an answer. Same countdown.
        alive = false;
        result.failed += 1;
        if (await recordFailure(storage, row.endpointHash)) result.removed += 1;
      }
    }

    if (alive && delivered > 0) {
      await storage.markPushSubscriptionOk(row.endpointHash, now().toISOString());
    }
  }

  return result;
}

/** Counts one failure and prunes on the fifth. Returns true if the row died. */
async function recordFailure(storage: Storage, endpointHash: string): Promise<boolean> {
  const failures = await storage.bumpPushSubscriptionFailure(endpointHash);
  if (failures < MAX_PUSH_FAILURES) return false;
  await storage.deletePushSubscription(endpointHash);
  return true;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
