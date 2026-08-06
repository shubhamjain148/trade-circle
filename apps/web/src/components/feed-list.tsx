import * as React from "react"

import { Button } from "@workspace/ui/components/button"

import { FeedEventRow } from "@/components/feed-event-row"
import {
  FeedNotice,
  FeedSkeleton,
  POLLING_CADENCE,
} from "@/components/feed-states"
import { useNow } from "@/hooks/use-now"
import { dayKey, dayLabel } from "@/lib/format"
import type { FeedEvent } from "@/lib/types"

interface FeedListProps {
  events: FeedEvent[] | undefined
  isLoading: boolean
  error?: Error
  onRetry?: () => void
  showAuthor?: boolean
  emptyTitle?: string
}

interface DaySection {
  key: string
  label: string
  events: FeedEvent[]
}

/** Feed arrives newest-first; keep that order and cut it into day sections. */
function groupByDay(events: FeedEvent[], now: number): DaySection[] {
  const sections: DaySection[] = []

  for (const event of events) {
    const key = dayKey(event.detectedAt)
    const current = sections.at(-1)

    if (current?.key === key) {
      current.events.push(event)
      continue
    }

    sections.push({
      key,
      label: dayLabel(event.detectedAt, now),
      events: [event],
    })
  }

  return sections
}

export function FeedList({
  events,
  isLoading,
  error,
  onRetry,
  showAuthor = true,
  emptyTitle = "No moves yet",
}: FeedListProps) {
  const now = useNow()
  const sections = React.useMemo(
    () => groupByDay(events ?? [], now),
    [events, now]
  )

  if (isLoading && !events) {
    return <FeedSkeleton />
  }

  if (error) {
    return (
      <FeedNotice
        tone="alert"
        title="Can't reach the watcher"
        description="The feed service didn't answer, so nothing below is current. Your friends' portfolios are untouched — this app only ever reads."
        hint={POLLING_CADENCE}
        action={
          onRetry ? (
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          ) : null
        }
      />
    )
  }

  if (sections.length === 0) {
    return (
      <FeedNotice
        title={emptyTitle}
        description="No activity yet — the watcher will post here when someone makes a move."
        hint={POLLING_CADENCE}
      />
    )
  }

  return (
    <div className="flex flex-col gap-7">
      {sections.map((section, index) => (
        <section key={section.key}>
          <div className="flex items-baseline justify-between gap-3 border-b border-border pb-1.5">
            <h3 className="font-mono text-2xs font-medium tracking-caps text-muted-foreground uppercase">
              {section.label}
            </h3>
            {index === 0 ? (
              <span className="font-mono text-3xs tracking-caps text-muted-foreground uppercase">
                % of portfolio
              </span>
            ) : null}
          </div>

          <ul className="divide-y divide-border">
            {section.events.map((event) => (
              <FeedEventRow
                key={event.id}
                event={event}
                showAuthor={showAuthor}
                now={now}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
