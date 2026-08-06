import { GateScreen } from "@/components/gate-screen"

/**
 * A dead end on purpose. There is no signup, no password, no "request access"
 * — the only way in is a link someone sends you, so the screen says exactly
 * that and offers nothing it can't honour.
 */
export function SignedOutView() {
  return (
    <GateScreen>
      <div className="flex flex-col gap-5">
        <h1 className="font-heading text-xl leading-snug font-medium tracking-tight text-balance">
          A private feed of what your friends are buying — invite only.
        </h1>

        <p className="border-t border-border pt-4 text-sm leading-relaxed text-muted-foreground">
          Open your invite link to join. It's a one-time link from whoever runs
          this watcher; ask them for one if you don't have it.
        </p>

        <dl className="grid gap-2 font-mono text-2xs leading-relaxed tracking-wide text-muted-foreground">
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 tracking-caps uppercase">Shows</dt>
            <dd>entries, exits and size changes — % of portfolio</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 tracking-caps uppercase">Never</dt>
            <dd>amounts, orders, advice, or anyone outside the group</dd>
          </div>
        </dl>
      </div>
    </GateScreen>
  )
}
