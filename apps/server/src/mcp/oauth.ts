import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
  type AuthorizationServerMetadata,
  type OAuthClientInformationFull,
  type OAuthTokens,
} from "@modelcontextprotocol/client";
import type { Config } from "../config.js";
import type { OAuthConnectionRow } from "../domain.js";
import type { Storage } from "../storage/index.js";
import { randomToken, type Vault } from "../auth/vault.js";

export interface McpDeps {
  storage: Storage;
  vault: Vault;
  config: Config;
  /** Injected in tests so nothing ever leaves the process. */
  fetchFn?: typeof fetch;
}

export function redirectUri(config: Config): string {
  return `${config.appUrl}/api/connect/indmoney/callback`;
}

/**
 * Leg one: discover, register (once per authorization server), PKCE + state,
 * hand back the URL the friend's browser has to visit.
 */
export async function startConnect(
  deps: McpDeps,
  memberId: string,
): Promise<{ authorizationUrl: string; state: string }> {
  const { storage, vault, config } = deps;
  const info = await discoverOAuthServerInfo(config.mcpBaseUrl, {
    fetchFn: deps.fetchFn,
  });
  const metadata = info.authorizationServerMetadata;
  if (!metadata) {
    throw new Error(
      `no authorization server metadata at ${info.authorizationServerUrl}`,
    );
  }

  // §2.1 gotcha: the resource-scoped PRM and the root PRM disagree. Prefer the
  // one that names the MCP endpoint we actually intend to call.
  const resource = new URL(info.resourceMetadata?.resource ?? config.mcpBaseUrl);
  const scope = (
    info.resourceMetadata?.scopes_supported ??
    metadata.scopes_supported ?? ["portfolio:read", "market:read"]
  ).join(" ");

  const clientInfo = await loadOrRegisterClient(
    deps,
    info.authorizationServerUrl,
    metadata,
    scope,
  );
  const state = randomToken();
  const { authorizationUrl, codeVerifier } = await startAuthorization(
    info.authorizationServerUrl,
    {
      metadata,
      clientInformation: clientInfo,
      redirectUrl: redirectUri(config),
      scope,
      state,
      resource,
    },
  );

  const now = new Date();
  await storage.createOAuthState({
    state,
    memberId,
    codeVerifierEnc: vault.encrypt(codeVerifier),
    issuer: metadata.issuer,
    authorizationServerUrl: info.authorizationServerUrl,
    authorizationServerMetaJson: JSON.stringify(metadata),
    clientInfoJsonEnc: vault.encryptJson(clientInfo),
    resource: resource.href,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + config.oauthStateTtlMs).toISOString(),
  });

  return { authorizationUrl: authorizationUrl.href, state };
}

/**
 * Leg two: redeem the code, vault the tokens, activate the account. The caller
 * captures tools/list separately (src/mcp/client.ts) so a schema-capture failure
 * cannot cost us a hard-won grant.
 */
export async function completeConnect(
  deps: McpDeps,
  params: { state: string; code: string; iss?: string },
): Promise<{ accountId: string; memberId: string }> {
  const { storage, vault, config } = deps;
  const now = new Date();
  const pending = await storage.consumeOAuthState(params.state, now.toISOString());
  if (!pending) throw new Error("unknown_or_expired_state");

  const metadata = JSON.parse(
    pending.authorizationServerMetaJson,
  ) as AuthorizationServerMetadata;
  const clientInfo = vault.decryptJson<OAuthClientInformationFull>(
    pending.clientInfoJsonEnc,
  );

  const tokens = await exchangeAuthorization(pending.authorizationServerUrl, {
    metadata,
    clientInformation: clientInfo,
    authorizationCode: params.code,
    iss: params.iss,
    codeVerifier: vault.decrypt(pending.codeVerifierEnc),
    redirectUri: redirectUri(config),
    resource: pending.resource ? new URL(pending.resource) : undefined,
    fetchFn: deps.fetchFn,
  });

  const accountId = await ensureAccount(storage, pending.memberId);
  const existing = await storage.getOAuthConnection(accountId);
  await storage.upsertOAuthConnection({
    accountId,
    provider: "indmoney",
    accessTokenEnc: vault.encrypt(tokens.access_token),
    refreshTokenEnc: tokens.refresh_token
      ? vault.encrypt(tokens.refresh_token)
      : null,
    expiresAt: expiryOf(tokens, now),
    scope: tokens.scope ?? null,
    clientInfoJsonEnc: pending.clientInfoJsonEnc,
    authorizationServerMetaJson: pending.authorizationServerMetaJson,
    createdAt: existing?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
    status: "active",
  });
  await storage.setAccountStatus(accountId, "active");

  return { accountId, memberId: pending.memberId };
}

/**
 * Silent renewal. Rotation is assumed: whatever the server returns replaces what
 * we held, and the old refresh token is never reused (appendix 1 §2.4).
 */
