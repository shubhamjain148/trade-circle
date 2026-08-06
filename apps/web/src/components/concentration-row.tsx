import { feedHref } from "@/hooks/use-feed-route"
import { instrumentLabel } from "@/lib/instrument"
import type { MemberConcentration } from "@/lib/types"

/**
 * How much of one member's portfolio sits in their three biggest positions.
 *
 * The number is a share of their own portfolio and nothing else, so 100% means
 * "three positions, that's the lot" rather than anything about size. The line
 * under the name says which position leads it, because "Rahul: 100%" on its own
 * is a statistic and "Rahul: 100%, NVDA at 61%" is a thing to text him about.
 */
export function ConcentrationRow({ row }: { row: MemberConcentration }) {
  const label = instrumentLabel(row.largest.symbol, row.largest.name)

  return (
    // No weight bar here, unlike every other row on this page. Top-three shares
    // cluster between 80 and 100 by construction — three near-full-width rules
    // stacked read as heavy dividers rather than as data, and the ranking is
    // already carried by the order and the number.
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 border-b border-border py-2">
      <div className="min-w-0">
        <p className="truncate font-heading text-sm font-medium tracking-tight">
          {row.memberId ? (
            <a
              href={feedHref({ kind: "member", memberId: row.memberId })}
              className="rounded-xs underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {row.name}
            </a>
          ) : (
            <span className="text-muted-foreground">{row.name}</span>
          )}
        </p>
        <p className="truncate font-mono text-2xs tracking-wide text-muted-foreground tabular-nums">
          {label.primary} {row.largest.pctOfPortfolio.toFixed(1)}%
          <span className="px-1 opacity-50">·</span>
          {row.positionCount} {row.positionCount === 1 ? "position" : "positions"}
        </p>
      </div>

      <div className="w-16 shrink-0 text-right font-mono text-sm tabular-nums">
        {row.topThreeWeight.toFixed(1)}%
        <span className="sr-only"> in their top three positions</span>
      </div>
    </li>
  )
}
