import * as React from "react"

import { Button } from "@workspace/ui/components/button"

import { ChatMessageRow } from "@/components/chat-message-row"
import { FeedEventRow } from "@/components/feed-event-row"
import {
  FeedNotice,
  FeedSkeleton,
  POLLING_CADENCE,
} from "@/components/feed-states"
import type { ChatItem } from "@/hooks/use-chat"
import { useNow } from "@/hooks/use-now"
import { dayKey, dayLabel } from "@/lib/format"

interface ChatTimelineProps {
  items: ChatItem[]
  /** The signed-in member — the only reason a row knows it is "yours". */
  memberId: string
  isLoading: boolean
  error?: Error
  onReload: () => void
  onRetryMessage: (id: string) => void
}

interface DaySection {
  key: string
  label: string
  items: ChatItem[]
}

function itemTime(item: ChatItem): string {
  return item.kind === "message" ? item.createdAt : item.detectedAt
}

/**
 * The chat arrives oldest-first — the opposite of /api/feed, because the newest
 * line belongs next to the composer. Day sections keep the feed's rhythm, they
 * just run down the page instead of up it.
 */
function groupByDay(items: ChatItem[], now: number): DaySection[] {
  const sections: DaySection[] = []

  for (const item of items) {
    const at = itemTime(item)
    const key = dayKey(at)
    const current = sections.at(-1)

    if (current?.key === key) {
      current.items.push(item)
      continue
    }

    sections.push({ key, label: dayLabel(at, now), items: [item] })
  }

  return sections
}

export function ChatTimeline({
  items,
  memberId,
  isLoading,
  error,
  onReload,
  onRetryMessage,
}: ChatTimelineProps) {
  const now = useNow()
  const sections = React.useMemo(() => groupByDay(items, now), [items, now])

  if (isLoading && items.length === 0) {
    return <FeedSkeleton />
  }

  // An error with rows already on screen is a stale banner's job, not a wipe:
  // only a cold start that never landed gets to replace the thread.
  if (error && items.length === 0) {
    return (
      <FeedNotice
        tone="alert"
        title="Can't reach the watcher"
        description="The chat service didn't answer, so nothing here is current. Your friends' portfolios are untouched — this app only ever reads."
        hint={POLLING_CADENCE}
        action={
          <Button variant="outline" size="sm" onClick={onReload}>
            Try again
          </Button>
        }
      />
    )
  }

  if (sections.length === 0) {
    return (
      <FeedNotice
        title="Nothing here yet"
        description="Say something, or wait for someone to make a move. Trades land in this thread on their own."
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
            {/* The unit belongs on the newest block — the one you land on. */}
            {index === sections.length - 1 ? (
              <span className="font-mono text-3xs tracking-caps text-muted-foreground uppercase">
                % of portfolio
              </span>
            ) : null}
          </div>

          <ul className="divide-y divide-border">
            {section.items.map((item) =>
              item.kind === "event" ? (
                <FeedEventRow key={item.id} event={item} now={now} />
              ) : (
                <ChatMessageRow
                  key={item.id}
                  message={item}
                  own={item.memberId === memberId}
                  now={now}
                  onRetry={onRetryMessage}
                />
              )
            )}
          </ul>
        </section>
      ))}
    </div>
  )
}
