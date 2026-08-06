# Appendix 1 — Can a headless backend be an MCP client for INDmoney?

**Status:** research only. Nothing in this document was produced by authenticating to INDmoney.
**Date of probes:** 2026-08-06 (all live probes re-runnable; see §5).
**Method:** unauthenticated HTTP probes of public OAuth discovery endpoints + web research.

> **Evidence legend used throughout:**
> **[V]** = verified by a live unauthenticated probe run today, output pasted inline.
> **[D]** = documented by a first-party INDmoney source.
> **[S]** = spec/SDK-level fact with a citation.
> **[?]** = inference or speculation — explicitly flagged.

---

## Addendum (2026-08-06): Superseded by live verification

Everything below this box was written before any real login. Later the same day the project made
its first genuine OAuth connect + poll against `mcp.indmoney.com`. Full facts and the "still open"
list live in `RESEARCH.md` (§6a, dated the same day) — this box is the pointer from the document
that was speculating to the one with the answer. Marked **[LIVE]** below for anything this
document's body got wrong or should no longer be treated as open.

- **§2.4 token lifetime — resolved [LIVE].** Access-token TTL is **exactly 1 hour** (`expires_at`
  showed +1h from issuance) — confirms the "~1h [?]" guess in §6 item 4 and the middle row of the
  §2.4 re-login table. A refresh token *was* issued. **Still open, exactly as §6 item 1/2 said:**
  whether it rotates and its own hard expiry — the first real refresh exercise happens ~1h after
  connect, not yet observed.
- **§2.5 tool count — resolved [LIVE].** `tools/list` returned **15 tools**, confirming the "15
  actually present" finding and this document's own tool-name list almost exactly — see
  `RESEARCH.md` for the verbatim 15 names as observed live (naming matches this doc's §2.5 list,
  not the `get_user_networth_v2` alias some third-party clients used).
