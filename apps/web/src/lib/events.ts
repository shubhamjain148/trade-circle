import type { FeedEventType } from "@/lib/types"

/**
 * One accent pair, spent carefully: green for money going in, red for money
 * coming out. The full-strength shade marks the decisive move (open / exit),
 * the softened shade marks the adjustment (add / trim). Everything else in the
 * row stays in tinted neutrals.
 */
export interface EventStyle {
  /** Column-style verb — uppercase, scans in a glance. */
  tag: string
  direction: "up" | "down"
  /** Text color for the tag. */
  tone: string
  /** Marker dot color. */
  dot: string
}

export const EVENT_STYLES: Record<FeedEventType, EventStyle> = {
  NEW_POSITION: {
    tag: "OPENED",
    direction: "up",
    tone: "text-pos-up",
    dot: "bg-pos-up",
  },
  SIZE_UP: {
    tag: "ADDED",
    direction: "up",
    tone: "text-pos-up-dim",
    dot: "bg-pos-up-dim",
  },
  SIZE_DOWN: {
    tag: "TRIMMED",
    direction: "down",
    tone: "text-pos-down-dim",
    dot: "bg-pos-down-dim",
  },
  EXITED: {
    tag: "EXITED",
    direction: "down",
    tone: "text-pos-down",
    dot: "bg-pos-down",
  },
}

/**
 * Members get a neutral avatar by default; identity comes from the initial and
 * a small step in surface value, not from a color wheel.
 */
const AVATAR_STEPS = [
  "bg-foreground/[0.06] text-foreground/70",
  "bg-foreground/[0.14] text-foreground/85",
  "bg-foreground/[0.24] text-foreground",
]

export function avatarTone(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  }
  return AVATAR_STEPS[hash % AVATAR_STEPS.length]
}
