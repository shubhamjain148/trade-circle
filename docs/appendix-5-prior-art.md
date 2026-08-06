# Appendix 5 — Prior Art Survey

Research date: **2026-08-06**. Research-only; no credentials used, no accounts touched.
Everything below was verified either from source (OpenAlgo cloned at commit `eb54e9d`, 2026-08-06,
version 2.0.1.8) or from a cited public page.

---

## 0. TL;DR orientation

The project splits cleanly into two halves that use **two different INDmoney surfaces**:

| Half | Surface | Prior art |
|---|---|---|
| **Read** friends' portfolios | INDmoney's *official* MCP server (`https://mcp.indmoney.com/mcp`), OAuth 2.1 + PKCE, **read-only, cannot trade** | Cloudflare MCP portals / multi-tenant MCP gateway patterns (§4) |
| **Write** the copied order | INDstocks Trading REST API (`https://api.indstocks.com`), bearer token | **OpenAlgo's `broker/indmoney` plugin** (§1) |

These are genuinely separate systems. INDmoney's MCP explicitly has "no write capability anywhere in
the system" ([indmoney.com/mcp](https://www.indmoney.com/mcp)), so approval-driven execution *must*
go through the INDstocks REST API — which is exactly the surface OpenAlgo already wraps.

⚠️ Read §6 (regulatory) before writing any code. SEBI's retail algo framework became fully
mandatory on **1 April 2026** and the self-built-algo sharing exemption stops at *immediate family*.
A friend-group copy-trader is, on a plain reading, outside it.

---

## 1. OpenAlgo — the named seed

- Repo: <https://github.com/marketcalls/openalgo>
- Docs: <https://docs.openalgo.in>
- IndMoney connector doc: <https://docs.openalgo.in/connect-brokers/brokers/indmoney>
- License: **AGPL-3.0** (`License.md` in repo root)
- Version at survey: **2.0.1.8**, last commit 2026-08-06 — **actively maintained, high velocity**

### 1.1 What it is

Not a library — a **self-hosted Flask + React 19 trading application**. Its own README is explicit
that it's "no longer just an API layer in front of your broker." It bundles four surfaces:

| Surface | Route |
|---|---|
| Unified broker REST API (`/api/v1/`) across 34 broker plugins | `restx_api/*.py` |
| Python strategy host (in-browser editor, IST scheduler, process isolation) | `/python` |
| "Flow" no-code node-graph strategy builder | `/flow` |
| Options tooling (chain, Greeks, max pain, GEX, payoff) | `/tools` |

Plus: Telegram bot, WhatsApp bot, sandbox/analyzer (paper) mode, latency monitoring, a local stdio
**MCP server**, and (on the `remotemcp` branch) a **remote MCP server with a full OAuth 2.1
authorization server**.

### 1.2 Architecture

Per-broker adapter directories under `broker/<name>/`, discovered by convention:

```
broker/indmoney/
  plugin.json                     # metadata: supported exchanges, broker_type, leverage flag
  api/baseurl.py                  # BASE_URL = https://api.indstocks.com
  api/auth_api.py                 # 24 lines — see below
  api/order_api.py                # 809 lines — orders, positions, holdings, smartorder
  api/data.py                     # 1122 lines — quotes, depth, history, option chain
  api/funds.py, api/margin_api.py
  mapping/transform_data.py       # OpenAlgo canonical order  <->  broker payload
  mapping/order_data.py           # broker responses -> canonical
  streaming/indmoney_adapter.py   # WebSocket market data adapter
  streaming/indmoney_order_adapter.py  # order-update stream
```

Streaming adapters are resolved by a **naming-convention factory**
(`websocket_proxy/broker_factory.py`, documented in `docs/design/52-broker-factory/README.md`):
import `broker.<x>.streaming.<x>_adapter`, resolve class `<X>WebSocketAdapter`, wrap in a connection
pool keyed by `(broker, user)`. Note the doc's own caveat: *"Plugin presence does not by itself prove
a working streaming adapter."*

The docs are unusually good — `docs/design/` has ~52 numbered design notes. Worth mining even if we
don't use the code.

### 1.3 What the INDmoney/INDstocks connector actually does

It is an **order-placement + portfolio bridge**, not just a data connector. Endpoints hit
(base `https://api.indstocks.com`):

| Function | Method + path |
|---|---|
| Place order | `POST /order` |
| Cancel order | `POST /order/cancel` |
| Modify order | `POST /order/modify` |
| Order book | `GET /order-book` |
| Trade book | `GET /trade-book?segment=EQUITY` and `?segment=DERIVATIVE` (two calls, merged) |
| Positions / holdings / funds / margin | in `order_api.py`, `funds.py`, `margin_api.py` |
| Streaming | WebSocket adapter for ticks + a separate order-update adapter |

