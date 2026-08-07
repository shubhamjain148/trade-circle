/**
 * The platform facts this app has to ask about, in one place: the install hint
 * under the feed, the notifications row in settings, and — since the composer
 * grew a touch-aware Enter key — what kind of pointer is driving the page.
 */

/** iPadOS reports itself as a Mac; the touch count is what gives it away. */
export function isIOS(): boolean {
  if (typeof window === "undefined") return false
  const { userAgent, maxTouchPoints } = window.navigator
  if (/iphone|ipad|ipod/i.test(userAgent)) return true
  return /macintosh/i.test(userAgent) && maxTouchPoints > 1
}

/**
 * The primary pointer is a finger (or a stylus) rather than a mouse.
 *
 * The same question `globals.css` already asks to stop iOS zooming a focused
 * field, kept as the one definition of "this is a touch device" — the composer
 * needs the answer in JS, and two different tests for one fact is how the two
 * drift apart.
 *
 * Deliberately *not* a userAgent sniff: a Surface with the keyboard folded back
 * and an iPad with a Magic Keyboard both change their answer at runtime, and
 * only the media query follows them.
 */
export const COARSE_POINTER_QUERY = "(pointer: coarse)"

export function isCoarsePointer(): boolean {
  if (typeof window === "undefined") return false
  return window.matchMedia(COARSE_POINTER_QUERY).matches
}
