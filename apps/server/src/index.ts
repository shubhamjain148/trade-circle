import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { feedEvents, members } from "./mock.js";

const app = new Hono();

app.use(logger());

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/members", (c) => c.json(members));

// Group feed: everyone's events interleaved, newest first.
// Individual feed: same log filtered by ?accountId=.
app.get("/api/feed", (c) => {
  const accountId = c.req.query("accountId");
  const events = feedEvents
    .filter((e) => !accountId || e.accountId === accountId)
    .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
  return c.json(events);
});

const port = Number(process.env.PORT ?? 3001);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`server listening on http://localhost:${info.port}`);
});
