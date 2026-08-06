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
 * Pinned to the bottom of the column, not floating over it: a rule and the same
 * blur as the header, so the thread scrolls under a surface that's clearly part
 * of the page. Enter sends, Shift+Enter breaks the line — this is a chat, and
 * reaching for a button to say "lol" is a tax.
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
    <div className="sticky bottom-0 z-10 -mx-4 mt-2 border-t border-border bg-background/85 px-4 py-3 backdrop-blur-md">
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

      {remaining <= COUNTER_FROM ? (
        <p
          aria-live="polite"
          className="pt-1 text-right font-mono text-3xs text-muted-foreground tabular-nums"
        >
          {remaining} left
        </p>
      ) : null}
    </div>
  )
}
