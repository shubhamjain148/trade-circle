import { serve } from "@hono/node-server";
import { createApp } from "./api.js";
import { Vault } from "./auth/vault.js";
import { config } from "./config.js";
import { McpPortfolioSource } from "./mcp/source.js";
import { createScheduler } from "./poller/scheduler.js";
import { SnapshotEchoSource } from "./poller/source.js";
import { Backoff, runPollTick } from "./poller/tick.js";
import { createStorage } from "./storage/index.js";

const storage = await createStorage(config.dbPath);
const mcp = { storage, vault: new Vault(config.appSecret), config };

// Accounts with an active grant go over MCP; everyone else replays their last
// snapshot, so the group polls cleanly while friends are still joining.
const source = new McpPortfolioSource(mcp, {
  fallback: new SnapshotEchoSource(storage),
});
const backoff = new Backoff();

const poll = (opts?: { force?: boolean }) =>
  runPollTick(storage, source, { staggerMs: 30_000, backoff, ...opts });

const app = createApp({ storage, poll, config, mcp });

const scheduler = createScheduler(poll);
if (process.env.DISABLE_SCHEDULER !== "1") scheduler.start();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`server listening on http://localhost:${info.port}`);
  const next = scheduler.nextAt();
  if (next) console.log(`next poll tick at ${next.toISOString()}`);
});