Supported exchanges per `plugin.json`: `NSE, BSE, NFO, BFO, NSE_INDEX, BSE_INDEX`.
Plugin author: Deepanshu Goyal. `leverage_config: false`.

**Auth is trivial and that matters.** `broker/indmoney/api/auth_api.py` in full is essentially:

```python
def authenticate_broker(code):
    BROKER_API_SECRET = os.getenv("BROKER_API_SECRET")
    # For IndMoney, the access token is directly provided in BROKER_API_SECRET
    # No OAuth flow needed - just return the access token
    if BROKER_API_SECRET:
        return BROKER_API_SECRET, None
```

There is **no OAuth flow**. Per the docs page: you generate a token manually at
<https://www.indstocks.com/app/api-trading>, paste it as `BROKER_API_SECRET`, put any dummy value in
`BROKER_API_KEY`, and — critically — **the token expires in ~24 hours** and **a static IP must be
whitelisted at generation time**.

> **This is the single most important operational finding in this document.** Any friend who wants
> their account traded must manually mint a fresh INDstocks token roughly every day, from a
> whitelisted static IP. There is no refresh-token path in the connector. Design around a daily
> re-auth ritual, or the system is dead by day two.

Recent OpenAlgo releases mention "IndMoney broker hardening with API realignment to the current
IndStocks docs for positions, order status, trade book, and WebSocket URI" — i.e. the upstream API
has been moving and the connector has been chasing it. Treat endpoint shapes as unstable.

### 1.4 Does it solve multi-account fan-out? **No.**

This is the decisive negative finding.

- `docs/design/02-backend/README.md`: *"The backend is a **single-user application**, but production
  can run multiple Flask workers."*
- The `auth` table (`database/auth_db.py`) has `name` as a **unique** column with one `broker` and
  one `auth` token per row — an install is one person's broker session.
- Broker credentials come from **process environment variables** (`BROKER_API_KEY`,
  `BROKER_API_SECRET`, `REDIRECT_URL`), not per-user records.
- Grep across the repo for `multi.?account`, `copy.?trad`, `fan.?out`, `multi.?tenant` returns only
  unrelated hits (rate-limiter comments, adapter docstrings).

So: **one OpenAlgo instance = one INDmoney account.** Fan-out to N friends means N instances (N
containers, N ports, N env files, N daily token pastes) plus an orchestrator we write ourselves.
That is a real cost and should be weighed against writing a ~300-line INDstocks client directly.

The `/api/v1/basketorder` and `/api/v1/splitorder` endpoints fan out **across symbols within one
account**, not across accounts. Do not mistake them for what we need.

### 1.5 The one piece of OpenAlgo that is genuinely worth stealing

`place_smartorder_api()` in `broker/indmoney/api/order_api.py` (line 523). It takes a **target
position size** rather than an order, reads the current open position, and emits only the delta:

```python
with symbol_lock:                          # per-(symbol, exchange, product) lock
    position_size   = int(data.get("position_size", "0"))
    current_position = int(get_open_position(symbol, exchange, map_product_type(product), AUTH_TOKEN))
    if position_size == current_position:  # no-op, idempotent
        ...
    elif position_size > current_position:
        action, quantity = "BUY",  position_size - current_position
    elif position_size < current_position:
        action, quantity = "SELL", current_position - position_size
    ...
    _invalidate_position_cache(AUTH_TOKEN)
```

This is **exactly the right primitive for a portfolio-mirroring copier**, and it's a different (and
better) model than event-replay copiers. Properties worth copying wholesale:

1. **Convergent, not event-driven.** Missed a notification? Bot was down for an hour? The next sync
   still lands you on target. Event replay copiers accumulate permanent drift.
2. **Idempotent.** Re-running it is a no-op. Approve-twice in Telegram doesn't double the position.
3. **Per-symbol mutex** serialises concurrent syncs for the same instrument.
4. **Cache invalidation immediately after the fill** so the next delta computation isn't stale.

Note the flaw to fix if we lift it: `get_open_position` reads a **cached** position and the code
does not reconcile against *pending/open orders*. Two syncs in quick succession, or a resting limit
order, will double-count. Our version needs open orders netted into "current".

### 1.6 Verdict on OpenAlgo

| Use it as | Verdict |
|---|---|
| A runnable multi-account copy-trading platform | ❌ No. Single-user by design. |
| A production INDstocks REST client we import | ⚠️ Only as a whole app; the broker package is not published as a standalone library and pulls in Flask/SQLAlchemy/etc. |
| **A specification of the INDstocks API** (endpoints, payload shapes, quirks, retry/backoff, symbol mapping) | ✅ **Strongly yes.** Read `order_api.py`, `mapping/transform_data.py`, `mapping/order_data.py` (~1900 lines total) and you've skipped weeks of API archaeology. |
| A design reference (smartorder, Fernet token vault, OAuth 2.1 AS, broker factory, Telegram bot) | ✅ Yes. |
| A dependency in a closed-source product | ❌ **AGPL-3.0.** Network use triggers source disclosure. Fine for a friend-group project; a landmine if this ever becomes a product. |

