import * as React from "react"

import { Button } from "@workspace/ui/components/button"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@workspace/ui/components/message-scroller"

import {
  ChatMessageGroup,
  type MessageGroupItem,
} from "@/components/chat-message-group"
import {
  Reactable,
  type ReactionHandlers,
} from "@/components/chat-reactions"
import { FeedEventRow } from "@/components/feed-event-row"
import {
  FeedNotice,
  FeedSkeleton,
  POLLING_CADENCE,
} from "@/components/feed-states"
import type { ChatItem } from "@/hooks/use-chat"
import { useNow } from "@/hooks/use-now"
import { dayKey, dayLabel } from "@/lib/format"
import { reactionKey, type FeedEvent, type ReactionMap } from "@/lib/types"

interface ChatTimelineProps extends ReactionHandlers {
  items: ChatItem[]
  /** The signed-in member — the only reason a row knows it is "yours". */
  memberId: string
  /** Keyed by reactionKey(); a missing entry is simply an unreacted row. */
  reactions: ReactionMap
  isLoading: boolean
  error?: Error
  onReload: () => void
  onRetryMessage: (id: string) => void
}

/** Lines from one person inside this window read as one breath, not three. */
const GROUP_WINDOW_MS = 5 * 60_000

/**
 * What the conversation is actually made of: a day marker, a run of speech from
 * one person, or a band of trades the watcher posted. Events are grouped too —
 * a poll that catches four moves at once is one interruption, not four.
 */
type ChatEntry =
  | { kind: "day"; key: string; label: string }
  | { kind: "events"; key: string; events: FeedEvent[] }
  | { kind: "group"; key: string; group: MessageGroupItem }

function itemTime(item: ChatItem): string {
  return item.kind === "message" ? item.createdAt : item.detectedAt
}

/**
 * The chat arrives oldest-first — the opposite of /api/feed, because the newest
 * line belongs next to the composer. One pass turns that flat list into the
 * blocks above, so nothing downstream has to look at its neighbours.
 */
function toEntries(
  items: ChatItem[],
  memberId: string,
  now: number
): ChatEntry[] {
  const entries: ChatEntry[] = []
  let day = ""

  for (const item of items) {
    const at = itemTime(item)
    const key = dayKey(at)

    if (key !== day) {
      day = key
      entries.push({ kind: "day", key: `day:${key}`, label: dayLabel(at, now) })
    }

    const last = entries.at(-1)

    if (item.kind === "event") {
      if (last?.kind === "events") last.events.push(item)
      else entries.push({ kind: "events", key: item.id, events: [item] })
      continue
    }

    const message = item
    const previous = last?.kind === "group" ? last.group : undefined
    const previousAt = previous?.messages.at(-1)?.createdAt

    if (
      previous?.memberId === message.memberId &&
      previousAt !== undefined &&
      new Date(message.createdAt).getTime() - new Date(previousAt).getTime() <=
        GROUP_WINDOW_MS
    ) {
      previous.messages.push(message)
      continue
    }

    entries.push({
      kind: "group",
      key: message.id,
      group: {
        key: message.id,
        memberId: message.memberId,
        authorName: message.authorName,
        own: message.memberId === memberId,
        messages: [message],
      },
    })
  }

  return entries
}

function DaySeparator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <span aria-hidden className="h-px flex-1 bg-border" />
      <h3 className="font-mono text-3xs font-medium tracking-caps text-muted-foreground uppercase">
        {label}
      </h3>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  )
}

/**
 * The thread itself. Scrolling is the MessageScroller's job, not ours: it
 * follows new lines only while the reader is already pinned to the bottom, so
 * scrolling up to yesterday is a deliberate opt-out that stays put. The hand-
 * rolled window-scroll listener this replaced did the same thing worse, and a
 * second scroll system on the same content would fight it.
 */
export function ChatTimeline({
  items,
  memberId,
  reactions,
  isLoading,
  error,
  onReload,
  onRetryMessage,
  onReact,
}: ChatTimelineProps) {
  const now = useNow()
  const entries = React.useMemo(
    () => toEntries(items, memberId, now),
    [items, memberId, now]
  )

  if (isLoading && items.length === 0) {
    return (
      <Frame>
        <FeedSkeleton />
      </Frame>
    )
  }

  // An error with rows already on screen is a stale banner's job, not a wipe:
  // only a cold start that never landed gets to replace the thread.
  if (error && items.length === 0) {
    return (
      <Frame>
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
      </Frame>
    )
  }

  if (entries.length === 0) {
    return (
      <Frame>
        <FeedNotice
          title="Nothing here yet"
          description="Say something, or wait for someone to make a move. Trades land in this thread on their own."
          hint={POLLING_CADENCE}
        />
      </Frame>
    )
  }

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport
          aria-label="Group chat"
          className="scroll-fade-b"
        >
          <MessageScrollerContent className="gap-4 pb-1">
            {entries.map((entry) => (
              <MessageScrollerItem
                key={entry.key}
                messageId={entry.key}
                /* The shipped 10rem guess is a chat with paragraphs in it;
                   most lines here are one sentence, and over-reserving makes
                   the scrollbar breathe on every pass. */
                className="[contain-intrinsic-size:auto_3rem]"
              >
                {entry.kind === "day" ? (
                  <DaySeparator label={entry.label} />
                ) : entry.kind === "events" ? (
                  /* Trades are not speech: a full-width band with hairlines
                     top and bottom, keeping the feed's mono tag, % and time. */
                  <div className="-mx-2 divide-y divide-border border-y border-border">
                    {entry.events.map((event) => (
                      /* The Reactable is the band's cell, so `divide-y` still
                         separates one trade from the next and the pills sit
                         inside the row they belong to. FeedEventRow itself is
                         untouched — the member feed renders the same component
                         with no wrapper and is pixel-for-pixel what it was. */
                      <Reactable
                        key={event.id}
                        itemKind="event"
                        itemId={event.id}
                        reactions={reactions[reactionKey("event", event.id)]}
                        label={`React to ${event.accountName}'s ${event.symbol} move`}
                        onReact={onReact}
                        /* The pills are indented to the row's own gutter and
                           bring their own bottom padding, so a band with no
                           reactions is the band that was already there. */
                        pillsClassName="px-2 pb-1.5"
                      >
                        <FeedEventRow as="div" event={event} now={now} />
                      </Reactable>
                    ))}
                  </div>
                ) : (
                  <ChatMessageGroup
                    group={entry.group}
                    now={now}
                    onRetry={onRetryMessage}
                    reactions={reactions}
                    onReact={onReact}
                  />
                )}
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>

        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}

/** Empty, loading and error all sit where the thread would, and scroll like it. */
function Frame({ children }: { children: React.ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
}
