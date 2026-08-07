import * as React from "react"

import { Button, buttonVariants } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

import { useNow } from "@/hooks/use-now"
import { CONNECTION_COPY, connectionKey } from "@/lib/account"
import { connectPath, connectStartPath, send } from "@/lib/api"
import { absoluteTime, relativeTime } from "@/lib/format"
import { REVEAL } from "@/lib/motion"
import type { Account } from "@/lib/types"

interface ConnectionCardProps {
  account: Account | null
  onChanged: () => void
}

/**
 * One account — yours. There is no admin view here and never will be: the
 * whole product is a group of peers who each hold their own key.
 */
export function ConnectionCard({ account, onChanged }: ConnectionCardProps) {
  const now = useNow()
  const [confirming, setConfirming] = React.useState(false)
  const [disconnecting, setDisconnecting] = React.useState(false)
  const [failure, setFailure] = React.useState<string | null>(null)

  const key = connectionKey(account)
  const copy = CONNECTION_COPY[key]
  const canDisconnect = account !== null && key !== "revoked"

  const disconnect = async () => {
    setDisconnecting(true)
    setFailure(null)

    try {
      await send(connectPath, "DELETE")
      setConfirming(false)
      onChanged()
    } catch {
      setFailure("Couldn't disconnect — the watcher didn't answer.")
    } finally {
      setDisconnecting(false)
    }
  }

  return (
    <section
      aria-labelledby="connection-heading"
      className="rounded-xl bg-card p-4 ring-1 ring-foreground/10"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2
          id="connection-heading"
          className="font-heading text-sm font-medium tracking-tight"
        >
          Your INDmoney account
        </h2>

        {/* Status reads as a column value, not a pill: dot + mono caps. */}
        <p className="flex items-center gap-1.5 font-mono text-2xs tracking-caps uppercase">
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full", copy.dot)}
          />
          <span className={copy.tone}>{copy.label}</span>
        </p>
      </div>

      <p className="max-w-prose pt-2 text-sm leading-relaxed text-muted-foreground">
        {copy.summary}
      </p>

      {/* A sync line only exists once there's something to sync. "Never
          synced" under "Not connected" is the same sentence twice — and so is
          "no pass yet" under a status that already says one is running. */}
      {account && key !== "pending" ? (
        <p className="pt-2 font-mono text-2xs tracking-wide text-muted-foreground tabular-nums">
          {account.lastPolledAt ? (
            <time
              dateTime={account.lastPolledAt}
              title={absoluteTime(account.lastPolledAt)}
            >
              last synced {relativeTime(account.lastPolledAt, now)}
            </time>
          ) : (
            "no pass yet"
          )}
        </p>
      ) : null}

      {confirming ? (
        <ConfirmDisconnect
          busy={disconnecting}
          onConfirm={disconnect}
          onCancel={() => setConfirming(false)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2 pt-4">
          {copy.action ? (
            /* A real link, not a button that fetches: /start answers 302 to
               INDmoney, an XHR would swallow the redirect, and keeping it an
               anchor preserves open-in-new-tab and link semantics. */
            <a
              href={connectStartPath}
              className={buttonVariants({
                size: key === "none" ? "default" : "sm",
                variant: key === "none" ? "default" : "outline",
              })}
            >
              {copy.action}
            </a>
          ) : null}

          {canDisconnect ? (
            <Button
              variant="ghost"
              size="sm"
              /* When it stands alone, its own padding is the only thing
                 indenting it away from the card's text edge. */
              className={cn("text-muted-foreground", !copy.action && "-ml-2.5")}
              onClick={() => setConfirming(true)}
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      )}

      {failure ? (
        <p role="alert" className="pt-3 text-sm text-destructive">
          {failure}
        </p>
      ) : null}
    </section>
  )
}

/**
 * Inline, not a modal. The consequence is one sentence long and the answer is
 * right where the question was asked — a dialog here would be ceremony.
 */
function ConfirmDisconnect({
  busy,
  onConfirm,
  onCancel,
}: {
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const confirmRef = React.useRef<HTMLButtonElement>(null)

  React.useEffect(() => confirmRef.current?.focus(), [])

  return (
    /* The question replaces the Disconnect button in place, so it needs the
       same 200ms reveal the app's other disclosures use — a block of consequence
       text that teleports in under your thumb is how people tap the wrong
       thing. */
    <div className={cn("mt-4 border-t border-border pt-3", REVEAL)}>
      <p className="text-sm text-foreground">
        Disconnect INDmoney? The group stops seeing your moves. Your past
        entries stay in the feed.
      </p>
      <div className="flex flex-wrap items-center gap-2 pt-3">
        <Button
          ref={confirmRef}
          variant="destructive"
          size="sm"
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? "Disconnecting…" : "Yes, disconnect"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          className="text-muted-foreground"
          onClick={onCancel}
        >
          Keep connected
        </Button>
      </div>
    </div>
  )
}