export async function refreshConnection(
  deps: McpDeps,
  accountId: string,
): Promise<string> {
  const { storage, vault } = deps;
  const connection = await storage.getOAuthConnection(accountId);
  if (!connection) throw new Error("no_connection");
  if (!connection.refreshTokenEnc) throw new Error("no_refresh_token");

  const metadata = JSON.parse(
    connection.authorizationServerMetaJson,
  ) as AuthorizationServerMetadata;
  const clientInfo = vault.decryptJson<OAuthClientInformationFull>(
    connection.clientInfoJsonEnc,
  );

  const tokens = await refreshAuthorization(metadata.issuer, {
    metadata,
    clientInformation: clientInfo,
    refreshToken: vault.decrypt(connection.refreshTokenEnc),
    resource: resourceOf(deps),
    fetchFn: deps.fetchFn,
  });

  const now = new Date();
  await storage.upsertOAuthConnection({
    ...connection,
    accessTokenEnc: vault.encrypt(tokens.access_token),
    refreshTokenEnc: tokens.refresh_token
      ? vault.encrypt(tokens.refresh_token)
      : connection.refreshTokenEnc,
    expiresAt: expiryOf(tokens, now),
    scope: tokens.scope ?? connection.scope,
    updatedAt: now.toISOString(),
    status: "active",
  });
  return tokens.access_token;
}

/** Best-effort revocation at the AS, then a local wipe that always happens. */
export async function revokeConnection(
  deps: McpDeps,
  accountId: string,
): Promise<{ revokedRemotely: boolean }> {
  const { storage, vault } = deps;
  const connection = await storage.getOAuthConnection(accountId);
  if (!connection) return { revokedRemotely: false };

  let revokedRemotely = false;
  try {
    const metadata = JSON.parse(
      connection.authorizationServerMetaJson,
    ) as AuthorizationServerMetadata;
    // Optional in RFC 8414 and absent from the SDK's narrowed type; INDmoney
    // does advertise one (appendix 1 §2.2).
    const endpoint = (metadata as Record<string, unknown>).revocation_endpoint;
    if (typeof endpoint !== "string") throw new Error("no revocation endpoint");
    {
      const clientInfo = vault.decryptJson<OAuthClientInformationFull>(
        connection.clientInfoJsonEnc,
      );
      const token = connection.refreshTokenEnc ?? connection.accessTokenEnc;
      const body = new URLSearchParams({
        token: vault.decrypt(token),
        token_type_hint: connection.refreshTokenEnc ? "refresh_token" : "access_token",
        client_id: clientInfo.client_id,
      });
      if (clientInfo.client_secret) body.set("client_secret", clientInfo.client_secret);
      const doFetch = deps.fetchFn ?? fetch;
      const res = await doFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      revokedRemotely = res.ok;
    }
  } catch {
    // A dead AS must not strand a friend's disconnect — the local wipe stands.
  }

  await storage.deleteOAuthConnection(accountId);
  await storage.setAccountStatus(accountId, "revoked");
  return { revokedRemotely };
}

export function resourceOf(deps: McpDeps): URL {
  return new URL(deps.config.mcpBaseUrl);
}

/** Access-token expiry, with a 60s safety margin applied at read time, not here. */
export function expiryOf(tokens: OAuthTokens, now: Date): string | null {
  if (typeof tokens.expires_in !== "number") return null;
  return new Date(now.getTime() + tokens.expires_in * 1000).toISOString();
}

export function isExpired(connection: OAuthConnectionRow, now = new Date()): boolean {
  if (!connection.expiresAt) return false;
  return Date.parse(connection.expiresAt) - 60_000 <= now.getTime();
}

async function loadOrRegisterClient(
  deps: McpDeps,
  authorizationServerUrl: string,
  metadata: AuthorizationServerMetadata,
  scope: string,
): Promise<OAuthClientInformationFull> {
  const stored = await deps.storage.findClientInfoForIssuer(metadata.issuer);
  if (stored) return deps.vault.decryptJson<OAuthClientInformationFull>(stored);

  // DCR is deprecated in the 2026-07-28 spec but INDmoney advertises no CIMD
  // support, so it is the only mechanism available (appendix 1 §1.4).
  return registerClient(authorizationServerUrl, {
    metadata,
    scope,
    clientMetadata: {
      client_name: deps.config.clientName,
      redirect_uris: [redirectUri(deps.config)],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
      application_type: "web",
      scope,
    },
    fetchFn: deps.fetchFn,
  });
}

async function ensureAccount(storage: Storage, memberId: string): Promise<string> {
  const existing = await storage.getAccountByMember(memberId);
  if (existing) return existing.id;
  const id = `a-${memberId}`;
  await storage.upsertAccount({
    id,
    memberId,
    provider: "indmoney",
    status: "active",
    lastPolledAt: null,
  });
  return id;
}