---

## 2. India-focused open-source copy trading / trade copiers

Honest headline: **this space is thin, stale, and low-quality.** GitHub searches for
`zerodha copy trading`, `multi account trading india`, `kite multiple accounts order` returned
**zero** results. There is no credible open-source Indian multi-account copier.

| Project | What it is | State |
|---|---|---|
| [ssjha/AutocopyTrade](https://github.com/ssjha/AutocopyTrade) | Zerodha Kite trade replicator, master → multiple child accounts. Config-driven (`config.json` with master + child accounts), passwords/TOTP secrets encrypted via a bundled `encryptpwd.py`. Apache-2.0. | 🪦 **Effectively abandoned.** 6 stars, 3 forks, **9 commits total.** Uses stored password + TOTP secret (i.e. unofficial login automation), which is now flatly non-compliant with SEBI's API rules. Read it for the config shape, nothing else. |
| [CosmicTrader/TradeCopier-IIFL_ZERODHA](https://github.com/CosmicTrader/TradeCopier-IIFL_ZERODHA) | WebSocket-driven copier: IIFL Blaze API → IIFL + Zerodha, with quantity-change option. | 🪦 2 stars, last touched Aug 2025. Notable only because it uses an **order-update WebSocket** as the trigger rather than polling — the right architecture. |
| [jugaad-py/jugaad-trader](https://github.com/jugaad-py/jugaad-trader) | Unofficial Python client for Zerodha (scrapes the web login). 166★, updated Jun 2026. | ⚠️ **Do not use.** Unofficial-login scraping is precisely what SEBI's static-IP / vendor-API-key rule outlaws for order placement. Its NSE *data* utilities are still fine. |
| [zerodha/pykiteconnect](https://github.com/zerodha/pykiteconnect) | Official Kite Connect Python client. | ✅ Healthy — the reference for what a well-shaped Indian broker SDK looks like (order params, exception taxonomy, ticker). |
| [dhan-oss/DhanHQ-py](https://github.com/dhan-oss/DhanHQ-py) | Official Dhan Python client. | ✅ Healthy. |
| [anshuopinion/dhan-ts](https://github.com/anshuopinion/dhan-ts) | Fully-typed TS client for Dhan v2, 15+ modules + WS feeds. | ✅ Useful if we go TypeScript. |
| [Kalaiviswa/indstocks-api-docs](https://github.com/Kalaiviswa/indstocks-api-docs) | Unofficial **Markdown conversion of the INDstocks Trading API docs** (`api-docs.indstocks.com`). | 🆕 Jul 2026, 0★. Low trust, but a fast grep-able copy of the spec. Cross-check against OpenAlgo's connector. |
| [meudayhegde/indstocks-client](https://github.com/meudayhegde/indstocks-client) | "Full-featured, async-first Python library for algorithmic trading with INDstocks." | 🆕 Jul 2026, 0★, unproven. **Worth 30 minutes of code review** — if it's decent it removes our need to vendor OpenAlgo's connector. |
| [samuelvinay91/skopaqtrader](https://github.com/samuelvinay91/skopaqtrader) | Multi-agent LLM trading daemon with INDstocks broker integration. 11★, Aug 2026. | 🆕 Different problem (LLM strategy generation), but a **second independent INDstocks integration** to diff against OpenAlgo's. Useful for confirming endpoint shapes. |

**Commercial context (not reusable, just for calibration):** Tradetron and AlgoTest both offer
multi-client strategy deployment and both are listed as INDmoney API integration partners — meaning
"one strategy, N broker accounts" is a solved commercial problem in India. They solve it by being
registered algo providers partnered with brokers, which is the compliance path we don't have.

### What the space reuse-ably solves (and doesn't)

| Concern | State of the art in OSS |
|---|---|
| Order fan-out to N accounts | Naive `for account in accounts: place_order(...)`. Nobody handles partial success properly. |
| Quantity scaling by capital | Crude integer multiplier in config. **Nobody handles lot-size rounding for F&O**, which is the actual hard part in India. |
| Partial fills | ❌ Essentially unsolved in every OSS copier surveyed. |
| Idempotency / replay safety | ❌ Only OpenAlgo's smartorder gets this right, and only partially. |
| Drift reconciliation | ❌ Nobody. |

**Conclusion: we are not going to find a copier to fork. We will build it, borrowing the smartorder
pattern.**

---

## 3. Global prior art — transferable design lessons only

### 3.1 eToro CopyTrader — the regulated-platform model

Sources: [How it works](https://www.etoro.com/copytrader/how-it-works/) ·
[Copy Stop Loss](https://help.etoro.com/en-us/s/article/what-is-copy-stop-loss-US) ·
[CopyTrading risks](https://www.etoro.com/customer-service/copytrading-risks/)

Lessons:

1. **Copy the *portfolio percentage*, not the *order*.** eToro replicates the leader's *allocation
   percentages* across their whole equity — holdings, cash, and unrealised P&L. Allocate ₹1L to
   copy someone with ₹10L, and their ₹1L position becomes your ₹10k position. This is the
   convergent model again, and it's what regulated platforms converged on. It also means
   **you must be able to see the leader's cash, not just their holdings** — otherwise you can't
   compute percentages. Check whether INDmoney's MCP exposes liquid savings / unallocated cash
   (its capability list says it does: "net worth snapshots across all asset classes... liquid
   savings").
2. **Copy Stop Loss as a first-class follower control.** Each *copy relationship* carries its own
   stop (5–95% of allocated capital). Breach → the entire copy unwinds and cash returns. This is a
   per-relationship circuit breaker, independent of any per-trade stop. **We should have this.**
3. **Allocation is a fixed budget, not "mirror my account."** The follower caps their downside by
   construction.

### 3.2 ZuluTrade — behavioural guardrails

Sources: [ZuluGuard overview](https://www.fxempire.com/news/article/zuluguard-a-better-way-to-manage-risk-in-social-trading-1331205) ·
[accounts & risk](https://www.forex-central.net/ZuluTrade-accounts-and-risk-management.php)

1. **ZuluGuard auto-disables a leader who deviates from expected behaviour.** Not a loss stop — a
   *style* stop. If the friend who's been trading large-cap equity suddenly buys weekly OTM options,
   stop copying and ask. Cheap to implement: instrument-class and position-size envelopes per leader.
2. **Auto vs custom sizing modes** + a cap on max concurrent copied positions.
3. **"Margin Call-o-Meter"** — forward-looking risk estimate from the leader's historical behaviour
   and the follower's settings, shown *before* committing. The generalisable idea: **show the
   follower the worst case at approval time**, in the approval message itself.

### 3.3 MT4/MT5 trade copiers — the mature-but-crude tier

The healthiest OSS copiers anywhere are in MQL, e.g.
[vobornik/mt4-trade-copy](https://github.com/vobornik/mt4-trade-copy) (255★, updated Aug 2026),
[wait4signal/sharing-is-caring](https://github.com/wait4signal/sharing-is-caring) (MT5, 54★),
[tetratensor/MT4-MT5-Trade-Copier-Backend](https://github.com/tetratensor/MT4-MT5-Trade-Copier-Backend)
(Node/Express/Postgres/Socket.IO, 15★), [sibvic/trade_copier](https://github.com/sibvic/trade_copier).

Transferable lessons:

1. **Every copier's core loop is master-state diff → per-follower scaled order**, and they all
   maintain an explicit **master-ticket → follower-ticket map** so modifies and closes route
   correctly. We need the same: a persistent `(leader_position_id, follower_id) → follower_order_id`
   table. Without it, "leader closed half" is unhandleable.
2. **Slippage tolerance is a per-follower setting, and orders are dropped, not chased.** If the
   price has moved more than X since the leader's fill, the copier *skips* the trade and reports it.
   Chasing is how copiers destroy followers. **Adopt: max-slippage-vs-leader-price rejection, and
   report the skip to the group.**
3. **Latency is the product.** MT4 copiers went to shared memory / WebSocket bridges rather than
   polling. Ours has a human approval step in the loop, so we're already in the seconds-to-minutes
   regime — which means we should stop pretending we're a fast copier and instead **explicitly price
   in the delay**: show the leader's fill price vs current price in the approval message and let the
   human decide.
4. Architecture worth mimicking: `tetratensor`'s master/copier split with a socket transport and a
   real database, rather than a script holding state in memory.

### 3.4 Open-source crypto copy traders — a warning, not a source

GitHub's `copy-trading` / `copy-trade` topics are **overwhelmingly SEO spam**. Representative search
results: repos whose entire description is the phrase "Solana Copy Trading Bot" repeated 12 times;
near-identical Hyperliquid/dYdX/KuCoin/BTSE "bots" from single-purpose throwaway orgs; keyword-stuffed
descriptions mentioning "MEV sandwich arbitrage flashloan" alongside copy trading. Star counts in the
100–300 range are not a quality signal here.

The only transferable ideas from the legitimate end of that space (leader-wallet mirroring):
**per-leader allocation caps**, **an instrument allowlist** (don't blindly copy into an illiquid
instrument), and **a "don't copy positions smaller than X" floor** to avoid dust orders — which in
our context maps to *don't copy anything below one lot / one share*.

---

## 4. MCP multi-tenant gateway patterns

The problem statement: **one server, N users' OAuth sessions to the same upstream MCP server**
(`mcp.indmoney.com/mcp`). This is a slightly unusual shape — most "MCP gateway" projects solve
*one user → many MCP servers*, which is the transpose of our problem.

### 4.1 The pattern that actually matches

**Cloudflare MCP server portals** — [changelog: static OAuth client credentials for MCP server
portals](https://developers.cloudflare.com/changelog/post/2026-07-31-mcp-portal-manual-oauth/) ·
[securing MCP servers](https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/) ·
[enterprise MCP reference architecture](https://blog.cloudflare.com/enterprise-mcp/)

The exact shape we want, described in their own words: **credentials are stored per JWT subject
(the `sub` of the bearer token the client presents), so one deployed server serves N users without
leaking creds across users**; the server encrypts and stores under key `server-name:sub`. The portal
holds *one* registered OAuth client (client_id/secret, encrypted at rest) against the upstream, while
**each user still authenticates to the upstream with their own account**. Service-token support
exists for non-interactive callers
([changelog](https://developers.cloudflare.com/changelog/post/2026-06-26-mcp-portal-service-tokens/)).

**Take away the data model even if we don't use Cloudflare:**
`(upstream_server, user_subject) → encrypted_credential_blob`, one row per friend, encrypted at rest,
never keyed by anything the LLM can see.

**Also take the warning:** when your server proxies to a third-party OAuth provider you must
implement **your own consent dialog before forwarding users upstream**, or you have a *confused
deputy* vulnerability (attacker exploits cached upstream consent). This is a real, named bug class
for exactly the architecture we're proposing.

### 4.2 Gateways worth looking at

| Project | Stars | License | Relevance |
|---|---|---|---|
| [IBM/mcp-context-forge](https://github.com/IBM/mcp-context-forge) | 4269★ | Apache-2.0 | The heavyweight. Gateway + registry + proxy in front of MCP/A2A/REST, unified endpoint, guardrails, plugins. Actively developed (Aug 2026). Almost certainly overkill for 5 friends, but the **reference for the domain model**. |
| [docker/mcp-gateway](https://github.com/docker/mcp-gateway) | 1517★ | — | Docker CLI plugin; per-server containerisation. Good isolation story, weak multi-user-identity story. |
| [microsoft/mcp-gateway](https://github.com/microsoft/mcp-gateway) | 769★ | — | Reverse proxy + **session-aware stateful routing** and lifecycle management on Kubernetes. The session-affinity design is the relevant bit — MCP sessions are stateful and a naive round-robin proxy breaks them. |
| [agentic-community/mcp-gateway-registry](https://github.com/agentic-community/mcp-gateway-registry) | 849★ | — | OAuth auth + dynamic tool discovery, Keycloak/Entra integration. Closest thing to an off-the-shelf identity-aware gateway. |
| [lasso-security/mcp-gateway](https://github.com/lasso-security/mcp-gateway) | 384★ | — | Plugin-based orchestration, security-vendor authored. |
| [hyprmcp/mcp-gateway](https://github.com/hyprmcp/mcp-gateway) | 92★ | — | **MCP OAuth proxy with dynamic client registration (DCR)** + prompt analytics + MCP firewall. Small and focused — the most readable implementation of the OAuth-proxy piece. |
| [Kuadrant/mcp-gateway](https://github.com/Kuadrant/mcp-gateway) | 95★ | — | Envoy/Istio-based; authN/authZ/rate limiting via policy attachment. |
| [geelen/mcp-remote](https://github.com/geelen/mcp-remote) | 1539★ | — | Not a gateway — a **stdio↔remote-HTTP shim** that handles the OAuth dance for clients that only speak stdio. Actively maintained (Aug 2026). Likely useful in dev/testing to poke at `mcp.indmoney.com` from a local script. |
| [e2b-dev/awesome-mcp-gateways](https://github.com/e2b-dev/awesome-mcp-gateways) | 161★ | — | The list to re-check before committing. |
| [coleam00/remote-mcp-server-with-auth](https://github.com/coleam00/remote-mcp-server-with-auth) | 299★ | — | Template: remote MCP server with GitHub OAuth. Good starting skeleton if *we* also expose an MCP surface. |

Also flagged in secondary sources but not verified from source: **Bifrost** (Maxim AI) advertising
per-user OAuth flows + automatic token refresh behind one gateway endpoint, and **MCP Mesh**
advertising an encrypted token vault with org-scoped multi-tenancy
([overview](https://www.getmaxim.ai/articles/mcp-authentication-explained-oauth-api-keys-and-token-management/),
[gateway roundup](https://www.arcade.dev/blog/best-mcp-gateways-enterprise/)). Treat as leads.

Background reading on the auth model:
[MCP authorization tutorial](https://modelcontextprotocol.io/docs/tutorials/security/authorization) ·
[multi-user authorization discussion #234](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/234) ·
[OAuth for MCP enterprise patterns](https://blog.gitguardian.com/oauth-for-mcp-emerging-enterprise-patterns-for-agent-authorization/) ·
[Red Hat: advanced authN/authZ for MCP Gateway](https://developers.redhat.com/articles/2025/12/12/advanced-authentication-authorization-mcp-gateway).

### 4.3 Token vault pattern — steal OpenAlgo's, it's small and correct

`database/auth_db.py` is a compact, readable reference implementation:

- **Fernet** symmetric encryption for broker auth tokens at rest.
- Key derived by **PBKDF2-HMAC-SHA256, 100k iterations**, from an `API_KEY_PEPPER` env var (**fails
  fast at import** if unset or < 32 chars) plus a **per-install random `FERNET_SALT`**
  auto-provisioned on first boot, with migration of existing ciphertext. A legacy hardcoded salt
  remains as a fallback but emits a one-time stderr warning — a nice pattern for shipping a security
  fix without breaking existing installs.
- **Argon2** (not bcrypt) for passwords; API keys stored **twice** — `api_key_hash` for verification,
  `api_key_encrypted` for retrieval.
- TTL cache in front of the DB, with TTL derived from the daily session expiry time so cache and
  token lifetime can't diverge.
- `ActiveSession` and `LoginAttempt` tables give per-device session listing and revocation.

And `database/oauth_db.py` (remote MCP) is a **full OAuth 2.1 authorization server**:
`OAuthClient` (dynamic client registration with an `approved` gate — clients must be admin-approved),
`OAuthRefreshToken` with **rotation + reuse detection via `family_id`/`parent_id` chains** and
`revoke_family()`, and `OAuthSigningKey` with RS256 + JWKS + rotation. Install guide:
`install/Remote-MCP-readme.md`; architecture and threat model: `docs/prd/remote-mcp.md` on the
`remotemcp` branch.

If we need to *be* an OAuth server (e.g. our own MCP surface), read this before writing anything.
If we only need to *hold* upstream tokens, the Fernet + PBKDF2 + pepper + per-install-salt recipe is
~40 lines and directly liftable (mind the AGPL if this ever ships commercially — reimplement from the
pattern, don't paste).

---

## 5. Reusable building blocks — shopping list

### MCP

| Thing | One-liner |
|---|---|
| [modelcontextprotocol/python-sdk](https://github.com/modelcontextprotocol/python-sdk) | 23.9k★, MIT, official. Client *and* server; the client half is what we need to call `mcp.indmoney.com`. Use this. |
| [geelen/mcp-remote](https://github.com/geelen/mcp-remote) | stdio↔remote-HTTP shim that runs the OAuth dance — fastest way to manually explore INDmoney's MCP before writing code. |
| [IBM/mcp-context-forge](https://github.com/IBM/mcp-context-forge) | Apache-2.0 gateway if we ever outgrow a hand-rolled token table. |
| OpenAlgo `install/Remote-MCP-readme.md` + `database/oauth_db.py` | Worked example of OAuth 2.1 + PKCE + DCR + refresh rotation for MCP. |

### Telegram (group notification + approval)

| Thing | One-liner |
|---|---|
| [python-telegram-bot](https://github.com/python-telegram-bot/python-telegram-bot) | 29.4k★, **GPL-3.0** (note!), the default if we're in Python. Inline keyboards → approval buttons. This is what OpenAlgo pins (`python-telegram-bot==22.8`). |
| [aiogram](https://github.com/aiogram/aiogram) | 5.8k★, **MIT**, fully async. Better license, cleaner FSM for multi-step approval flows. **Preferred over PTB if license matters.** |
| [grammY](https://github.com/grammyjs/grammY) | 3.7k★, MIT, TypeScript. The pick if the backend is Node/TS. |
| OpenAlgo `docs/design/43-telegram-bot/README.md` | Worth reading: a real bot design split into config/lifecycle/alert-delivery/EventBus-subscriber layers, with **encrypted bot token**, linked-user table, retry queue, and an `is_active` gate that automatic alerts respect but explicit human sends deliberately bypass. That last distinction is a genuinely good idea. |

### Scheduling / diffing / plumbing

| Thing | One-liner |
|---|---|
| **APScheduler** (`APScheduler==3.11.2` in OpenAlgo) | In-process cron/interval jobs with a **DB-backed job store** so schedules survive restarts. Right size for "poll each friend's portfolio every N minutes during market hours". |
| **`pandas-market-calendars` / NSE holiday lists** ([jugaad-py/master-data](https://github.com/jugaad-py/master-data), stale 2022; OpenAlgo has `database/market_calendar_db.py` + `/api/v1/market_holidays`) | Don't poll on holidays; don't diff at 3am and call it a signal. |
| **`httpx[http2]`** | What OpenAlgo standardised on, with a shared client + `request_with_retry` wrapper. Async, connection pooling, HTTP/2. |
| **`deepdiff`** or a hand-rolled dict diff | Portfolio snapshot → change set. Honestly, for `{symbol: qty}` maps a 20-line hand-rolled diff beats a library and is easier to unit-test. **Model the diff as target-state, not events** (§1.5). |
| **`cryptography`** (Fernet) + Argon2 (`argon2-cffi`) | The token-vault primitives from §4.3. |
| **SQLite + SQLAlchemy** | Five friends. Do not reach for Postgres. |

### INDstocks specifics

| Thing | One-liner |
|---|---|
| OpenAlgo `broker/indmoney/` (~4900 LOC) | The de-facto INDstocks API spec. Read `order_api.py` + `mapping/transform_data.py`. AGPL — read, don't paste. |
| [Kalaiviswa/indstocks-api-docs](https://github.com/Kalaiviswa/indstocks-api-docs) | Grep-able Markdown mirror of the official docs. Unverified. |
| [meudayhegde/indstocks-client](https://github.com/meudayhegde/indstocks-client) | Async-first standalone Python INDstocks client. Unproven; 30-min review could save us the whole write side. |
| <https://www.indstocks.com/app/api-trading> | Where the 24h bearer token is minted (static IP whitelist required). |

---

## 6. ⚠️ Regulatory reality check (SEBI)

This is prior art of a different kind and it materially constrains the design.

- SEBI's algo-trading framework for retail (circular **4 Feb 2025**) became **fully mandatory
  1 April 2026** — i.e. it is **in force today**.
  ([Fyers](https://fyers.in/blog/sebi-algo-trading-rules-and-regulations-in-india/),
  [Angel One](https://www.angelone.in/knowledge-center/online-share-trading/sebi-algo-trading-rules),
  [FinSec Law tracker](https://www.finseclaw.com/article/finsec-tracker-on-sebi-issues-guidelines-on-retail-participation-in-algorithmic-trading))
- **API access requires a vendor/client-specific API key and a broker-whitelisted static IP.** This
  is why the INDstocks token flow demands a static IP — it's not a quirk, it's the regulation.
- **Every algo order carries an Algo ID.** Sub-10-orders-per-second strategies get a "Generic Algo
  ID" rather than individual exchange approval — they are *not* exempt from being classified as algos.
- **The self-built-algo exemption covers the author and *immediate family only*** — spouse,
  dependent children, dependent parents. Reported explicitly:
  *"Sharing a self-built strategy with anyone outside this definition is not permitted."*
  NSE permits sharing a static IP among family members with prior broker permission.
  ([sahi.com summary](https://www.sahi.com/blogs/sebi-algo-trading-rules-2026-what-every-retail-trader-must-know-before-april))
- Algo providers who serve non-family users must **empanel with a registered broker**; they cannot
  connect directly to exchanges. This is the path Tradetron/AlgoTest took.
- Separately and independently: systematically telling friends what to buy, and executing it,
  edges toward **unregistered investment advice** under the SEBI (Investment Advisers) Regulations.

**Implication for the design, stated plainly:** a *"friend group"* copy-trader that places orders in
other people's accounts via broker APIs is, on the face of it, outside the family-only exemption, and
each friend's static-IP-bound API key is issued to *them*, not to us. The architectures that stay
clearly inside the lines are:

1. **Notify-only.** We watch and post to the group; each friend places their own order manually.
   Zero execution risk, and the MCP read side is genuinely read-only anyway.
2. **Each friend runs their own instance.** The backend is software they self-host against their own
   API key and their own IP; we ship the code, not the service. (This is precisely why OpenAlgo is
   single-user — it is not an accident.)
3. **Family-only execution**, notify-only for everyone else.

This should be settled before architecture, not after. **Recommend: get an opinion from someone
who actually knows SEBI's retail algo circular before building the write path.**

---

## 7. What we can reuse vs must build

| Capability | Reuse | Source | Must build |
|---|---|---|---|
| Read friends' portfolios | ✅ | **INDmoney official MCP** (`https://mcp.indmoney.com/mcp`) — OAuth 2.1 + PKCE, 14 tools, net worth + holdings + market data + watchlists/SIPs, per-user rate limits | — |
| MCP client | ✅ | `modelcontextprotocol/python-sdk` (MIT) | — |
| One server holding N users' upstream MCP sessions | 🟡 pattern only | Cloudflare portals' `(server, jwt_sub) → encrypted creds` model; hyprmcp/mcp-gateway as readable code | The actual store + refresh loop (small) |
| Token vault (encrypt at rest, per-user isolation) | 🟡 pattern only | OpenAlgo `database/auth_db.py` — Fernet + PBKDF2(100k) + mandatory pepper + per-install salt; Argon2 for passwords | ~40 LOC reimplementation (AGPL — don't paste) |
| Consent screen before proxying users upstream | ❌ | (Cloudflare docs name the confused-deputy risk) | **Must build.** Non-optional. |
| INDstocks order placement API knowledge | ✅ | OpenAlgo `broker/indmoney/api/order_api.py` + `mapping/*` — endpoints `/order`, `/order/cancel`, `/order/modify`, `/order-book`, `/trade-book` | — |
| INDstocks client code | 🟡 | `meudayhegde/indstocks-client` (unproven) or vendor OpenAlgo's connector (AGPL) | Likely a thin client of our own |
| Daily token re-auth (24h expiry, static IP) | ❌ | Nobody solves this | **Must build** — a re-auth nudge ritual in the Telegram bot. Biggest ops risk in the project. |
| Position-delta → order ("smart order") | ✅ **design** | OpenAlgo `place_smartorder_api` — target-state, idempotent, per-symbol lock | Our version must also net **open/pending orders**, which OpenAlgo's doesn't |
| Multi-account order fan-out | ❌ | **Nothing exists.** OpenAlgo is single-user; Indian OSS copiers are abandoned toys | **Must build.** Per-follower isolation, partial-failure handling, per-account result reporting |
| Proportional sizing by capital | 🟡 concept | eToro's "% of leader's total equity, scaled to your allocation" | **Must build**, incl. **lot-size rounding for F&O** and a min-order floor — nobody OSS does this |
| Leader position ↔ follower order mapping table | 🟡 concept | Universal in MT4/MT5 copiers | **Must build.** Without it, partial closes and modifies are unhandleable |
| Partial fill handling | ❌ | Unsolved everywhere surveyed | **Must build.** The convergent/target-state model makes this tractable: next sync fixes it |
| Slippage guard | 🟡 concept | MT4 copiers: per-follower max slippage, **skip rather than chase** | **Must build** — plus show leader-fill-price vs now in the approval message |
| Per-follower risk caps | 🟡 concept | eToro Copy Stop Loss (5–95% of allocation); ZuluGuard style-deviation auto-disable; max concurrent positions | **Must build** |
| Telegram group notify + inline approval | ✅ | `aiogram` (MIT, preferred) / `python-telegram-bot` (GPL-3.0) / `grammY` (TS) | Approval state machine, timeouts, per-follower opt-in |
| Bot architecture reference | ✅ | OpenAlgo `docs/design/43-telegram-bot/` — encrypted token, linked users, retry queue, active-gate semantics | — |
| Scheduling / market calendar | ✅ | APScheduler + DB job store; OpenAlgo `market_calendar_db.py` for NSE holidays | — |
| Paper-trading / dry-run mode | ✅ **design** | OpenAlgo "Analyzer Mode" + `sandbox/` — the same order path with execution stubbed | Build ours the same way: one flag, same code path |
| Compliance posture | ❌ | — | **Must decide first** (§6) |

### Recommendation in one line

**Don't adopt OpenAlgo; read it.** Use INDmoney's official MCP for the read half, mine
`broker/indmoney/` as the INDstocks spec and `place_smartorder_api` as the copier's core algorithm,
lift the Fernet/PBKDF2 token-vault recipe and Cloudflare's per-subject credential model for
multi-user token storage, and build the fan-out, sizing, and risk layers ourselves — because nothing
open-source solves them. Settle §6 before writing the write path.

---

## Staleness / trust notes

| Item | Note |
|---|---|
| OpenAlgo | ✅ Very active (commits same-day as survey, v2.0.1.8). AGPL-3.0. Docs excellent. |
| OpenAlgo `remotemcp` branch | ⚠️ Opt-in, **not on main**. Treat as beta. |
| OpenAlgo INDmoney connector | ⚠️ Endpoints have been "realigned to current IndStocks docs" in recent releases — upstream API is moving. Verify against live docs. |
| `ssjha/AutocopyTrade` | 🪦 Abandoned (9 commits, 6★) **and** non-compliant (stored passwords + TOTP secrets). Reference only. |
| `jugaad-trader` | ⚠️ Maintained but unofficial-login-based; unsuitable for order placement under current SEBI rules. |
| `CosmicTrader/TradeCopier-IIFL_ZERODHA` | 🪦 2★, Aug 2025. Architecture note only. |
| `meudayhegde/indstocks-client`, `Kalaiviswa/indstocks-api-docs` | 🆕 New, 0★, unverified. Review before trusting. |
| GitHub `copy-trading` topic | 🚮 Dominated by keyword-spam repos. Star counts are not a quality signal there. |
| Bifrost / MCP Mesh claims | ⚠️ From vendor/roundup articles, not verified from source. |
| SEBI details | ⚠️ Sourced from broker/industry blogs, not the circular itself. **Read the primary SEBI circular (4 Feb 2025) before relying on any of it.** |
