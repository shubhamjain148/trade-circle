# Appendix 3 — The Execution Leg

*Research date: 2026-08-06. Research only — no accounts touched, no credentials handled, no orders placed.*

The watch leg is settled: INDmoney's MCP is strictly read-only, so it can see the lead trader's positions but cannot mirror them. This appendix looks at what could actually place the copy order in a friend's own account, and what each option costs in trust.

Three candidates:

- **(a)** INDstocks Trading API, one credential set per friend, held by a shared server.
- **(b)** Human-in-the-loop: server builds an order *intent*, friend confirms in their own app. Server never holds write credentials.
- **(c)** Mixed-broker: friends stay on whichever broker they already use; the server speaks several APIs.

---

## (a) INDstocks Trading API, per friend

### Seed facts — verified

Everything in the brief checks out against the live docs (fetched 2026-08-06):

| Claim | Status | Source |
|---|---|---|
| Separate full REST write API at `api-docs.indstocks.com` | Confirmed | [api-overview](https://api-docs.indstocks.com/api-overview/) |
| `POST /order`, `/order/modify`, `/order/cancel` | Confirmed | [normal_orders](https://api-docs.indstocks.com/normal_orders/) |
| GTT / smart orders (`/smart/order` + modify/cancel) | Confirmed | [api-overview](https://api-docs.indstocks.com/api-overview/) |
| Portfolio: `/portfolio/holdings`, `/portfolio/positions` | Confirmed | api-overview |
| Funds/margin: `/funds`, `/margin` | Confirmed | api-overview |
| Quotes + historical: `/market/quotes/{full,ltp,mkt}`, `/market/historical/{interval}`, `/market/instruments` | Confirmed | api-overview |
| WebSocket `wss://api.indstocks.com/ws` | Confirmed | api-overview |
| Dashboard access tokens, 24h expiry | Confirmed | [getting-started](https://api-docs.indstocks.com/getting-started/), [Users](https://api-docs.indstocks.com/Users/) |
| `POST /generate/token` with Client ID + MPIN + TOTP | Confirmed | [Users](https://api-docs.indstocks.com/Users/), [faq](https://api-docs.indstocks.com/faq/) |
| TOTP secret enrolled once on the website, no API enrollment | Confirmed | Users, faq |
| 1 token / 60 seconds | Confirmed | faq |
| ₹5 flat per order, API access itself free | Confirmed | faq, docs landing page |
| Docs silent on multi-account management | Confirmed — no partner/multi-user model documented anywhere | — |

Extras the docs added beyond the seed facts:

- **Single live token per account.** "Only one TOTP-generated token is live at a time" — generating a new one revokes the previous. This is a real constraint: two processes (say a copy-trading server and the friend's own script) cannot hold valid tokens simultaneously. Whoever regenerates last wins.
- **TOTP lockouts.** 5 failed attempts in 15 min → 15-min lockout; 3 lockouts in an hour → 60 min. Existing tokens survive the lockout. So a buggy retry loop can lock a friend out of token regeneration for an hour.
- **Static IP.** The third-party OpenAlgo integration guide says token setup requires configuring a static IP on the INDstocks side. This is a meaningful control — it means a leaked credential set is only usable from the whitelisted egress IP. Not confirmed in the first-party docs; treat as likely-but-unverified.
- **Utility endpoints** not in the seed list: `/option-chain`, `/option-chain-symbols`, `POST /greeks`.
- **Token compromise procedure** exists: revoke from dashboard, regenerate, review account activity for unauthorized trades. There is a `security@indstocks.com` contact.

### Order surface — what a credential can actually do

From `POST /order` (`https://api.indstocks.com/order`):

| Field | Values |
|---|---|
| `txn_type` | BUY, SELL |
| `exchange` | NSE, BSE |
| `segment` | EQUITY, DERIVATIVE |
| `product` | CNC, INTRADAY, MARGIN |
| `order_type` | LIMIT, MARKET |
| `validity` | DAY, IOC |
| `security_id`, `qty` | instrument + quantity |
| `algo_id` | `99999` (NSE) / `9999999999999999` (BSE) — mandatory |
| `limit_price`, `is_amo` | optional |

Notable limits:

- **No pure MARKET orders.** A MARKET order is converted to a LIMIT at the live price before transmission. For a copy-trading system this is actually a feature — no runaway fills — but it means partial/non-fills are normal and the system must reconcile.
- **Equity + F&O on NSE/BSE only.** No MCX/currency documented. No US stocks via this API, despite INDmoney's US-stocks product — worth flagging since the lead trader's INDmoney portfolio may include US holdings the API cannot mirror.
- **Validation** covers freeze quantity, lot size multiples, price bands; rejection reasons come back in `extra_info`.
- The mandatory `algo_id` is the SEBI algo-tagging hook (see Regulatory note below).

### Trust and custody — the honest version

This is the crux, and it deserves plain language.

Under option (a), each friend hands the shared server their **Client ID + MPIN + TOTP secret**. That triple is not an API key with a narrow blast radius. It is a *token-minting machine*. The server can regenerate a fresh 24-hour token forever, without the friend's involvement, indefinitely, with no expiry on the arrangement. Concretely, whoever runs that server can:

- place any BUY or SELL, any quantity, on any NSE/BSE equity or derivative, up to available funds and margin;
- use MARGIN and INTRADAY products — i.e. leverage the friend's capital, not just their cash;
- create GTT/smart orders that fire days later, after the credentials are notionally "removed";
- read full holdings, positions, funds, P&L, and personal profile (name, email, UCC, DDPI status);
- and do all of this while the friend's own scripts get locked out, because generating a token revokes theirs.

The only things it cannot do are withdraw money (funds move to the linked bank account only, through the app) and change account settings. That's the floor, and it's a low floor: an adversary who wanted to hurt someone doesn't need to withdraw — repeatedly trading illiquid options with leverage is enough.

Compare to the read-only MCP posture, where the worst case of a compromise is embarrassment: someone learns what the lead trader holds. The gap between those two blast radii is the entire security story of this project.

**Is there any way to scope it down?** Researched specifically; the answer is no. The docs describe exactly one token type with exactly one privilege level — full account access. There is no read-only token, no order-only token, no per-segment scope, no notional cap, no OAuth-style consent screen listing permissions, no expiry-date-bounded grant. The `Authorization: Bearer <token>` header either works for everything or nothing. The mitigations that *do* exist are operational, not cryptographic:

1. **Static IP whitelisting** (probable) — narrows where a leaked secret can be used.
2. **The friend keeps the dashboard.** They can revoke the token and re-enroll TOTP at any time, from the website, without the server's cooperation. This is the real kill switch, and it's important that every friend knows exactly where it is *before* they hand anything over.
3. **Fund starvation.** A friend can keep only the capital they're willing to have copy-traded in the account. This is the single most effective control available and it requires no cooperation from the software.
4. **Server-side limits** — per-order notional cap, daily order count, instrument allowlist, no-derivatives rule. These are honest engineering but they protect against *bugs*, not against a compromised server, because an attacker with the credentials bypasses the server's own code entirely.

Point 4 deserves emphasis because it's easy to fool yourself here: a "safe" copy-trading server with careful limits is only safe while the server is running your code. The credential doesn't know about your limits.

### Regulatory note (new since the seed facts)

SEBI's retail algo-trading framework (Feb 2025 circular, phased through Oct 2025, **fully mandatory from 1 April 2026** — i.e. already in force as of today) reshapes this space:

- The broker is the principal; any algo *provider* is an agent and must be empanelled with the exchanges, with broker due-diligence.
- Algo orders must be tagged (hence the mandatory `algo_id`).
- Retail traders writing algos **for their own account** are fine; algos crossing an orders-per-second threshold must be registered with the exchange.

A friend-group copy-trading server sits in an uncomfortable spot. If it only places orders in *your own* account, it's plainly a personal algo. Once it places orders in *other people's* accounts on their behalf, a regulator could reasonably read it as providing an algo service, or as unregistered investment advice / portfolio management. This is not a blocker for a small non-commercial friend group, but it is a real reason to prefer a posture where **each friend's own app places their own order**.

---

## (b) Human-in-the-loop: order intents the friend confirms

### Does INDmoney/INDstocks offer this?

**No — nothing found.** Searched INDstocks API docs, the INDmoney and INDstocks marketing sites, app-store listings, and third-party reviews. There is:

- no Kite-Publisher equivalent,
- no documented deep-link or URL scheme (`indmoney://`, `indstocks://`) for prefilling an order ticket,
- no basket-link / shareable-trade feature,
- no partner or "trade via link" program.

INDstocks does have baskets *inside* the app for multi-leg strategies, but they are user-constructed, not link-constructible from outside. Treat the absence as "undocumented" rather than "proven nonexistent" — a URL scheme could exist and simply not be published (see Probes).

### What the pattern looks like elsewhere

**Zerodha Kite Publisher** is the reference implementation and is worth understanding because it's exactly the shape we want. A third party embeds `publisher.js` with their API key, declares an order intent (`exchange`, `tradingsymbol`, `transaction_type`, `quantity`, `order_type`, `price`), and an inline popup walks the user through confirming *in their own Kite session*, then returns them to the page. Up to 10 items per basket; optional read-only mode locks quantity and price so the user can only accept or decline. The publisher never holds the user's credentials — the trust model is inverted relative to option (a). Caveat: the JS plugin does not work in iOS WebViews due to Safari cookie policy.

Elsewhere: Dhan supports webhook-driven order flows and TradingView order placement, but those are *authenticated* flows (the user's token is already configured), not credential-free intents. Nothing found for Upstox or Angel One resembling Publisher. Kite Publisher appears to be genuinely unique in the Indian market.

### The fallback, and why it's better than it sounds

Absent any deep link, the fallback is deliberately dumb:

> Push/Telegram/WhatsApp notification: **"Lead bought 25 × NIFTY 24500 CE @ ₹142. Your size: 15 lots. [Open INDstocks]"** — plain app link, no order prefill. Friend opens the app, types the trade, confirms.

Roughly 30 seconds of tapping. What it costs: a little slippage on fast trades, and it fails for anyone who isn't looking at their phone. What it buys:

- The server holds **zero write credentials**. Compromise = information leak, nothing more.
- Every trade has genuine, informed human consent — which is also the cleanest answer to the SEBI question above, since each friend is placing their own order.
- No 24-hour token refresh machinery, no TOTP lockout failure mode, no single-live-token collision, no static-IP infrastructure.
- Friends can be on any broker at all — the notification doesn't care.

For a friend group copying discretionary trades (not sub-second scalps), the latency cost is close to irrelevant and the trust cost saved is enormous. This is the option that ships fastest and is easiest to explain to a friend over dinner.

---

## (c) Mixed-broker survey

Survey depth only — verify against the live docs before building against any of these.

| Broker | Auth model | Token lifetime | Daily manual login? | API cost | Multi-user / partner model |
|---|---|---|---|---|---|
| **INDstocks (INDmoney)** | Bearer token; dashboard OR headless `POST /generate/token` with Client ID + MPIN + TOTP | 24h; one live TOTP token at a time; 1 token/60s | **No** — fully headless refresh is documented and supported | Free API; ₹5 flat/order | Not documented |
| **Zerodha Kite Connect** | API key + secret → browser login → request_token → access_token. TOTP 2FA mandatory for order placement | Expires daily ~06:00 | **Yes** — Zerodha states exchange rules require manual login at least once daily and explicitly discourages automating it | Order/portfolio APIs **free** (personal) since Mar 2025; data APIs ₹500/mo per key (down from ₹2,000) | Publisher (order intents) + full Connect apps |
| **Dhan (DhanHQ v2)** | Web-generated token, or API-key OAuth-style 3-step consent flow | 24h, but a **Renew Token API** extends programmatically | **No** — renewal is API-driven | Trading APIs free; data APIs paid (~₹499/mo) | **Yes — explicit Partner model** for platforms serving multiple end-users |
| **Fyers (API v3)** | App ID + secret → auth code → access token; refresh token available | Access token 24h; refresh token ~15 days | Effectively daily-ish; refresh token softens it | Free (trading and data) | App-based; not a formal partner tier |
| **Upstox** | OAuth-style authorization code → access token | Valid until **03:30 the next day**, regardless of generation time | **Yes** — browser login each day | Reported free in current docs; older third-party reviews claim a subscription. **Conflicting — verify** | OAuth apps |
| **Angel One SmartAPI** | `loginByPassword` with client code + PIN/password + **TOTP** — fully headless | Session valid till midnight; refresh-token endpoint issues new JWTs | **No** — TOTP makes it headless | Free | App-based |

Reading across the table, the honest summary is:

- **Headless-capable** (no human at a browser each morning): INDstocks, Angel One, Dhan. These are the only realistic candidates for an unattended server.
- **Requires a human daily**: Zerodha, Upstox. Zerodha's is a *policy* position tied to exchange rules, not merely a technical limitation — automating it is against their stated guidance.
- **Cheapest to operate**: INDstocks (free API, ₹5/order) and Dhan (free trading APIs). Zerodha is free too if you don't need market data — and for copy trading you may not, since the *watch* leg comes from the MCP.
- **Only one with a first-class multi-user story**: Dhan's Partner model. Everyone else, including INDstocks, is designed around "one person, own account". Building a friend-group server on any of them means using a personal-use API in a way it wasn't designed for.
- **Only one with a credential-free intent flow**: Zerodha, via Publisher.

An interesting consequence: if the group cared most about the trust model, the strongest technical answer is *Zerodha Kite Publisher*, not INDstocks — but it requires friends to be on Zerodha, which defeats the premise of an INDmoney-centred project.

---

## (d) Recommended posture

**Phase 2a — read-only MCP watcher + human-in-the-loop execution. Ship this.**
**Phase 2b — full INDstocks API automation. Only if 2a proves the idea and every friend actively opts in, one at a time.**

### Blast radius if the server is compromised

*Phase 2a (no write credentials anywhere on the server):*

- Attacker learns the lead trader's positions and the group's trade history. Real but bounded — it's information, not money.
- Attacker can send **fake notifications** ("lead bought X, do this"). This is the genuine attack, and it's a social-engineering attack, not a financial one: it only works if a friend confirms without thinking. Mitigate by putting the lead's actual position in every notification, so a fabricated one is checkable against the app, and by keeping the group small enough that a weird alert prompts a message in the group chat.
- Money at risk without further human action: **zero**.
- Recovery: shut the server down. Nothing to revoke.

*Phase 2b (Client ID + MPIN + TOTP secret for N friends on one server):*

- Attacker holds full trading power over **every** participating account, simultaneously, for as long as it takes anyone to notice.
- They can drain value without withdrawing anything: leveraged INTRADAY positions, wide-spread illiquid options, wash-trading against their own account on the other side. Losses are real, immediate, and hard to unwind.
- They can plant GTT/smart orders that fire days after the breach is "contained".
- Detection is slow. Friends who aren't watching intraday might not notice until the contract note arrives.
- Recovery requires **every friend individually** logging into the INDstocks dashboard to revoke their token and re-enroll TOTP. You cannot fix it for them. If one friend is asleep, on a flight, or unreachable, their account stays exposed.
- The blast radius scales linearly with group size, and the server becomes a genuinely attractive target — N brokerage accounts behind one box.

That asymmetry is the whole argument. Phase 2a's worst case is a bad day. Phase 2b's worst case is losing friends money and, plausibly, friends.

### Tradeoffs, stated plainly

**What 2a genuinely costs you:** trades take ~30 seconds instead of ~1 second, so fast-moving entries will slip. Friends who miss notifications miss trades, so tracking error against the lead is real and will occasionally be embarrassing. It doesn't work while anyone is asleep or in a meeting. If the group's edge depends on speed, 2a doesn't deliver it — and if that's the case, the honest answer is that this project needs a different design (or a regulated one), not weaker security.

**What 2b genuinely buys you:** tight tracking, no missed trades, no attention tax. For a discretionary swing-trading friend group, these advantages are smaller than they feel in the planning stage.

**If you do go to 2b**, the non-negotiables:
1. Every friend funds the account with only what they'll accept losing to a bug or breach.
2. Server-side hard limits: per-order notional cap, daily order count, instrument allowlist, derivatives off by default. (Protects against bugs — not against a breach. Don't let it make you feel safer than you are.)
3. Static IP egress, credentials in a real secrets manager, never in the repo or in env files on a shared box.
4. Every order mirrored to the friend's own notification channel *as it happens*, so a rogue order is visible within seconds.
5. A written, rehearsed revocation drill — each friend has done the dashboard revoke once, before there's an emergency.
6. Onboard friends one at a time, starting with the person running the server. Eat your own risk first.

**The bridge worth building:** phase 2a's notification pipeline is not throwaway. It's the same trade-decision pipeline 2b needs, minus the credential handling. Build 2a, run it for a season, and you'll have both real data on whether the tracking error actually matters and the infrastructure to upgrade if it does.

---

## Unknowns

Where the docs are silent or the research couldn't settle it:

1. **Multi-account management** — completely undocumented for INDstocks. No partner tier, no sub-account model, no terms-of-service statement found on whether operating another person's credentials is permitted. This may well be a ToS violation; it is not addressed either way.
2. **Whether the INDstocks ToS / API agreement permits third-party credential custody at all.** Not located. The docs say only "your access token is like a password — never share it publicly", which is guidance, not a legal term.
3. **Exact rate limits.** FAQ says limits vary by category (Order / Data-Quote / Non-Trading) and points to "API Conventions" — that page returned 404 at every URL tried and is absent from the sitemap (the sitemap lists only 3 URLs and is clearly incomplete). Numbers unknown.
4. **Static IP requirement** — asserted by OpenAlgo's third-party integration guide, not confirmed in first-party docs. Unclear whether it's mandatory, optional, or one IP vs. a range.
5. **Whether INDstocks' headless TOTP token generation is compliant** with the exchange rule Zerodha cites (manual login once daily). Two brokers, opposite readings of the same rule. Unresolved.
6. **Any INDmoney/INDstocks deep-link URL scheme.** Nothing published. Cannot rule out an undocumented one.
7. **US stocks via the API** — INDmoney offers US equities but the Trading API documents NSE/BSE only. If the lead trader holds US positions, the copy leg may simply be unable to mirror them.
8. **Order-update WebSocket detail** — `wss://api.indstocks.com/ws` is documented as carrying market data, order updates, and portfolio changes, but the auth model and message schema weren't fetched. Matters for fill confirmation.
9. **Upstox API pricing** — current docs read as free, older third-party reviews say subscription. Conflicting.
10. **SEBI algo framework applicability** to a non-commercial friend group placing orders in others' accounts. Genuinely ambiguous. Not legal advice; worth an actual opinion if 2b is ever seriously considered.

---

## Practical probes for next session

Ordered roughly by value-per-effort. Items marked **[user]** need an account and cannot be done by an agent.

1. **[user] Inspect the INDstocks API dashboard** at `indstocks.com/app/api-trading/access-tokens`. Screenshot the token-creation screen. Questions: are there *any* scope/permission checkboxes? Is static IP mandatory or optional, single IP or CIDR? Is there an expiry-date option on a token? Is there a per-token label so multiple tokens are distinguishable? This single probe resolves Unknowns 1, 4 and the whole scoping question.
2. **[user] Find and read the INDstocks API terms of service / developer agreement** — linked from the dashboard, probably not from the docs site. Look specifically for language about sharing credentials or operating on behalf of others. Resolves Unknown 2.
3. **[user] Probe for a deep-link URL scheme.** On an Android device with the INDstocks app installed, dump the manifest intent filters (`adb shell dumpsys package com.indmoney.indstocks | grep -A5 android.intent.action.VIEW`), or on iOS check the app's `LSApplicationQueriesSchemes` / try `indstocks://` and `indmoney://` from Safari. Also check whether shared links from the app's own "share" feature carry order parameters. Resolves Unknown 6 — and if a scheme exists, option (b) gets dramatically better.
4. **Email `api-support@indstocks.com`** with three direct questions: (i) published rate limits per category, (ii) is any read-only or scoped token available, (iii) is there a partner/multi-user model or is per-account credential sharing permitted. Low effort, potentially settles Unknowns 1, 3 and the scoping question authoritatively.
5. **Re-attempt the API Conventions page.** It's referenced by the FAQ but 404s at the obvious URLs and is missing from the sitemap. Try crawling the docs nav HTML directly rather than guessing paths. Resolves Unknown 3.
6. **[user] Sandbox test with a funded-with-₹500 account** *(only if proceeding toward 2b)*. Set up TOTP, exercise `POST /generate/token`, place one 1-share CNC order, cancel it, and — critically — **practise the revoke** from the dashboard and confirm the token dies immediately. This is the revocation drill; do it once in calm conditions.
7. **Prototype the 2a notification** end to end: MCP read → diff detection → Telegram message with stock, qty, price, and a plain app link. No credentials involved, so this can be built immediately and is the actual phase-2a deliverable.
8. **Document the WebSocket order-update contract** (auth handshake, message schema) — needed for fill reconciliation in either phase. Resolves Unknown 8.

---

## Sources

- [INDstocks API docs — landing](https://api-docs.indstocks.com/)
- [Complete API Overview](https://api-docs.indstocks.com/api-overview/)
- [Users — Access Tokens & Profile](https://api-docs.indstocks.com/Users/)
- [Order Management API](https://api-docs.indstocks.com/normal_orders/)
- [FAQ](https://api-docs.indstocks.com/faq/)
- [Getting Started](https://api-docs.indstocks.com/getting-started/)
- [Market Quotes API](https://api-docs.indstocks.com/MarketQuote/)
- [INDstocks — API Trading feature page](https://www.indstocks.com/features/api-trading)
- [OpenAlgo — IndMoney (INDstocks) broker integration](https://docs.openalgo.in/connect-brokers/brokers/indmoney)
- [Zerodha Kite Connect — Publisher](https://kite.trade/docs/connect/v3/publisher/)
- [Zerodha — free personal APIs from Kite Connect](https://zerodha.com/z-connect/updates/free-personal-apis-from-kite-connect)
- [Kite Connect forum — revising fees ₹2000 → ₹500](https://kite.trade/forum/discussion/15015/revising-kite-connect-fees-from-2000-to-500-per-month)
- [Kite Connect forum — mandatory TOTP for all Kite Connect apps](https://kite.trade/forum/discussion/10391/mandatory-totp-for-all-kite-connect-apps)
- [Kite Connect forum — notes on the NSE circular on API usage](https://kite.trade/forum/discussion/15350/notes-on-the-nse-circular-prescribing-operating-procedures-for-api-usage)
- [Kite Connect — User / authentication docs](https://kite.trade/docs/connect/v3/user/)
- [DhanHQ v2 — Authentication](https://dhanhq.co/docs/v2/authentication/)
- [Dhan support — maximum validity of an API access token](https://dhan.co/support/platforms/dhanhq-api/what-is-the-maximum-validity-of-an-api-access-token-in-dhan-apis/)
- [Upstox — Authentication](https://upstox.com/developer/api-documentation/authentication/)
- [Upstox community — access token validity](https://community.upstox.com/t/access-token-validity/4646)
- [Angel One SmartAPI — docs](https://smartapi.angelone.in/docs)
- [SmartAPI forum — change in Angel One login policy (TOTP)](https://smartapi.angelbroking.com/topic/3383/important-announcement-change-in-angel-one-login-policy)
- [FYERS API](https://api-docs.fyers.in/)
- [FYERS support — authentication and login flow](https://support.fyers.in/portal/en/kb/articles/how-does-the-authentication-and-login-flow-work-for-user-apps-on-fyers)
- [SEBI algo trading rules 2026 — overview](https://www.sahi.com/blogs/sebi-algo-trading-rules-2026-what-every-retail-trader-must-know-before-april)
- [QuantInsti — Algorithmic trading in India (2026): SEBI framework](https://www.quantinsti.com/articles/algorithmic-trading-india/)
- [Medianama — SEBI proposes framework for retail investors in algo trading](https://www.medianama.com/2025/02/223-sebi-proposes-framework-retail-investors-algo-trading/)
