export type FeedEventType =
  | "NEW_POSITION"
  | "EXITED"
  | "SIZE_UP"
  | "SIZE_DOWN";

export interface FeedEvent {
  id: string;
  accountId: string;
  accountName: string;
  type: FeedEventType;
  symbol: string;
  instrumentName: string;
  /** Position size as % of that friend's portfolio — never rupee amounts. */
  pctOfPortfolio: number;
  /** For SIZE_UP/SIZE_DOWN: relative change in quantity, e.g. 0.25 = +25%. */
  qtyChangePct?: number;
  detectedAt: string;
}

export interface Member {
  id: string;
  name: string;
  visibility: "named" | "anonymous" | "paused";
}

/**
 * One line of group chat. Always attributed by name: visibility is a dial on
 * what the *watcher* publishes about your portfolio, not on your own speech —
 * an anonymous chat in a five-person WhatsApp replacement is just confusing.
 */
export interface ChatMessage {
  id: string;
  memberId: string;
  authorName: string;
  body: string;
  createdAt: string;
}

/** The group timeline is one list: what people said and what people did. */
export type TimelineItem =
  | ({ kind: "message" } & ChatMessage)
  | ({ kind: "event" } & FeedEvent);

/**
 * `cursor` is the ordering key of the newest item on the page ("<iso>|<id>").
 * Hand it back as ?after= and the next read is just the tail — an idle poll
 * returns `items: []` and the same cursor.
 */
export interface ChatPage {
  items: TimelineItem[];
  cursor: string;
}