- **§2.5 argument shapes — corrected [LIVE].** `networth_holdings{asset_type}` takes an *enum*, not
  a free string: `IND_STOCK, MF, US_STOCK, BOND, EPF, NPS, SA, FD, CRYPTO, INSURANCE, VEHICLE, RE,
  RD, AIF, PMS, PPF`. An unrecognized value does **not** error — it silently returns an empty list.
  `networth_snapshot` takes no arguments at all (this doc didn't cover its shape).
- **New, not anticipated by this document:** results arrive double-wrapped — both
  `content[0].text` (a JSON string) and `structuredContent.result` (also a JSON string) — because
  the server runs on FastMCP. Unwrap both.
- **New:** holdings rows carry no ticker symbol anywhere, only `investment_code` /
  `investment` (name) — `lookup_ind_keys` is the only name→id path, exactly as this doc assumed but
  never confirmed against a real payload.
- **New:** INDmoney aggregates external-broker holdings too (a Zerodha position appeared under
  `IND_STOCK` with `broker: "Zerodha"`) — broader visibility than "INDmoney-native holdings only."
- **Still fully open** (this document's §5/§6 checklist items not yet touched by the live connect):
  refresh rotation/hard expiry (P12, only partially begun), rate-limit shape (P15), protocol
  revision negotiation (P14), DCR `client_secret` expiry (P8), ToS restriction on non-Claude clients
  (item 10), concurrent-session behavior (P16).

---

## 0. Executive answer

Yes. A plain backend server can be a fully-fledged MCP client to `https://mcp.indmoney.com/mcp`.
Nothing about MCP requires an LLM in the loop — the client is a JSON-RPC client, and `tools/call`
is just an RPC. The blocker is not protocol, it is **consent UX**: INDmoney's authorization server
advertises only `authorization_code` and `refresh_token` grants **[V]**, so every friend must
personally complete a browser-based mobile+OTP+MPIN login once. There is no machine-to-machine
path.

The single most important finding: **INDmoney issues refresh tokens, and third-party clients are
already using them in production.** `grant_types_supported` includes `refresh_token` **[V]**, and
an independent open-source client documents "silently obtain a new one using the stored refresh
token" as a working feature **[S]** (§2.4). That converts the project from "everyone re-logs in
constantly" to "everyone logs in once, and the backend silently refreshes." The remaining unknown
is the refresh token's *own* hard expiry, which nobody has published.

**Second-most important, and it validates the whole premise:** an independent client's
architecture notes state that INDmoney's MCP exposes tools "all for the authenticated individual
account — **no family/multi-member tools exist**" **[S]**. So a per-friend OAuth token really is
the *only* way to see multiple people's positions. There is no shortcut and no family API to
discover.

---

## 1. Can a backend server speak MCP directly?

### 1.1 Yes — MCP has no LLM requirement

MCP is a JSON-RPC 2.0 protocol. The "client" role in the spec is a protocol role, not an AI role.
The [MCP specification](https://modelcontextprotocol.io/specification/versioning) defines clients
purely in terms of transports, capabilities and RPC methods; an LLM is one possible *consumer* of
a client, never a required component. Calling `tools/call` from a cron job is as spec-legal as
calling it from Claude.

**Important version note:** the current protocol revision is **`2026-07-28`**, not `2025-06-18`
([versioning page](https://modelcontextprotocol.io/specification/versioning)). That revision
replaced the `initialize` handshake with per-request version declaration via the
`io.modelcontextprotocol/protocolVersion` key in `_meta` (plus the `MCP-Protocol-Version` header
on Streamable HTTP), and added a mandatory `server/discover` RPC that returns supported protocol
versions and capabilities in one request. Backward compatibility with handshake-based revisions
(`2025-11-25` and earlier) is explicitly specified. **[S]**

Practical consequence: pin your client SDK version deliberately and be ready to negotiate down —
we do **not** know which revisions INDmoney supports, because the server 401s before any version
negotiation happens (§5, probe P6).

### 1.2 Transport

INDmoney is `streamable-http` **[D]** — confirmed by INDmoney's own published Claude Code config
on <https://www.indmoney.com/mcp>:

```json
{
  "mcpServers": {
    "indmoney": {
      "url": "https://mcp.indmoney.com/mcp",
      "type": "streamable-http"
    }
  }
}
```

Streamable HTTP is a plain HTTPS endpoint that accepts `POST` of JSON-RPC and may respond with
either `application/json` or an SSE stream. Any HTTP client can drive it; the SDKs mainly wrap
retries, streaming and auth.

⚠️ **The transport changed materially in the 2026-07-28 revision** — it lists *"Removal of the GET
stream endpoint. Removal of protocol-level sessions."* Older clients used an `Mcp-Session-Id`
header and a long-lived GET/SSE channel; the current revision makes every request an independent
POST carrying `Authorization` and `MCP-Protocol-Version`. **Which shape INDmoney speaks is unknown
(P14) and determines which SDK major version to pin.** **[S]**

### 1.3 SDKs — and a version warning

Both official SDKs ship a client *and* a full OAuth client implementation, which is the part that
matters here. **The Python SDK is now at v2.0.0 and its client API changed** — older tutorials
showing `streamablehttp_client` + `ClientSession` are out of date. v2 tracks the `2026-07-28`
spec and added RFC 9207 issuer validation, the SEP-990 identity-assertion flow, and a
client-credentials extension
([release notes](https://github.com/modelcontextprotocol/python-sdk/releases/tag/v2.0.0)).

**Python (v2)** — the OAuth provider is an `httpx2.Auth` implementation that you attach to the
HTTP client; the `Client` itself stays entirely unaware of OAuth. Verbatim from the
[official OAuth client docs](https://py.sdk.modelcontextprotocol.io/client/oauth-clients/):

```python
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.client.auth import OAuthClientProvider, AuthorizationCodeResult
from mcp.shared.auth import OAuthClientMetadata, OAuthToken, OAuthClientInformationFull

oauth = OAuthClientProvider(
    server_url="https://mcp.indmoney.com/mcp",
    client_metadata=OAuthClientMetadata(
        client_name="...",
        redirect_uris=[AnyUrl("https://your-server/callback")],
        scope="portfolio:read market:read",
    ),
    storage=YourPerFriendTokenStorage(),   # <-- the vault seam, see §3.2
    redirect_handler=send_url_to_friend,   # <-- your out-of-band delivery
    callback_handler=wait_for_callback,    # <-- your HTTPS callback route
)

async with httpx2.AsyncClient(auth=oauth, follow_redirects=True) as http_client:
    transport = streamable_http_client("https://mcp.indmoney.com/mcp", http_client=http_client)
    async with Client(transport) as client:
        result = await client.list_tools()
```

`TokenStorage` is a **protocol, not a base class** — implement four async methods
(`get_tokens`, `set_tokens`, `get_client_info`, `set_client_info`) and no inheritance is needed.
The docs explicitly advise persisting `client_info` "to avoid re-registration on subsequent runs".
**This is precisely the seam where a per-friend encrypted token vault plugs in (§3.2)** — the
architecture we need is a first-class, documented extension point, not a hack.

The provider "handles discovery, registration, PKCE, token exchange, and refresh automatically."

**Two Python correctness traps, straight from the SDK source [S]:**

- **You must persist `client_info`, not just tokens.** Internally `can_refresh_token()` returns
  `bool(tokens and refresh_token and client_info)` — **without stored client info the SDK silently
  will not refresh**, and your friend gets a spurious re-login prompt. This is the #1 way to
  accidentally build the "nags everyone daily" version of this project.
- **Set an explicit timeout.** A bare `httpx2.AsyncClient()` defaults to a flat 5 seconds, far too
  short for streaming responses. Use `httpx2.Timeout(30, read=300)`.

**TypeScript** — note there are now **two live package lines**: the classic
`@modelcontextprotocol/sdk` (v1.30.x) and the new `@modelcontextprotocol/client` (v2.0.0,
published 2026-07-27). **v2 makes the headless case dramatically simpler** — the whole auth
interface collapses to
([docs/clients/machine-auth.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/machine-auth.md)):

```ts
export interface AuthProvider {
  token(): Promise<string | undefined>;
  onUnauthorized?(ctx: { response: Response; serverUrl: URL; fetchFn: FetchLike }): Promise<void>;
}
```

> "The transport calls `token()` before every request and sets the `Authorization` header from
> whatever it returns. Without `onUnauthorized`, a 401 throws `UnauthorizedError`. Add
> `onUnauthorized(ctx)` to refresh the credential and the transport retries the request once."

So a per-friend backend client is genuinely about five lines:

```ts
const authProvider: AuthProvider = {
  token: () => db.getAccessToken(friendId),
  onUnauthorized: async ctx => { await refreshAndStore(friendId, ctx.fetchFn); },
};
await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider }));
```

*(In v1 the equivalent is the much larger `OAuthClientProvider` interface plus the `auth()` helper
and `finishAuth()`; a `redirectUrl` of `undefined` selects the non-interactive path but then
requires you to implement `prepareTokenRequest`. **If starting fresh, use v2.**)* **[S]**

**Recommendation:** pin deliberately. Both SDK families shipped breaking v2 renames on
2026-07-27/28, and most tutorials online still describe v1.

Both SDKs let you call tools directly (`call_tool` / `list_tools`) — no model, no sampling, no
agent loop. A model only ever enters if *you* pass a `sampling_callback`; the default returns an
error. **[S]**

**Two adaptations for a headless multi-user server:**

1. **Redirect handling.** The default handlers assume a local browser and a loopback redirect.
   You override `redirect_handler` (post the URL to the friend out-of-band — DM, group chat) and
   `callback_handler` (a public HTTPS route that receives `code`+`state`+`iss`, looks up the PKCE
   verifier by `state`, and completes the exchange). That's a normal three-legged OAuth web app —
   the same shape as "Login with Google".
2. **`ClientCredentialsOAuthProvider` is a trap here.** The SDK ships one
   (`mcp.client.auth.extensions.client_credentials`) and it is very tempting for a backend — but
   **INDmoney does not support the `client_credentials` grant** (§2.2 **[V]**). Don't design
   around it.

**Identity assertion / SEP-990 does not apply either.** It sounds relevant ("enterprise-managed
authorization", no browser flows) but it requires an enterprise IdP issuing ID-JAG tokens via the
RFC 7523 `jwt-bearer` grant, which INDmoney does not advertise **[V]**. It is not a way to avoid
per-friend consent.

### 1.4 What the spec requires of your client (revision 2026-07-28)

From [the authorization spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization):

| Requirement | Level | Notes |
|---|---|---|
| RFC 9728 Protected Resource Metadata for AS discovery | **MUST** (client) | Server MUST implement it |
| RFC 8414 AS metadata **or** OIDC Discovery | Server MUST provide ≥1; **client MUST support both** | |
| PKCE | **MUST** (OAuth 2.1) | |
| RFC 8707 `resource` parameter | **MUST** be sent in *both* authorization and token requests | "MCP clients **MUST** send this parameter regardless of whether authorization servers support it." |
| Token audience binding | Server **MUST** validate tokens were issued for it | |
| RFC 9207 `iss` validation | Client **MUST** validate `iss` against recorded issuer before sending the code to any token endpoint | New/tightened in this revision |
| `Authorization: Bearer` on **every** HTTP request | **MUST** | Tokens **MUST NOT** go in the query string |
| Token passthrough | Clients **MUST NOT** send tokens other than those issued by the server's own AS; servers **MUST NOT** accept or transit others | |
| Refresh tokens | Client **SHOULD** include `refresh_token` in its `grant_types` client metadata; **MUST NOT** assume they'll be issued | |

**Client registration has changed and this matters for us.** The
[client registration page](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)
defines three mechanisms with an explicit priority order:

1. Pre-registered credentials, if available
2. **Client ID Metadata Documents (CIMD)** — if the AS advertises `client_id_metadata_document_supported: true`
3. **Dynamic Client Registration** — fallback, if `registration_endpoint` is present
4. Prompt the user to enter client details

DCR now carries an explicit deprecation warning: *"Dynamic Client Registration is deprecated. New
implementations should use Client ID Metadata Documents instead. This option remains available for
backwards compatibility with authorization servers that do not support Client ID Metadata
Documents."* **[S]**

**Where INDmoney lands:** its AS metadata contains **no `client_id_metadata_document_supported`
field** and **does** expose `registration_endpoint` **[V]**. So under the spec's own priority
order, **DCR is the correct and only available choice** for us. We are using a deprecated
mechanism because the server gives us no alternative — that's spec-sanctioned, not a smell. The
forward-compat risk is that INDmoney eventually moves to CIMD; that would be a small, contained
migration (host a JSON document, swap the `client_id`) **[?]**.

Two DCR details that will bite in practice **[S]**:

- **`application_type` MUST be specified.** Omitting it defaults to `"web"` under OIDC, which
  conflicts with native-style redirect URIs. Our backend has a real remote HTTPS callback, so
  `application_type: "web"` is correct — but specify it explicitly.
- **Credentials MUST be keyed to the issuer.** Store the DCR `client_id`/`client_secret` against
  `issuer: "https://mcp.indmoney.com/"`, and if PRM ever points at a different AS, **re-register
  rather than reuse**.

---

## 2. INDmoney's actual OAuth surface (all verified today)

This is the highest-value section: it replaces guesswork with measured facts. Every response below
was obtained with `curl` against public endpoints, with **no credentials sent**.

### 2.1 Protected Resource Metadata + the 401 challenge — **[V]**

An unauthenticated `POST https://mcp.indmoney.com/mcp` returns:

```
HTTP/2 401
www-authenticate: Bearer error="invalid_token", error_description="Authentication required",
                  resource_metadata="https://mcp.indmoney.com/.well-known/oauth-protected-resource"
x-request-id: 01KZB3DNV4JQ1WPZWEBTJ04T0E
```

```json
{"error":"invalid_token","error_description":"Authentication required"}
```

So INDmoney is **RFC 9728 compliant** and points at its PRM document. Note the `x-request-id` —
this is the SEBI-compliance request ID INDmoney advertises **[D]**, and it is emitted even on
unauthenticated requests.

`GET /.well-known/oauth-protected-resource/mcp` (the correct path-suffixed form for a resource at
`/mcp`) returns:

```json
{
  "resource": "https://mcp.indmoney.com/mcp",
  "authorization_servers": ["https://mcp.indmoney.com/"],
  "scopes_supported": ["portfolio:read", "market:read"],
  "bearer_methods_supported": ["header"]
}
```

The root form `/.well-known/oauth-protected-resource` also resolves, but to a *different* document
with a narrower scope list (`["portfolio:read"]` only) and `resource: "https://mcp.indmoney.com/"`.

> ⚠️ **Gotcha worth writing down.** The `WWW-Authenticate` header points at the **root** PRM
> document, whose `resource` is `https://mcp.indmoney.com/`, but the actual MCP endpoint is
> `https://mcp.indmoney.com/mcp` and its PRM declares `resource: "https://mcp.indmoney.com/mcp"`.
> Since the spec requires you to send `resource=` as the canonical URI of the server you intend to
> use, and requires the server to validate audience, there is a real chance of an audience mismatch
> depending on which value you send. **Try `https://mcp.indmoney.com/mcp` first**, fall back to
> `https://mcp.indmoney.com`. This is exactly the kind of thing the 1-hour probe (§5) settles.

Also note: the 401 does **not** include a `scope` parameter, which the spec says servers
**SHOULD** provide. So per the spec's fallback rule, request all of `scopes_supported`.

### 2.2 Authorization Server Metadata — **[V]**

`GET https://mcp.indmoney.com/.well-known/oauth-authorization-server`:

```json
{
  "issuer": "https://mcp.indmoney.com/",
  "authorization_endpoint": "https://mcp.indmoney.com/authorize",
  "token_endpoint": "https://mcp.indmoney.com/token",
  "registration_endpoint": "https://mcp.indmoney.com/register",
  "scopes_supported": ["portfolio:read", "market:read"],
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic"],
  "service_documentation": "https://mcp.indmoney.com/docs",
  "revocation_endpoint": "https://mcp.indmoney.com/revoke",
  "revocation_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic"],
  "code_challenge_methods_supported": ["S256"]
}
```

`GET /.well-known/openid-configuration` → **404**. So RFC 8414 only, no OIDC discovery.

**Six things fall straight out of this document:**

1. **`refresh_token` is a supported grant.** This is the headline. See §2.4.
2. **No `client_credentials`.** There is no machine-to-machine path. Every friend must do a
   browser login. This is not a limitation you can engineer around.
3. **DCR is available** at `/register`.
4. **PKCE S256 is mandatory** — and `plain` is actively rejected (proved below).
5. **Confidential clients only.** `token_endpoint_auth_methods_supported` lists
   `client_secret_post` and `client_secret_basic` but **not `none`**. A registered client gets a
   secret and must authenticate at the token endpoint. For a backend server this is *good* — you
   can hold a secret safely, unlike a desktop app.
6. **A revocation endpoint exists** — clean per-friend offboarding is possible programmatically.

There is **no `authorization_response_iss_parameter_supported`** field, so under the
2026-07-28 rules you fall into the "false or absent" rows: validate `iss` if present, proceed if
absent. **[S]**

### 2.3 Dynamic Client Registration is open and unauthenticated — **[V]**

`GET /register` → `405`, `allow: OPTIONS, POST`.

A deliberately **empty** `POST` (which creates nothing — it fails metadata validation before any
record is written) returns:

```json
{"error":"invalid_client_metadata","error_description":"redirect_uris: Field required"}
```

That is an **RFC 7591 metadata validation error**, not an authorization error. If registration
were closed or gated we'd expect `401`/`403`/`access_denied`. So: **open dynamic client
registration, no pre-approval, no partner agreement needed to get a `client_id`.** **[V]**

Corroborating: `GET /authorize?client_id=probe-nonexistent&...` returns

```json
{"error":"invalid_request","error_description":"Client ID 'probe-nonexistent' not found","state":"xyz"}
```

— i.e. there is no shared/implicit client; registration is genuinely the only way in.

**PKCE enforcement, proven:**

```
GET /authorize (no params)
→ {"error":"invalid_request","error_description":"client_id: Field required\nresponse_type: Field required\ncode_challenge: Field required"}
```

`code_challenge` is a **required field**, so PKCE cannot be skipped. And:

```
GET /authorize?...&code_challenge_method=plain
→ {"error":"invalid_request","error_description":"code_challenge_method: Input should be 'S256'"}
```

S256 enforced. Also worth noting: that last request included `&resource=https://mcp.indmoney.com/mcp`
and the server did **not** reject the parameter — weak positive evidence that RFC 8707 resource
indicators are at least tolerated **[?]** (tolerated ≠ honoured; only a real token's `aud` claim
would prove it).

`POST /token` with an empty body → `401 {"error":"unauthorized_client","error_description":"Missing client_id"}`.

### 2.4 Token lifetime and refresh — what we know and what we don't

**What is verified [V]:** the authorization server advertises `refresh_token` in
`grant_types_supported`. An AS that advertises the grant but never issues refresh tokens would be
unusual, though the spec explicitly warns clients **MUST NOT** assume refresh tokens will be
issued **[S]**.

**🔑 What independent client code confirms [S] — this is the strongest evidence we have.** Several
open-source third-party clients already drive this exact server, and their docs describe refresh
working in production. `ritexlabs/ai-desk-companion` (`docs/agents/portfolio.md`) states:

> "Access tokens expire. Click **Refresh token** in the Portfolio settings to silently obtain a
> new one using the stored refresh token. The app will also remind you when the token is near
> expiry."

That is real-world corroboration that (a) a `refresh_token` **is** actually issued, and (b) a
non-Claude, third-party, DCR-registered client can use it to silently renew. **This substantially
de-risks the project's central assumption.** What it still does not tell us is the refresh token's
*own* hard expiry — i.e. how often the friend must do a full OTP+MPIN login again. Nobody has
published that number.

The same source documents a failure mode worth designing for now: an `invalid_request` on the
redirect caused by a **stale `client_id`**, fixed by disconnect/reconnect to force fresh dynamic
registration. **Store DCR credentials durably, but handle their invalidation gracefully** — treat
`invalid_client`/`invalid_request` at authorize time as "re-register, then retry."

**What INDmoney documents [D]** (from <https://www.indmoney.com/mcp>) — note how carefully it
avoids numbers:

- "Tokens are short-lived for security. Click the re-auth link Claude shows; **the sign-in flow
  takes about 30 seconds.**" ← the only quantified thing INDmoney says, and it's about the *cost*
  of re-auth, not its frequency. 30 seconds per friend is cheap if it's weekly, intolerable if
  it's hourly.
- "short-lived and rotated automatically"
- "stored encrypted server-side, never on your device, never in plain text"
- "If exposed, it expires before it can be reused"
- Users see "Session expired, please re-authenticate" prompts — **frequency unspecified**
- "Revoke access in two clicks"; "The connection is killed immediately"
- "INDmoney MCP applies per-user rate limits to keep the service responsive for everyone" —
  **no numbers published**

**⚠️ A correction to a widely-repeated claim.** Search results conflate the official server with a
community project. The figures **"AES-256-GCM encrypted sessions with a 12-hour TTL"** and
"persists across server restarts" come from a **third-party, unofficial, Playwright-screen-scraping
INDmoney MCP server** described in
[this DEV.to post](https://dev.to/vigneshwaran_m/i-built-an-mcp-server-for-indmoney-ask-claude-about-your-portfolio-in-plain-english-431i)
— **not** from `mcp.indmoney.com`. Do not plan around a 12-hour TTL. It is not an INDmoney number.
(The same caution applies to `mcp.so/servers/indmoney-mcp-python`, `SharunIyer/indian-broker-mcp`,
and `Sparker0i/indian-stock-mcp-agent` — all community, all unrelated to the first-party server.)

**Realistic UX cost per friend — three scenarios [?]:**

| Scenario | Re-login cadence | Viability for a friend group |
|---|---|---|
| Long-lived rotating refresh token (weeks–months) | Once, then effectively never | ✅ Fine |
| Refresh token capped to a session (e.g. 12–24h) | Daily | ⚠️ Annoying but survivable with a good nudge bot |
| No refresh token issued in practice; access token ~1h | Hourly | ❌ Project is dead as designed |

We genuinely cannot distinguish these without one real token exchange. **Say so plainly in the
main synthesis: this is the single go/no-go variable, and it costs one friend ten minutes to
resolve.**

A useful outside signal on the *general* fragility of MCP OAuth refresh: multiple open Anthropic
issues report MCP connectors expiring daily even with valid refresh tokens —
[claude-code#65036](https://github.com/anthropics/claude-code/issues/65036) ("MCP OAuth: Claude
doesn't auto-refresh access tokens, daily 'Connection expired' despite valid refresh token"),
[claude-code#43789](https://github.com/anthropics/claude-code/issues/43789),
[claude-code#77130](https://github.com/anthropics/claude-code/issues/77130) (one session's refresh
invalidating connectors in other concurrent sessions). Those are *client* bugs, and a purpose-built
backend avoids most of them — but #77130 is a warning that **refresh-token rotation can invalidate
concurrent sessions**, which is directly relevant if your backend and the friend's own Claude app
hold tokens for the same account **[?]**.

### 2.5 The tools — 14 documented, **15 actually present**

INDmoney's page lists 14 **[D]**; **input schemas are not published anywhere**. But several
open-source clients drive the live server and have reverse-engineered the real schemas, which is
far more useful than the marketing copy.

*Lookup:* `lookup_ind_keys` — resolve names → INDmoney `ind_key` identifiers.

*Portfolio:* `networth_snapshot`, `networth_allocation_breakdown`, `networth_holdings` (units,
P&L, XIRR per instrument), `user_watchlist`, `indian_stocks_sips`, `mf_sips`.

*Market data:* `get_indian_stocks_ohlc`, `get_indian_stocks_details`,
`get_indian_stocks_option_chain`, `get_indian_stocks_greeks_history`, `get_mf_by_category`,
`get_mf_funds_details`, `get_us_stocks_details`.

**🔎 A 15th tool exists that the official page omits [S]:** `get_indian_stocks_movers`.
`ishanavasthi/alphadesk` (`backend/tools/ind_money.py`) comments *"Valid categories for
get_indian_stocks_movers (from the live tool schema)"* and lists: `top-gainers`, `top-losers`,
`most-active`, `52-week-high`, `52-week-low`, `upper-circuit-stocks`, `lower-circuit-stocks`.
`ritexlabs/mcp-playground` independently states the server *"exposes 15 tools."* **Treat the
official list as marketing, not an inventory — always enumerate via `tools/list`.**

**Observed argument shapes [S]** (reverse-engineered, unofficial, may drift):

```
lookup_ind_keys{names: List[str], filter_type: Optional[str]}
networth_holdings{asset_type}                      # seen: MF, IND_STOCK/INDIAN_STOCK, US_STOCK
get_indian_stocks_details{ind_keys: List[str],     # capped at 10 ids/call
                          segments: Optional[List[str]]}   # "analyst", "news"
get_indian_stocks_ohlc{ind_key, interval, lookback}        # e.g. "1day", "3month"
get_indian_stocks_option_chain{ind_key, use_expiry_date: bool, expiry_date, strikes_around_atm: int}
get_indian_stocks_greeks_history{ind_key, lookback}
user_watchlist{type}                               # e.g. "all"
```

Identifiers look like `INDS00577`, `INDS01417` (Dabur), `INDS01960` (EMMBI).

⚠️ **Schema drift is real and documented.** `abinashstack/indmoney-watch` lists a *different*
net-worth tool name — `get_user_networth_v2` — plus a bare `holdings`, suggesting the surface has
changed over time or carries aliases. Its README is blunt: *"INDmoney's contract isn't documented
anywhere public"* and *"INDmoney can change MCP schemas at any time."* **Design defensively:
enumerate `tools/list` at startup, validate tool names exist before calling, and alert rather than
crash when a tool disappears.** **[S]**

**🔑 The finding that most directly shapes this project [S].** `ritexlabs/mcp-playground`
(`docs/architecture.md`) states verbatim:

> "`mcp.indmoney.com/mcp` exposes 15 tools, all for the authenticated individual account.
> **No family/multi-member tools exist.** `networth_holdings` returns `broker` per holding but no
> `member_name` field."

So there is **no family or multi-account API to discover** — the per-friend OAuth token really is
the only path to multiple people's positions, exactly as designed in §3. This closes off the
"maybe there's an easier way" question definitively.

For a position-watching bot the workhorses are `networth_holdings` (positions with P&L) and
`get_indian_stocks_details` (live marks, **max 10 `ind_keys` per call**). That cap is the main
schema-level constraint and directly shapes batching: with N friends holding M distinct symbols,
you need `ceil(distinct_symbols / 10)` market-data calls — and **symbols should be de-duplicated
across friends**, since market data is identical for everyone and only the holdings are per-user.

**Read-only is architectural, per INDmoney [D]:** "INDmoney MCP cannot place trades, transfer
money, redeem investments, or change any setting. There is no write capability anywhere in the
system. Not disabled, not implemented." The two advertised scopes (`portfolio:read`,
`market:read`) corroborate this at the protocol level **[V]** — there is no writable scope to
request even if you wanted one.

---

## 3. Multi-user backends as MCP clients

### 3.1 What the spec says: essentially nothing

This is the honest answer. The MCP authorization spec is written throughout in the singular — "an
MCP client acts as an OAuth 2.1 client, making protected resource requests **on behalf of a
resource owner**" (singular). There is **no section on multi-tenancy, no guidance on a single
client identity serving many end users, and no notion of user identity in the protocol at all.**
**[S]**

**This silence is deliberate, and the community has repeatedly asked for it to change [S]:**

- [Discussion #193 "Multi-Tenant Client Support (Server-to-Server)"](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/193)
  — *"For MCP to become the universal protocol… it must evolve to support a multi-tenant client
  approach."* Never became a SEP.
- [Discussion #234 "Multi-user Authorization"](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/234)
  (per-call user tokens via `_meta`) — **closed without adoption.**
- `modelcontextprotocol/servers#2173` "Multi tenancy support" — **closed as not planned.**
- [SEP-2567 "Sessionless MCP"](https://modelcontextprotocol.io/seps/2567-sessionless-mcp) pushes
  it out of scope explicitly: gateways bridging per-user state need *"a different correlation key,
  which is a transport-layer concern (route by authenticated principal, or a cookie / gateway-issued
  header) rather than something this SEP defines."*

The nearest official construct is the **Enterprise-Managed Authorization** extension (SEP-990),
which uses RFC 8693 token exchange against a corporate IdP to avoid per-user browser redirects —
but it "still assumes one identity per client session" and requires every user in one IdP.
**Irrelevant to a friend group.**

**Implication:** multi-user is not forbidden, it is deliberately *out of scope*. It's an
application concern, and the entire burden of correctness falls on you. The one piece of
spec-normative guidance worth stealing is the state-keying rule from the security best practices:
key stored state as `<user_id>:<handle>` where **the user ID is derived from the verified token,
never supplied by the caller.** **[S]**

### 3.2 The pattern that actually applies here

The good news: nothing about multi-user needs protocol support. The correct architecture is
boring and well-understood:

- **One OAuth client** (one `client_id`/`client_secret` from DCR), shared across all friends.
  This is normal — it's exactly how any SaaS integration works. The `client_id` identifies *your
  app*, not the user.
- **N token grants**, one per friend, each obtained through that friend's own browser login and
  consent screen.
- **N independent client instances.** Do **not** pool or share connections or auth providers. Each
  friend's requests carry only that friend's bearer token.

  ⚠️ **This is a real footgun, not a stylistic preference.** The Python SDK's
  `OAuthClientProvider` holds `current_tokens` as *instance state*. Sharing one provider across
  users **will cross-contaminate credentials** — friend A's request going out with friend B's
  token. Instantiate **one provider and one `httpx2.AsyncClient` per friend.** **[S]**

  ⚠️ **Do not design around `Mcp-Session-Id`.** The 2026-07-28 transport revision
  ([Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http))
  explicitly lists *"Removal of the GET stream endpoint. Removal of protocol-level sessions."*
  There is no session ID any more; every request is an independent POST carrying
  `Authorization` (which **MUST** be on *every* request) plus `MCP-Protocol-Version`. Most
  2025-era blog advice about session-based multi-user routing is now obsolete —
  **route by authenticated principal instead.** **[S]**
- **A token vault**: encrypted-at-rest per-user records `{user_id, access_token, refresh_token,
  expires_at, scopes}`, with the encryption key held outside the database.

This maps cleanly onto the SDK seams: the Python SDK's `TokenStorage` protocol and the TS SDK's
`OAuthClientProvider` are both per-instance, so you instantiate one provider per friend and the
SDK does the right thing.

### 3.3 Patterns in the wild

The general shape has a name — an **MCP gateway** — and the production implementations converge on
a *per-user credential broker*. Two are worth copying from directly **[S]**:

- **[IBM ContextForge](https://ibm.github.io/mcp-context-forge/manage/oauth/)** — the closest
  match to our problem, and it validates the design: *"OAuth tokens are scoped per ContextForge
  user (using `app_user_email` field) **to prevent token sharing between users**… Encrypt tokens
  at rest using `AUTH_ENCRYPTION_SECRET`… Auto-refresh using refresh tokens when near expiry."*
  That is exactly the architecture in §3.2, shipped and documented.
- **[Cloudflare `workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)** —
  **the best storage pattern I found, and worth adopting wholesale.** Tokens are stored *only by
  hash*, and the sensitive payload is *"encrypted with AES-GCM using key material wrapped by the
  corresponding secret token."* The consequence is the important bit: **a database dump alone
  yields nothing usable** — upstream credentials are only decryptable when the user's own token is
  presented. For a hobby server holding six people's financial credentials, that property is worth
  the extra day of work.

Others in the space: Solo.io agentgateway and Obot (both built around **RFC 8693 token exchange**),
Cloudflare MCP Server Portals (identity-aware proxy), and Docker MCP Gateway (a developer
workstation tool — not a multi-tenant answer).

**RFC 8693 does not help us, and it's important to understand why.** Token exchange solves
identity propagation *within your own identity domain*. As Auth0 and Descope both note, it does
nothing when the downstream is a third party outside your IdP — there, *someone* must hold a
per-user refresh token. INDmoney doesn't advertise the grant anyway **[V]**. So the per-user
encrypted vault isn't a shortcut we're taking; it's the only correct answer.

### 3.4 ToS, consent and risk — read this part twice

This is where the project's real exposure lives, and it is *not* a technical problem.

**What's fine:** INDmoney explicitly states the MCP server "works with every flavour of Claude"
and any MCP-compliant client **[D]**, and it runs **open** dynamic client registration with no
partner gating **[V]**. Building a custom client is clearly anticipated. Each friend performs
their own login on INDmoney's own domain and clicks their own consent screen — that is genuine,
individual, informed consent, which is the strongest thing you have going for you.

**What's genuinely risky:**

1. **You become a custodian of N people's brokerage credentials.** A refresh token for
   `portfolio:read` is a durable, silent read capability over someone's entire net worth —
   holdings, P&L, XIRR, SIPs, and per INDmoney's own marketing, potentially credit score, loans
   and liabilities. A single server compromise leaks everyone's complete financial position at
   once. This is a materially different risk class from a hobby project, and the friend group
   should be told so in exactly these words before anyone connects.
2. **Consent is to *you*, not to the group.** Each friend consents to your server reading *their*
   data. Consenting to that is **not** consent to broadcast their positions into a shared group
   chat. Get that agreed separately and explicitly, in writing, ideally per-friend and
   per-data-type. "Notify a group" is the part that turns a personal tool into a disclosure
   pipeline.
3. **Rate limits are per-user and undocumented [D].** Since each friend has their own token, you
   get N separate budgets rather than one shared one — which helps. But a naive
   poll-every-10-seconds loop across N friends will find the ceiling fast, and hitting it looks
   like abuse. Poll conservatively, back off on `429`, and cache.
   *Planning anchors until P15 gives a real number:* comparable production MCP servers land around
   **60 requests per 60 seconds per authenticated user** (e.g. Sentry's, per
   [this survey](https://www.scalekit.com/blog/rate-limiting-virtual-mcp-servers)) **[?]**. More
   directly: `abinashstack/indmoney-watch` polls the real INDmoney server **every 10 minutes
   during market hours** and reports no rate limiting, with the README noting *"Don't be a bad
   citizen"* **[S]**. **No third-party developer has publicly reported hitting a ceiling.**
   Designing for **one `networth_holdings` poll per friend per 1–5 minutes**, with market data
   de-duplicated across friends, sits well inside any plausible limit and is more than fast enough
   for position-change notifications.
4. **SEBI logging.** Every call is logged with a request ID for SEBI-aligned compliance **[D]**,
   confirmed by the `x-request-id` header even on unauthenticated calls **[V]**. Your traffic is
   attributable and auditable per friend. Behave accordingly — this is a feature, not a threat,
   but it means "nobody will notice" is not a strategy.
5. **Read-only genuinely bounds the blast radius.** No scope exists that could place an order
   **[V]**. The worst case is a confidentiality breach, never an unauthorized trade. That is a
   meaningful comfort and worth stating in the synthesis.

**Concrete security checklist for the token vault** (each item sourced to spec text or a
production implementation) **[S]**:

- [ ] **Envelope-encrypt** per-friend refresh tokens; hold the key material outside the database
      (Cloudflare's wrapped-key AES-GCM pattern is the reference).
- [ ] **Key rows by the verified token subject**, never a caller-supplied ID (spec-normative
      `<user_id>:<handle>` rule).
- [ ] **One provider + one HTTP client per friend** — never share (SDK instance-state hazard, §3.2).
- [ ] **Never log `Authorization` headers, tokens, codes, or secrets.** MCP's own security
      tutorial calls this out explicitly. Easy to violate accidentally with verbose HTTP logging.
- [ ] **Pin to a single issuer.** Store DCR credentials against
      `issuer: "https://mcp.indmoney.com/"` and reject anything else — the spec makes this a
      **MUST** ("Authorization Server Binding").
- [ ] **Never pass a friend's token anywhere downstream** — token passthrough is a spec-level
      **MUST NOT**.
- [ ] **SSRF-protect any OAuth discovery fetch** if URLs ever become configurable (spec cites the
      [OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)).
- [ ] **Implement `/revoke` on offboarding** so a friend leaving actually kills the grant.

Wider reading: OWASP GenAI's
[Practical Guide for Secure MCP Server Development](https://genai.owasp.org/resource/a-practical-guide-for-secure-mcp-server-development/)
(Feb 2026), plus [WorkOS](https://workos.com/blog/mcp-auth-developer-guide) and
[Stytch](https://stytch.com/blog/MCP-authentication-and-authorization-guide/) MCP auth guides.

**The "copy-trading" elephant.** The repo is named `indmoney-copy-trading`. Read-only MCP can tell
you *what a friend holds*; it cannot execute anything. If the intent ever drifts from "watch and
notify" toward "act on someone else's positions," that crosses into investment-advice and
portfolio-management territory that is regulated in India, and this appendix should not be read as
support for it. As scoped — watch positions, notify a group of consenting friends — it's a
notification bot, and that's a different thing entirely.

---

## 4. Public chatter about INDmoney MCP

**First-party:** <https://www.indmoney.com/mcp> is the *only* official source — a marketing page
with a 20-question FAQ, not documentation. `https://mcp.indmoney.com/docs` is advertised as
`service_documentation` in the AS metadata **[V]** but **does not resolve**: `403` Cloudflare
"Just a moment..." interstitial to `curl`, `404` via other fetchers **[V]**. Best read: the
advertised docs page **doesn't exist**. Still worth two minutes in a real browser (P17), but lower
your expectations — this is not the goldmine I initially assumed.

**Not listed in any MCP registry [S]:** absent from the official MCP Registry
(`registry.modelcontextprotocol.io?search=indmoney` → `{"servers":[],"metadata":{"count":0}}`),
absent from PulseMCP, absent from Anthropic's connectors directory. The `mcp.so` entries that
surface in search are the *third-party Python* server, not the official one.

**Launch date: unknown, no announcement exists.** No INDmoney blog post, no press release, no
LinkedIn post from INDmoney or Ashish Kashyap, no coverage in Entrackr / Inc42 / Moneycontrol /
YourStory / ET. The earliest hard timestamp is a GitHub repo consuming it, created
**2026-05-06**, so the server was live by early May 2026 **[S]**. Wayback CDX was rate-limited and
could not confirm first capture.

**The genuinely useful third-party material is client source code, not blog posts.** A healthy
ecosystem of open-source clients already drives the official server, and their code is currently
the *best available documentation* for tool schemas (§2.5) and token behaviour (§2.4):
[`ritexlabs/ai-desk-companion`](https://github.com/ritexlabs/ai-desk-companion) (documents the full
OAuth flow + refresh),
[`ritexlabs/mcp-playground`](https://github.com/ritexlabs/mcp-playground) (architecture notes; the
"no family tools" finding), `ishanavasthi/alphadesk` (live tool schemas; the 15th tool),
`abinashstack/indmoney-watch` (Go menu-bar poller), plus `build-with-dhiraj/equity-research-os`,
`Kush1297/unified_portfolio_dashboard`, `nitiprabhu/portfolio-compass`, `srvsngh99/Krill`,
`gurjarmahesh95-dev/trading-ops-manager`. **This is strong evidence that custom non-Claude clients
are normal and workable** — we would not be doing anything unprecedented.

**⚠️ Do not confuse these two things.** The official server is the remote OAuth-gated
`https://mcp.indmoney.com/mcp`. Separately, Vigneshwaran M published an *unofficial,
reverse-engineered, local* Python server
([dev.to, 2026-05-27](https://dev.to/vigneshwaran_m/i-built-an-mcp-server-for-indmoney-ask-claude-about-your-portfolio-in-plain-english-431i);
PyPI `indmoney-mcp`) using **Playwright browser automation + OTP + network interception**, with
AES-256-GCM sessions, a **12-hour TTL**, and 5-min/60-min caches. **The "12-hour TTL" and
"AES-256-GCM" figures circulating in search summaries belong to *that* project — not to INDmoney.**
Same caution for `SharunIyer/indian-broker-mcp`, `Sparker0i/indian-stock-mcp-agent`,
`ingpoc/stock_mcp_server`.

**Regulatory context [S]:** [Inc42, "When AI Enters Stock Broking"](https://inc42.com/features/when-ai-enters-stock-broking/)
(~Jan 2026) quotes INDmoney's CTO — *"We draw a hard architectural line between probabilistic
insight and deterministic execution"* — and notes Zerodha and Groww also ship MCP servers, all
read-only, with SEBI expecting "explainability, auditability, and disclosure." A
[LeapRate piece](https://www.leaprate.com/technology/broker-mcp-ai-agent-trading-infrastructure-race-2026/)
(2026-06-22) shows the same read-only pattern globally (IG Group: "no trade execution through the
AI layer"). **No SEBI circular, consultation paper, or regulatory commentary naming MCP exists** —
INDmoney's "SEBI-aligned compliance" is its own phrasing, not a SEBI endorsement. Read-only across
every broker in the market is a strong signal about where the regulatory line sits **[?]**.

**Explicitly not found, despite hard searching:** numeric rate limits (nowhere — not official, not
in any client, not in any user report); numeric token TTL or observed `expires_in`; published tool
JSON schemas; **zero GitHub issues** (`gh search issues "indmoney mcp"` → no results); **zero
Reddit / X / HN user reports** of any kind. The total absence of complaint about re-login pain is
weak positive evidence **[?]** — but genuinely weak, since adoption may simply be low.

---

## 5. One-hour probe checklist

Probes **P1–P7 are already done** (results in §2). **P8 onward require exactly one friend — or
you — to complete one real login**, and they resolve every remaining go/no-go question.

### Already completed — no auth needed ✅

| # | Probe | Result |
|---|---|---|
| P1 | `GET /.well-known/oauth-protected-resource` and `.../mcp` | ✅ RFC 9728 present; scopes `portfolio:read`, `market:read`; **two different documents** (§2.1) |
| P2 | `GET /.well-known/oauth-authorization-server` | ✅ Full metadata; **`refresh_token` grant present**; no `client_credentials` |
| P3 | `GET /.well-known/openid-configuration` | ✅ 404 — RFC 8414 only |
| P4 | Unauth `POST /mcp` → inspect `WWW-Authenticate` | ✅ Correct challenge + `resource_metadata`; no `scope` param |
| P5 | DCR support: `GET /register`, empty `POST /register` | ✅ **Open, unauthenticated DCR** (metadata validation error, not authz error) |
| P6 | Protocol version negotiation | ❌ **Unresolved** — server 401s before any version handling |
| P7 | PKCE enforcement (`code_challenge`, `method=plain`) | ✅ **S256 mandatory**, `plain` rejected |

### Requires one real login — the go/no-go set 🔑

| # | Probe | What it settles | Effort |
|---|---|---|---|
| **P8** | `POST /register` with real `redirect_uris`, `grant_types: ["authorization_code","refresh_token"]`, `token_endpoint_auth_method: "client_secret_post"`, **`application_type: "web"`**. Inspect the response. | Does DCR return a `client_secret`? Is there a `client_secret_expires_at`? A `registration_access_token`? **If the secret expires, you have a recurring ops chore.** Also: what `client_name` shows up on the friend's consent screen? | 5 min, no login |
| **P9** | Build the authorize URL with `resource=https://mcp.indmoney.com/mcp` and complete one login in a browser. | Confirms the consent screen contents, whether both scopes are grantable, and whether the `resource` param is accepted end-to-end. | 10 min |
| **P10** | **Inspect the token response for `refresh_token` and `expires_in`.** | 🔑 **THE decisive probe.** Presence of `refresh_token` + the `expires_in` value determines whether this project is viable. | included in P9 |
| **P11** | Decode the access token (if JWT) and read `aud`, `exp`, `scope`. | Confirms audience binding and which `resource` value is correct (§2.1 gotcha). If opaque, note that and move on. | 2 min |
| **P12** | Wait for access-token expiry, then exercise the refresh grant. | 🔑 **Is the refresh token rotated? Does the old one die? Does the refresh token itself have a hard expiry?** Sets the true re-login cadence. *Note: OAuth 2.1 mandates rotation only for **public** clients; ours is confidential (§2.2), so INDmoney may well return a stable, long-lived refresh token — which would be the best case.* | 1h wall-clock, ~0 attention |
| **P13** | `tools/list` on the live session; dump **all 15** JSON schemas verbatim into the repo. | Ground truth for input schemas — pagination, date ranges, batch limits, and whether `get_indian_stocks_movers` and/or `get_user_networth_v2` are present. Feeds directly into polling design, and gives a baseline to diff against when INDmoney changes things. | 5 min |
| **P14** | `server/discover` (2026-07-28) and an `initialize` handshake with older versions. | Which protocol revisions are supported → **which SDK major version to pin.** Matters a lot: the 2026-07-28 transport dropped sessions and the GET stream, so a v1-era and v2-era client behave differently on the wire. | 5 min |
| **P15** | Call `networth_holdings` in a tight-ish loop; watch for `429`, `Retry-After`, `X-RateLimit-*`. | Discovers the undocumented per-user rate limit → sets your safe polling interval. **Ramp gently; don't hammer a broker.** | 10 min |
| **P16** | Open a second concurrent session for the *same* account (e.g. backend + the friend's own Claude). | Does a second grant or a refresh invalidate the first? (cf. claude-code#77130.) **Critical**: friends will keep using Claude normally alongside your bot. | 5 min |
| **P17** | Read `https://mcp.indmoney.com/docs` **in a real browser**. | Cloudflare-blocked to tooling. May answer P10/P12/P15 for free. **Do this first.** | 2 min |

**Suggested order:** P17 → P8 → P9/P10/P11 → P13/P14 → P16 → P12 → P15.
P10 and P12 are the ones that decide whether to build.

---

## 6. Unknowns

Ordered by how much they'd change the design.

1. **🔑 What is the *refresh token's own* hard expiry — i.e. the real re-login cadence?**
   Downgraded from "does refresh work at all": the grant is advertised **[V]** and a third-party
   client documents silent refresh working in production **[S]**. What nobody has published is how
   long the refresh token itself lives before a full OTP+MPIN re-login is required. **This is now
   the project's only genuine go/no-go.** → P10, P12.
2. **🔑 Is the refresh token rotated, and does rotation invalidate concurrent sessions?** If your
   backend's refresh kicks a friend out of their own Claude connector every hour, the friends will
   revolt. → P12, P16.
3. **Per-user rate limits.** Confirmed to exist, numbers never published **[D]**. Determines
   polling interval and therefore how "live" the notifications can be. → P15.
4. **Access-token TTL.** "Short-lived" **[D]**, no number. Probably ~1h **[?]**, unverified.
5. **Tool input schemas — and schema stability.** Partially resolved from third-party client code
   (§2.5) **[S]**, but those are reverse-engineered, undated, and demonstrably drift
   (`networth_holdings` vs `get_user_networth_v2`). The official page under-reports the tool count
   (14 vs 15). Unknown whether `networth_holdings` supports filtering/pagination. → P13.
6. **Which MCP protocol revisions the server supports** — and therefore which SDK major version to
   pin. The 401 precedes negotiation **[V]**, and the 2026-07-28 transport is materially different
   (no sessions, no GET stream). → P14.
7. **Whether `resource` (RFC 8707) is honoured or merely tolerated**, and which canonical URI is
   correct given the two conflicting PRM documents (§2.1). → P11.
8. **Does DCR issue an expiring `client_secret`?** Would add a recurring ops chore. → P8.
9. **Contents of `/docs`.** Advertised but does not resolve (403/404) **[V]** — most likely simply
   absent. Two minutes in a browser settles it. → P17.
10. **Whether INDmoney's ToS restricts non-Claude or multi-user clients.** Open DCR and "any
    MCP-compliant client" **[D][V]** suggest not, but the actual ToS/API terms were not located
    and were not read. **Unverified — someone should read them before this goes live.**
11. **Concurrent-session limits per account.** Unknown whether N sessions per user are permitted at
    all. → P16.
12. **Whether the consent screen's language covers third-party server use.** It is written for
    "Claude" **[D]**; how it renders for a custom DCR client name is unknown, and matters for
    whether friends feel misled. → P9.

---

## 7. Bottom line

**Technically: green.** A Node or Python backend, one DCR client, one browser login per friend, a
per-user encrypted token vault, and N isolated streamable-HTTP MCP sessions. Every protocol piece
is present and standards-compliant, DCR is open and unauthenticated, and the read-only scope
ceiling means the worst-case failure is a data leak rather than a rogue trade. **A dozen
open-source third-party clients already do exactly this against the live server**, so we would be
walking a well-trodden path, not pioneering one. And since **no family/multi-member API exists**,
the per-friend-token architecture isn't just one option — it's the only one.

**Operationally: one unknown decides it, and it's smaller than it looked.** Refresh tokens are
advertised **[V]** *and* documented as working in a third-party client **[S]**, so the "everyone
re-authenticates hourly" nightmare is unlikely. What remains is the refresh token's own lifetime —
weekly is fine, daily is survivable (re-auth takes ~30 seconds **[D]**), hourly kills it. That
costs one login plus an hour of wall-clock waiting to answer (P10 + P12). **Resolve it before
writing any other code.**

**Build defensively regardless.** The tool surface is undocumented, under-reported by one tool, and
has demonstrably changed names over time. Enumerate `tools/list` at startup, tolerate missing
tools, and expect to re-register the DCR client occasionally.

**Socially: the token vault is the real design problem.** Holding six friends' durable read
credentials to their entire net worth is a serious thing to do. Encrypt at rest with an external
key, implement one-click revocation against `/revoke`, and get explicit, separate consent for
broadcasting anyone's positions into a shared chat.
