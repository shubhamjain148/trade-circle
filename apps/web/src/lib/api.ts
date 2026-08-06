/**
 * Thin typed wrapper over the watcher API. Vite proxies /api to the Hono
 * server on :3001 (see vite.config.ts).
 */

export async function getJson<T>(
  path: string,
  signal?: AbortSignal
): Promise<T> {
  const response = await fetch(path, {
    signal,
    headers: { Accept: "application/json" },
  })

  if (!response.ok) {
    throw new Error(`Request to ${path} failed (${response.status})`)
  }

  return (await response.json()) as T
}

export const feedPath = (accountId?: string) =>
  accountId
    ? `/api/feed?accountId=${encodeURIComponent(accountId)}`
    : "/api/feed"

export const membersPath = "/api/members"
