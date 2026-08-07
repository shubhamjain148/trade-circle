import * as React from "react"

import { COARSE_POINTER_QUERY, isCoarsePointer } from "@/lib/platform"

/**
 * True while the primary pointer is a finger. Subscribed rather than read once,
 * for the same reason `useStandalone` is: an iPad that has just been dropped
 * into a keyboard case is a different device than it was a second ago, and the
 * composer's Enter key has to change its mind with it.
 *
 * The server-side snapshot is `false` — a hardware keyboard is the assumption
 * that degrades safely, because Shift+Enter still breaks the line either way.
 */
export function useCoarsePointer(): boolean {
  return React.useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(COARSE_POINTER_QUERY)
      query.addEventListener("change", onChange)
      return () => query.removeEventListener("change", onChange)
    },
    isCoarsePointer,
    () => false
  )
}
