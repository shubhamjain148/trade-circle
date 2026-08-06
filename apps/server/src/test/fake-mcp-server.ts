import { createHash, randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { z } from "zod";

// A local stand-in for mcp.indmoney.com: an OAuth 2.1 authorization server plus a
// streamable-HTTP MCP server. It exists so the integration tests never touch a
// real INDmoney endpoint. Its OAuth surface mirrors what appendix 1 §2.2 measured
// (S256-only PKCE, confidential clients, refresh + revocation); its tools are
// shaped like the guesses in src/mcp/toolmap.ts, not like anything verified.

export interface FakeToken {
  clientId: string;
  scope: string;
  expiresAt: number;
  revoked: boolean;
}

export interface FakeMcpServer {
  url: string;
  mcpUrl: string;
  close(): Promise<void>;
  /** Payload `networth_holdings` returns; swap it to script a portfolio change. */
  setHoldings(rows: unknown[]): void;
  /** Server-side revocation, as if the friend clicked disconnect inside INDmoney. */
  revokeAll(): void;
  /** Ages every live access token so the next call must refresh. */
  expireAccessTokens(): void;
  readonly registrations: number;
  readonly tokenGrants: { grant: string; refreshToken: string }[];
  readonly revocations: string[];
  readonly toolCalls: string[];
}

export interface FakeOptions {
  accessTokenTtlSec?: number;
  holdings?: unknown[];
}

const DEFAULT_HOLDINGS = [
  { ind_key: "INDS00577", symbol: "DABUR", name: "Dabur India Ltd", qty: 40, avg_cost: 512.5, ltp: 548.2 },
  { ind_key: "INDS01960", symbol: "EMMBI", name: "Emmbi Industries Ltd", qty: 120, avg_cost: 88, ltp: 94.75 },
];

export async function startFakeMcpServer(
  options: FakeOptions = {},
): Promise<FakeMcpServer> {
  const ttl = options.accessTokenTtlSec ?? 3600;
  const clients = new Map<string, { secret: string; redirectUris: string[] }>();
  const codes = new Map<
    string,
    { clientId: string; challenge: string; redirectUri: string; scope: string }
  >();
  const accessTokens = new Map<string, FakeToken>();
  const refreshTokens = new Map<string, FakeToken>();
  const state = {
    holdings: options.holdings ?? DEFAULT_HOLDINGS,
    registrations: 0,
    tokenGrants: [] as { grant: string; refreshToken: string }[],
    revocations: [] as string[],
    toolCalls: [] as string[],
  };

  const app = new Hono();
  const origin = (url: string) => new URL(url).origin;

  app.get("/.well-known/oauth-protected-resource/mcp", (c) =>
    c.json({
      resource: `${origin(c.req.url)}/mcp`,
      authorization_servers: [`${origin(c.req.url)}/`],
      scopes_supported: ["portfolio:read", "market:read"],
      bearer_methods_supported: ["header"],
    }),
  );

  app.get("/.well-known/oauth-authorization-server", (c) => {
    const base = origin(c.req.url);
    return c.json({
      issuer: `${base}/`,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      revocation_endpoint: `${base}/revoke`,
      scopes_supported: ["portfolio:read", "market:read"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: [
        "client_secret_post",
        "client_secret_basic",
      ],
      revocation_endpoint_auth_methods_supported: ["client_secret_post"],
      code_challenge_methods_supported: ["S256"],
    });
  });

  app.post("/register", async (c) => {
    const body = (await c.req.json()) as { redirect_uris?: string[] };
    if (!body.redirect_uris?.length) {
      return c.json(
        { error: "invalid_client_metadata", error_description: "redirect_uris: Field required" },
        400,
      );
    }
    const clientId = `fake-client-${randomUUID()}`;
    const secret = randomUUID();
    clients.set(clientId, { secret, redirectUris: body.redirect_uris });
    state.registrations += 1;
    return c.json(
      {
        ...body,
        client_id: clientId,
        client_secret: secret,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_secret_expires_at: 0,
      },
      201,
    );
  });

  // Auto-approving consent: the real screen is a mobile+OTP+MPIN login.
  app.get("/authorize", (c) => {
    const q = c.req.query();
    const client = q.client_id ? clients.get(q.client_id) : undefined;
    if (!client) return c.json({ error: "invalid_request", error_description: "Client ID not found" }, 400);
    if (q.code_challenge_method !== "S256") {
      return c.json({ error: "invalid_request", error_description: "code_challenge_method: Input should be 'S256'" }, 400);
    }
    if (!q.code_challenge) {
      return c.json({ error: "invalid_request", error_description: "code_challenge: Field required" }, 400);
    }
    const code = randomUUID();
    codes.set(code, {
      clientId: q.client_id!,
      challenge: q.code_challenge,
      redirectUri: q.redirect_uri!,
      scope: q.scope ?? "portfolio:read market:read",
    });
    const redirect = new URL(q.redirect_uri!);
    redirect.searchParams.set("code", code);
    if (q.state) redirect.searchParams.set("state", q.state);
    redirect.searchParams.set("iss", `${origin(c.req.url)}/`);
    return c.redirect(redirect.href, 302);
  });

  app.post("/token", async (c) => {
    const form = await c.req.parseBody();
    const clientId = String(form.client_id ?? "");
    const client = clients.get(clientId);
    if (!client || String(form.client_secret ?? "") !== client.secret) {
      return c.json({ error: "invalid_client" }, 401);
    }

    const scope = (() => {
      if (form.grant_type === "authorization_code") {
        const entry = codes.get(String(form.code ?? ""));
        if (!entry) return null;
        codes.delete(String(form.code));
        if (entry.challenge !== s256(String(form.code_verifier ?? ""))) return null;
        return entry.scope;
      }
      if (form.grant_type === "refresh_token") {
        const token = refreshTokens.get(String(form.refresh_token ?? ""));
        if (!token || token.revoked) return null;
        // Rotation: the presented refresh token dies here.
        refreshTokens.delete(String(form.refresh_token));
        return token.scope;
      }
      return null;
    })();
    if (scope === null) return c.json({ error: "invalid_grant" }, 400);

    const access = randomUUID();
    const refresh = randomUUID();
    const expiresAt = Date.now() + ttl * 1000;
    accessTokens.set(access, { clientId, scope, expiresAt, revoked: false });
    refreshTokens.set(refresh, { clientId, scope, expiresAt: 0, revoked: false });
    state.tokenGrants.push({ grant: String(form.grant_type), refreshToken: refresh });
    return c.json({
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: ttl,
      scope,
    });
  });

  app.post("/revoke", async (c) => {
    const form = await c.req.parseBody();
    const token = String(form.token ?? "");
    state.revocations.push(token);
    for (const store of [accessTokens, refreshTokens]) {
      const entry = store.get(token);
      if (entry) entry.revoked = true;
    }
    return c.body(null, 200);
  });

  const handler = createMcpHandler(() => buildMcpServer(state));

  app.all("/mcp", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
    const entry = accessTokens.get(token);
    if (!entry || entry.revoked || entry.expiresAt <= Date.now()) {
      return new Response(
        JSON.stringify({ error: "invalid_token", error_description: "Authentication required" }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": `Bearer error="invalid_token", resource_metadata="${origin(c.req.url)}/.well-known/oauth-protected-resource/mcp"`,
          },
        },
      );
    }
    return handler.fetch(c.req.raw, {
      authInfo: {
        token,
        clientId: entry.clientId,
        scopes: entry.scope.split(" "),
      },
    });
  });

  const { server, port } = await new Promise<{
    server: ReturnType<typeof serve>;
    port: number;
  }>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
      resolve({ server: s, port: info.port }),
    );
  });
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    mcpUrl: `${url}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
    setHoldings(rows) {
      state.holdings = rows;
    },
    revokeAll() {
      for (const store of [accessTokens, refreshTokens]) {
        for (const entry of store.values()) entry.revoked = true;
      }
    },
    expireAccessTokens() {
      for (const entry of accessTokens.values()) entry.expiresAt = 0;
    },
    get registrations() {
      return state.registrations;
    },
    get tokenGrants() {
      return state.tokenGrants;
    },
    get revocations() {
      return state.revocations;
    },
    get toolCalls() {
      return state.toolCalls;
    },
  };
}

/** Three tools shaped like the toolmap guesses — names and args are inventions. */
function buildMcpServer(state: { holdings: unknown[]; toolCalls: string[] }): McpServer {
  const server = new McpServer({ name: "fake-indmoney", version: "0.0.0" });

  server.registerTool(
    "networth_snapshot",
    { description: "Total net worth, the cheap change probe.", inputSchema: z.object({}) },
    async () => {
      state.toolCalls.push("networth_snapshot");
      const total = state.holdings.reduce((sum: number, h) => {
        const row = h as { qty?: number; ltp?: number };
        return sum + (row.qty ?? 0) * (row.ltp ?? 0);
      }, 0);
      return jsonResult({ total_value: Math.round(total * 100) / 100, currency: "INR" });
    },
  );

  server.registerTool(
    "networth_holdings",
    {
      description: "Positions with quantity, cost and value.",
      inputSchema: z.object({ asset_type: z.string().optional() }),
    },
    async () => {
      state.toolCalls.push("networth_holdings");
      return jsonResult({ holdings: state.holdings });
    },
  );

  server.registerTool(
    "lookup_ind_keys",
    {
      description: "Resolve names to INDmoney ind_key identifiers.",
      inputSchema: z.object({ names: z.array(z.string()) }),
    },
    async ({ names }) => {
      state.toolCalls.push("lookup_ind_keys");
      return jsonResult({
        results: names.map((name, i) => ({ name, ind_key: `INDS0${1000 + i}` })),
      });
    },
  );

  return server;
}

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
