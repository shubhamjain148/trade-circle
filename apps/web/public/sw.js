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

// --- Web Push ----------------------------------------------------------------
// Subscription management (pushManager.subscribe with the VAPID key, POSTing
// the endpoint to /api) lives on the page side, in notifications-section.tsx.
// What is left here is the two things only a worker can do: receive a message
// while every tab is closed, and decide where a tap goes.
//
// The payload is the flat JSON apps/server/src/push/notify.ts builds —
// { title, body, tag, url }. Position events only; chat does not push.

/** Never shown in the normal case; the fallback for a payload we can't read. */
const FALLBACK_NOTIFICATION = {
  title: "Movement in the group",
  body: "Open the watcher to see what changed.",
  tag: "group-moves",
  url: "/#/",
}

function readPushPayload(event) {
  if (!event.data) return FALLBACK_NOTIFICATION
  try {
    const payload = event.data.json()
    if (!payload || typeof payload.title !== "string") return FALLBACK_NOTIFICATION
    return {
      title: payload.title,
      body: typeof payload.body === "string" ? payload.body : "",
      tag: typeof payload.tag === "string" ? payload.tag : "group-moves",
      // The server sends a hash route ("#/m/abc"); the worker needs a path it
      // can open. Anything absolute or off-origin is discarded rather than
      // followed — a notification must never be a way out of this app.
      url:
        typeof payload.url === "string" && payload.url.startsWith("#/")
          ? `/${payload.url}`
          : "/#/",
    }
  } catch {
    return FALLBACK_NOTIFICATION
  }
}

self.addEventListener("push", (event) => {
  const payload = readPushPayload(event)
  // waitUntil is not optional: on both Android and iOS a push that resolves
  // without showing a notification is a permission the browser can revoke.
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      // Per event id, so a redelivery of the same move replaces the row it is
      // already sitting under instead of stacking a second copy.
      tag: payload.tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: payload.url },
      // No vibration, no requireInteraction, no renotify: this group's moves
      // land in the middle of the IST night and none of them is an emergency.
    })
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const target = new URL(event.notification.data?.url ?? "/#/", self.location.origin)

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      })

      // Focus what is already open rather than stacking a second window: on a
      // phone the app is usually still in the background, and the hash route is
      // enough to move it to the right screen.
      for (const client of clients) {
        if (new URL(client.url).origin !== target.origin) continue
        await client.focus()
        if ("navigate" in client) await client.navigate(target.href).catch(() => {})
        return
      }

      await self.clients.openWindow(target.href)
    })()
  )
})
