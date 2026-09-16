# trade-circle

A private portfolio feed for a circle of friends. Everyone connects their INDmoney account
(read-only, over INDmoney's MCP), and the group sees each other's moves as they happen —
"Priya opened NVDA", "Rahul trimmed AAPL to 12%" — as percentages of portfolio, never rupee
amounts. A group chat sits next to the feed, so nobody has to ask "how are you looking at the
market?" any more. Read-only by design: no order placement, ever.

One deployment is one group. Host it yourself for your friends on Cloudflare's free plan; every
group gets its own Worker and its own database, and nobody else holds your brokerage tokens.
Research and decisions: [docs/RESEARCH.md](docs/RESEARCH.md).

## Self-hosting

Fork this repo, create a Worker and a D1 database, add a handful of repository secrets, and every
push to `main` deploys via GitHub Actions. The full runbook, including the one-time secrets and how
to create the first admin, is in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Structure

- `apps/web` — React + TypeScript + Tailwind v4 + shadcn/ui (Vite). See
  [MONOREPO.md](MONOREPO.md) for adding shadcn components.
- `apps/server` — Hono API, MCP poller, diff engine, chat. Runs on Node (SQLite) and on
  Cloudflare Workers (D1) from the same code.
- `packages/ui` — shared shadcn/ui components.

## Dev

```bash
pnpm install
pnpm dev          # turbo: web on :5173 (proxies /api), server on :3001
pnpm --filter server seed
pnpm --filter server invite m1
```

`docs/` holds the research report, appendices, and the deployment runbook.

## License

[MIT](LICENSE)
