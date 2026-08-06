import * as React from "react"

import { Button } from "@workspace/ui/components/button"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { cn } from "@workspace/ui/lib/utils"

import { HoldingSparkline } from "@/components/holding-sparkline"
import { useHoldingsHistory } from "@/hooks/use-holdings-history"
import { useNow } from "@/hooks/use-now"
import { useResource } from "@/hooks/use-resource"
import { memberPositionsPath } from "@/lib/api"
import { absoluteTime, relativeTimeCompact } from "@/lib/format"
import { instrumentLabel } from "@/lib/instrument"
import { describeSeries, heldFor } from "@/lib/sparkline"
import type { Holding, HoldingHistory } from "@/lib/types"

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
  // A second, parallel read: the rows are the panel and must not wait on a
  // month of history to appear. See use-holdings-history.ts.
  const history = useHoldingsHistory(memberId)
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
          {/* The sparklines' span, said once for the column rather than drawn as
              an axis under every 44px mark. */}
          {history.days.length > 1 ? (
            <>
              <span>{history.days.length}d trend</span>
              <span className="px-1 opacity-50">·</span>
            </>
          ) : null}
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
              <HoldingRow
                key={holding.instrumentId}
                holding={holding}
                series={history.seriesFor(holding.instrumentId)}
                days={history.days}
                historyLoading={history.isLoading}
                now={now}
              />
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

interface HoldingRowProps {
  holding: Holding
  /** This instrument's weight series, once the history read lands. */
  series: HoldingHistory | undefined
  days: string[]
  historyLoading: boolean
  now: number
}

/**
 * The sparkline sits in its own column between the name and the weight, and the
 * column claims its width from the first paint — before the history request has
 * answered — so nothing shifts when the marks arrive.
 *
 * It costs no row height: the mark is 14px inside a name block that is already
 * ~36px whenever a row carries a company name under its ticker. The one caption
 * that can outgrow that (a "held 3w" under the line on a row with no second
 * name line) is exactly the case worth four pixels, because it is the sentence
 * the chart is drawn to say.
 */
function HoldingRow({
  holding,
  series,
  days,
  historyLoading,
  now,
}: HoldingRowProps) {
  const instrument = instrumentLabel(holding.symbol, holding.name)
  // % of portfolio is already 0-100, so the bar is the number, drawn.
  const width = Math.min(100, Math.max(0, holding.pctOfPortfolio))

  // An answer with no days in it is not "everything is new" — it is a watcher
  // that has never polled, or a history read that failed. Either way the row
  // says nothing rather than accusing every holding of being a day old.
  const ready = !historyLoading && days.length > 0
  const hasLine = (series?.points.length ?? 0) > 1
  const age = !ready
    ? null
    : hasLine
      ? heldFor(series?.openedAt ?? null, now)
      : "new"

  return (
    <li className="relative grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 border-b border-border py-2">
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

      {/* Nothing is drawn until there is something true to draw: while the read
          is in flight, and after one that failed or came back empty, the column
          is simply blank. A row of lone dots would read as "all of this is new". */}
      <div className="w-11 shrink-0 self-center">
        {ready ? <HoldingSparkline history={series} days={days} /> : null}
        {age ? (
          <p className="pt-0.5 text-right font-mono text-3xs tracking-wide text-muted-foreground tabular-nums">
            {age}
          </p>
        ) : null}
        {/* The chart in words. Screen readers get the absolute numbers the
            auto-scaled line can't carry; sighted readers get the same sentence
            from the SVG's <title> on hover. */}
        {ready ? (
          <span className="sr-only">
            {hasLine
              ? describeSeries(series?.points ?? [])
              : "New holding — no weight history yet."}
          </span>
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
            className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 border-b border-border py-2"
          >
            <Skeleton
              className="h-3.5 rounded-sm"
              style={{ width: `${44 - index * 6}%` }}
            />
            {/* The sparkline column, held open so the real rows land in the
                same geometry the skeleton drew. */}
            <Skeleton className="h-3.5 w-11 rounded-sm" />
            <Skeleton className="h-3.5 w-10 rounded-sm" />
          </li>
        ))}
      </ul>
      <span className="sr-only">Reading the latest holdings…</span>
    </div>
  )
}
