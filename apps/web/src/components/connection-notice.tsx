import { navigate, SETTINGS_HREF } from "@/hooks/use-route"
import { connectionKey, needsAttention, type ConnectionKey } from "@/lib/account"
import type { Account } from "@/lib/types"

const NOTICE: Partial<Record<ConnectionKey, { message: string; cta: string }>> =
  {
    none: {
      message:
        "Your INDmoney account isn't connected — the group can't see your moves.",
      cta: "Connect it",
    },
    needs_reauth: {
      message:
        "Your INDmoney link needs re-authorising — the group can't see your moves.",
      cta: "Reconnect it",
    },
    revoked: {
      message:
        "Your INDmoney access was revoked — the group can't see your moves.",
      cta: "Reconnect it",
    },
  }

/**
 * One line, once, above the feed. It states a fact and offers the fix; it does
 * not repeat itself, cannot be dismissed into oblivion, and never grows into a
 * banner. If it's still here tomorrow that's information, not nagging.
 */
export function ConnectionNotice({ account }: { account: Account | null }) {
  if (!needsAttention(account)) return null

  const copy = NOTICE[connectionKey(account)]
  if (!copy) return null

  return (
    /* Grid, not flex-wrap: the marker has to hold the first line's optical
       baseline on a phone, where the sentence runs to three lines. */
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 border-b border-border pb-3">
      <span
        aria-hidden
        className="mt-[0.5rem] size-1.5 shrink-0 rounded-full bg-pos-down-dim"
      />
      <p className="text-sm leading-relaxed text-muted-foreground">
        {copy.message}{" "}
        <a
          href={SETTINGS_HREF}
          onClick={(event) => {
            event.preventDefault()
            navigate(SETTINGS_HREF)
          }}
          className="font-medium whitespace-nowrap text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
        >
          {copy.cta}
        </a>
      </p>
    </div>
  )
}
