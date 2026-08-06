import * as React from "react"

/**
 * True when the app is running from the home screen rather than a browser tab.
 * Chrome/Edge/Android report it through the display-mode media query; iOS
 * Safari never implemented that one and exposes `navigator.standalone`
 * instead, so both are asked.
 */
const STANDALONE_QUERY = "(display-mode: standalone)"

function readStandalone(): boolean {
  if (typeof window === "undefined") return false
  if (window.matchMedia(STANDALONE_QUERY).matches) return true
  return (
    "standalone" in window.navigator &&
    (window.navigator as { standalone?: boolean }).standalone === true
  )
}

export function useStandalone(): boolean {
  // Subscribed rather than read once: launching the installed app is a fresh
  // document, but Chrome flips display-mode live when a tab is installed.
  return React.useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(STANDALONE_QUERY)
      query.addEventListener("change", onChange)
      return () => query.removeEventListener("change", onChange)
    },
    readStandalone,
    () => false
  )
}
