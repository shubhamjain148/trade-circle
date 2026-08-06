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
