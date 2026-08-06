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

  constructor(status: number, message: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
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
    throw new ApiError(
      response.status,
      `Request to ${path} failed (${response.status})`
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

export const membersPath = "/api/members"
export const mePath = "/api/me"
export const visibilityPath = "/api/me/visibility"
export const sessionPath = "/api/auth/session"
export const logoutPath = "/api/auth/logout"
export const connectPath = "/api/connect/indmoney"
/**
 * A 302 to INDmoney's authorize page — this is a destination for the browser,
 * never a fetch. Redirected OAuth in an XHR just yields an opaque failure.
 */
export const connectStartPath = "/api/connect/indmoney/start"
