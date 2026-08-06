# Deployment options — survey only, decision deferred

We build first, deploy later. Constraints from the design: a Vite static frontend, a Hono API,
an **hourly poll job** during US market hours, and (phase 1) a SQLite file. Options, in rough
order of fit:

## 1. Vercel Hobby (free) — viable with one workaround
- Frontend: static Vite deploy, trivially free.
- API: Hono has a first-class Vercel adapter (`hono/vercel`); serverless functions on Hobby are
  free and a poll tick fits well inside limits.
- **Catch 1 — cron:** Hobby cron jobs only run **once per day**, so the hourly poll can't use
  Vercel cron. Workaround: an external free scheduler (GitHub Actions `schedule`, cron-job.org)
  hitting a `/api/poll` endpoint hourly. Ugly but standard.
- **Catch 2 — SQLite:** no persistent disk on serverless. The store would have to move to a free
  hosted DB (Turso — SQLite-compatible libSQL, generous free tier; or Neon Postgres).

## 2. Cloudflare Workers (free) — strongest pure-free fit
- Hono is Workers-native; **cron triggers are free at any frequency**; D1 is SQLite-compatible
  with a real free tier. The whole product fits the free plan with no workarounds.
- Cost: porting off `@hono/node-server` (small — Hono core is runtime-agnostic) and the MCP
  client + token vault must be Workers-compatible.

## 3. Long-running Node box — simplest mental model
- Fly.io (small VM, near-free), Railway (trial credit), Render free (sleeps — bad for a poller),
  an Oracle always-free VPS, or a home machine. One process, real SQLite file, node-cron inside
  the app. Matches the self-hosted posture in RESEARCH.md; not "free plan on Vercel" but the
  least engineering.

**Leaning:** keep the code runtime-agnostic (Hono everywhere, storage behind an interface) so
1–3 all stay open; decide when the poller is real.
