/**
 * The two platform facts this app has to ask about, in one place because two
 * screens now need them: the install hint under the feed, and the notifications
 * row in settings.
 */

/** iPadOS reports itself as a Mac; the touch count is what gives it away. */
export function isIOS(): boolean {
  if (typeof window === "undefined") return false
  const { userAgent, maxTouchPoints } = window.navigator
  if (/iphone|ipad|ipod/i.test(userAgent)) return true
  return /macintosh/i.test(userAgent) && maxTouchPoints > 1
}
