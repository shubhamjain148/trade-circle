import { Bubble, BubbleContent } from "@workspace/ui/components/bubble"
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "@workspace/ui/components/message"
import { cn } from "@workspace/ui/lib/utils"

import { MemberAvatar } from "@/components/member-avatar"
import type { ChatItem } from "@/hooks/use-chat"
import { absoluteTime, relativeTimeCompact } from "@/lib/format"

export type ChatMessageItem = Extract<ChatItem, { kind: "message" }>

/** A run of consecutive lines from one person — one avatar, one name, one time. */
export interface MessageGroupItem {
  key: string
  memberId: string
  authorName: string
  /** Sent by the signed-in member. */
  own: boolean
  messages: ChatMessageItem[]
}

interface ChatMessageGroupProps {
  group: MessageGroupItem
  now?: number
  onRetry: (id: string) => void
}

/**
 * Speech, built on shadcn's Message: avatar and name once per run, a bubble per
 * line, one timestamp under the group. Own lines swap sides and swap fill for
 * outline — side plus surface is enough to tell yourself apart, so the accent
 * pair stays reserved for which way a trade went.
 */
export function ChatMessageGroup({
  group,
  now,
  onRetry,
}: ChatMessageGroupProps) {
  const { own, messages } = group
  const last = messages[messages.length - 1]

  return (
    <Message align={own ? "end" : "start"}>
      {/* Your own avatar is the one face you never need pointed out. */}
      {own ? null : (
        <MessageAvatar className="pt-5">
          <MemberAvatar
            name={group.authorName}
            seed={group.memberId}
            size="sm"
          />
        </MessageAvatar>
      )}

      <MessageContent className="gap-1">
        {own ? null : (
          <MessageHeader className="font-heading text-xs font-medium text-foreground/75">
            {group.authorName}
          </MessageHeader>
        )}

        {messages.map((message) => (
          <Bubble
            key={message.id}
            variant={
              message.failed ? "destructive" : own ? "outline" : "secondary"
            }
            className="max-w-[85%] sm:max-w-[75%]"
          >
            <BubbleContent
              className={cn(
                "whitespace-pre-wrap",
                message.pending && "opacity-60"
              )}
            >
              {message.body}
            </BubbleContent>

            {message.failed ? (
              <p className="flex items-center gap-2 px-1 font-mono text-3xs tracking-caps uppercase">
                <span className="text-destructive">Not sent</span>
                <button
                  type="button"
                  onClick={() => onRetry(message.id)}
                  className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  Retry
                </button>
              </p>
            ) : null}
          </Bubble>
        ))}

        {/* Not uppercased, unlike the day and event labels: "45M" reads as a
            unit, "45m" reads as a time, and this column is full of them. */}
        <MessageFooter className="px-1 font-mono text-3xs tracking-wide text-muted-foreground tabular-nums">
          {last.failed ? null : last.pending ? (
            <span>Sending…</span>
          ) : (
            <time
              dateTime={last.createdAt}
              title={absoluteTime(last.createdAt)}
            >
              {relativeTimeCompact(last.createdAt, now)}
            </time>
          )}
        </MessageFooter>
      </MessageContent>
    </Message>
  )
}
