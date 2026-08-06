import * as React from "react"

import { GateScreen } from "@/components/gate-screen"

/**
 * /api/me decides which of three screens you get, so there is a real gap
 * before the app can say anything true. Held blank for a beat first: on a warm
 * session the answer lands in under 100ms, and a loading line that appears and
 * vanishes is more disruptive than the wait it describes.
 */
const QUIET_MS = 220

export function BootView() {
  const [showLine, setShowLine] = React.useState(false)

  React.useEffect(() => {
    const timer = window.setTimeout(() => setShowLine(true), QUIET_MS)
    return () => window.clearTimeout(timer)
  }, [])

  return (
    <GateScreen>
      <p
        role="status"
        aria-live="polite"
        data-visible={showLine}
        className="font-mono text-2xs tracking-caps text-muted-foreground uppercase opacity-0 transition-opacity duration-300 data-[visible=true]:opacity-100 motion-reduce:transition-none"
      >
        {showLine ? "Checking your session…" : null}
      </p>
    </GateScreen>
  )
}
