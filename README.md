# indmoney-watcher

Friend-group US-stock portfolio watcher over INDmoney's read-only MCP: see what bets your
friends are taking in an in-app feed instead of a WhatsApp thread. Read-only by design — no
order placement, ever. Research + decisions: [docs/RESEARCH.md](docs/RESEARCH.md).

## Structure

- `apps/web` — React + TypeScript + Tailwind v4 + shadcn/ui (Vite). See
  [MONOREPO.md](MONOREPO.md) for adding shadcn components.
- `apps/server` — Node + Hono API (feed endpoints; MCP poller lands here).
- `packages/ui` — shared shadcn/ui components.

## Dev

```bash
pnpm install
pnpm dev          # turbo: web on :5173 (proxies /api), server on :3001
```

`docs/` holds the research report and appendices; `docs/DEPLOYMENT.md` surveys hosting options
(undecided).
