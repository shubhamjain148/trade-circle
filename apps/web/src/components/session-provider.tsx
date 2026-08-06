/* eslint-disable react-refresh/only-export-components */
import * as React from "react"

import { isFetchingFirstSnapshot } from "@/lib/account"
import { ApiError, getJson, logoutPath, mePath, send } from "@/lib/api"
import type { Account, Me, Member } from "@/lib/types"

/**
 * Four states, because the wrong screen shown confidently is worse than a
 * blank one: "booting" is the honest gap before /api/me answers, and
 * "unreachable" keeps a server outage from masquerading as being signed out.
 */
export type SessionState =
  | { status: "booting" }
  | { status: "signed-out" }
  | { status: "signed-in"; member: Member; account: Account | null }
  | { status: "unreachable"; error: Error }

interface SessionValue {
  state: SessionState
  /** Re-reads /api/me. Used after joining, connecting and disconnecting. */
  refresh: () => Promise<void>
  /**
   * Writes the signed-in member locally, without a round trip. This is how an
   * optimistic change (and its revert) reaches every surface that reads the
   * session — a change that only lands after the server answers reads as lag.
   * A no-op unless we're signed in: there is no member to replace otherwise.
   */
  setMember: (member: Member) => void
  signOut: () => Promise<void>
}

const SessionContext = React.createContext<SessionValue | undefined>(undefined)

/** How often to re-read /api/me while the first snapshot is still landing. */
const FIRST_FETCH_POLL_MS = 3000

function toState(me: Me): SessionState {
  return { status: "signed-in", member: me.member, account: me.account }
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<SessionState>({ status: "booting" })

  const refresh = React.useCallback(async () => {
    try {
      setState(toState(await getJson<Me>(mePath)))
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setState({ status: "signed-out" })
        return
      }

      setState({
        status: "unreachable",
        error: cause instanceof Error ? cause : new Error(String(cause)),
      })
    }
  }, [])

  const setMember = React.useCallback((member: Member) => {
    setState((current) =>
      current.status === "signed-in" ? { ...current, member } : current
    )
  }, [])

  const signOut = React.useCallback(async () => {
    // Optimistic: the cookie is gone server-side either way, and leaving a
    // signed-in shell on screen after "Log out" is the worse failure.
    try {
      await send(logoutPath, "POST")
    } finally {
      setState({ status: "signed-out" })
    }
  }, [])

  React.useEffect(() => {
    // Boot read. Wrapped so the state transition is unambiguously async —
    // the very first paint must be the boot screen, never a guess.
    let cancelled = false

    void (async () => {
      await Promise.resolve()
      if (!cancelled) await refresh()
    })()

    return () => {
      cancelled = true
    }
  }, [refresh])

  // The first fetch after a connect runs in the background on the server, so
  // the only way the card learns it finished is to ask again. Three seconds
  // against a fetch that usually takes a few: fast enough that "Connected"
  // feels like it arrived by itself, and it stops the moment it has.
  const fetchingFirstSnapshot =
    state.status === "signed-in" && isFetchingFirstSnapshot(state.account)

  React.useEffect(() => {
    if (!fetchingFirstSnapshot) return

    const timer = window.setInterval(() => void refresh(), FIRST_FETCH_POLL_MS)
    return () => window.clearInterval(timer)
  }, [fetchingFirstSnapshot, refresh])

  const value = React.useMemo(
    () => ({ state, refresh, setMember, signOut }),
    [state, refresh, setMember, signOut]
  )

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  )
}

export function useSession(): SessionValue {
  const context = React.useContext(SessionContext)

  if (context === undefined) {
    throw new Error("useSession must be used within a SessionProvider")
  }

  return context
}
