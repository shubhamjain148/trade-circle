import type * as React from "react"

import { Skeleton } from "@workspace/ui/components/skeleton"

/** How the watcher actually works — worth repeating wherever the feed is bare. */
export const POLLING_CADENCE =
  "The watcher polls hourly during US market hours, plus one pass before the open and one after the close."

export function FeedSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    // Announced, not silent: the skeleton is decorative but the fact that we're
    // loading is not.
    <div role="status" aria-busy="true" aria-live="polite">
      <ul aria-hidden className="divide-y divide-border">
        {Array.from({ length: rows }).map((_, index) => (
          <li
            key={index}
            /* py-2 matches the real row, so the feed doesn't jolt on arrival. */
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 py-2"
          >
            <Skeleton className="size-6 rounded-full" />
            <div className="space-y-1.5">
              <Skeleton
                className="h-3.5 rounded-sm"
                style={{ width: `${52 - (index % 3) * 8}%` }}
              />
              <Skeleton
                className="h-2.5 rounded-sm"
                style={{ width: `${34 - (index % 2) * 6}%` }}
              />
            </div>
            <div className="w-16 space-y-1.5">
              <Skeleton className="ml-auto h-3.5 w-10 rounded-sm" />
              <Skeleton className="ml-auto h-2.5 w-6 rounded-sm" />
            </div>
          </li>
        ))}
      </ul>
      <p className="pt-4 font-mono text-2xs tracking-caps text-muted-foreground uppercase">
        Reading the latest pass…
      </p>
    </div>
  )
}

interface FeedNoticeProps {
  title: string
  description: string
  hint?: string
  action?: React.ReactNode
  /** Errors need announcing; an empty feed is just the page. */
  tone?: "quiet" | "alert"
}

export function FeedNotice({
  title,
  description,
  hint,
  action,
  tone = "quiet",
}: FeedNoticeProps) {
  return (
    <div
      role={tone === "alert" ? "alert" : undefined}
      className="flex flex-col gap-2 border-t border-border py-8"
    >
      <p className="font-heading text-sm font-medium">{title}</p>
      <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      {hint ? (
        <p className="max-w-md font-mono text-2xs leading-relaxed tracking-wide text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  )
}
