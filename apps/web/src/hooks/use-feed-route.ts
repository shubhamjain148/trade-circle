import * as React from "react"

import { GROUP_VIEW, type FeedView } from "@/lib/types"

/**
 * The feed lives in the URL. This group's loop is "scan, then paste it in the
 * WhatsApp thread", so a member feed has to be a link — and the phone back
 * gesture has to walk back through tabs instead of leaving the app.
 *
 * Hash-based on purpose: no router dependency, and no server rewrite rules
 * needed for a static build. Swap for useParams/useNavigate if a router lands.
 */
export function parseFeedHash(hash: string): FeedView {
  const memberId = /^#\/m\/([^/?#]+)/.exec(hash)?.[1]

  if (memberId) {
    return { kind: "member", memberId: decodeURIComponent(memberId) }
  }

  return GROUP_VIEW
}

export function feedHref(view: FeedView): string {
  return view.kind === "group"
    ? "#/"
    : `#/m/${encodeURIComponent(view.memberId)}`
}

export function useFeedRoute(): [FeedView, (view: FeedView) => void] {
  const [view, setView] = React.useState<FeedView>(() =>
    parseFeedHash(window.location.hash)
  )

  React.useEffect(() => {
    const handleHashChange = () => setView(parseFeedHash(window.location.hash))

    window.addEventListener("hashchange", handleHashChange)
    return () => window.removeEventListener("hashchange", handleHashChange)
  }, [])

  const navigate = React.useCallback((next: FeedView) => {
    const href = feedHref(next)

    if (href === window.location.hash) {
      return
    }

    // Pushing (not replacing) is what makes Back walk the tabs.
    window.location.hash = href.slice(1)
  }, [])

  return [view, navigate]
}
