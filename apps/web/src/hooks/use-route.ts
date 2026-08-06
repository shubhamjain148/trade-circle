import * as React from "react"

import { parseFeedHash } from "@/hooks/use-feed-route"
import type { Route } from "@/lib/types"

/**
 * Same hash router as the feed, widened to the two screens that arrive from
 * outside the app: an invite link (#/join?token=…) and an OAuth return
 * (#/settings?connected=1). Both carry a query, so the hash is split on "?"
 * before the path is matched — the feed's own routes never have one.
 */
export function parseHash(hash: string): Route {
  const [path, query = ""] = hash.split("?")
  const params = new URLSearchParams(query)

  if (/^#\/join\/?$/.test(path)) {
    return { kind: "join", token: params.get("token") }
  }

  if (/^#\/stats\/?$/.test(path)) {
    return { kind: "stats" }
  }

  if (/^#\/settings\/?$/.test(path)) {
    return {
      kind: "settings",
      connected: params.get("connected") === "1",
      connectError: params.get("connect_error"),
    }
  }

  return { kind: "feed", view: parseFeedHash(path) }
}

export const SETTINGS_HREF = "#/settings"
export const STATS_HREF = "#/stats"
export const FEED_HREF = "#/"

export function useRoute(): Route {
  const [route, setRoute] = React.useState<Route>(() =>
    parseHash(window.location.hash)
  )

  React.useEffect(() => {
    const handleHashChange = () => setRoute(parseHash(window.location.hash))

    window.addEventListener("hashchange", handleHashChange)
    return () => window.removeEventListener("hashchange", handleHashChange)
  }, [])

  return route
}

export function navigate(href: string) {
  if (href === window.location.hash) return
  // Pushing (not replacing) is what makes Back walk the screens.
  window.location.hash = href.slice(1)
}

/**
 * Drops a one-shot query (?token, ?connected, ?connect_error) once it has been
 * consumed, without a navigation: a reload or a Back should not re-run the
 * handshake, and re-firing hashchange here would restart the screen mid-render.
 */
export function stripHashQuery() {
  const [path] = window.location.hash.split("?")
  if (path === window.location.hash) return

  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${path}`
  )
}
