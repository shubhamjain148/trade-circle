import * as React from "react"

import { Button } from "@workspace/ui/components/button"

import { MAX_MESSAGE_LENGTH } from "@/hooks/use-chat"
import { useCoarsePointer } from "@/hooks/use-coarse-pointer"

interface ChatComposerProps {
  onSend: (body: string) => void
  /**
   * Fired on input. Throttling lives in useChat, not here — the composer's job
   * is to say that a key was pressed, not to have an opinion about how often.
   */
  onTyping?: () => void
}

/** Roughly five lines before the box stops growing and starts scrolling. */
const MAX_HEIGHT = 132

/** The counter is noise until it's news. */
const COUNTER_FROM = MAX_MESSAGE_LENGTH - 200

/**
 * Whether the browser can size the box off its own content.
 *
 * `field-sizing: content` became Baseline in June 2026 (Chrome 123, Safari
 * 26.2, Firefox 152) — which is recent enough that a phone one OS release
 * behind still can't do it, and this is a product read on phones. So the CSS is
 * the path and the measure-and-set effect below is the fallback, kept alive
 * only for the browsers that need it. Read once at module scope: no browser
 * grows the property mid-session.
 */
const SUPPORTS_FIELD_SIZING =
  typeof CSS !== "undefined" &&
  typeof CSS.supports === "function" &&
  CSS.supports("field-sizing", "content")

/**
 * The last band of the chat column, below the thread rather than floating over
 * it: the scroller owns its own overflow now, so the composer needs a rule and
 * nothing else — no blur, no glass, nothing scrolling underneath it.
 *
 * Enter sends and Shift+Enter breaks the line — on a keyboard. On a phone that
 * rule is exactly backwards: the on-screen return key is the only way to write
 * a second line, and a keyboard that sends on every press turns one thought
 * into four messages. So the pointer decides. Sending from a touch device is
 * the Send button, which is what a thumb was already reaching for.
 */
export function ChatComposer({ onSend, onTyping }: ChatComposerProps) {
  const [value, setValue] = React.useState("")
  const field = React.useRef<HTMLTextAreaElement>(null)
  const touch = useCoarsePointer()

  // Grow to fit, measured rather than guessed: rows={n} can't see wrapping.
  // Dead code wherever `field-sizing` works, which is the point of the guard —
  // writing an inline height would fight the CSS for the same pixels.
  React.useLayoutEffect(() => {
    if (SUPPORTS_FIELD_SIZING) return
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
          onChange={(event) => {
            setValue(event.target.value)
            // Clearing the box is not typing; neither is deleting the last char.
            if (event.target.value.trim()) onTyping?.()
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return
            // IME composition: Enter is picking a candidate, not sending.
            if (event.nativeEvent.isComposing) return
            // A thumb on a return key means "new line". Let it through
            // untouched — the textarea inserts the break itself.
            if (touch) return

            event.preventDefault()
            submit()
          }}
          placeholder="Say something to the group"
          aria-label="Message the group"
          /* min-h-8 and max-h-[132px] are the same two numbers the measuring
             effect used, so the box grows and stops exactly where it did. */
          className="field-sizing-content max-h-[132px] min-h-8 flex-1 resize-none rounded-md border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
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
