# Deployment

**DECIDED: Cloudflare Workers + D1, free plan.** The survey that led here is at the bottom.

Node stays. `apps/server/src/index.ts` is unchanged and `pnpm --filter server dev` still runs the
whole app against a local SQLite file. Workers is a *second* runtime over the same Hono app, not a
replacement — the only things that differ are storage, config plumbing, and how the poller is woken.

---

## What runs where

| Piece | Node (`src/index.ts`) | Workers (`src/worker.ts`) |
| --- | --- | --- |
| HTTP | `@hono/node-server` | `export default { fetch }` |
| Storage | `SqliteStorage` (`node:sqlite`, `./data/watcher.db`) | `D1Storage` over the `DB` binding |
| Schema | `SCHEMA` in `storage/sqlite.ts`, applied in `init()` | `migrations/0001_init.sql`, applied by wrangler |
| Frontend | Vite dev server on `:5173` | Workers Assets serving `apps/web/dist` |
| Poller | `createScheduler` — a self-rescheduling `setTimeout` | cron triggers + `scheduled()` |
| Config | `loadConfig(process.env)` | built in `wire()` from Workers vars/secrets |
| Seed | `pnpm --filter server seed` | `POST /api/dev-seed` (local only, `DEV_SEED=1`) |

Everything else — `api.ts`, `chat.ts`, `admin.ts`, `mcp/*`, `diff/*`, `poller/tick.ts` — is shared,
unmodified, and runs identically on both.

### Layout

```
apps/server/
  wrangler.jsonc              worker config: D1, assets, crons, nodejs_compat
  migrations/0001_init.sql    D1 schema (mirrors sqlite.ts's SCHEMA)
  src/worker.ts               fetch + scheduled entry point
  src/storage/d1.ts           Storage over the D1 binding
  src/dev-seed.ts             seed + invite minting, reachable only in local dev
```

`wrangler.jsonc` lives in `apps/server` rather than the repo root so that `main`, `migrations_dir`
and `wrangler d1 …` all resolve without `--config` gymnastics. The one path that reaches outside is
`assets.directory: "../web/dist"`.

---

## Deploy runbook

Run everything from `apps/server`.

```bash
cd apps/server
```

**1. Log in.** One browser round trip; picks the account the Worker lands in.

```bash
pnpm exec wrangler login
pnpm exec wrangler whoami
```

**2. Create the database.**

```bash
pnpm exec wrangler d1 create indmoney-watcher
```

Copy the printed `database_id` into `wrangler.jsonc` — it replaces
`"REPLACE_WITH_D1_DATABASE_ID"`. Commit that; it is an identifier, not a secret.

**3. Apply the schema.**

```bash
pnpm cf:migrate          # wrangler d1 migrations apply indmoney-watcher --remote
```

**4. Set the vault key.** This is the only real secret. It keys AES-256-GCM over every access and
refresh token in the database; lose it and every friend has to reconnect, leak it and a database
dump becomes readable.

```bash
openssl rand -base64 48        # generate; paste at the prompt, do not pass it as an argument
pnpm exec wrangler secret put APP_SECRET
```

**5. First deploy** — needed before you know the URL.

```bash
pnpm cf:deploy           # pnpm --filter web build && wrangler deploy
```

Wrangler prints `https://indmoney-watcher.<your-subdomain>.workers.dev`.

**6. Pin `APP_URL` to that URL and redeploy.** `APP_URL` is what the OAuth redirect URI is built
from (`{APP_URL}/api/connect/indmoney/callback`) and where the settings page redirects back to. If
it is wrong, connect fails at INDmoney's end with a redirect-URI mismatch.

Add it to `wrangler.jsonc`:

```jsonc
"vars": {
  "MCP_CLIENT_NAME": "indmoney-watcher",
  "APP_URL": "https://indmoney-watcher.<your-subdomain>.workers.dev"
}
```

```bash
pnpm cf:deploy
```

**7. Create yourself, then everyone else.** There is no CLI on Workers, so the first admin has to
be written straight into D1:

