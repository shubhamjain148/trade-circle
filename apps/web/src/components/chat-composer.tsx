import * as React from "react"

import { Button } from "@workspace/ui/components/button"

import { MAX_MESSAGE_LENGTH } from "@/hooks/use-chat"

interface ChatComposerProps {
  onSend: (body: string) => void
}

/** Roughly five lines before the box stops growing and starts scrolling. */
const MAX_HEIGHT = 132

/** The counter is noise until it's news. */
const COUNTER_FROM = MAX_MESSAGE_LENGTH - 200

/**
 * The last band of the chat column, below the thread rather than floating over
 * it: the scroller owns its own overflow now, so the composer needs a rule and
 * nothing else — no blur, no glass, nothing scrolling underneath it. Enter
 * sends, Shift+Enter breaks the line — this is a chat, and reaching for a
 * button to say "lol" is a tax.
 */
export function ChatComposer({ onSend }: ChatComposerProps) {
  const [value, setValue] = React.useState("")
  const field = React.useRef<HTMLTextAreaElement>(null)

  // Grow to fit, measured rather than guessed: rows={n} can't see wrapping.
  React.useLayoutEffect(() => {
    const element = field.current
    if (!element) return

    element.style.height = "auto"
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`
  }, [value])

  const submit = () => {
    const body = value.trim()
    if (!body) return

    onSend(body)
    setValue("")
  }

  const remaining = MAX_MESSAGE_LENGTH - value.length

  return (
    <div className="-mx-4 shrink-0 border-t border-border bg-background px-4 pt-3 pb-2">
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <textarea
          ref={field}
          rows={1}
          value={value}
          maxLength={MAX_MESSAGE_LENGTH}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return
            // IME composition: Enter is picking a candidate, not sending.
            if (event.nativeEvent.isComposing) return

            event.preventDefault()
            submit()
          }}
          placeholder="Say something to the group"
          aria-label="Message the group"
          className="min-h-8 flex-1 resize-none rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
        />
        <Button type="submit" disabled={value.trim().length === 0}>
          Send
        </Button>
      </form>

      {/* The page footer's disclaimer has no room in a full-height chat, so the
          line that has to be somewhere lives here, under the box you type in. */}
      <div className="flex items-baseline justify-between gap-3 pt-1.5">
        <p className="font-mono text-3xs tracking-wide text-muted-foreground">
          Read-only feed — no advice, no orders, no money movement.
        </p>
        {remaining <= COUNTER_FROM ? (
          <p
            aria-live="polite"
            className="shrink-0 font-mono text-3xs text-muted-foreground tabular-nums"
          >
            {remaining} left
          </p>
        ) : null}
      </div>
    </div>
  )
}
