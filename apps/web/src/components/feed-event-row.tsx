import { cn } from "@workspace/ui/lib/utils"

import { MemberAvatar } from "@/components/member-avatar"
import { EVENT_STYLES } from "@/lib/events"
import {
  absoluteTime,
  formatQtyChange,
  relativeTimeCompact,
} from "@/lib/format"
import type { FeedEvent } from "@/lib/types"

interface FeedEventRowProps {
  event: FeedEvent
  /** Group feed shows who moved; an individual feed already knows. */
  showAuthor?: boolean
  /** Ticking clock, so "7h" doesn't freeze on a tab left open all evening. */
  now?: number
}

/**
 * One line of the feed: who · what · how much · when, left to right, with the
 * numbers in an aligned right-hand column. Deliberately not a card.
 *
 * The row highlight is row-tracking across the alignment gutter, not a tap
 * affordance — the cursor never changes and nothing here is focusable.
 */
export function FeedEventRow({
  event,
  showAuthor = true,
  now,
}: FeedEventRowProps) {
  const style = EVENT_STYLES[event.type]
  const exited = event.type === "EXITED"

  return (
    <li className="-mx-2 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-2 transition-colors hover:bg-foreground/[0.035]">
      {showAuthor ? (
        <MemberAvatar
          name={event.accountName}
          seed={event.accountId}
          size="sm"
        />
      ) : (
        <span aria-hidden className={cn("size-1.5 rounded-full", style.dot)} />
      )}

      <div className="min-w-0">
        <div className="flex items-baseline gap-x-2">
          {showAuthor ? (
            <span className="shrink-0 font-heading text-sm font-medium">
              {event.accountName}
            </span>
          ) : null}
          <span
            className={cn(
              "shrink-0 font-mono text-2xs font-medium tracking-[0.09em]",
              style.tone
            )}
          >
            {style.tag}
          </span>
          <span className="truncate font-mono text-sm font-semibold tracking-tight">
            {event.symbol}
          </span>
        </div>

        <p className="truncate text-xs text-muted-foreground">
          {event.instrumentName}
          {event.qtyChangePct !== undefined ? (
            <>
              <span className="px-1 opacity-50">·</span>
              <span className="tabular-nums">
                {formatQtyChange(event.qtyChangePct)}
              </span>
            </>
          ) : null}
        </p>
      </div>

      <div className="w-16 shrink-0 text-right">
        <div
          className={cn(
            "font-mono text-sm tabular-nums",
            exited ? "text-muted-foreground" : "text-foreground"
          )}
        >
          {exited ? "—" : `${event.pctOfPortfolio.toFixed(1)}%`}
          {/* The unit used to live in a title attribute — unreachable on the
              phone this is mostly read on, and invisible to screen readers. */}
          <span className="sr-only">
            {exited ? " — position closed" : " of portfolio"}
          </span>
        </div>
        <time
          dateTime={event.detectedAt}
          title={absoluteTime(event.detectedAt)}
          className="font-mono text-2xs text-muted-foreground tabular-nums"
        >
          {relativeTimeCompact(event.detectedAt, now)}
        </time>
      </div>
    </li>
  )
}
