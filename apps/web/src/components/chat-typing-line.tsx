import type { TypingMember } from "@/hooks/use-chat"

interface ChatTypingLineProps {
  typing: TypingMember[]
}

/**
 * Names, or a count once there are too many names to read at a glance. Three
 * people typing in a five-person group is a crowd, not a list.
 */
function typingLabel(names: string[]): string {
  if (names.length === 0) return ""
  if (names.length === 1) return `${names[0]} is typing…`
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`
  return `${names.length} people are typing…`
}

/**
 * One quiet line between the thread and the composer.
 *
 * Always rendered, never conditionally: the height is reserved whether anyone
 * is typing or not, because a line that appears and disappears would shove the
 * whole conversation up and down every few seconds — which is exactly the kind
 * of motion this app doesn't do.
 *
 * Mono, muted, 3xs — the same register as the disclaimer directly below it, so
 * it reads as chrome rather than as speech. The pulse is the only movement, it
 * is opacity only, and it is off under prefers-reduced-motion.
 */
export function ChatTypingLine({ typing }: ChatTypingLineProps) {
  const label = typingLabel(typing.map((t) => t.name))

  return (
    <p
      aria-live="polite"
      className="h-4 shrink-0 truncate pb-1 font-mono text-3xs tracking-wide text-muted-foreground"
    >
      {label ? (
        <span className="animate-pulse motion-reduce:animate-none">
          {label}
        </span>
      ) : null}
    </p>
  )
}
