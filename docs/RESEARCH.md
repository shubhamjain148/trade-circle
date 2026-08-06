# INDmoney Friend-Group Portfolio Watcher — Research Synthesis

**Date:** 2026-08-06 · **Status:** research only, nothing built, no accounts touched.

**Scope decision (made during this research):** this project is **read-only watch + notify, only**.
We watch each friend's **US stock portfolio** on INDmoney and surface "X just bought Y" into the
group — replacing the WhatsApp chatter about what bets everyone is taking. There is **no write
access, no order placement, no copy-trading execution leg** — ever, in this design. The execution
research (appendix 3) and the legal analysis of execution (appendix 4) are kept as the documented
reasons *why* we don't do writes.

---

## 1. TL;DR — is it possible?

**Yes, cleanly.** Every load-bearing assumption checked out:

| Question | Verdict | Detail |
|---|---|---|
| Can our own backend (not Claude) speak MCP to INDmoney? | ✅ Yes | MCP is plain JSON-RPC over streamable-http; a dozen third-party OSS clients already drive the live INDmoney server. No AI model involved unless you wire one in. |
| Can a server do the OAuth for each friend? | ✅ Yes, one browser login each | OAuth 2.1 + PKCE with **open, unauthenticated dynamic client registration** — no partner deal needed. No `client_credentials`, so each friend logs in once via browser (mobile + OTP + MPIN + consent screen). |
| Will friends have to re-login constantly? | ✅ Probably not | `refresh_token` is a supported grant, and third-party client code documents silent refresh working in production. The one open question is the refresh token's own hard expiry — resolvable with a one-hour probe (§6). |
| Is it truly read-only? | ✅ Yes, by construction | Only two scopes exist: `portfolio:read` and `market:read`. No writable scope exists anywhere in the MCP. Worst case of a server compromise is a **confidentiality** breach, never a rogue trade. |
| Does it cover US stocks? | ✅ Yes | Holdings span 16+ asset classes including US equities (INDmoney's flagship); market-data tools cover US tickers (up to 10 per call). Fractional shares are the norm on INDmoney US — the diff engine must handle fractional quantities. |
| Is a notify-only friend group legally safe? | ✅ Comfortably | SEBI's advice-registration hook requires **fees + holding out to the public**; a free, closed group sharing *confirmed* holdings changes meets neither. All enforcement cases found involved money + a public audience. The sharp edges (algo framework, credential custody) attach only to order placement — which we've descoped. |

The one honest asterisk: INDmoney's ToS say the platform is for "personal use only," and the MCP's
stated purpose ("answer your questions in your Claude session") is narrower than a standing watcher.
Each friend authorizing their *own* OAuth session, revocable any time, with explicit in-group
consent, is the defensible posture — but INDmoney could in principle object or throttle. See §5.

## 2. What the MCP gives us (the raw material)

15 read-only tools (the official page under-reports 14) in three groups:

- **Portfolio** — net worth snapshot, holdings by asset class (incl. US equities), position detail
  with units / P&L / XIRR, watchlist, SIP status. *This is the watcher's food.*
- **Market data** — live prices/depth, OHLC 1m–1M, option chains + Greeks, analyst consensus,
  **US equities up to 10 tickers/call**, MF discovery. *Used to enrich notifications (price at
  detection, day move) — not required for diffing.*
- **Lookup** — name → instrument id.

Auth surface (verified by unauthenticated probes of the well-known OAuth metadata): standards-
compliant OAuth 2.1, PKCE S256 mandatory, open DCR (RFC 7591), refresh grant present, revocation
endpoint present, confidential clients only. Tokens are short-lived and rotated; per-user rate
limits exist but are unpublished; every request is logged with a unique ID for SEBI compliance.

Caveats carried forward from appendix 1:
- The current MCP spec revision (2026-07-28) **removed protocol-level sessions** — don't design
  around `Mcp-Session-Id`.
- Both official MCP SDKs shipped breaking v2 renames in late July 2026 — pin versions deliberately.
- Python SDK trap: refresh silently fails unless you persist `client_info` alongside tokens —
  the easiest way to accidentally build the version that nags everyone daily.
- Circulating "12-hour TTL / AES-256-GCM" claims belong to an *unofficial scraping* server, not
  INDmoney's official MCP. Ignore them.

## 3. Recommended architecture

One small self-hosted service (a friend's VPS or home box), SQLite, Telegram.

```
                          one-time browser login per friend
  Friend A ──┐            (OAuth 2.1 + PKCE, consent screen,
  Friend B ──┼──────────►  revocable from INDmoney any time)
  Friend C ──┘                        │
                                      ▼
 ┌─────────────────────────── Watcher server ────────────────────────────┐
 │                                                                       │
 │  Token vault (per-friend refresh tokens, encrypted at rest;           │
 │  pattern: OpenAlgo auth_db / Cloudflare (server, sub)→creds)          │
 │            │                                                          │
 │            ▼                                                          │
 │  Poller (US-market-hours aware, per-account stagger + backoff)        │
 │     ├─ cheap probe: net-worth snapshot hash, every ~5 min             │
 │     └─ full holdings pull only when the hash changes                  │
 │            │                                                          │
 │            ▼                                                          │
 │  Diff engine (keyed on instrument id, fractional-qty aware)           │
 │     ├─ NEW_POSITION / EXITED / SIZE_UP / SIZE_DOWN                    │
 │     └─ corporate-action suppressor (value-continuity +                │
 │        cross-account-simultaneity heuristics; bias to suppress)       │
 │            │                                                          │
 │            ▼                                                          │
 │  Store: latest snapshot + append-only event log + 90-day raw          │
 │  payload archive (SQLite/WAL)                                         │
 │            │                                                          │
 │            ▼                                                          │
 │  Notifier ──────────► Telegram group bot                              │
 │     "🟢 Rahul opened a new position: NVDA (~2.4% of portfolio)"       │
 │     per-friend visibility settings: named / anonymous / paused        │
 └───────────────────────────────────────────────────────────────────────┘
```

Key design choices (full reasoning in appendix 2):

- **Two-tier polling.** A cheap net-worth-snapshot probe every ~5 minutes per account; a full
  holdings pull only when the probe's hash changes, plus unconditional pulls at session open/close
  and a next-morning settlement catch-up. Accounts staggered; ~100 calls/account/day — deliberately
  timid since INDmoney publishes no rate-limit numbers. Backoff is **per-account** (limits are
  per-user; one friend's throttle must not stall the group).
- **US market hours.** For a US-stock watcher the hot window is 19:00–02:00 IST (…20:00–02:30 in
  US winter). Poll densely there, sparsely otherwise, with one catch-up pass the next morning IST —
  practically, most notifications will land in the group in the evening, which suits a friend
  group fine. US T+1 settlement means a buy may surface in *holdings* a day after execution; the
  probe on net-worth and the position-detail tool likely surface it sooner — exactly which tool
  shows same-day activity is probe P-list item #1 (§6).
- **Diff on instrument id, never ticker.** Handle fractional quantities (INDmoney US default) with
  a tolerance threshold so a ₹50 auto-invest drip doesn't spam the group.
- **Corporate-action suppression.** A split/bonus looks like a quantity jump with no trade. Two
  cheap heuristics catch nearly all of it: (1) *value continuity* — a split rescales avg cost by
  exactly the ratio and leaves market value flat, a real buy raises cost basis; (2) *cross-account
  simultaneity* — same instrument, same ratio, same tick, in two accounts ⇒ corporate action.
  Bias hard toward suppression; require two agreeing polls before ever emitting "sold everything."
- **Storage: snapshot + event log + raw archive.** The 90-day raw-payload archive is what lets us
  backtest improved heuristics against real past false positives.
- **Telegram, not WhatsApp.** WhatsApp's Business API is structurally wrong for this: server-
  initiated messages outside a 24-hour window must be pre-approved templates, and interactive
  buttons don't work outside that window — plus Meta business verification. Telegram gives a free
  bot, group messages, and (if we ever want them) inline buttons. Since the group already lives on
  WhatsApp, the switch cost is one new Telegram group — worth it. Coalesce each account's changes
  per tick into one message (Telegram caps ~20 msg/min per group).
- **Privacy inside the group.** Broadcasting is **opt-in per friend**, with modes: named /
  anonymous ("someone in the group bought…") / paused. Report position sizes as *percentage of
  portfolio*, never rupee amounts, by default. Instant `/pause` command. Everyone signs off (a
  message in the group is fine) that they understand what's shared. DPDP's personal/domestic
  exemption probably covers this, but build as if it didn't — it's cheap.

## 4. Why no write access — for the record

We descoped copy-trading execution by choice, but the research says the choice is also the only
comfortable one (appendices 3 and 4):

1. **No scoped write credential exists.** INDstocks' API has exactly one token type: full trading
   power. Granting the server write access means handing it your Client ID + MPIN + TOTP secret —
   a perpetual token-minting machine, not a revocable key. Blast radius of a server compromise
   goes from "someone saw our portfolios" to "leveraged orders in every account at once."
2. **SEBI's algo framework (Feb 2025, fully mandatory since April 2026)** allows a retail
   investor's self-built algo for *family only* — and friends are not family. A central server
   placing API orders for N friends reads as an unempanelled algo provider. Notify-only never
   touches this framework at all.
3. **INDmoney has no credential-free order-intent mechanism** (no Kite-Publisher equivalent, no
   basket deep links). Even "human-in-the-loop" execution would have meant custody of write
   credentials. And US stocks on INDmoney aren't orderable via INDstocks' API anyway (NSE/BSE
   only) — so for a **US-stock** group, the write leg was never even technically available.

The natural human loop replaces it: notification says what was bought; anyone who wants in opens
their own INDmoney app and taps for 30 seconds. Sharing *confirmed* fills (never pre-trade intent)
also keeps us clear of the front-running-shaped patterns SEBI actually prosecutes.

## 5. Risk register (what could still bite)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Refresh token has a short hard expiry → periodic re-logins | Open question | Annoyance only | Probe P10/P12 (§6); worst case each friend re-logs in every N weeks via a bot-DM'd link |
| INDmoney objects to standing non-Claude MCP usage / throttles it | Possible | Project stops | Low volume, own-account consent-based access, revocable; be a polite client (timid polling, honest User-Agent). Accept the risk knowingly. |
| Corporate action misread as a buy → false signal in group | Certain occasionally | Embarrassment; someone acts on it | Suppression heuristics + "not investment advice, verify before acting" footer in every notification |
| Partial/failed payload read as mass liquidation | Low | Panic message | Row-count sanity check; two agreeing polls before any EXITED event |
| Token vault leak | Low | All portfolios readable until revocation | Encrypt at rest, no plaintext tokens in logs, document the "revoke from INDmoney app" path for every friend |
| Tool schemas drift (no formal docs, observed drift already) | Medium | Watcher breaks quietly | Raw-payload archive + schema-mismatch alert instead of silent zero-diffs |

## 6. Phased plan

**Phase 0 — the one-hour probe session (next session, ~1 hr, one volunteer account):**
resolves every remaining unknown before writing real code. From the appendix checklists:
1. Connect an MCP client (TS SDK, pinned v2) through the full OAuth flow — confirm DCR, consent
   screen contents, and scopes as observed.
2. `tools/list` — capture the actual tool schemas (settling the 14-vs-15 count and the exact
   US-holdings shape, incl. fractional quantity fields).
3. Buy nothing; just pull holdings twice and diff — confirm which tool reflects same-day US
   activity vs settled-only, and the timestamp/settlement semantics.
4. Hold the session an hour+; observe access-token TTL, exercise the refresh grant, record whether
   the refresh token rotates and any hint of its hard expiry.
5. Deliberately poll a bit fast once to observe the rate-limit response shape (status code,
   Retry-After) — then never again.

**Phase 1 — watch + notify (the product):** token vault, two-tier poller, diff engine with
corporate-action suppression, SQLite store, Telegram bot with per-friend visibility settings.
Run it for the group. Iterate on false positives using the raw archive. **This is the whole
roadmap's end state** — anything beyond it is a new conversation with new (legal) homework.

Nice-to-haves once stable: weekly portfolio-drift digest, "who's most exposed to NVDA" fun stats,
a `/portfolio` DM command showing only your own data.

## 7. Appendices

- [appendix-1-mcp-headless.md](appendix-1-mcp-headless.md) — MCP-as-headless-client deep dive: protocol, SDKs, OAuth probes, multi-user patterns, probe checklist.
- [appendix-2-watcher-architecture.md](appendix-2-watcher-architecture.md) — polling/diff/storage/notification design, schema sketch, sequence diagrams.
- [appendix-3-execution-leg.md](appendix-3-execution-leg.md) — execution options survey (descoped; kept as the record of why).
- [appendix-4-legal-risk-map.md](appendix-4-legal-risk-map.md) — SEBI / ToS / DPDP risk map (not legal advice).
- [appendix-5-prior-art.md](appendix-5-prior-art.md) — OpenAlgo, trade-copiers, MCP multi-tenant gateways, reusable building blocks.

Appendices were written when copy-trading was still in scope; where they discuss execution,
read them as background, not plan.
