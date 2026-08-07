/**
 * The app's motion vocabulary, and the one piece of state it needs.
 *
 * Three durations and one curve — see the note at the top of
 * packages/ui/src/styles/globals.css for the tiers and the rules. Everything
 * here is a Tailwind class string rather than a component, because none of this
 * motion is worth a wrapper element.
 */

/* ------------------------------------------------------------------ *
 * Arrivals — who animates in, and who was simply already here.
 * ------------------------------------------------------------------ */

/**
 * This is the whole difference between a chat that feels like people are in it
 * and a page that flickers on load. A line — or a reaction — that lands while
 * you are reading should arrive; the fifty of them that render because you
 * opened the app must not, or every cold start is a slideshow.
 *
 * Module state rather than a context, because there is exactly one thread on
 * screen at a time and a provider for a single consumer tree is ceremony. Two
 * properties make it work, and both are load-bearing:
 *
 *   - **Decided once, then frozen.** The timeline re-renders on every clock
 *     tick and every poll. A flag recomputed from "is this newer than the last
 *     render" would flip back to false mid-flight, and removing an animation
 *     class part-way through snaps the element to its end state — a jolt worse
 *     than the pop it was there to prevent.
 *   - **Idempotent per key.** The answer is read during render, so StrictMode's
 *     double invoke has to agree with itself. Asking twice returns the first
 *     answer; it never re-decides.
 */
let settled = false
const decided = new Map<string, boolean>()

/**
 * True when this key first appeared after the thread had painted — i.e. it
 * arrived rather than loaded.
 */
export function isArriving(key: string): boolean {
  const seen = decided.get(key)
  if (seen !== undefined) return seen

  decided.set(key, settled)
  return settled
}

/** Called from an effect once the thread's first real paint is behind us. */
export function settleArrivals(): void {
  settled = true
}

/** Called when the thread unmounts: the next mount is a cold load again. */
export function resetArrivals(): void {
  settled = false
  decided.clear()
}

/* ------------------------------------------------------------------ *
 * The class strings.
 * ------------------------------------------------------------------ */

/**
 * A line settling into the thread: fade and a 4px rise, 200ms ease-out — the
 * beat every chat app uses, and the same curve the rest of this app enters on.
 * Upward because that is the direction the thread grows; your own message and a
 * friend's take the same path, because they land in the same place.
 *
 * Transform and opacity only, so a line arriving mid-scroll costs the
 * compositor nothing.
 */
export const ARRIVING_LINE =
  "duration-200 ease-out animate-in fade-in slide-in-from-bottom-1 motion-reduce:animate-none"

/**
 * A reaction landing on something. Same beat as a line, but it grows rather
 * than rises — a pill has no journey to make, it is somebody leaning in. 95%,
 * not 50%: a lean, not a jack-in-the-box, and there is no overshoot in it.
 */
export const ARRIVING_PILL =
  "duration-200 ease-out animate-in fade-in zoom-in-95 motion-reduce:animate-none"

/**
 * The quick-react row opening. Faster than everything else here — 150ms — for
 * the frequency: on a mouse this appears every time the pointer crosses a
 * message, and an affordance you wait for is an affordance that feels broken.
 * Scaled from the edge nearest the item it belongs to, so it reads as coming
 * *out of* that message rather than landing on top of it.
 *
 * Must be applied to a child of the positioned element, never the element
 * itself: `clampIntoThread` writes an inline transform there, and an animation
 * that also writes transform would fight it for 150ms and paint the row in the
 * wrong place — off the edge of the thread, on a phone.
 */
export const OPENING_PICKER =
  "duration-150 ease-out animate-in fade-in zoom-in-95 motion-reduce:animate-none"

/**
 * A section unfolding under the control that opened it: 200ms, fade and a 4px
 * drop, matching what the settings sections already do. One beat for the whole
 * block, never a stagger — these are tables and lists, and a table that deals
 * itself out is a table you have to wait for.
 */
export const REVEAL =
  "duration-200 ease-out animate-in fade-in slide-in-from-top-1 motion-reduce:animate-none"
