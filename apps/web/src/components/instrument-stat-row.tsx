import * as React from "react"

import { cn } from "@workspace/ui/lib/utils"

import { feedHref } from "@/hooks/use-feed-route"
import { instrumentLabel } from "@/lib/instrument"
import type { GroupInstrument, StatsHolder } from "@/lib/types"

interface InstrumentStatRowProps {
  instrument: GroupInstrument
  /** The denominator in "held by 3 of 4" — every member the group can see. */
  visibleMembers: number
}

/**
 * One instrument, and how much of the group is in it.
 *
 * Two rows in one component because they are one row with a different holder
 * count: a consensus pick opens to show who holds it, a solo pick has nothing
 * to open — its single holder fits on the line under the ticker. Splitting them
 * would give the page two row rhythms for the same fact.
 *
 * The number on the right is the *average* holder's weight in their own
 * portfolio, and the hairline under the row is that number drawn against 100.
 * Never the sum: a summed weight above 100% would read as a share of something,
 * and there is no group portfolio for it to be a share of.
 */
export function InstrumentStatRow({
  instrument,
  visibleMembers,
}: InstrumentStatRowProps) {
  const [open, setOpen] = React.useState(false)
  const label = instrumentLabel(instrument.symbol, instrument.name)
  const expandable = instrument.holderCount > 1
  const holdersId = `holders-${instrument.instrumentId}`
  const weight = Math.min(100, Math.max(0, instrument.averageWeight))

  const heading = (
    <>
      <div className="min-w-0">
        {/* A ticker is a code and earns monospace; a company name is prose and
            doesn't — the same call the feed row and the holdings panel make. */}
        <p
          className={cn(
            "truncate text-sm font-semibold tracking-tight",
            label.isTicker ? "font-mono" : "font-heading"
          )}
        >
          {label.primary}
        </p>
        <p className="truncate font-mono text-2xs tracking-wide text-muted-foreground tabular-nums">
          {expandable ? (
            `held by ${instrument.holderCount} of ${visibleMembers}`
          ) : (
            <>
              only <HolderName holder={instrument.holders[0]} />
            </>
          )}
          {label.detail ? (
            <span className="font-sans tracking-normal">
              <span className="px-1 opacity-50">·</span>
              {label.detail}
            </span>
          ) : null}
        </p>
      </div>

      <div className="flex shrink-0 items-baseline gap-1.5">
        <span className="w-16 text-right font-mono text-sm tabular-nums">
          {instrument.averageWeight.toFixed(1)}%
        </span>
        {expandable ? <Caret open={open} /> : <span className="w-3" />}
      </div>

      {/* The row's own hairline, darkened for the length of the weight. Sits on
          the border rather than beside it: a histogram that costs no height. */}
      <span
        aria-hidden
        className="absolute -bottom-px left-0 h-px bg-foreground/30"
        style={{ width: `${weight}%` }}
      />
    </>
  )

  const shape =
    "relative grid w-full grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-border py-2 text-left"

  return (
    <li>
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={holdersId}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            shape,
            "transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/40"
          )}
        >
          {heading}
        </button>
      ) : (
        <div className={shape}>{heading}</div>
      )}

      {expandable && open ? (
        <ul id={holdersId} className="border-l border-border pl-3">
          {instrument.holders.map((holder, index) => (
            <li
              key={holder.memberId ?? `anon-${index}`}
              className="relative grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-border py-1.5"
            >
              <span className="truncate text-xs">
                <HolderName holder={holder} />
              </span>
              <span className="w-16 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums">
                {holder.pctOfPortfolio.toFixed(1)}%
                <span className="sr-only"> of their portfolio</span>
              </span>
              <span
                aria-hidden
                className="absolute -bottom-px left-0 h-px bg-foreground/20"
                style={{
                  width: `${Math.min(100, Math.max(0, holder.pctOfPortfolio))}%`,
                }}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}

/**
 * A named holder links to their page; an anonymous one is plain text, and the
 * client never has to make that call — the server sends `memberId: null` for
 * exactly the members it declines to name.
 */
export function HolderName({ holder }: { holder: StatsHolder }) {
  if (!holder.memberId) {
    return <span className="text-muted-foreground">{holder.name}</span>
  }

  return (
    <a
      href={feedHref({ kind: "member", memberId: holder.memberId })}
      className="rounded-xs underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {holder.name}
    </a>
  )
}

/** Rotates rather than swaps: one glyph, and the turn says which way it went. */
function Caret({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 12 12"
      className={cn(
        "size-3 shrink-0 self-center text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
        open && "rotate-90"
      )}
    >
      <path
        d="M4.5 2.5 8 6l-3.5 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
