import { serve } from "@hono/node-server";
import { createApp } from "./api.js";
import { createScheduler } from "./poller/scheduler.js";
import { SnapshotEchoSource } from "./poller/source.js";
import { Backoff, runPollTick } from "./poller/tick.js";
import { createStorage } from "./storage/index.js";

const storage = await createStorage();

// Swap for McpPortfolioSource once the client lands — see
// src/poller/sources/mcp.todo.md. Nothing else here changes.
const source = new SnapshotEchoSource(storage);
const backoff = new Backoff();

const poll = () =>
  runPollTick(storage, source, { staggerMs: 30_000, backoff });

const app = createApp({ storage, poll });

const scheduler = createScheduler(poll);
if (process.env.DISABLE_SCHEDULER !== "1") scheduler.start();

const port = Number(process.env.PORT ?? 3001);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`server listening on http://localhost:${info.port}`);
  const next = scheduler.nextAt();
  if (next) console.log(`next poll tick at ${next.toISOString()}`);
});
