# INDmoney Friend-Group Portfolio Watcher — Research Synthesis

**Date:** 2026-08-06 · **Status:** research only, nothing built, no accounts touched.

> **Decisions log (2026-08-06):**
> 1. Read-only watch + notify only; no write access ever (see §4).
> 2. Notifications live in an **in-app chat/activity feed served by our own app** — no push
>    messages for now. The Telegram bot gets *provisioned* (bot + group created, token stored)
>    but stays dormant until we want push.
> 3. Polling: **hourly probe during US market hours**, plus one pull **before market open** and
>    one **after market close**. (~10 calls/account/day.)
> 4. The feed has two views: a **group feed** (everyone's events interleaved, chat-style) and an
>    **individual feed per friend** (one person's activity history).

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
| Will friends have to re-login constantly? | ✅ Probably not, still verifying | **Verified 2026-08-06:** access token TTL is exactly 1 hour, and a refresh token *was* issued on connect. Third-party client code documents silent refresh working in production. What's still open: whether the refresh token rotates and its own hard expiry — the first real refresh exercise happens ~1h after connect and hasn't been observed yet (§6a). |
| Is it truly read-only? | ✅ Yes, by construction | Only two scopes exist: `portfolio:read` and `market:read` — **confirmed exactly these two were granted on a real consent screen, 2026-08-06.** No writable scope exists anywhere in the MCP. Worst case of a server compromise is a **confidentiality** breach, never a rogue trade. |
| Does it cover US stocks? | ✅ Yes | Holdings span 16+ asset classes including US equities (INDmoney's flagship); market-data tools cover US tickers (up to 10 per call). Fractional shares are the norm on INDmoney US — **confirmed live**, `total_units` is fractional and there's no ticker field anywhere (only `investment_code`/name — use `lookup_ind_keys` to resolve). INDmoney also aggregates external-broker holdings (e.g. Zerodha) under the same `IND_STOCK` rows — the watcher sees more than INDmoney-native holdings. |
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

One small self-hosted service (a friend's VPS or home box), SQLite, and an in-app chat/activity
feed as the delivery surface (Telegram provisioned but dormant).

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
 │     ├─ hourly probe during US market hours:                           │
 │     │    net-worth snapshot hash → full holdings pull on change       │
 │     └─ unconditional pulls: once pre-open, once post-close            │
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
 │  Notifier ──────────► in-app chat / activity feed (our own app)       │
 │     "🟢 Rahul opened a new position: NVDA (~2.4% of portfolio)"       │
 │     per-friend visibility settings: named / anonymous / paused        │
 │     (Telegram bot provisioned but dormant — future push channel)      │
 └───────────────────────────────────────────────────────────────────────┘
```

Key design choices (full reasoning in appendix 2):

- **Two-tier polling, hourly cadence (decided).** A cheap net-worth-snapshot probe **once per
  hour** per account during US market hours; a full holdings pull only when the probe's hash
  changes, plus unconditional pulls **once before market open and once after market close** (the
  post-close and pre-open pulls also serve as the T+1 settlement catch-up). Accounts staggered
  within the hour; roughly 10 calls/account/day — so far below any plausible rate limit that the
  unpublished-limits unknown mostly stops mattering. Backoff is still **per-account** (limits are
  per-user; one friend's throttle must not stall the group). Notification latency is up to an
  hour, which is fine for a feed you check like a group chat, and the cadence is trivial to
  tighten later if the feed feels stale.
- **US market hours.** For a US-stock watcher the hot window is 19:00–02:00 IST (…20:00–02:30 in
  US winter). Hourly probes run only inside that window; the pre-open and post-close pulls bracket
  it — practically, most feed items will appear in the evening IST, which suits a friend group
  fine. US T+1 settlement means a buy may surface in *holdings* a day after execution; the
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
- **Delivery: in-app chat/feed first; Telegram provisioned but dormant (decided).** The app
  itself hosts the group's chat/activity feed — trade events post into it as messages alongside
  the friends' own chatter, no push for now; you open the app the way you'd open the WhatsApp
  group. This sidesteps all third-party messaging constraints and keeps portfolio data entirely
  inside our own service. We still create the Telegram bot + group and store the token now
  (5-minute setup) so that turning on push later is a config flip, not a build. If/when push
  turns on: Telegram over WhatsApp — WhatsApp's Business API is structurally wrong for this
  (server-initiated messages outside a 24-hour window must be pre-approved templates, plus Meta
  business verification), while Telegram gives a free bot, group messages, and inline buttons.
  Coalesce each account's changes per tick into one feed message either way.
- **Two feed views (decided).** A **group feed** — everyone's trade events interleaved
  chronologically, chat-style — and an **individual feed** per friend, showing one person's
  activity history ("what has Rahul been buying lately"). Both are straight projections of the
  same append-only event log (`WHERE account_id = ?` vs no filter), so this costs nothing extra
  in storage design; per-friend visibility settings (named / anonymous / paused) apply
  identically to both views.
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

**Phase 0 — the one-hour probe session (started 2026-08-06, one volunteer account):**
resolves every remaining unknown before writing real code. From the appendix checklists — status
after the first real connect (see §6a for the full facts):
1. ✅ **VERIFIED.** Connected an MCP client through the full OAuth flow — DCR accepted a localhost
   redirect with no partner arrangement, the full authorize flow (mobile+OTP+MPIN + consent)
   worked, and scopes granted were exactly `portfolio:read market:read`.
2. ✅ **VERIFIED.** `tools/list` returned **15 tools** (names captured in §6a) — settles the
   14-vs-15 count in favor of 15. Holdings shape confirmed too: no ticker field anywhere,
   fractional `total_units`, and `asset_type` is a fixed enum (unknown values silently return `[]`,
   no error).
3. ⏳ **Still open.** Haven't yet pulled holdings twice to diff — which tool reflects same-day US
   activity vs settled-only, and the timestamp/settlement semantics, remain unresolved.
4. ◑ **Partially verified.** Access-token TTL confirmed exactly 1 hour, and a refresh token was
   issued on connect. Still open: whether the refresh token rotates on use, and its own hard
   expiry — the first real refresh exercise happens ~1h after connect and hasn't happened yet.
5. ⏳ **Still open.** Rate-limit response shape (status code, Retry-After) not yet probed.

### 6a. Verified in practice (2026-08-06)

Everything below comes from a live capture — the project's first real OAuth connect and poll
against `mcp.indmoney.com`, not from unauthenticated probes or third-party client code. Where
appendix 1 speculated, this is the answer; see its dated addendum for the pointer back.

- **OAuth.** Dynamic client registration accepted a localhost redirect URI with no partner
  arrangement needed. The full authorize flow (mobile + OTP + MPIN + consent screen) worked
  end-to-end. Scopes granted: exactly `portfolio:read market:read` — nothing broader was offered
  or requested.
- **Access token TTL: exactly 1 hour.** `expires_at` on the token response was +1h from issuance.
  A refresh token was issued. Rotation behavior and the refresh token's own hard expiry are **not
  yet known** — silent refresh hasn't been exercised, since that first happens ~1h after connect.
- **`tools/list`: 15 tools**, confirming appendix 1's "15 actually present" over the official
  page's 14. Names: `indian_stocks_sips`, `networth_snapshot`, `networth_allocation_breakdown`,
  `networth_holdings`, `get_indian_stocks_ohlc`, `get_indian_stocks_details`,
  `get_indian_stocks_movers`, `get_indian_stocks_option_chain`, `get_indian_stocks_greeks_history`,
  `lookup_ind_keys`, `user_watchlist`, `get_mf_funds_details`, `get_mf_by_category`, `mf_sips`,
  `get_us_stocks_details`.
- **`networth_holdings{asset_type}`** takes a fixed enum: `IND_STOCK, MF, US_STOCK, BOND, EPF, NPS,
  SA, FD, CRYPTO, INSURANCE, VEHICLE, RE, RD, AIF, PMS, PPF`. An unrecognized `asset_type` silently
  returns an empty list — no error. **`networth_snapshot` takes no arguments.**
- **Holdings row fields (US_STOCK):** `investment_code`, `investment` (name), `asset_type`,
  `assetclass_l2`, `invested_amount` (total invested — can be the literal string `"unknown"` for
  external-broker holdings), `market_value`, `holding_percent` (of total net worth), `total_pnl`,
  `pnl_per`, `xirr`, `total_units` (fractional), `unit_price`, `broker`, `market_cap`. **No ticker
  symbol anywhere** — `lookup_ind_keys` is the only name→id resolution path.
- **`IND_STOCK` rows also carry `positions` / `intra_day_positions` / `open_orders` fields** (null
  or `[]` in this capture) — hints that intraday visibility may exist for Indian stocks;
  unverified, and irrelevant to the US-stock scope of this project unless that changes.
- **Server stack is FastMCP.** Tool results arrive **double-wrapped**: both `content[0].text` (a
  JSON string) and `structuredContent.result` (also a JSON string). Client code must unwrap both.
- **INDmoney aggregates external brokers.** A Zerodha holding appeared under `IND_STOCK` with
  `broker: "Zerodha"` — the watcher sees more than INDmoney-native positions, which is good news
  for coverage but means "INDmoney" in this doc really means "everything INDmoney can see," not
  just its own brokerage.

**Still unresolved after this first contact:** refresh token rotation and hard expiry (exercise
happens ~1h post-connect), rate-limit shape (never deliberately probed), and same-day settlement
visibility (which tool/field shows a same-day US buy before T+1 settlement — not yet tested).

**Phase 1 — watch + notify (the product):** token vault, hourly poller (+ pre-open/post-close
pulls), diff engine with corporate-action suppression, SQLite store, and the **in-app chat/
activity feed** (group view + individual per-friend view) with per-friend visibility settings. Provision the Telegram bot + group (dormant).
Run it for the friend group. Iterate on false positives using the raw archive. **This is the
whole roadmap's end state** — anything beyond it is a new conversation with new (legal) homework.

Nice-to-haves once stable: turning on Telegram push, weekly portfolio-drift digest, "who's most
exposed to NVDA" fun stats, a private "my portfolio" view showing only your own data.

## 7. Appendices

- [appendix-1-mcp-headless.md](appendix-1-mcp-headless.md) — MCP-as-headless-client deep dive: protocol, SDKs, OAuth probes, multi-user patterns, probe checklist.
- [appendix-2-watcher-architecture.md](appendix-2-watcher-architecture.md) — polling/diff/storage/notification design, schema sketch, sequence diagrams.
- [appendix-3-execution-leg.md](appendix-3-execution-leg.md) — execution options survey (descoped; kept as the record of why).
- [appendix-4-legal-risk-map.md](appendix-4-legal-risk-map.md) — SEBI / ToS / DPDP risk map (not legal advice).
- [appendix-5-prior-art.md](appendix-5-prior-art.md) — OpenAlgo, trade-copiers, MCP multi-tenant gateways, reusable building blocks.

Appendices were written when copy-trading was still in scope; where they discuss execution,
read them as background, not plan.
