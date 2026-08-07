import * as React from "react"

import { cn } from "@workspace/ui/lib/utils"

import { ARRIVING_PILL, isArriving, OPENING_PICKER } from "@/lib/motion"
import { REACTION_EMOJI } from "@/lib/types"
import type { ReactionItemKind, ReactionSummary } from "@/lib/types"

/**
 * Reactions, for either half of the timeline — a line someone typed or a trade
 * the watcher posted. Two pieces, and the split is the whole design:
 *
 *   - the **pills** are in the flow, and only exist once somebody has reacted.
 *     An unreacted row is exactly as tall as it was before this feature, so a
 *     quiet thread does not grow a stripe of empty affordances;
 *   - the **quick-react row** is absolutely positioned and therefore costs no
 *     height at all. It arrives on hover, on a long press, or on focusing the
 *     one keyboard trigger, and it is only in the DOM while it is open — eight
 *     permanently-mounted buttons per row would be eight tab stops per row.
 *
 * Quiet on purpose, per .impeccable.md: opacity and colour, no scale, no
 * bounce. Counts are mono and tabular because every other number here is.
 */

/** Long enough not to fire while scrolling, short enough to feel deliberate. */
const LONG_PRESS_MS = 400

/** A finger that has travelled this far is scrolling, not pressing. */
const LONG_PRESS_SLOP_PX = 10

/** Breathing room a floating row keeps from the thread's own clipped edges. */
const FLOAT_MARGIN_PX = 6

/**
 * Nudge a floating element back inside the thread.
 *
 * This is not polish. The thread is a clipped scroll viewport, so anything
 * placed relative to an item can land outside it — and outside the clip an
 * element is not merely half-hidden, it is unhittable. Two cases showed up
 * immediately on a 390px emulation and neither is visible at desktop width:
 * the quick-react row is wider than the gap between a right-aligned bubble and
 * the screen edge, and any row belonging to the topmost item hangs above the
 * clip entirely.
 *
 * Written as a ref callback and a direct style write rather than through
 * state, because that is exactly what this is: positioning one transient
 * popover against a box React does not model. A measure-then-setState round
 * trip would paint it in the wrong place first, which is a visible jump.
 *
 * `base` is whatever transform the class list already applies for centring; it
 * has to be re-applied before measuring, or the rect would be read from an
 * un-centred position and the correction would be wrong by half the element.
 */
function clampIntoThread(node: HTMLElement | null, base: string): void {
  if (!node) return
  node.style.transform = base

  const clip = node
    .closest('[data-slot="message-scroller-viewport"]')
    ?.getBoundingClientRect()
  if (!clip) return

  const rect = node.getBoundingClientRect()
  let dx = 0
  let dy = 0
  // Right before left, bottom before top: when the element is bigger than the
  // box the near edge wins, which is the one the reader is looking at.
  if (rect.right > clip.right - FLOAT_MARGIN_PX) {
    dx = clip.right - FLOAT_MARGIN_PX - rect.right
  }
  if (rect.left + dx < clip.left + FLOAT_MARGIN_PX) {
    dx = clip.left + FLOAT_MARGIN_PX - rect.left
  }
  if (rect.bottom > clip.bottom - FLOAT_MARGIN_PX) {
    dy = clip.bottom - FLOAT_MARGIN_PX - rect.bottom
  }
  if (rect.top + dy < clip.top + FLOAT_MARGIN_PX) {
    dy = clip.top + FLOAT_MARGIN_PX - rect.top
  }

  if (dx !== 0 || dy !== 0) {
    node.style.transform = `translate(${dx}px, ${dy}px) ${base}`
  }
}

/** The quick-react row: centred on the item, sitting in the gutter beside it. */
const anchorPicker = (node: HTMLDivElement | null) =>
  clampIntoThread(node, "translateY(-50%)")

/** The reactor-names label: centred over its pill, above it. */
const anchorNames = (node: HTMLSpanElement | null) =>
  clampIntoThread(node, "translateX(-50%)")

export interface ReactionHandlers {
  onReact: (
    kind: ReactionItemKind,
    id: string,
    emoji: string,
    on: boolean
  ) => void
}

interface ReactableProps extends ReactionHandlers {
  itemKind: ReactionItemKind
  itemId: string
  /** Undefined and empty mean the same thing here: nothing to draw. */
  reactions: ReactionSummary[] | undefined
  /**
   * Which edge things hang off. "end" for your own messages, which sit on the
   * right of the thread; "start" for everyone else's and for trade bands.
   */
  side?: "start" | "end"
  /** Named for the keyboard trigger's accessible name — "React to Rahul's move". */
  label: string
  className?: string
  /**
   * Applied to the pill row only, which is the point: anything that would add
   * height — padding under a trade band, say — has to live somewhere that does
   * not exist until there is a pill to pad.
   */
  pillsClassName?: string
  children: React.ReactNode
}

