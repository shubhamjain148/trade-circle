import type { FeedEvent, Member } from "./types.js";

// Placeholder data until the MCP poller lands (phase 1). Shapes mirror the
// event log schema in docs/appendix-2-watcher-architecture.md.
export const members: Member[] = [
  { id: "m1", name: "Shubham", visibility: "named" },
  { id: "m2", name: "Rahul", visibility: "named" },
  { id: "m3", name: "Anjali", visibility: "named" },
];

export const feedEvents: FeedEvent[] = [
  {
    id: "e1",
    accountId: "m2",
    accountName: "Rahul",
    type: "NEW_POSITION",
    symbol: "NVDA",
    instrumentName: "NVIDIA Corp",
    pctOfPortfolio: 2.4,
    detectedAt: "2026-08-05T20:15:00.000Z",
  },
  {
    id: "e2",
    accountId: "m3",
    accountName: "Anjali",
    type: "SIZE_UP",
    symbol: "AAPL",
    instrumentName: "Apple Inc",
    pctOfPortfolio: 6.1,
    qtyChangePct: 0.25,
    detectedAt: "2026-08-05T21:15:00.000Z",
  },
  {
    id: "e3",
    accountId: "m2",
    accountName: "Rahul",
    type: "EXITED",
    symbol: "TSLA",
    instrumentName: "Tesla Inc",
    pctOfPortfolio: 0,
    detectedAt: "2026-08-06T01:45:00.000Z",
  },
];
