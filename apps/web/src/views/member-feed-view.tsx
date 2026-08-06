import { Badge } from "@workspace/ui/components/badge"
import { cn } from "@workspace/ui/lib/utils"

import { FeedList } from "@/components/feed-list"
import { HoldingsPanel } from "@/components/holdings-panel"
import { MemberAvatar } from "@/components/member-avatar"
import { useSession } from "@/components/session-provider"
import { useNow } from "@/hooks/use-now"
import { useFeed } from "@/hooks/use-watcher-data"
import { ANONYMOUS_NAME, VISIBILITY_COPY } from "@/lib/account"
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
  const { state } = useSession()
  // Your own page shows your own holdings whatever your visibility says: the
  // dial governs what the group sees, not what the app will tell you about you.
  const isSelf = state.status === "signed-in" && state.member.id === memberId

  const name =
    member?.visibility === "anonymous"
      ? ANONYMOUS_NAME
      : (member?.name ?? events?.[0]?.accountName ?? "Member")

  // A paused member's events are dropped server-side, history included, so this
  // feed is empty for a reason the roster knows and the list can't see.
  const paused = member?.visibility === "paused"

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
            ) : paused ? (
              "paused — nothing shared"
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
            {VISIBILITY_COPY[member.visibility].label}
          </Badge>
        ) : null}
      </header>

      {/* What they hold now, above what they did. Two questions, two sections:
          the panel stays compact so the first row of history is still on screen
          on a phone. */}
      <HoldingsPanel
        memberId={memberId}
        name={name}
        paused={paused}
        isSelf={isSelf}
      />

      <FeedList
        events={events}
        isLoading={isLoading}
        error={error}
        onRetry={reload}
        showAuthor={false}
        emptyTitle={paused ? `${name} is paused` : `Nothing from ${name} yet`}
        emptyDescription={
          paused
            ? "Paused members are held back from the feed entirely — past moves included. Nothing is lost; it reappears if they switch back."
            : undefined
        }
      />
    </div>
  )
}
