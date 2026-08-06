import { FeedList } from "@/components/feed-list"
import { useNow } from "@/hooks/use-now"
import { useFeed } from "@/hooks/use-watcher-data"
import { relativeTimeCompact } from "@/lib/format"
import type { Member } from "@/lib/types"

interface GroupFeedViewProps {
  members: Member[] | undefined
}

export function GroupFeedView({ members }: GroupFeedViewProps) {
  const { data: events, error, isLoading, updatedAt, reload } = useFeed()
  const now = useNow()

  const watched = members?.filter((m) => m.visibility !== "paused").length

  return (
    <div className="flex flex-col gap-5">
      {/* min-h-11 matches the member header, so the first feed row lands in the
          same place whichever tab you're on. */}
      <header className="flex min-h-11 flex-col justify-center">
        <h2 className="font-heading text-base font-medium tracking-tight">
          Group feed
        </h2>
        <p className="font-mono text-2xs tracking-wide text-muted-foreground tabular-nums">
          {/* Never assert counts we don't have: a failed fetch says so. */}
          {error
            ? "not synced"
            : [
                watched === undefined
                  ? null
                  : `watching ${watched} friend${watched === 1 ? "" : "s"}`,
                events ? `${events.length} moves` : null,
                updatedAt
                  ? `synced ${relativeTimeCompact(new Date(updatedAt).toISOString(), now)}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
        </p>
      </header>

      <FeedList
        events={events}
        isLoading={isLoading}
        error={error}
        onRetry={reload}
      />
    </div>
  )
}