/**
 * Press and hold — the phone's own gesture for "act on this". Mouse pointers
 * are excluded: they have hover, and a mouse held on a message is usually the
 * beginning of a text selection.
 */
function useLongPress(onLongPress: () => void) {
  const timer = React.useRef(0)
  const origin = React.useRef({ x: 0, y: 0 })

  const clear = React.useCallback(() => {
    if (!timer.current) return
    window.clearTimeout(timer.current)
    timer.current = 0
  }, [])

  React.useEffect(() => clear, [clear])

  return {
    onPointerDown: (event: React.PointerEvent) => {
      if (event.pointerType === "mouse") return
      origin.current = { x: event.clientX, y: event.clientY }
      clear()
      timer.current = window.setTimeout(onLongPress, LONG_PRESS_MS)
    },
    onPointerMove: (event: React.PointerEvent) => {
      if (!timer.current) return
      const { x, y } = origin.current
      if (Math.hypot(event.clientX - x, event.clientY - y) > LONG_PRESS_SLOP_PX) {
        clear()
      }
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
  }
}

/**
 * Escape, and a press anywhere outside `inside`. Capture phase, so a tap on a
 * second item closes the first before it opens the second — but skipping
 * anything within our own subtree, or the tap that chooses an emoji would
 * unmount the button it landed on before the click could fire.
 */
function useDismiss(
  open: boolean,
  inside: React.RefObject<HTMLElement | null>,
  onDismiss: () => void
) {
  React.useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && inside.current?.contains(target)) return
      onDismiss()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss()
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("keydown", onKey)
    }
  }, [open, inside, onDismiss])
}

export function Reactable({
  itemKind,
  itemId,
  reactions,
  side = "start",
  label,
  className,
  pillsClassName,
  children,
  onReact,
}: ReactableProps) {
  const root = React.useRef<HTMLDivElement>(null)
  /** A deliberate open: long press, or the keyboard trigger. Survives the mouse. */
  const [held, setHeld] = React.useState(false)
  /**
   * Hover, in state rather than in `group-hover`, and that is not a preference.
   * The row sits outside the item's box, so a CSS hover on the item alone would
   * close it the moment the pointer travelled across to use it. React's
   * pointerleave follows the DOM tree, and the row is a child — so moving onto
   * it never counts as leaving.
   */
  const [hovered, setHovered] = React.useState(false)

  const close = React.useCallback(() => setHeld(false), [])
  useDismiss(held, root, close)

  const longPress = useLongPress(() => setHeld(true))
  const summaries = reactions ?? []
  const open = held || hovered
  const mine = new Set(summaries.filter((r) => r.mine).map((r) => r.emoji))

  /**
   * The row sits in the gutter *beside* the item, on the free side, vertically
   * centred on it — not straddling its top edge, which is where this started.
   * Above the item it covered the author's name; over the item it covered the
   * message. Beside it, at the widths this app is read at, it covers nothing at
   * all, and on a phone (where there is no gutter) the clamp above slides it
   * back over the message body rather than over the name.
   */
  const pickerEdge = side === "end" ? "right-full mr-1.5" : "left-full ml-1.5"

  const toggle = (emoji: string, on: boolean) => {
    setHeld(false)
    onReact(itemKind, itemId, emoji, on)
  }

  return (
    <div
      ref={root}
      className={cn("relative", className)}
      {...longPress}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") setHovered(true)
      }}
      onPointerLeave={(event) => {
        longPress.onPointerLeave()
        if (event.pointerType === "mouse") setHovered(false)
      }}
    >
      {children}

      {/* Absolute and conditional: a row nobody has reacted to is untouched.
          Two nested elements rather than one — the outer is position (and the
          only thing clampIntoThread is allowed to touch), the inner is the
          chrome and the entrance. See OPENING_PICKER for why they can't be the
          same node. */}
      {open ? (
        <div
          ref={anchorPicker}
          className={cn("absolute top-1/2 z-10 -translate-y-1/2", pickerEdge)}
        >
          <div
            className={cn(
              "flex items-center gap-0.5 rounded-full border border-border bg-background/95 px-1 py-0.5 backdrop-blur-sm",
              OPENING_PICKER,
              side === "end" ? "origin-right" : "origin-left"
            )}
          >
            {REACTION_EMOJI.map((emoji) => {
              const on = mine.has(emoji)
              return (
                <button
                  key={emoji}
                  type="button"
                  aria-label={on ? `Remove ${emoji}` : `React with ${emoji}`}
                  aria-pressed={on}
                  data-reaction={emoji}
                  onClick={() => toggle(emoji, !on)}
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full text-sm leading-none transition-colors",
                    on
                      ? "bg-foreground/10"
                      : "hover:bg-foreground/[0.07] active:bg-foreground/10"
                  )}
                >
                  <span aria-hidden>{emoji}</span>
                </button>
              )
            })}
          </div>
        </div>
      ) : null}

      {/*
        The keyboard's way in. Out of sight and out of the layout until it is
        focused, at which point it becomes the same chip a hover would have
        produced — one tab stop per item, which is the price of this being
        operable without a pointer at all.
      */}
      <button
        type="button"
        aria-label={label}
        aria-expanded={held}
        onClick={() => setHeld((current) => !current)}
        className={cn(
          "sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:top-1/2 focus-visible:z-10 focus-visible:flex focus-visible:size-6 focus-visible:-translate-y-1/2 focus-visible:items-center focus-visible:justify-center focus-visible:rounded-full focus-visible:border focus-visible:border-border focus-visible:bg-background focus-visible:font-mono focus-visible:text-3xs focus-visible:text-muted-foreground",
          side === "end"
            ? "focus-visible:right-full focus-visible:mr-1.5"
            : "focus-visible:left-full focus-visible:ml-1.5"
        )}
      >
        <span aria-hidden>+</span>
      </button>

      {summaries.length > 0 ? (
        <ReactionPills
          summaries={summaries}
          side={side}
          className={pillsClassName}
          arrivalKey={`${itemKind}:${itemId}`}
          onToggle={(emoji, on) => toggle(emoji, on)}
        />
      ) : null}
    </div>
  )
}

