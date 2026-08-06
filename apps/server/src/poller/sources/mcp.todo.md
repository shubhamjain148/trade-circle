# `McpPortfolioSource` — the seam, not yet built

`src/poller/source.ts` defines the only contract the rest of the watcher knows about:

```ts
interface PortfolioSource {
  readonly name: string;
  fetchHoldings(accountId: string): Promise<Position[]>;
  fetchNetWorthHash(accountId: string): Promise<string>;
}
```

`MockPortfolioSource` implements it today. The real implementation goes in
`src/poller/sources/mcp.ts` and plugs into `src/index.ts` and `src/seed.ts` by
swapping one constructor call. Nothing else in the codebase should learn that MCP exists.

## What it has to do

Background and the verified protocol details are in **docs/appendix-1-mcp-headless.md**;
the polling/diff design it feeds is **docs/appendix-2-watcher-architecture.md**.

1. **Transport.** MCP is plain JSON-RPC over streamable-http against
   `https://mcp.indmoney.com/mcp`. No model in the loop. `initialize` handshake, then
   `tools/call`.
2. **Auth.** OAuth 2.1 + PKCE with open dynamic client registration. Each friend logs in
   once in a browser; the server keeps a per-account `refresh_token` and refreshes
   silently. Scopes are `portfolio:read` + `market:read` — no writable scope exists.
   Token material must not live in `watcher.db`: OS keychain, an age-encrypted file, or
   a sealed blob (appendix 2 §3.2). The `accounts.status` column already carries
   `needs_reauth` for the 401 path.
3. **`fetchNetWorthHash` → `networth_snapshot`.** Cheap change-detector. Hash the
   normalized totals. This is what keeps the call budget at ~10/account/day.
4. **`fetchHoldings` → `networth_holdings`**, filtered to US equities. Map each row to
   `Position`:
   - `instrumentId` — the INDmoney internal key from `lookup_ind_keys`, **never the
     ticker**. A rebrand would otherwise emit a spurious EXITED + NEW_POSITION pair.
   - `qty` is fractional on US holdings; the diff engine's relative threshold exists
     for exactly this.
   - `avgCost` and `mktValue` are load-bearing: H1 corporate-action suppression is
     built entirely out of them. If a field is missing, leave it `null`-ish rather
     than guessing — H1 skips candidates it cannot evaluate.
5. **Errors.** Throw on failure and let `runPollTick` drive `Backoff`. Before that
   is useful the stub in `tick.ts` needs the real curve from appendix 2 §1.2:
   honor `Retry-After`, full jitter, `base = 30s` for 5xx, and stop polling entirely
   on 401 rather than backing off.

## Open question that gates all of this

Appendix 2 §0: it is **unverified** whether `networth_holdings` reflects same-day
activity or only settled positions. If settled-only, events arrive T+1 and the product
is a portfolio activity feed, not a live signal. Verify empirically before tuning cadence.
