# Appendix 2 — Watcher & Notification Architecture

**Status:** design proposal. Everything below marked _(recommendation)_ is a reasoned design choice, not a verified fact about INDmoney's MCP. Items marked _(unverified)_ must be confirmed empirically against the live server before any of this is built on top of.
**Date:** 2026-08-06
**Scope:** read-only position watching + group notification + approval capture. Order execution ("the execution leg") is deliberately out of scope here and is assumed to be a separate broker integration.

---

## 0. What we actually know about the data source

From INDmoney's public MCP page (<https://www.indmoney.com/mcp>), endpoint `https://mcp.indmoney.com/mcp`, OAuth 2.1 + PKCE, 14 read-only tools:

| Tool | Relevance to the watcher |
|---|---|
| `networth_holdings` | **Primary diff source.** Row-per-position with P&L metrics. |
| `networth_snapshot` | Cheap change-detector (total value / per-asset-class totals). |
| `networth_allocation_breakdown` | Mid-cost drill-down into one asset class. |
| `get_indian_stocks_details` | Live price for up to 10 tickers — used for approval staleness checks. |
| `lookup_ind_keys` | Symbol → internal identifier resolution; needed to build stable keys. |
| `user_watchlist` | Secondary signal (intent, not position). |
| `indian_stocks_ohlc` | Backfill / price-continuity checks for corporate-action detection. |
| remaining (option chain, greeks, MF/US/SIP tools) | Not on the hot path. |

Two facts that shape the whole design:

1. **INDmoney states only that it "applies per-user rate limits."** No published numbers. _(unverified)_ Everything below assumes we must discover the limit by careful probing and then stay an order of magnitude under it.
2. **There is no published intraday-positions / order-book tool.** The task brief assumes a "positions" tool distinct from holdings; the public tool list shows only `networth_holdings`. **This is the single biggest open question.** If `networth_holdings` reflects only settled demat + broker-reported positions, then:
   - Intraday (MIS/square-off-same-day) trades may never appear at all.
   - Delivery buys may only appear on T+1.
   That turns "X just bought Y" into "X bought Y yesterday" — still useful for a friend group, useless for same-day copy trading. **Action: verify empirically before building anything time-sensitive** (place a tiny delivery buy in one account, poll `networth_holdings` every 5 min, record the first timestamp it appears).

---

## 1. Polling & diff engine

### 1.1 Cadence _(recommendation)_

Unknown rate limits + a friend-group workload (≤ ~15 accounts) argue for **conservative fixed cadence with a cheap-probe/expensive-confirm split**, not aggressive polling.

**Recommended default: 5-minute `networth_snapshot` probe per account during market hours; full `networth_holdings` pull only when the probe changes, plus one unconditional full pull per account per session boundary.**

| Window (IST, Mon–Fri) | Probe cadence | Full holdings pull |
|---|---|---|
| 09:00–09:15 (pre-open) | none | one baseline pull at 09:05 |
| 09:15–15:30 (continuous) | 5 min | on probe-delta, max 1 per 5 min per account |
| 15:30–16:00 (post-close) | 15 min | one pull at 15:45 |
| 16:00–18:30 | 30 min | one pull at 18:00 (catches broker EOD reconciliation) |
| 08:30 next morning | — | **one pull — this is the T+1 settlement catch-up pull** |
| Weekends / NSE holidays | none | one pull Sat 10:00 (catch late corp-action credits) |

Budget at 15 accounts: ~75 probe calls/account/day + ~10–20 full pulls/account/day ≈ **95 calls per account per day, ~1 call/account every 4 min at peak**. That is deliberately timid. Start here; only tighten to 2-minute probes after observing zero 429s for two full weeks.

