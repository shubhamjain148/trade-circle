import * as React from "react"

/**
 * A clock the relative timestamps can hang off. Without it "7h" is frozen at
 * whatever it was when the tab was opened — which, for a feed people leave
 * open all evening, quietly turns into a lie.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])

  return now
}
