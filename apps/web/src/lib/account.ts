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
  pending: {
    label: "Connecting",
    summary:
      "INDmoney has approved the link. The watcher takes your first snapshot on the next pass.",
    dot: "bg-muted-foreground/50",
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

/** The two states worth interrupting the feed for. Everything else stays quiet. */
export function needsAttention(account: Account | null): boolean {
  const key = connectionKey(account)
  return key === "none" || key === "needs_reauth" || key === "revoked"
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
    summary: "Your moves appear, attributed to Anonymous.",
  },
  paused: {
    label: "Paused",
    summary: "Nothing of yours reaches the feed. The watcher keeps polling.",
  },
}