interface ReactionPillsProps {
  summaries: ReactionSummary[]
  side: "start" | "end"
  className?: string
  /** Identifies the item, so each pill's arrival can be decided once. */
  arrivalKey: string
  onToggle: (emoji: string, on: boolean) => void
}

/**
 * The standing count. One pill per emoji, filled when you are in it, and the
 * names one hover or one press-and-hold away — reactions are attributed speech
 * in this product, so who reacted is never a secret, only folded away.
 */
function ReactionPills({
  summaries,
  side,
  className,
  arrivalKey,
  onToggle,
}: ReactionPillsProps) {
  return (
    <div
      className={cn(
        "mt-1 flex flex-wrap items-center gap-1",
        side === "end" && "justify-end",
        className
      )}
    >
      {summaries.map((summary) => (
        <ReactionPill
          key={summary.emoji}
          summary={summary}
          arrivalKey={`${arrivalKey}:${summary.emoji}`}
          onToggle={() => onToggle(summary.emoji, !summary.mine)}
        />
      ))}
    </div>
  )
}

function ReactionPill({
  summary,
  arrivalKey,
  onToggle,
}: {
  summary: ReactionSummary
  arrivalKey: string
  onToggle: () => void
}) {
  const root = React.useRef<HTMLSpanElement>(null)
  // A reaction that lands while you're reading is the clearest signal in this
  // app that somebody else is here. One that was already on the row when the
  // page opened is just a number, and popping forty of them on load would say
  // the opposite of "someone is here".
  const arriving = isArriving(arrivalKey)
  const [revealed, setRevealed] = React.useState(false)
  const hide = React.useCallback(() => setRevealed(false), [])
  useDismiss(revealed, root, hide)

  const longPress = useLongPress(() => setRevealed(true))
  const names = summary.who.join(", ")

  return (
    <span ref={root} className="relative inline-flex">
      <button
        type="button"
        aria-pressed={summary.mine}
        // The names live in the accessible name too, not only in the popover: a
        // screen reader should not have to discover a long press.
        aria-label={`${summary.emoji} ${summary.count} — ${names}`}
        data-reaction-pill={summary.emoji}
        onClick={onToggle}
        {...longPress}
        onFocus={() => setRevealed(true)}
        onBlur={hide}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") setRevealed(true)
        }}
        onPointerLeave={(event) => {
          longPress.onPointerLeave()
          if (event.pointerType === "mouse") hide()
        }}
        className={cn(
          "inline-flex items-center gap-1 rounded-full border px-1.5 py-px transition-colors",
          summary.mine
            ? "border-foreground/25 bg-foreground/[0.08]"
            : "border-border hover:border-foreground/20",
          arriving && ARRIVING_PILL
        )}
      >
        <span aria-hidden className="text-[0.8125rem] leading-4">
          {summary.emoji}
        </span>
        <span
          aria-hidden
          className={cn(
            "font-mono text-3xs tabular-nums",
            summary.mine ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {summary.count}
        </span>
      </button>

      {revealed ? (
        <span
          ref={anchorNames}
          role="presentation"
          data-reaction-who={summary.emoji}
          className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 max-w-[60vw] -translate-x-1/2 truncate rounded-md border border-border bg-background px-1.5 py-0.5 font-mono text-3xs whitespace-nowrap text-muted-foreground"
        >
          {names}
        </span>
      ) : null}
    </span>
  )
}
