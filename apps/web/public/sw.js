/**
 * The watcher's service worker. Hand-rolled and deliberately small — the app
 * is one bundle served from Cloudflare's asset store, so there is very little
 * here worth being clever about.
 *
 * Rules, in the order the fetch handler applies them:
 *   /api/*        — never touched. Falls through to the network with no cache
 *                   entry, ever. Positions and chat are the product; a stale
 *                   answer is worse than no answer.
 *   navigations   — network first, cached shell as the offline fallback. The
 *                   HTML names the hashed bundle, so it must never go stale.
 *   /assets/*     — cache first. Vite hashes these names; a hit is by
 *                   definition the right bytes.
 *   icons, fonts, — cache first with a background refresh: small, rarely
 *   the manifest    changed, never version-critical. An allowlist by request
 *                   destination; anything else is left to the network.
 *
 * PRECACHE and VERSION are rewritten at build time from the real bundle by the
 * `watcher-sw-precache` plugin in vite.config.ts. The literals below are the
 * dev-time fallback and are never what ships.
 */

const VERSION = "__SW_VERSION__"
const PRECACHE = ["/index.html"] /* __SW_PRECACHE__ */

const CACHE = `watcher-${VERSION}`
const SHELL = "/index.html"

/** Off-bundle files worth keeping: icons, the manifest, the two font families. */
const STATIC_DESTINATIONS = new Set([
  "image",
  "font",
  "style",
  "script",
  "manifest",
])

self.addEventListener("install", (event) => {
  // No skipWaiting: an updated worker takes over the next time every tab is
  // gone, rather than swapping the cache out from under a chat that's open.
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Individually, not addAll: one 404 in the list must not throw away the
      // whole install and leave the app with no worker at all.
      Promise.all(
        PRECACHE.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => {})
        )
      )
    )
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("watcher-") && key !== CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  )
})

/**
 * Every read ignores Vary. The asset server sends `Vary: Origin`, and a
 * precached entry is stored from a worker-issued request that carries no Origin
 * header — so a `<script crossorigin>` asking for the very same URL would miss
 * the cache and, offline, fail outright. These entries are keyed by URL and
 * nothing else.
 */
const MATCH = { ignoreVary: true }

/** Only 200s from our own origin are worth keeping. */
function isCacheable(response) {
  return (
    Boolean(response) && response.status === 200 && response.type === "basic"
  )
}

async function networkFirst(request) {
  try {
    const response = await fetch(request)
    if (isCacheable(response)) {
      const copy = response.clone()
      const cache = await caches.open(CACHE)
      await cache.put(SHELL, copy)
    }
    return response
  } catch (error) {
    const cached = await caches.match(SHELL, MATCH)
    if (cached) return cached
    throw error
  }
}

async function cacheFirst(request, { revalidate = false } = {}) {
  const cached = await caches.match(request, MATCH)

  const fromNetwork = fetch(request)
    .then(async (response) => {
      if (isCacheable(response)) {
        const cache = await caches.open(CACHE)
        await cache.put(request, response.clone())
      }
      return response
    })
    .catch((error) => {
      if (cached) return cached
      throw error
    })

  if (!cached) return fromNetwork
  if (revalidate) void fromNetwork.catch(() => {})
  return cached
}

self.addEventListener("fetch", (event) => {
  const { request } = event

  if (request.method !== "GET") return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // The live data. Not ours to hold on to.
  if (url.pathname.startsWith("/api/")) return

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request))
    return
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request))
    return
  }

  // Named destinations only. An allowlist rather than "everything else": the
  // Worker answers an unknown path with index.html, so a catch-all would
  // happily cache the shell under whatever URL something happened to request.
  if (STATIC_DESTINATIONS.has(request.destination)) {
    event.respondWith(cacheFirst(request, { revalidate: true }))
  }
})

// --- Web Push seam -----------------------------------------------------------
// The next feature extends this file rather than adding a second worker: a
// "push" listener calling self.registration.showNotification(), and a
// "notificationclick" listener that focuses an existing client if one is open
// and otherwise opens the deep link carried on the payload. Subscription
// management (pushManager.subscribe with the VAPID key, POSTing the endpoint
// to /api) belongs on the page side, not here.
