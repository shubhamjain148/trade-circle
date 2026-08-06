/**
 * Thin typed wrapper over the watcher API. Vite proxies /api to the Hono
 * server on :3001 (see vite.config.ts).
 */

/**
 * Status is carried, not flattened into the message: the difference between
 * 401 (sign in), 410 (invite already used) and 500 (our fault) is the whole
 * difference between three screens.
 */
export class ApiError extends Error {
  readonly status: number
  /**
   * The server's own word for what went wrong, when it sent one. Two 410s can
   * mean two different sentences — an invite already spent, or a device link
   * that timed out — and only the body tells them apart.
   */
  readonly code: string | undefined

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
  }
}

const JSON_HEADERS = { Accept: "application/json" }

async function request(
  path: string,
  init: RequestInit & { signal?: AbortSignal } = {}
): Promise<Response> {
  // Session lives in an httpOnly cookie, so every call is credentialed.
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { ...JSON_HEADERS, ...init.headers },
  })

  if (!response.ok) {
    // Best-effort: the failures that carry a code are ours and answer in JSON,
    // and the ones that don't (a proxy's 502, an empty body) fall through with
    // the status alone, exactly as before.
    const code = await response
      .json()
      .then((body: unknown) =>
        body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : undefined
      )
      .catch(() => undefined)

    throw new ApiError(
      response.status,
      `Request to ${path} failed (${response.status})`,
      code
    )
  }

  return response
}

export async function getJson<T>(
  path: string,
  signal?: AbortSignal
): Promise<T> {
  const response = await request(path, { signal })
  return (await response.json()) as T
}

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

  return (await response.json()) as T
}

export async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const response = await request(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

  return (await response.json()) as T
}

/** For the 204s: logout and disconnect. */
export async function send(path: string, method: "POST" | "DELETE") {
  await request(path, { method })
}

export const feedPath = (accountId?: string) =>
  accountId
    ? `/api/feed?accountId=${encodeURIComponent(accountId)}`
    : "/api/feed"

/**
 * The group timeline. With a cursor this is the poll the tab runs every few
 * seconds; without one it's the cold open.
 */
export const chatPath = (after?: string) =>
  after ? `/api/chat?after=${encodeURIComponent(after)}` : "/api/chat"

/**
 * Live delivery for the same timeline. Same origin as everything else, so the
 * session cookie rides the handshake — there is no token in this URL and there
 * must never be one, because URLs end up in logs and referrers.
 *
 * Absolute because WebSocket has no notion of a relative URL. On a runtime
 * without a room (the Node entry point) this 501s and the caller stays on the
 * poll loop it never stopped running.
 */
export const chatSocketUrl = () => {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${scheme}//${window.location.host}/api/chat/ws`
}

export const membersPath = "/api/members"

/**
 * One member's current holdings — the panel above their feed. Weights and
 * names only; the server never sends amounts (apps/server/src/positions.ts).
 */
export const memberPositionsPath = (memberId: string) =>
  `/api/members/${encodeURIComponent(memberId)}/positions`

export const mePath = "/api/me"
export const visibilityPath = "/api/me/visibility"
export const sessionPath = "/api/auth/session"
export const logoutPath = "/api/auth/logout"
/**
 * Mints a single-use link that signs *you* in on another device. Session-gated
 * and self-service: there is no member id in the request, because the only
 * member it can ever name is the one holding the session.
 */
export const deviceLinkPath = "/api/auth/device-link"
export const connectPath = "/api/connect/indmoney"
/**
 * A 302 to INDmoney's authorize page — this is a destination for the browser,
 * never a fetch. Redirected OAuth in an XHR just yields an opaque failure.
 */
export const connectStartPath = "/api/connect/indmoney/start"

/**
 * A manual tick over every account. Admin only — it reads every friend's
 * holdings — and separate from the automatic passes: the cron fires inside the
 * worker and a connect fetches that one account on its own.
 */
export const pollPath = (force = false) =>
  force ? "/api/poll?force=1" : "/api/poll"

/** Admin only. Everything under here 403s for a plain member. */
export const adminMembersPath = "/api/admin/members"
export const adminInvitePath = (memberId: string) =>
  `/api/admin/members/${encodeURIComponent(memberId)}/invite`
