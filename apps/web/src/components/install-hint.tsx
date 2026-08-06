import * as React from "react"

import { useStandalone } from "@/hooks/use-standalone"

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

const DISMISSED_KEY = "watcher:install-hint-dismissed"

/* Chrome fires beforeinstallprompt once, shortly after load, and the event is
   the only way back to the install dialog — so it is caught at module scope,
   before React has mounted anything, rather than in an effect that might be
   late. */
let deferred: BeforeInstallPromptEvent | null = null
const listeners = new Set<() => void>()

function announce() {
  for (const listener of listeners) listener()
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault()
    deferred = event as BeforeInstallPromptEvent
    announce()
  })
  window.addEventListener("appinstalled", () => {
    deferred = null
    announce()
  })
}

function useInstallPrompt() {
  return React.useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    () => deferred,
    () => null
  )
}

/** iPadOS reports itself as a Mac; the touch count is what gives it away. */
function isIOS(): boolean {
  const { userAgent, maxTouchPoints } = window.navigator
  if (/iphone|ipad|ipod/i.test(userAgent)) return true
  return /macintosh/i.test(userAgent) && maxTouchPoints > 1
}

/**
 * One quiet line under the disclaimer, never a banner over the feed: this is a
 * tool the group already has open, and "install me" is at most a footnote.
 * Shown only outside standalone, and only once — the dismissal sticks.
 */
export function InstallHint() {
  const standalone = useStandalone()
  const prompt = useInstallPrompt()
  const [dismissed, setDismissed] = React.useState(
    () => localStorage.getItem(DISMISSED_KEY) === "1"
  )

  const dismiss = () => {
    localStorage.setItem(DISMISSED_KEY, "1")
    setDismissed(true)
  }

  if (standalone || dismissed) return null

  // Desktop browsers with no install path get nothing rather than advice they
  // can't act on.
  const ios = isIOS()
  if (!prompt && !ios) return null

  return (
    <p className="flex items-baseline gap-2 pt-2 font-mono text-3xs tracking-wide text-muted-foreground">
      {prompt ? (
        <>
          <span>Keep it a tap away —</span>
          <button
            type="button"
            onClick={() => {
              void prompt.prompt()
            }}
            className="underline decoration-dotted underline-offset-2 hover:text-foreground"
          >
            install the app
          </button>
        </>
      ) : (
        <span>
          Keep it a tap away — Share, then <em>Add to Home Screen</em>.
        </span>
      )}
      <button
        type="button"
        onClick={dismiss}
        className="ml-auto shrink-0 underline decoration-dotted underline-offset-2 hover:text-foreground"
      >
        Dismiss
      </button>
    </p>
  )
}
