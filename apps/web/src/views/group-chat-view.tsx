import * as React from "react"

import { ChatComposer } from "@/components/chat-composer"
import { ChatTimeline } from "@/components/chat-timeline"
import { useSession } from "@/components/session-provider"
import { useChat } from "@/hooks/use-chat"
import { useNow } from "@/hooks/use-now"
import { ApiError } from "@/lib/api"
import { relativeTimeCompact } from "@/lib/format"
import type { Member } from "@/lib/types"

interface GroupChatViewProps {
  members: Member[] | undefined
  member: Member
}

/**
 * The group surface: the thread the friends already had, with the watcher
 * posting into it. Trades are the same rows the feed always drew — they just
 * arrive between the sentences now (docs/RESEARCH.md decisions log).
 *
 * Three bands in a viewport-tall column — heading, thread, composer. Following
 * the newest line is the MessageScroller's job inside ChatTimeline; there is no
 * window-scroll listener here any more, and deliberately only one scroller on
 * the screen at a time.
 */
export function GroupChatView({ members, member }: GroupChatViewProps) {
  const { refresh } = useSession()
  const { items, isLoading, error, updatedAt, send, retry, reload } =
    useChat(member)
  const now = useNow()

  const watched = members?.filter((m) => m.visibility !== "paused").length
  const moves = items.filter((item) => item.kind === "event").length

  // A session that expires with the tab open shows up as a 401 on the next
  // poll. Send it back through /api/me rather than calling it an outage.
  React.useEffect(() => {
    if (error instanceof ApiError && error.status === 401) void refresh()
  }, [error, refresh])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* min-h-11 matches the member header, so the first row lands in the
          same place whichever tab you're on. */}
      <header className="flex min-h-11 shrink-0 flex-col justify-center">
        <h2 className="font-heading text-base font-medium tracking-tight">
          Group chat
        </h2>
        <p className="font-mono text-2xs tracking-wide text-muted-foreground tabular-nums">
          {/* Never assert counts we don't have: a failed sync says so. */}
          {error && items.length === 0
            ? "not synced"
            : [
                watched === undefined
                  ? null
                  : `watching ${watched} friend${watched === 1 ? "" : "s"}`,
                items.length > 0 ? `${moves} moves` : null,
                error
                  ? "sync failed"
                  : updatedAt
                    ? `synced ${relativeTimeCompact(new Date(updatedAt).toISOString(), now)}`
                    : null,
              ]
                .filter(Boolean)
                .join(" · ")}
        </p>
      </header>

      <ChatTimeline
        items={items}
        memberId={member.id}
        isLoading={isLoading}
        error={error}
        onReload={reload}
        onRetryMessage={retry}
      />

      <ChatComposer onSend={send} />
    </div>
  )
}