Market hours source: NSE/BSE continuous session is 09:15–15:30 IST, pre-open 09:00–09:15. Holidays must come from the NSE trading-holiday list, refreshed yearly and cached (<https://www.nseindia.com/resources/exchange-communication-holidays>). Do **not** infer holidays from "no data changed" — a quiet day and a holiday look identical.

Stagger accounts across the 5-minute tick (`offset = hash(account_id) % 300s`) so all N accounts never fire simultaneously; this also avoids a thundering herd against a shared upstream.

### 1.2 Backoff _(recommendation)_

Per-account, not global — rate limits are per-user, so one friend's throttle must not stall everyone.

```
on 429 / rate-limit error:
    honor Retry-After if present
    else: backoff = min(base * 2^n, 30 min), full jitter (random(0, backoff))
on 5xx:            same curve, base = 30s
on 401 / expired:  STOP polling this account. Mark auth_state='needs_reauth'.
                   DM the owner once (not the group), then hourly reminder,
                   max 3, then silent until they re-auth.
after 3 consecutive 429s:  halve this account's cadence for the rest of the
                           session (adaptive floor: never faster than 15 min)
after a clean hour:        step cadence back up one notch
```

Tokens are documented as "short-lived and rotated automatically" with sessions that expire — so **treat re-auth as a routine event, not an incident.** Budget for it in the UX: a friend who has to re-OAuth every few days will silently drop out of the group unless the bot nags them.

Circuit breaker: if >50% of accounts 429 within 10 minutes, assume a shared/global limit rather than per-user and pause the whole scheduler for 15 min.

### 1.3 Diff algorithm

Normalize each poll into a set of rows keyed by a **stable instrument key**, then diff against the last stored snapshot.

```
key = (account_id, asset_class, instrument_id)
```

Use INDmoney's internal identifier from `lookup_ind_keys` as `instrument_id`, **not** the ticker symbol. Tickers get renamed on mergers/rebrands and would produce a spurious REMOVE+ADD pair.

```
diff(prev_rows, curr_rows):
    prev_k, curr_k = keys(prev_rows), keys(curr_rows)

    for k in curr_k - prev_k:          -> candidate POSITION_OPENED
    for k in prev_k - curr_k:          -> candidate POSITION_CLOSED
    for k in prev_k & curr_k:
        dq = curr.qty - prev.qty
        if dq == 0: continue
        if dq > 0:  -> candidate QTY_INCREASED
        else:       -> candidate QTY_DECREASED

    every candidate then passes through the corporate-action filter (§2)
    and the confidence classifier below before it becomes a notifiable event.
```

Additional signals to carry on every candidate, because they are what makes the corporate-action filter possible:

- `qty_before`, `qty_after`, `ratio = qty_after / qty_before`
- `avg_cost_before`, `avg_cost_after` (a real buy moves avg cost toward the market price; a bonus/split rescales it by exactly the ratio)
- `market_value_before`, `market_value_after`
- `unrealized_pnl_before/after` (a corporate action preserves absolute P&L; a trade does not)

**Confidence classification** — do not emit a notification at `low`:

| Signal | Confidence |
|---|---|
| qty change + avg-cost change consistent with a trade at a plausible market price | `high` → notify |
| qty change, avg cost rescaled by exactly `1/ratio`, market value flat | corporate action → suppress (§2) |
| qty change with no avg-cost data | `medium` → notify, but hedge the wording ("looks like…") |
| whole-portfolio row-count change > 60% in one poll | `low` → suspected bad/partial payload → suppress everything, re-poll once, alert operator |

**Never trust a single poll for a mass change.** A partial upstream response that returns 3 of 20 holdings would otherwise fire 17 "sold everything" alerts. Require two consecutive agreeing polls before emitting any `POSITION_CLOSED`, and hard-suppress any batch where >3 closures appear in one tick (log for human review instead).

### 1.4 T+1 settlement lag and intraday vs delivery

India runs a **T+1 settlement cycle for equities since 27 Jan 2023**, with an **optional T+0 cycle** SEBI has been phasing in across a widening list of scrips through 2025. Practical consequences for a holdings-only feed:

- A delivery buy on Monday may not show in a demat-derived holdings view until Tuesday. The Tuesday 08:30 catch-up pull is what makes those visible.
- **Attribution is therefore ambiguous:** a new row on Tuesday morning could be Monday's trade (settled) or Tuesday's pre-open trade. Recommendation: label the event with `detected_at` and an explicit `attribution: 'settled_prior_session' | 'same_session'` inferred from *which poll window* first saw it (an overnight-first-seen change → prior session).
- **Intraday positions that open and close the same day may be entirely invisible** to a settled-holdings feed. Do not promise "we catch every trade." Promise "we catch position changes." _(unverified — depends entirely on the §0 open question.)_
- If a distinct positions/intraday tool does exist, the split should be: **positions tool = fast lane (5-min, same-session, ephemeral, drives copy-trade prompts); holdings tool = slow lane (session boundaries, authoritative, drives the ledger).** Reconcile at 18:00: anything in the fast lane that never landed in the slow lane was an intraday round-trip; anything in the slow lane never seen in the fast lane was a missed detection (log it — it measures the watcher's recall).
- T+0 scrips settle same-day (trades in the intraday window, funds ~16:30), so for those the holdings row can appear the *same* evening. Don't hard-code "new row before 09:15 = yesterday's trade."

---

## 2. Corporate-action dedup

### 2.1 How corporate actions look in a holdings feed

| Action | Signature in the feed |
|---|---|
| **Bonus (1:1)** | qty ×2, avg cost ÷2, market value ~flat, P&L unchanged. Price on the exchange also halves on ex-date. |
| **Stock split (1→5)** | qty ×5, face value ÷5, avg cost ÷5, market value ~flat. Indistinguishable from bonus in a holdings row alone. |
| **Rights issue** | qty increases by a *non-round* ratio, **and** cash decreases — a genuine subscription, so arguably worth notifying, but with different wording. |
| **Merger / amalgamation** | Old instrument row disappears entirely, new instrument row appears at a swap ratio. Looks exactly like SELL-all + BUY-new. **Highest false-positive risk.** |
| **Demerger** | Original qty unchanged (or reduced), a brand-new instrument row appears with qty = ratio × original, cost basis re-apportioned. Looks like a fresh buy of the resulting entity. |
| **Dividend** | No qty change (only cash) — harmless. |
| **Buyback acceptance** | Partial qty decrease with cash increase. Looks like a partial sell. |
| **Consolidation / reverse split** | qty ÷ n, avg cost × n. Looks like a partial sell. |

### 2.2 Heuristics _(recommendation)_ — apply in order, cheapest first

**H1 — Value continuity (no external data, catches most of it).**
For an ADD/INCREASE candidate, compute:
```
value_drift = |mv_after - mv_before| / mv_before
cost_drift  = |avg_cost_after * qty_after - avg_cost_before * qty_before| / (avg_cost_before * qty_before)
```
If `value_drift < 2%` **and** `cost_drift < 1%` **and** `ratio` is close to a simple fraction (within 0.5% of p/q for small integers p,q ≤ 20), classify as **corporate action, suppress**. A real buy injects new capital: total cost basis must rise materially. This one rule catches splits, bonuses and consolidations without any external feed.

**H2 — Simultaneity across accounts (free, very strong).**
If ≥2 independent friends' accounts show the *same instrument* changing by the *same ratio* within the same polling window, it is a corporate action with near-certainty — friends do not coincidentally buy the identical scrip in the identical proportion at the identical minute. With ≥3 accounts holding a name this is the cheapest high-precision signal available and costs zero API calls. Use it as an override that suppresses even `high`-confidence trade classifications.

**H3 — Corporate-action calendar cross-check (external, authoritative).**
NSE publishes forthcoming corporate actions (ex-dates for bonus, split, dividend, rights, mergers) at <https://www.nseindia.com/companies-listing/corporate-filings-actions>. Ingest daily (a nightly job, ~1 request), store `(symbol, ex_date, purpose, ratio)`, and suppress any qty change on an instrument whose ex-date is within **T-1..T+3** of the detection. The wide window absorbs the settlement/record-date lag between ex-date and the demat credit — bonus shares in particular often land in the demat account several days after ex-date.
Practical note: nseindia.com requires a browser-like session (cookie warm-up + `User-Agent`) for its JSON endpoints and rate-limits scrapers aggressively; libraries like `NseIndiaApi` (<https://bennythadikaran.github.io/NseIndiaApi/api.html>, `NSE.actions()`) wrap this. **BSE publishes an equivalent list** — cross-check both, since a scrip may be listed on one only. Treat the calendar as best-effort: if the fetch fails, fall back to H1+H2 and mark events `ca_check: 'unavailable'`.

**H4 — Price-adjustment corroboration.**
On ex-date the exchange adjusts the price by the same ratio. Pull `indian_stocks_ohlc` daily candles for the instrument and check whether close(t-1)/open(t) ≈ the qty ratio. If yes, corporate action. Costs one API call per candidate — use only when H1 is borderline and H3 was unavailable.

**H5 — Merger/demerger pairing.**
Before emitting a `POSITION_CLOSED` + `POSITION_OPENED` in the same account in the same poll, check whether `mv(closed) ≈ mv(opened)` (within 5%) and no cash moved. If so, emit a single `CORPORATE_ACTION_SWAP` event, not two trade events. Cross-check against the H3 calendar for a merger/demerger entry on either symbol.

### 2.3 Failure posture

**Bias toward suppression.** A missed "X bought more Y" is a shrug; a false "X bought 500 more shares of Y" that triggers a copy-trade approval prompt is a real-money mistake. Every suppressed candidate is still written to the event log with `suppressed_reason` so the group can audit misses, and a weekly digest can surface "3 changes we treated as corporate actions" for a human sanity check.

---

## 3. Storage shape

### 3.1 Recommendation: **latest snapshot + append-only event log + a bounded snapshot archive**

Justification:

- **Event log alone** cannot answer "what does X hold right now?" without replaying from genesis, and any bug in the diff engine silently corrupts all downstream state with no way to recompute. Bad for a system whose whole job is diffing.
- **Snapshot-only** loses history: you cannot answer "when did X first buy this?", cannot audit a wrong notification, cannot re-run an improved corporate-action heuristic over past data, and cannot compute a friend's realized track record.
- **Both** gives: O(1) current-state reads for the diff engine, a durable audit trail for notifications and approvals, and — critically — the ability to **re-derive events from raw snapshots when the heuristics improve**. Keep raw poll payloads (compressed) for ~90 days so heuristic changes can be backtested against real false positives. Beyond 90 days keep only session-boundary snapshots (one per account per trading day), which is ~250 rows/account/year — nothing.

Storage volume for 15 accounts × ~30 holdings × ~100 polls/day is trivial; **SQLite in WAL mode is the right call** and removes an entire class of operational burden. Revisit only if the group exceeds ~100 accounts or the server goes multi-process-writer.

### 3.2 Minimal schema sketch

```sql
PRAGMA journal_mode = WAL;

-- ── identity & consent ───────────────────────────────────────────────
CREATE TABLE account (
  id                TEXT PRIMARY KEY,          -- internal uuid
  display_name      TEXT NOT NULL,             -- "Rohit"
  telegram_user_id  INTEGER UNIQUE,
  auth_state        TEXT NOT NULL              -- active|needs_reauth|paused|revoked
                      CHECK (auth_state IN ('active','needs_reauth','paused','revoked')),
  poll_interval_s   INTEGER NOT NULL DEFAULT 300,   -- adaptive, per §1.2
  poll_offset_s     INTEGER NOT NULL DEFAULT 0,     -- stagger
  created_at        TEXT NOT NULL
);

-- token material lives OUTSIDE sqlite (OS keychain / age-encrypted file /
-- libsodium sealed blob). If it must live here, store only a ciphertext
-- column and never the plaintext refresh token. See §5.4.

CREATE TABLE broadcast_pref (                  -- §5.4 visibility scoping
  account_id     TEXT NOT NULL REFERENCES account(id),
  scope          TEXT NOT NULL,                -- 'default' | asset_class | instrument_id
  mode           TEXT NOT NULL                 -- broadcast|anonymous|aggregate_only|private
                   CHECK (mode IN ('broadcast','anonymous','aggregate_only','private')),
  min_value_inr  INTEGER NOT NULL DEFAULT 0,   -- suppress trades below this size
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (account_id, scope)
);

-- ── raw poll archive (rolling 90d) ───────────────────────────────────
CREATE TABLE poll (
  id            INTEGER PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES account(id),
  tool          TEXT NOT NULL,                 -- networth_holdings | networth_snapshot
  started_at    TEXT NOT NULL,
  latency_ms    INTEGER,
  status        TEXT NOT NULL,                 -- ok|rate_limited|auth_error|error|partial
  http_status   INTEGER,
  payload_gz    BLOB,                          -- gzipped raw JSON, NULL on error
  payload_hash  TEXT                           -- sha256 of normalized payload; skip diff if unchanged
);
CREATE INDEX poll_acct_time ON poll(account_id, started_at DESC);

-- ── current state (one row per live position) ────────────────────────
CREATE TABLE holding_current (
  account_id     TEXT NOT NULL REFERENCES account(id),
  instrument_id  TEXT NOT NULL,                -- INDmoney internal key, NOT ticker
  asset_class    TEXT NOT NULL,                -- equity_in|equity_us|mf|gold|...
  symbol         TEXT,                         -- display only, may change
  name           TEXT,
  qty            REAL NOT NULL,
  avg_cost       REAL,
  last_price     REAL,
  market_value   REAL,
  unrealized_pnl REAL,
  xirr           REAL,
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  last_poll_id   INTEGER REFERENCES poll(id),
  PRIMARY KEY (account_id, instrument_id)
);

-- ── append-only event log (never UPDATE, never DELETE) ───────────────
CREATE TABLE position_event (
  id               INTEGER PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES account(id),
  instrument_id    TEXT NOT NULL,
  symbol           TEXT,
  kind             TEXT NOT NULL,   -- POSITION_OPENED|POSITION_CLOSED|QTY_INCREASED
                                    -- |QTY_DECREASED|CORPORATE_ACTION_SWAP
  qty_before       REAL,
  qty_after        REAL,
  avg_cost_before  REAL,
  avg_cost_after   REAL,
  value_delta      REAL,            -- signed INR, the "size" of the move
  detected_at      TEXT NOT NULL,
  attribution      TEXT,            -- same_session|settled_prior_session|unknown
  confidence       TEXT NOT NULL,   -- high|medium|low
  suppressed       INTEGER NOT NULL DEFAULT 0,
  suppressed_reason TEXT,           -- corp_action_h1|h2|h3|h5|partial_payload|user_pref|below_min
  ca_ref           TEXT,            -- matched corporate_action.id if any
  from_poll_id     INTEGER REFERENCES poll(id),
  to_poll_id       INTEGER REFERENCES poll(id),
  dedup_key        TEXT NOT NULL UNIQUE
);
-- dedup_key = sha256(account_id|instrument_id|kind|qty_before|qty_after|trading_day)
-- -> re-running the differ over the same window is idempotent by construction.
CREATE INDEX evt_acct_time ON position_event(account_id, detected_at DESC);

-- ── corporate action calendar (NSE + BSE, refreshed nightly) ─────────
CREATE TABLE corporate_action (
  id         TEXT PRIMARY KEY,      -- hash(source|symbol|ex_date|purpose)
  source     TEXT NOT NULL,         -- nse|bse|manual
  symbol     TEXT NOT NULL,
  isin       TEXT,
  ex_date    TEXT NOT NULL,
  record_date TEXT,
  purpose    TEXT NOT NULL,         -- raw text, e.g. "BONUS 1:1"
  action_type TEXT,                 -- bonus|split|dividend|rights|merger|demerger|buyback|other
  ratio_num  INTEGER, ratio_den INTEGER,
  fetched_at TEXT NOT NULL
);
CREATE INDEX ca_sym_date ON corporate_action(symbol, ex_date);

-- ── notifications & approvals ────────────────────────────────────────
CREATE TABLE notification (
  id             INTEGER PRIMARY KEY,
  event_id       INTEGER NOT NULL REFERENCES position_event(id),
  channel        TEXT NOT NULL,     -- telegram
  chat_id        TEXT NOT NULL,
  message_id     TEXT,              -- for editMessageReplyMarkup
  sent_at        TEXT,
  send_status    TEXT NOT NULL,     -- pending|sent|failed
  expires_at     TEXT NOT NULL,     -- approval window close (§5.3)
  ref_price      REAL,              -- price at notify time, for staleness check
  idem_key       TEXT NOT NULL UNIQUE   -- = position_event.dedup_key + channel + chat_id
);

CREATE TABLE approval (
  id                 INTEGER PRIMARY KEY,
  notification_id    INTEGER NOT NULL REFERENCES notification(id),
  event_id           INTEGER NOT NULL REFERENCES position_event(id),
  approver_account_id TEXT NOT NULL REFERENCES account(id),
  action             TEXT NOT NULL,   -- copy|skip|copy_half|snooze
  requested_qty      REAL,
  ref_price_at_tap   REAL,
  state              TEXT NOT NULL,   -- pending|confirmed|expired|stale_price|cancelled
                                      -- |queued_for_exec|executed|failed
  callback_query_id  TEXT,
  created_at         TEXT NOT NULL,
  resolved_at        TEXT,
  UNIQUE (event_id, approver_account_id)   -- ← double-tap protection, enforced by the DB
);
```

The `UNIQUE (event_id, approver_account_id)` constraint plus `notification.idem_key` are the two lines doing the real idempotency work. Everything else is bookkeeping.

---

## 4. Notification fan-out: Telegram vs WhatsApp vs Discord

### 4.1 The comparison

| | **Telegram Bot API** | **WhatsApp Business Cloud API** | **Discord** |
|---|---|---|---|
| Cost to send | Free | India, Jan 2026 local-currency billing: **marketing ₹0.88 / utility ₹0.13 / auth ₹0.13** per delivered template message; free-form replies inside the 24h window are free | Free |
| Bot setup | @BotFather, ~2 minutes, no business entity | Meta Business account + verified business + phone number + (usually) a BSP; template review queues | Developer portal app, ~10 minutes |
| Can the bot initiate a message? | Yes, any time, to anyone who has `/start`ed it | **Only via a pre-approved template** outside the 24-hour customer service window | Yes |
| Inline buttons | Native `InlineKeyboardMarkup` + `callback_query`, free, instant, editable after the fact | Interactive reply buttons **only inside the 24-hour window**; outside it you need an approved template with buttons; max 3 reply buttons | Message components (buttons, selects), native |
| Rate limits (published/community) | ~30 msg/s broadcast (1000/s with paid broadcasts); **≤1 msg/s per chat; ≤20 msg/min per group**; all methods incl. `answerCallbackQuery` count | Per-number throughput tiers + template quality ratings that can throttle you | Webhook 5 req/2s; per-channel 5 req/5s; global 50 req/s; interaction token valid 15 min |
| Editing a sent message | Yes (`editMessageText` / `editMessageReplyMarkup`) — key for "approved ✅" state | Not editable | Yes |
| Indian friend-group fit | Everyone will install it; used widely for trading/alert groups in India | Everyone already has it — but the *bot* story is bad | Only if the group is already gamers/devs |

### 4.2 Recommendation: **Telegram** _(recommendation)_

Three reasons, in order of weight:

1. **WhatsApp's initiation model is structurally wrong for this product.** The watcher's entire job is *unsolicited, server-initiated* alerts. On WhatsApp, every server-initiated message outside a 24-hour window must be a **pre-approved template** — meaning fixed structure, variable substitution only, and a review process. "Rohit added 40 shares of HDFC Bank at ₹1,712, +33% position size" fits a template awkwardly, and **interactive reply buttons are unavailable outside the 24h window**, which kills the one-tap approval UX at the root. Add per-message billing and a Meta business-verification requirement and there is genuinely no good hobby story here. Cost itself isn't the blocker (utility messages are ₹0.13; even 500 alerts/month across 15 people is ~₹1,000/month) — the *approval-button unavailability* and the onboarding friction are.
2. **Telegram gives us exactly the primitives the approval UX needs, free:** inline keyboards, `callback_query` with a payload we control, `answerCallbackQuery` for instant toast feedback, and `editMessageReplyMarkup` to mutate the buttons into a resolved state ("✅ Copied by Anjali"). No other channel gives all four at zero cost and zero business verification. Telegram's own docs note the same update may be delivered more than once, so dedup is expected of us anyway — and we already have it in the schema.
3. **Discord is technically fine but socially wrong** for an Indian friend group discussing money. Its component model is comparable to Telegram's; the objection is purely adoption. If the group already lives in Discord, Discord is an equally good technical choice and the design below ports almost unchanged (buttons → message components, `callback_query` → interaction, `answerCallbackQuery` → deferred interaction response, 15-min interaction-token expiry maps neatly onto approval expiry).

**Practical Telegram limits to design against:** ≤1 message/second in a single chat and **≤20 messages/minute in a group**. With one group chat, a burst of 25 position changes at 09:16 would hit the ceiling. Mitigation: **coalesce**. Batch all events detected in one polling tick per account into a single message ("Rohit made 3 changes: …"), and rate-limit the group to ≤10 msg/min with a queue. Approval buttons still work on a coalesced message — one button row per event, or a single "Review all 3" button opening a per-event DM.

### 4.3 Channel abstraction

Regardless of the choice, keep a `Notifier` interface (`send(event) -> message_id`, `update_markup(message_id, state)`, `on_action(callback)`) so the channel is a swappable adapter. The `notification` table already stores `channel` + `chat_id` generically. Cost of the abstraction: one afternoon. Cost of not having it when the group moves to WhatsApp: a rewrite.

---

## 5. Approval UX

### 5.1 Message flow

```
Rohit's account                Watcher                  Group chat (Telegram)         Anjali
      │                           │                              │                       │
      │◄── poll networth_holdings ─┤ (every 5 min, staggered)     │                       │
      ├── holdings JSON ──────────►│                              │                       │
      │                     ┌──────┴──────┐                       │                       │
      │                     │ diff vs     │                       │                       │
      │                     │ holding_    │                       │                       │
      │                     │ current     │                       │                       │
      │                     └──────┬──────┘                       │                       │
      │                            │ candidate: HDFCBANK 60→100   │                       │
      │                     ┌──────┴──────┐                       │                       │
      │                     │ corp-action │ H1 value continuity   │                       │
      │                     │ filter §2   │ H2 cross-account      │                       │
      │                     │             │ H3 NSE CA calendar    │                       │
      │                     └──────┬──────┘                       │                       │
      │                            │ → real trade, confidence=high│                       │
      │                     ┌──────┴──────┐                       │                       │
      │                     │ broadcast_  │ Rohit: mode=broadcast │                       │
      │                     │ pref check  │ value ≥ min_value_inr │                       │
      │                     └──────┬──────┘                       │                       │
      │                            │ INSERT position_event (dedup_key UNIQUE)             │
      │                            │ INSERT notification (idem_key UNIQUE, expires_at)     │
      │                            ├─ sendMessage + inline kbd ──►│                       │
      │                            │◄─ message_id ────────────────┤                       │
      │                            │                              ├── renders ───────────►│
      │                            │                              │                       │
      │                            │                              │◄── taps "Copy 50%" ───┤
      │                            │◄────────── callback_query ────┤                       │
      │                     ┌──────┴──────┐                                               │
      │                     │ answerCallbackQuery (<3s, always)   │                       │
      │                     │ validate: not expired? price fresh? │                       │
      │                     │ INSERT approval  ← UNIQUE(event,    │                       │
      │                     │        approver) rejects double-tap │                       │
      │                     └──────┬──────┘                                               │
      │                            ├─ editMessageReplyMarkup ────►│                       │
      │                            │  "✅ Anjali · 50%"           ├── updates in place ──►│
      │                            │                                                      │
      │                            └─► approval.state = queued_for_exec ──► EXECUTION LEG │
      │                                                                     (out of scope)│
```

Component view:

```
        ┌───────────────────────────────────────────────────────────┐
        │                      watcher server                        │
        │                                                            │
  ┌─────┴─────┐   ┌──────────┐   ┌───────────┐   ┌──────────────┐   │
  │ scheduler │──►│ MCP pool │──►│  differ   │──►│ CA filter    │   │
  │ (market-  │   │ (per-acct│   │ (§1.3)    │   │ (§2, H1-H5)  │   │
  │  hours    │   │  token,  │   └───────────┘   └──────┬───────┘   │
  │  aware,   │   │  backoff)│                          │           │
  │  jittered)│   └────┬─────┘                          ▼           │
  └───────────┘        │                        ┌──────────────┐    │
        │              │                        │ pref/scoping │    │
        │              ▼                        │    (§5.4)    │    │
        │      ┌───────────────┐                └──────┬───────┘    │
        │      │ mcp.indmoney  │                       ▼            │
        │      │    .com/mcp   │                ┌──────────────┐    │
        │      └───────────────┘                │  notifier    │    │
        │                                       │  (Telegram)  │    │
        │  ┌──────────────────────────────┐     └──────┬───────┘    │
        └─►│ SQLite (WAL)                 │◄───────────┤            │
           │  poll · holding_current      │            ▼            │
           │  position_event · corp_action│     ┌──────────────┐    │
           │  notification · approval     │◄────│ callback     │    │
           └──────────────────────────────┘     │ handler      │    │
                    ▲                           └──────┬───────┘    │
           ┌────────┴────────┐                         │            │
           │ nightly CA sync │                         ▼            │
           │ (NSE + BSE)     │                  ┌──────────────┐    │
           └─────────────────┘                  │ exec queue   │    │
                                                │ (out of scope)│   │
                                                └──────────────┘    │
        └───────────────────────────────────────────────────────────┘
```

### 5.2 Idempotency (double-tap protection)

Four layers, cheapest first:

1. **Callback payload carries the identity, not an index.** `cb:{event_id}:{action}:{nonce}` — never "the 3rd button". Telegram callback data is capped at 64 bytes, so use short integer ids, not JSON.
2. **`answerCallbackQuery` immediately, always** — within Telegram's 3-second expectation, before any DB work. Otherwise the user sees a hanging spinner and taps again, manufacturing the exact duplicate we're guarding against. Fast ack is itself the primary double-tap mitigation.
3. **DB-level uniqueness is the real guard:** `UNIQUE (event_id, approver_account_id)` on `approval`. Second tap → constraint violation → treat as success, re-answer the callback with "Already recorded ✅". Do not `INSERT OR REPLACE`; a second tap must not overwrite a queued execution.
4. **Update-level dedup:** Telegram may redeliver the same update. Keep a bounded LRU of processed `callback_query.id` (or `update_id`) for ~1 hour; drop repeats before they reach the handler.

Also: **`editMessageReplyMarkup` right after recording**, so the button visually resolves. Half of double-taps are users who saw no feedback.

### 5.3 Expiry / staleness

Two independent clocks — both must pass:

- **Wall-clock expiry:** `notification.expires_at = min(sent_at + 15 min, next market close)`. After that the callback returns "This trade signal expired" and the markup is replaced with a dead "⏳ expired" label. A background sweeper flips `approval.state`/notification markup at expiry so stale buttons don't linger overnight. Copy-trading a signal from three hours ago is a different trade.
- **Price staleness:** on tap, fetch `get_indian_stocks_details` for the instrument and compare to `notification.ref_price`.
  - drift ≤ **0.5%** → proceed straight to `queued_for_exec`.
  - 0.5–2% → **re-confirm**: edit the message to "Price moved 1.3% to ₹1,734 — still copy?" with fresh Confirm/Cancel buttons and a new 60-second window.
  - \> 2% → refuse, `state = 'stale_price'`, tell the user to act manually.
  These thresholds are starting guesses _(recommendation)_ and should be tuned per volatility — a 2% band is tight for a smallcap and loose for a large-cap ETF; consider scaling the band by the instrument's 20-day ATR.
- **Outside market hours:** any tap after 15:30 queues as `pending_next_open` with an explicit confirmation at 09:15 rather than auto-executing into the open. Never let an overnight-approved trade fire into a gap.

### 5.4 Visibility scoping — can a friend opt out?

**Yes, and this must be opt-*in* per account at onboarding, not opt-out.** Someone connecting a read-only brokerage feed to a group chat is exposing their entire financial life; the default must be the conservative one. Four modes, stored in `broadcast_pref` and resolvable at three granularities (global default → asset class → specific instrument, most specific wins):

| Mode | Group sees |
|---|---|
| `broadcast` | "Rohit added 40 HDFCBANK (+67% of position)" — name, instrument, direction, relative size |
| `anonymous` | "Someone in the group added HDFCBANK" — instrument + direction, no identity |
| `aggregate_only` | "2 members added HDFCBANK this week" — weekly digest, no per-trade events |
| `private` | nothing; the account is watched for the owner's own use only |

Additional controls worth having:
- **Never absolute rupee amounts by default.** Broadcast percentage-of-position or a coarse bucket ("small / medium / large"). Position sizing is the most sensitive number in the whole feed and is not needed for copy-trading decisions — the follower sizes to their own book anyway.
- **`min_value_inr` floor** so tiny rebalances don't spam.
- **Per-instrument mute** (`/mute HDFCBANK`) and **global pause** (`/pause`, `/resume`) as Telegram commands — a friend must be able to go dark instantly, without a config file.
- **Retroactive delete:** `/oops` within N minutes deletes the group message and marks the event `suppressed`. The event log keeps the row (append-only), but the audience doesn't.
- **Asymmetry is fine and should be allowed:** a member may consume everyone's signals while broadcasting none. Enforcing reciprocity is a social problem; do not encode it in software.

---

## 6. Key risks

| Risk | Impact | Mitigation |
|---|---|---|
| No intraday/positions tool; holdings are settled-only | Same-day copy-trading impossible; alerts arrive T+1 | **Verify first (§0).** If confirmed, reframe the product as a "portfolio activity feed," not a copy-trading signal. |
| Unknown per-user rate limits | Silent throttling, or account lockout | Start at 5-min probes, per-account adaptive backoff, circuit breaker |
| Token expiry / re-auth friction | Accounts silently go dark | `auth_state` machine + DM nags + a group-visible "3 members need to reconnect" weekly line |
| Corporate action → false "bought more" → someone copies | Real money lost | H1+H2 suppress without external deps; bias to suppression; two-poll confirmation for closures |
| Partial/malformed payload read as mass liquidation | Alert storm, panic | Row-count sanity check, hard suppression above 3 closures/tick |
| Telegram 20 msg/min group cap | Dropped alerts at open | Coalesce per account per tick, outbound queue |
| Privacy blowback | Friend group fallout, irreversible | Opt-in default, no absolute amounts, instant `/pause` |
| Regulatory posture | Copy-trading with approvals may edge toward unregistered investment advice in India | Out of scope for this appendix — **flag for a separate legal read before the execution leg ships.** |

---

## Sources

- INDmoney MCP overview and tool list — <https://www.indmoney.com/mcp>
- Telegram Bot API reference — <https://core.telegram.org/bots/api>
- Telegram Bot FAQ (broadcast / per-chat / per-group limits) — <https://core.telegram.org/bots/faq>
- python-telegram-bot `CallbackQuery` (must always answer; duplicate delivery) — <https://docs.python-telegram-bot.org/en/stable/telegram.callbackquery.html>
- WhatsApp interactive reply buttons (24h window constraint), Meta — <https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages>
- WhatsApp service messages / customer service window, Meta — <https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages>
- WhatsApp Business API India pricing 2026 — <https://setsmart.io/blog/whatsapp-business-api-pricing> and <https://2factor.in/v3/lp/whatsapp-business-api-pricing.php>
- Discord rate limits — <https://docs.discord.com/developers/topics/rate-limits>
- NSE corporate filings & actions — <https://www.nseindia.com/companies-listing/corporate-filings-actions>
- NSE corporate action adjustments (derivatives, ex-date mechanics) — <https://www.nseclearing.in/clearing-settlement/equity-derivatives/corporate-actions-adjustment>
- `NseIndiaApi` Python wrapper (`NSE.actions()`) — <https://bennythadikaran.github.io/NseIndiaApi/api.html>
- T+1 settlement in India (effective 27 Jan 2023) — <https://www.fisdom.com/t1-settlement-for-indian-equities/>
- Optional T+0 settlement rollout — <https://www.citigroup.com/global/insights/navigating-india-t-0> and <https://select.finology.in/articles/broker/sebi-extends-t0-settlement-deadline>
