# Connecting an INDmoney account

How a friend joins the watcher, what they are consenting to, and how to leave.

## 1. Getting an invite

Members are created by whoever runs the server (`src/seed.ts`, or by hand). Once a
member row exists, mint them a single-use join link:

```bash
pnpm --filter server invite m1
# → http://localhost:5173/#/join?token=<one-time-token>
```

Send it directly to that person, not to the group chat. The link:

- works exactly once — opening it a second time returns `invalid_or_used_invite`
- is stored only as a SHA-256 hash, so a database dump cannot be replayed as a login
- sets a `httpOnly; SameSite=Lax` session cookie good for 90 days

Losing the link is not a problem — mint another one.

## 2. Connecting INDmoney

From Settings, "Connect INDmoney" sends the browser to
`GET /api/connect/indmoney/start`, which discovers INDmoney's authorization server,
registers this app once (dynamic client registration), and redirects to INDmoney's
own consent screen.

**What that screen shows.** The friend logs in on `indmoney.com` with their usual
mobile number, OTP and MPIN — this server never sees any of it. The consent screen
names the client (`trade-circle` by default; set `MCP_CLIENT_NAME` to change it)
and the two scopes being requested:

- `portfolio:read` — holdings, quantities, P&L, XIRR, SIPs
- `market:read` — prices and instrument details

There is no writable scope in INDmoney's MCP. Nothing here can place a trade,
move money, or change a setting — read-only is architectural on their side, not a
toggle on ours.

**What that consent does and does not cover.** It authorises *this server* to read
*that friend's* portfolio. It is not consent to broadcast their positions to the
group. Visibility is a separate, per-member setting (`named` / `anonymous` /
`paused`) and should be agreed explicitly.

After approval INDmoney redirects to `/api/connect/indmoney/callback`, which
exchanges the code, encrypts the tokens into the vault, and bounces the browser to
`/#/settings?connected=1`. On failure it bounces to `/#/settings?connect_error=…`.

**The first fetch.** The callback also kicks off a poll of *that one account* before
it redirects, without waiting on it — `ctx.waitUntil()` on Workers, a detached
promise under Node. So a new friend's baseline lands in seconds rather than at the
next cron slot. Until it does, `GET /api/me` reports the account as `pending` and
Settings says it is fetching your positions; the page re-reads `/api/me` every three
seconds and flips itself to Connected when `lastPolledAt` is set. If the fetch fails
the grant still stands, and the next scheduled pass picks the account up.

## 3. Staying connected

Access tokens are short-lived. The server refreshes them silently — proactively
just before expiry, and again on any 401 — and persists the rotated refresh token
each time. If refresh itself fails, the account flips to `needs_reauth`, which shows
up in `GET /api/me` and `GET /api/accounts`; reconnecting is the same two clicks as
the first time and takes about thirty seconds.

How often a full re-login is actually needed is the one thing nobody has measured
(appendix 1 §6). Watch it after the first real connect.

## 4. Disconnecting

**From here:** `DELETE /api/connect/indmoney` (the Disconnect button). It calls
INDmoney's revocation endpoint, then deletes the stored tokens and marks the
account `revoked`. The local wipe happens even if the remote call fails.

**From INDmoney:** revoke the connected app in INDmoney's own settings. Do this too
if you want certainty — it kills the grant at the source, and the next poll here
will simply fail and mark the account `needs_reauth`.

Either way, historical feed events already recorded stay in the database. Ask the
operator to delete the member if you want those gone as well.

## 5. First real connect: read the tool catalog

INDmoney publishes no tool schemas, and third-party clients disagree about the
names (`networth_holdings` vs `get_user_networth_v2`). So the callback captures the
raw `tools/list` response into the `tool_catalog` table on every connect.

**After the first genuine connect, read it and fix `src/mcp/toolmap.ts`:**

```bash
sqlite3 apps/server/data/watcher.db \
  "SELECT tools_json FROM tool_catalog ORDER BY id DESC LIMIT 1;" | jq .
```

Check the real tool names, their argument names (`asset_type`? something else?),
and the field names in the holdings rows. The normalizer in `src/mcp/normalize.ts`
guesses across a candidate list, but the fixtures in `normalize.test.ts` are
inventions and should be replaced with a real (redacted) payload once one exists.
Overrides can be applied without a code change via `MCP_TOOL_*` env vars.
