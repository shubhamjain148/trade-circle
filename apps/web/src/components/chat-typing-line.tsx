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
 * it reads as chrome rather than as speech.
 *
 * Two motions, and they do different jobs. The outer span *arrives* — 150ms
 * fade and a 2px rise, because someone starting to type is news and news that
 * blinks into existence reads as a rendering glitch. The inner span *breathes*
 * — the existing pulse, opacity only, saying the claim is still live. Nesting
 * them is not decoration: one element cannot run an entrance and a loop at
 * once, they'd be the same `animation` property.
 *
 * Both are off under prefers-reduced-motion.
 */
export function ChatTypingLine({ typing }: ChatTypingLineProps) {
  const label = typingLabel(typing.map((t) => t.name))

  return (
    <p
      aria-live="polite"
      className="h-4 shrink-0 truncate pb-1 font-mono text-3xs tracking-wide text-muted-foreground"
    >
      {label ? (
        <span className="inline-block animate-in duration-150 ease-out fade-in slide-in-from-bottom-1 motion-reduce:animate-none">
          <span className="animate-pulse motion-reduce:animate-none">
            {label}
          </span>
        </span>
      ) : null}
    </p>
  )
}