```bash
pnpm exec wrangler d1 execute indmoney-watcher --remote --command \
  "INSERT INTO members (id, name, visibility, role, created_at) \
   VALUES ('m1','<your name>','named','admin','$(date -u +%Y-%m-%dT%H:%M:%S.000Z)')"
```

Then mint yourself a join link (also SQL — the link is `{APP_URL}/#/join?token=<token>` and only its
SHA-256 is stored, so this one time you have to produce both halves yourself):

```bash
node -e 'const t=require("crypto").randomBytes(32).toString("base64url");
const h=require("crypto").createHash("sha256").update(t).digest("base64url");
console.log("token:",t);console.log("hash: ",h)'

pnpm exec wrangler d1 execute indmoney-watcher --remote --command \
  "INSERT INTO invite_tokens (token_hash, member_id, created_at) VALUES ('<hash>','m1','$(date -u +%Y-%m-%dT%H:%M:%S.000Z)')"
```

Open `{APP_URL}/#/join?token=<token>`. From then on the admin UI (`/api/admin/*`) adds members and
mints links, and you never touch SQL again.

**8. Each friend connects.** Send each of them their join link. They sign in, go to Settings, hit
*Connect INDmoney*, and consent on INDmoney's own screen. **Everyone who was connected before this
deploy has to reconnect** — see "What changed" below.

**9. Confirm the cron.** `wrangler deploy` prints the three schedules. Watch one fire:

```bash
pnpm exec wrangler tail
```

Each tick logs one structured line: `{"msg":"poll tick","cron":…,"polled":N,"events":N,…}`, or
`{"msg":"poll skipped, outside market window",…}`.

### Rollback

```bash
pnpm exec wrangler versions list
pnpm exec wrangler rollback           # or rollback <VERSION_ID>
```

Rollback does not touch D1. A schema change needs its own forward migration.

---

## Local development

Two loops, both real.

**Node** — unchanged, the fast one:

```bash
pnpm dev                                  # web on :5173, server on :3001
pnpm --filter server seed
pnpm --filter server invite m1
```

**Workers** — miniflare with a local D1 file under `.wrangler/state`:

```bash
cd apps/server
cp .dev.vars.example .dev.vars            # APP_SECRET, APP_URL, DEV_SEED=1
pnpm --filter web build                   # assets are served from apps/web/dist
pnpm cf:migrate:local
pnpm cf:dev                               # wrangler dev --test-scheduled, :8787

curl -X POST localhost:8787/api/dev-seed  # members, demo history, one invite link each
curl "localhost:8787/__scheduled?cron=30+13-20+*+*+1-5"   # fire the cron handler by hand
```

`POST /api/dev-seed` exists only when `DEV_SEED=1`; it 404s otherwise, and `DEV_SEED` is never set
in `wrangler.jsonc`. It returns one plaintext invite token per member — the Workers stand-in for
`pnpm --filter server invite`.

### Pointing at a fake INDmoney

`MCP_BASE_URL` is deliberately **not** in `wrangler.jsonc`'s `vars`. A key present in `vars` wins
over the same key in `.dev.vars`, so declaring it there would make every local connect attempt reach
the real INDmoney authorization server and register a throwaway DCR client with it. `src/worker.ts`
defaults it to `https://mcp.indmoney.com/mcp`, and `.dev.vars` can override it — for instance at the
fake MCP server in `src/test/fake-mcp-server.ts`, which is what the local verification below used.

---

## What changed, and what it costs you

### The token vault moved from scrypt to PBKDF2 (v1 → v2)

`src/auth/vault.ts` derived its AES-256-GCM key with `scryptSync` from `node:crypto`. WebCrypto has
no scrypt, and Workers' `node:crypto` cannot be relied on for it, so the KDF is now
**PBKDF2-HMAC-SHA-256 at 600,000 iterations** via `crypto.subtle`, which behaves identically in
Node 25 and in workerd. The cipher (AES-256-GCM), the envelope (`<version>.<iv>.<tag>.<ciphertext>`,
base64url) and `hashToken`'s output are all unchanged; only the version prefix moved to `v2`.

