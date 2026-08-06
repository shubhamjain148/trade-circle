import * as React from "react"

import { Button } from "@workspace/ui/components/button"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { cn } from "@workspace/ui/lib/utils"

import { useNow } from "@/hooks/use-now"
import { useResource } from "@/hooks/use-resource"
import { memberPositionsPath } from "@/lib/api"
import { absoluteTime, relativeTimeCompact } from "@/lib/format"
import { instrumentLabel } from "@/lib/instrument"
import type { Holding } from "@/lib/types"

/**
 * How many rows a portfolio shows before it asks. Five is about where a phone
 * still leaves the first feed row on screen, and five holdings is most of a
 * concentrated US portfolio anyway — the tail is one tap away, not hidden.
 */
const COMPACT_ROWS = 5

interface HoldingsPanelProps {
  memberId: string
  /** How the page names this member; used in the empty/paused copy. */
  name: string
  /** Paused members are held back from the group — see the copy below. */
  paused?: boolean
  /** The signed-in member is looking at their own page. */
  isSelf?: boolean
}

/**
 * What a friend is holding right now, above the log of what they did.
 *
 * A table, not cards: name on the left, weight in an aligned right-hand column,
 * and the row's hairline doubling as a proportional bar. That bar is the only
 * visual the panel spends, and it is scaled against the whole portfolio rather
 * than against the largest holding — scaling to the largest makes a two-stock
 * portfolio look like two full-width rules, which reads as a heavier divider
 * rather than as data. Against 100 the bar is always a fraction of the row, and
 * a concentrated portfolio looks concentrated.
 *
 * Weights only, never amounts: the server sends nothing else (see
 * apps/server/src/positions.ts) and this component asks for nothing else.
 */
export function HoldingsPanel({
  memberId,
  name,
  paused = false,
  isSelf = false,
}: HoldingsPanelProps) {
  const { data, error, isLoading, reload } = useResource<Holding[]>(
    memberPositionsPath(memberId)
  )
  const now = useNow()
  const [expanded, setExpanded] = React.useState(false)

  const holdings = data ?? []
  const shown = expanded ? holdings : holdings.slice(0, COMPACT_ROWS)
  const hidden = holdings.length - shown.length
  // The tail's combined weight — so collapsing never hides how much is down there.
  const hiddenWeight = holdings
    .slice(shown.length)
    .reduce((total, h) => total + h.pctOfPortfolio, 0)

  // One "as of" for the panel: every row lands in the same pass, and a column
  // of identical timestamps would be noise.
  const asOf = holdings.reduce<string | null>(
    (latest, h) => (!latest || h.updatedAt > latest ? h.updatedAt : latest),
    null
  )

  return (
    <section aria-labelledby="holdings-heading">
      <div className="flex items-baseline justify-between gap-3 border-b border-border pb-1.5">
        <h3
          id="holdings-heading"
          className="font-mono text-2xs font-medium tracking-caps text-muted-foreground uppercase"
        >
          Holdings
          {holdings.length ? (
            <span className="pl-1.5 tabular-nums">{holdings.length}</span>
          ) : null}
        </h3>
        <span className="shrink-0 font-mono text-3xs tracking-caps text-muted-foreground uppercase tabular-nums">
          {asOf ? (
            <time dateTime={asOf} title={absoluteTime(asOf)}>
              as of {relativeTimeCompact(asOf, now)}
            </time>
          ) : (
            "% of portfolio"
          )}
        </span>
      </div>

      {isLoading && !data ? (
        <HoldingsSkeleton />
      ) : error ? (
        // Quiet: the feed below runs its own fetch and will shout if the
        // watcher is genuinely down. Two alarms for one outage is a panic.
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-3">
          <p className="text-sm text-muted-foreground">
            Couldn't read the current holdings.
          </p>
          <Button variant="outline" size="sm" onClick={reload}>
            Try again
          </Button>
        </div>
      ) : holdings.length === 0 ? (
        <p className="max-w-md py-3 text-sm text-muted-foreground">
          <span className="text-foreground">No positions visible.</span>{" "}
          {/* The long version of the paused story belongs to the feed below —
              this panel and that notice sit two inches apart, and printing the
              same paragraph twice reads as a stutter, not as emphasis. */}
          {paused
            ? `${name} is paused, so holdings are held back too.`
            : `Nothing on file for ${name} yet — holdings appear after the watcher's first pass.`}
        </p>
      ) : (
        <>
          <ul id="holdings-rows">
            {shown.map((holding) => (
              <HoldingRow key={holding.instrumentId} holding={holding} />
            ))}
          </ul>

          {hidden > 0 || expanded ? (
            <div className="flex flex-wrap items-baseline gap-x-2 pt-1.5">
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={expanded}
                aria-controls="holdings-rows"
                className="-ml-2.5 font-mono text-2xs tracking-wide text-muted-foreground tabular-nums"
                onClick={() => setExpanded((open) => !open)}
              >
                {expanded ? `Top ${COMPACT_ROWS}` : `All ${holdings.length}`}
              </Button>
              {hidden > 0 ? (
                <span className="font-mono text-3xs tracking-wide text-muted-foreground tabular-nums">
                  {hidden} more · {hiddenWeight.toFixed(1)}%
                </span>
              ) : null}
            </div>
          ) : null}

          {paused && isSelf ? (
            // Their own page, so the rows are here — but the group's copy of
            // this panel is empty, and saying so beats them finding out later.
            <p className="pt-2 font-mono text-3xs leading-relaxed tracking-wide text-muted-foreground">
              You're paused — only you can see this. The group's view of your
              holdings is empty until you switch back.
            </p>
          ) : null}
        </>
      )}
    </section>
  )
}

function HoldingRow({ holding }: { holding: Holding }) {
  const instrument = instrumentLabel(holding.symbol, holding.name)
  // % of portfolio is already 0-100, so the bar is the number, drawn.
  const width = Math.min(100, Math.max(0, holding.pctOfPortfolio))

  return (
    <li className="relative grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-border py-2">
      <div className="min-w-0">
        {/* A ticker is a code and earns monospace; a company name is prose and
            doesn't — same call the feed row makes, so the two read as one app. */}
        <p
          className={cn(
            "truncate text-sm font-semibold tracking-tight",
            instrument.isTicker ? "font-mono" : "font-heading"
          )}
        >
          {instrument.primary}
        </p>
        {instrument.detail ? (
          <p className="truncate text-xs text-muted-foreground">
            {instrument.detail}
          </p>
        ) : null}
      </div>

      <div className="w-16 shrink-0 text-right font-mono text-sm tabular-nums">
        {holding.pctOfPortfolio.toFixed(1)}%
        <span className="sr-only"> of portfolio</span>
      </div>

      {/* The row's own hairline, darkened for the length of its weight. Sits on
          the border rather than beside it: a histogram that costs no height. */}
      <span
        aria-hidden
        className="absolute -bottom-px left-0 h-px bg-foreground/30"
        style={{ width: `${width}%` }}
      />
    </li>
  )
}

function HoldingsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <ul aria-hidden>
        {Array.from({ length: rows }).map((_, index) => (
          /* py-2 matches the real row, so nothing jolts on arrival. */
          <li
            key={index}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-b border-border py-2"
          >
            <Skeleton
              className="h-3.5 rounded-sm"
              style={{ width: `${44 - index * 6}%` }}
            />
            <Skeleton className="h-3.5 w-10 rounded-sm" />
          </li>
        ))}
      </ul>
      <span className="sr-only">Reading the latest holdings…</span>
    </div>
  )
}
