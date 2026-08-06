import type * as React from "react"

/**
 * One band of the stats page: a hairline-ruled label, an optional right-hand
 * unit note, and rows under it.
 *
 * The same header the holdings panel draws, lifted into a component because
 * this page stacks four of them and a page whose sections each invent their own
 * rule weight reads as four pages. No card, no icon, no surface — the rule and
 * the type size are the entire hierarchy.
 */
interface StatsSectionProps {
  id: string
  title: string
  /** Sits next to the title in tabular numerals, e.g. how many rows follow. */
  count?: number
  /** Right-hand note. What the numbers in this section *are*, not a subtitle. */
  unit?: string
  children: React.ReactNode
}

export function StatsSection({
  id,
  title,
  count,
  unit,
  children,
}: StatsSectionProps) {
  return (
    <section aria-labelledby={id}>
      <div className="flex items-baseline justify-between gap-3 border-b border-border pb-1.5">
        <h3
          id={id}
          className="font-mono text-2xs font-medium tracking-caps text-muted-foreground uppercase"
        >
          {title}
          {count === undefined ? null : (
            <span className="pl-1.5 tabular-nums">{count}</span>
          )}
        </h3>
        {unit ? (
          <span className="shrink-0 font-mono text-3xs tracking-caps text-muted-foreground uppercase tabular-nums">
            {unit}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  )
}

/** A section that has nothing in it yet, said in one line rather than a panel. */
export function StatsSectionEmpty({ children }: { children: React.ReactNode }) {
  return (
    <p className="max-w-md py-3 text-sm text-muted-foreground">{children}</p>
  )
}