**Consequence: v1 ciphertext cannot be read.** Decrypting one throws
`vault: v1 (scrypt) ciphertext cannot be read by this build — reconnect the INDmoney account to
re-issue tokens`, rather than failing as a generic auth-tag error. The only v1 data that ever
existed was one grant on one dev machine, and the redirect URI changes on deploy anyway, so a
reconnect was required regardless. Nobody needs to do anything except click *Connect INDmoney*.

`hashToken` is the one holdout on `node:crypto`: `api.ts` and `auth/session.ts` call it inline, and
WebCrypto has no synchronous digest. Its output is byte-identical to v1, so existing invite and
session rows keep working.

### `nodejs_compat` is required

Not a nicety. `src/chat.ts` (`randomUUID`), `src/diff/index.ts`, `src/mcp/normalize.ts`,
`src/poller/source.ts`, `src/poller/tick.ts` and `vault.ts`'s `hashToken` all import `node:crypto`
synchronously. Workers supports the full `node:crypto` API under this flag.

### CPU: the one number to watch

Measured inside workerd (Apple silicon; Cloudflare's hardware will be in the same order):

| Operation | CPU |
| --- | --- |
| PBKDF2-SHA-256, 600k iterations | **~39 ms** |
| PBKDF2-SHA-256, 100k iterations | ~6 ms |
| AES-GCM encrypt/decrypt once the key exists | <1 ms |
| Typical API request (feed, chat, accounts) | 6–11 ms wall, well under the CPU limit |

Free-plan limits are **10 ms CPU per HTTP request** and **10 ms per cron trigger**; paid is 5 min
and 30 s. The KDF is derived **once per isolate** and cached (`keyCache` in `vault.ts`), so only the
first request in a cold isolate that actually touches the vault pays it — connect, callback, token
refresh, or a poll of a connected account. Cloudflare documents "built-in flexibility to allow for
cases where your Worker infrequently runs over the configured limit", which is exactly this shape,
but it is not a guarantee.

If `wrangler tail` shows `exceeded CPU time limit` on connect or on a cron tick, set:

```bash
pnpm exec wrangler secret put VAULT_KDF_ITERATIONS   # e.g. 100000
```

That is a deliberate, documented trade. `APP_SECRET` is 48 bytes of `openssl rand` output, not a
human password, so PBKDF2's work factor is defence in depth rather than the primary control — the
secret's own entropy is. 600k is the default because it is OWASP's floor for the case where the
secret *is* weak.

Everything else about the poll tick is cheap: the staggered sleeps in `runPollTick` are wall time,
not CPU, and the cron wall-clock ceiling is 15 minutes against a stagger of at most a few tens of
seconds.

### Cron schedule

Three triggers, in UTC, mirroring `runMinutesUtc()` in `poller/scheduler.ts` exactly:

| Cron | Slots | IST |
| --- | --- | --- |
| `0 13 * * 1-5` | pre-open | 18:30 |
| `30 13-20 * * 1-5` | hourly through the US session | 19:00 – 02:00 |
| `15 21 * * 1-5` | post-close | 02:45 |

`scheduled()` re-checks the window in code (`isScheduledSlot`, ±5 minutes, weekdays only) because
cron is coarse and a trigger list is easy to edit without noticing the schedule it was meant to
match. `src/worker.test.ts` pins the two representations against each other. Free plans allow five
cron triggers per account; this uses three.

### D1 semantics preserved, with two notes

`d1.ts` mirrors `sqlite.ts` statement for statement. Idempotency (`INSERT OR IGNORE` on the
content-hash primary key), single-use invites and OAuth states, and the inclusive `since` bounds the
chat cursor depends on all behave identically. Two differences worth knowing:

- **Transactions are `batch()`.** There is no `exec("BEGIN")`. `replaceCurrentPositions`,
  `insertFeedEvents` and the OAuth-state sweep each run as one batch, which D1 executes
  sequentially inside a single implicit transaction and rolls back whole on any failure.
- **`consumeInvite` has a one-round-trip race.** SQLite could hold the read and the stamp in one
  transaction; D1 has no interactive transaction, so the read and the `UPDATE … WHERE used_at IS
  NULL` are separate. Two redemptions of the same link inside one round trip could both get a
  session — for the member the link already named. The stamp still lands exactly once.

`src/storage/d1.test.ts` runs the real `d1.ts` SQL against `migrations/0001_init.sql` through a shim
that puts the D1 client surface on `node:sqlite`, including its refusal to bind `undefined` or
booleans. It reads the migration file rather than re-declaring the schema, so drift between the two
schemas breaks the test.

---

## Verification performed (no deploy)

Everything below ran locally against `wrangler dev` with miniflare's local D1.

- **Schema.** `wrangler d1 migrations apply --local` — 22 statements, clean.
- **Bundle.** `wrangler deploy --dry-run` — 813 KiB / 172 KiB gzipped, against a 3 MB free-plan
  ceiling. No unresolved imports.
- **Static assets.** `/` and a deep link both return `index.html`; `/api/*` reaches Hono;
  `/api/nope` 404s from the router rather than falling back to the SPA.
- **Seed → join → feed → chat.** `POST /api/dev-seed` wrote 3 members, 7 events, 3 suppressed
  (corporate-action suppression working through D1). Invite redeemed once (200) and rejected the
  second time (410). `/api/me`, `/api/feed`, `/api/feed?accountId=`, `/api/accounts`, `/api/chat`
  POST + GET + cursor poll (0 fresh items on a repeat) and a 401 without the cookie: all correct.
- **Admin routes over D1.** `/api/admin/members` returned the roster with invite status, exercising
  `listInvites`.
- **Poller.** `POST /api/poll` and `GET /__scheduled?cron=…` both ran a full tick and logged one
  structured line each.
- **Vault on workerd.** The real `Vault` class, loaded into a probe Worker: v2 envelope, round-trip,
  JSON round-trip, wrong-secret rejection, the v1 reconnect message, `hashToken` and `randomToken`.
- **Full OAuth + MCP loop on Workers.** Against the repo's own `fake-mcp-server.ts`: discovery →
  DCR → PKCE → authorize → callback → token exchange → vault → D1 `oauth_connections` → tool
  catalog capture → an MCP `tools/list` and tool calls through `withMcpClient` → diff → 5 feed
  events in D1. **`@modelcontextprotocol/client` 2.0.0 is Workers-compatible with no changes** —
  it is `fetch`-based throughout, and its streamable-HTTP transport works under workerd.
- **Node runtime unbroken.** `pnpm --filter server typecheck` clean; `pnpm --filter server test`
  104/104 passing.

The one thing that genuinely cannot be tested before deploying is INDmoney's own authorization
server: the redirect URI it accepts is registered at DCR time from `APP_URL`, so leg two only proves
itself against the deployed URL.

---

## Appendix: the options that were surveyed

We built first and deployed later. The constraints were a Vite static frontend, a Hono API, an
hourly poll during US market hours, and (phase 1) a SQLite file.

**1. Vercel Hobby.** Frontend trivially free; Hono has a first-class adapter. Two catches: Hobby
cron runs *once per day*, so the hourly poll would need an external scheduler (GitHub Actions,
cron-job.org) hitting `/api/poll`; and serverless has no disk, so storage would move to Turso or
Neon. Two workarounds for one deploy.

**2. Cloudflare Workers — chosen.** Hono is Workers-native, cron triggers are free at any frequency,
and D1 is SQLite-compatible with a real free tier. The whole product fits the free plan with no
workarounds. The cost was porting the KDF and writing a second `Storage` implementation, which is
what the interface was designed for.

**3. A long-running Node box.** Fly.io, Railway, an Oracle always-free VPS, or a home machine. One
process, a real SQLite file, the existing scheduler. The least engineering and the closest match to
the self-hosted posture in RESEARCH.md — but it is a box someone has to own. Still viable: nothing
in this port removes it, and `pnpm --filter server start` is exactly that deployment.
