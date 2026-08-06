import { Button } from "@workspace/ui/components/button"

import { GateScreen } from "@/components/gate-screen"

/**
 * The server didn't answer at all — distinct from being signed out, because
 * telling someone they're logged out when they aren't sends them hunting for
 * an invite link they don't need.
 */
export function UnreachableView({ onRetry }: { onRetry: () => void }) {
  return (
    <GateScreen>
      <div className="flex flex-col items-start gap-5" role="alert">
        <h1 className="font-heading text-xl leading-snug font-medium tracking-tight text-balance">
          Can't reach the watcher.
        </h1>

        <p className="border-t border-border pt-4 text-sm leading-relaxed text-muted-foreground">
          Your session is probably fine — the server just didn't answer. Nothing
          was changed; this app only ever reads.
        </p>

        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </GateScreen>
  )
}
