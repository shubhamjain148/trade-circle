import { Badge } from "@workspace/ui/components/badge"
import { cn } from "@workspace/ui/lib/utils"

import { FeedList } from "@/components/feed-list"
import { MemberAvatar } from "@/components/member-avatar"
import { useNow } from "@/hooks/use-now"
import { useFeed } from "@/hooks/use-watcher-data"
import { EVENT_STYLES } from "@/lib/events"
import { relativeTimeCompact } from "@/lib/format"
import type { Member } from "@/lib/types"

interface MemberFeedViewProps {
  memberId: string
  member: Member | undefined
}

export function MemberFeedView({ memberId, member }: MemberFeedViewProps) {
  const { data: events, error, isLoading, reload } = useFeed(memberId)
  const now = useNow()

  const name =
    member?.visibility === "anonymous"
      ? "Anonymous"
      : (member?.name ?? events?.[0]?.accountName ?? "Member")

  const entries =
    events?.filter((e) => EVENT_STYLES[e.type].direction === "up").length ?? 0
  const exits = (events?.length ?? 0) - entries
  const latest = events?.[0]

  return (
    <div className="flex flex-col gap-5">
      <header className="flex min-h-11 items-center gap-3">
        <MemberAvatar name={name} seed={memberId} size="lg" />

        <div className="min-w-0">
          <h2 className="truncate font-heading text-base font-medium tracking-tight">
            {name}
          </h2>
          <p className="font-mono text-2xs tracking-wide text-muted-foreground tabular-nums">
            {/* A failed fetch must not render a confident "0 in · 0 out" — that
                reads as a fact about someone's portfolio that we don't have. */}
            {error ? (
              "not synced"
            ) : isLoading && !events ? (
              "reading…"
            ) : (
              <>
                {/* Semantic colour is for direction, not for zero. */}
                <span className={cn(entries > 0 && "text-pos-up")}>
                  {entries} in
                </span>
                <span className="px-1 opacity-50">·</span>
                <span className={cn(exits > 0 && "text-pos-down")}>
                  {exits} out
                </span>
                {latest ? (
                  <>
                    <span className="px-1 opacity-50">·</span>
                    <span>
                      last {relativeTimeCompact(latest.detectedAt, now)}
                    </span>
                  </>
                ) : null}
              </>
            )}
          </p>
        </div>

        {member && member.visibility !== "named" ? (
          <Badge
            variant="outline"
            className="ml-auto font-mono text-3xs tracking-caps text-muted-foreground uppercase"
          >
            {member.visibility}
          </Badge>
        ) : null}
      </header>

      <FeedList
        events={events}
        isLoading={isLoading}
        error={error}
        onRetry={reload}
        showAuthor={false}
        emptyTitle={`Nothing from ${name} yet`}
      />
    </div>
  )
}
