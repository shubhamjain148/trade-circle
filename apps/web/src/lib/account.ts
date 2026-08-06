import type { Account, AccountStatus, Visibility } from "@/lib/types"

/**
 * The one place that decides what a connection state *is*. Four server
 * statuses plus "no account on file" collapse into five presentations, so the
 * settings card, the feed notice and the menu can never disagree.
 */
export type ConnectionKey = "none" | AccountStatus

export interface ConnectionCopy {
  /** Column-style label, uppercase in the UI. */
  label: string
  /** One line under the label — what this state means for the group. */
  summary: string
  /** Marker dot. Semantic colour only where direction is genuinely at stake. */
  dot: string
  /** Text tone for the label. */
  tone: string
  /** Label for the primary action, or null when there's nothing to do. */
  action: string | null
}

export const CONNECTION_COPY: Record<ConnectionKey, ConnectionCopy> = {
  none: {
    label: "Not connected",
    summary:
      "The group can't see your moves. Connecting is what puts you in the feed.",
    dot: "bg-muted-foreground/50",
    tone: "text-muted-foreground",
    action: "Connect INDmoney",
  },
  /**
   * Not a queue — a live fetch. The server kicks the first pull off the moment
   * the OAuth callback lands, so this state is seconds long and resolves on its
   * own; the card re-reads /api/me until it does.
   */
  pending: {
    label: "Fetching positions",
    summary:
      "The link is live and the watcher is reading your holdings now. This usually takes under a minute.",
    dot: "animate-pulse bg-muted-foreground/50 motion-reduce:animate-none",
    tone: "text-muted-foreground",
    action: null,
  },
  active: {
    label: "Connected",
    summary:
      "The watcher is reading your holdings and posting changes to the group feed.",
    dot: "bg-pos-up",
    tone: "text-pos-up",
    action: null,
  },
  needs_reauth: {
    label: "Needs re-auth",
    summary:
      "INDmoney stopped accepting the link — usually an expired session. Nothing new reaches the feed until you reconnect.",
    dot: "bg-pos-down-dim",
    tone: "text-pos-down-dim",
    action: "Reconnect INDmoney",
  },
  revoked: {
    label: "Revoked",
    summary:
      "Access was withdrawn on the INDmoney side. Your past moves stay in the feed; new ones won't appear.",
    dot: "bg-pos-down",
    tone: "text-pos-down",
    action: "Reconnect INDmoney",
  },
}

/**
 * `status` wins over `connected` once an account exists: a revoked link is a
 * disconnected account with a story, and flattening it to "not connected"
 * would lose the reason the feed went quiet.
 */
export function connectionKey(account: Account | null): ConnectionKey {
  return account ? account.status : "none"
}

/**
 * The admin roster's version of the same question. The server sends account
 * states the feed has no presentation for ("not_connected" for a member who has
 * never linked, "paused" for one the poller is leaving alone) — both mean the
 * same thing to someone scanning the list: nothing is coming from them yet.
 */
export function rosterKey(status: string): ConnectionKey {
  return status === "active" ||
    status === "pending" ||
    status === "needs_reauth" ||
    status === "revoked"
    ? status
    : "none"
}

/**
 * The states worth interrupting the feed for. Everything else stays quiet —
 * "pending" in particular, which is a healthy first fetch in progress and
 * clears itself within a minute. A notice for it would be a nag about nothing.
 */
export function needsAttention(account: Account | null): boolean {
  const key = connectionKey(account)
  return key === "none" || key === "needs_reauth" || key === "revoked"
}

/**
 * Connected, but no baseline yet: the server is fetching the first snapshot
 * right now. The one state the session re-reads itself out of.
 */
export function isFetchingFirstSnapshot(account: Account | null): boolean {
  return connectionKey(account) === "pending"
}

/**
 * Callback failures arrive as a code in the hash. Known codes get plain
 * language; anything else is shown verbatim rather than guessed at, so a new
 * server code never reads as the wrong explanation.
 */
const CONNECT_ERRORS: Record<string, string> = {
  access_denied: "The approval was declined on the INDmoney screen.",
  state_mismatch:
    "That connect link had gone stale by the time it came back. Starting again fixes it.",
  expired: "The connect link expired before it was approved.",
  invalid_scope:
    "INDmoney didn't grant the read-only holdings scope the watcher needs.",
  already_connected: "This INDmoney account is already linked to a member.",
  provider_error: "INDmoney returned an error while approving the link.",
  server_error: "The watcher couldn't finish the handshake on its side.",
}

export function connectErrorMessage(code: string): string {
  return CONNECT_ERRORS[code] ?? "The connection didn't go through."
}

/**
 * What the feed actually calls an anonymous member — the server writes this
 * string onto every event and message it attributes (apps/server/src/feed.ts).
 * Anywhere the client names that state itself has to use the same words, or the
 * tab, the header and the rows below it read as three different people.
 */
export const ANONYMOUS_NAME = "Someone in the group"

export const VISIBILITY_COPY: Record<
  Visibility,
  { label: string; summary: string }
> = {
  named: {
    label: "Named",
    summary: "Your moves appear in the feed under your name.",
  },
  anonymous: {
    label: "Anonymous",
    summary: `Your moves still appear, credited to "${ANONYMOUS_NAME}" — including the ones already there.`,
  },
  paused: {
    label: "Paused",
    summary:
      "Your moves leave the feed entirely, past ones included. The watcher keeps polling, so nothing is lost.",
  },
}
