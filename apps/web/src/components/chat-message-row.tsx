import { cn } from "@workspace/ui/lib/utils"

import { MemberAvatar } from "@/components/member-avatar"
import type { ChatItem } from "@/hooks/use-chat"
import { absoluteTime, relativeTimeCompact } from "@/lib/format"

type ChatMessageItem = Extract<ChatItem, { kind: "message" }>

interface ChatMessageRowProps {
  message: ChatMessageItem
  /** Sent by the signed-in member — marked, not re-styled into a bubble. */
  own: boolean
  now?: number
  onRetry: (id: string) => void
}

/**
 * A message on the same three-column grid as a feed event, so a sentence and a
 * trade sit on one rhythm. What separates them is content, not chrome: an event
 * carries a mono tag and a number in the right column, a message carries prose
 * and nothing but the time.
 *
 * Own messages get a hairline rail and a "You" label — enough to find yourself
 * scrolling back, far short of a second colour scheme for half the thread.
 */
export function ChatMessageRow({
  message,
  own,
  now,
  onRetry,
}: ChatMessageRowProps) {
  return (
    <li
      className={cn(
        "relative -mx-2 grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 rounded-md px-2 py-2 transition-colors hover:bg-foreground/[0.035]",
        own &&
          "before:absolute before:inset-y-1.5 before:left-0 before:w-px before:rounded-full before:bg-foreground/25"
      )}
    >
      <MemberAvatar
        name={message.authorName}
        seed={message.memberId}
        size="sm"
      />

      <div className="min-w-0">
        <span
          className={cn(
            "font-heading text-sm font-medium",
            own && "text-muted-foreground"
          )}
        >
          {own ? "You" : message.authorName}
        </span>
        <p
          className={cn(
            "text-sm leading-snug break-words whitespace-pre-wrap text-foreground/90",
            message.pending && "opacity-60"
          )}
        >
          {message.body}
        </p>
      </div>

      <div className="w-16 shrink-0 pt-0.5 text-right">
        {message.failed ? (
          <>
            <span className="font-mono text-2xs text-pos-down tabular-nums">
              failed
            </span>
            <button
              type="button"
              onClick={() => onRetry(message.id)}
              className="block w-full font-mono text-3xs tracking-caps text-muted-foreground uppercase hover:text-foreground"
            >
              Retry
            </button>
          </>
        ) : message.pending ? (
          <span className="font-mono text-2xs text-muted-foreground tabular-nums">
            sending
          </span>
        ) : (
          <time
            dateTime={message.createdAt}
            title={absoluteTime(message.createdAt)}
            className="font-mono text-2xs text-muted-foreground tabular-nums"
          >
            {relativeTimeCompact(message.createdAt, now)}
          </time>
        )}
      </div>
    </li>
  )
}
