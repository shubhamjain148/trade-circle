import * as React from "react"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

import { useStandalone } from "@/hooks/use-standalone"
import {
  ApiError,
  getJson,
  postJson,
  pushKeyPath,
  pushSubscribePath,
  sendJson,
} from "@/lib/api"
import { isIOS } from "@/lib/platform"

/**
 * "Notifications" — everyone's, like Devices above it.
 *
 * What it turns on: a buzz when a friend opens, adds to, trims or exits a
 * position, with the app closed. Not chat. The group's moves land during US
 * market hours, which is the middle of the night in IST, so this is the
 * difference between reading the feed the next evening and knowing now.
 *
 * The interesting part of this component is the states it refuses to hide. A
 * push subscription can be impossible for five different reasons — the browser
 * has no Push API, iOS has one only inside an installed app, the person said no
 * once and the browser now says no on their behalf, the service worker isn't
 * running, the deploy has no VAPID keypair — and every one of them wants a
 * different sentence. A single greyed-out button with no explanation is the
 * failure mode this section exists to avoid.
 *
 * Subscription state is read from this browser, never from the server: the row
 * is per-device, and a member signed in on a phone and a laptop must be able to
 * see that this one is off while the other is on.
 */

type State =
  /** Still asking the browser and the server what's possible. */
  | { kind: "checking" }
  /** No Push API at all, or iOS in a tab rather than the installed app. */
  | { kind: "unsupported"; reason: string }
  /** The deploy has no VAPID keypair; /api/push/key 404s. */
  | { kind: "unconfigured" }
  /** The browser is refusing on the person's behalf; only settings can undo it. */
  | { kind: "denied" }
  /** Everything is ready and this device is not subscribed. */
  | { kind: "off" }
  /** This device is subscribed. */
  | { kind: "on" }

export function NotificationsSection() {
  const standalone = useStandalone()
  const [state, setState] = React.useState<State>({ kind: "checking" })
  const [busy, setBusy] = React.useState(false)
  const [failure, setFailure] = React.useState<string | null>(null)
  // The applicationServerKey, cached from the first look so the Enable tap
  // doesn't wait on a round trip it could have made while nobody was watching.
  const keyRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    let live = true

    const look = async () => {
      const blocker = supportBlocker(standalone)
      if (blocker) {
        setState({ kind: "unsupported", reason: blocker })
        return
      }

      const registration = await activeRegistration()
      if (!live) return
      if (!registration) {
        setState({
          kind: "unsupported",
          reason:
            "The app's background worker isn't running here. It only ships in " +
            "the built app — reload, or open the installed one.",
        })
        return
      }

      try {
        keyRef.current = (await getJson<{ key: string }>(pushKeyPath)).key
      } catch (error) {
        if (!live) return
        // 404 is the deploy having no keypair, which has its own sentence.
        // Anything else — a 500, a dead proxy — is not that, and saying so
        // would send someone off to check a config that is perfectly fine.
        setState(
          error instanceof ApiError && error.status === 404
            ? { kind: "unconfigured" }
            : {
                kind: "unsupported",
                reason:
                  "Couldn't reach the watcher to check. Reload and try again.",
              }
        )
        return
      }

      const existing = await registration.pushManager.getSubscription()
      if (!live) return
      if (existing) {
        setState({ kind: "on" })
        return
      }
      setState(Notification.permission === "denied" ? { kind: "denied" } : { kind: "off" })
    }

    void look()
    return () => {
      live = false
    }
  }, [standalone])

  const enable = async () => {
    if (busy) return
    setBusy(true)
    setFailure(null)
    try {
      // Asked at the tap and never before: an unprompted permission dialog on
      // first load is how a person decides "no" without knowing what for.
      const permission = await Notification.requestPermission()
      if (permission !== "granted") {
        setState(permission === "denied" ? { kind: "denied" } : { kind: "off" })
        return
      }

      const registration = await activeRegistration()
      if (!registration || !keyRef.current) throw new Error("no registration")

      // Bounded, unlike the permission prompt above it. `subscribe` talks to the
      // browser's own push service over the network, and when that service is
      // unreachable it does not reject — it simply never settles, which leaves
      // the button reading "Turning on…" for as long as the page is open. A
      // person deciding on a permission dialog may take a minute; a push service
      // that hasn't answered in twenty seconds is not going to.
      const subscription = await withDeadline(
        registration.pushManager.subscribe({
          // Required by every browser, and honest: every push this app sends
          // shows a notification. There is no silent-wakeup path here.
          userVisibleOnly: true,
          applicationServerKey: decodeKey(keyRef.current),
        }),
        20_000
      )
      await postJson(pushSubscribePath, { subscription: subscription.toJSON() })
      setState({ kind: "on" })
    } catch {
      // Roll the browser's subscription back if the server never learned about
      // it: a device the watcher can't send to but the browser thinks is
      // subscribed is the one state nobody can diagnose from either end.
      await unsubscribeQuietly()
      setFailure(
        "Couldn't turn notifications on — this browser's push service didn't " +
          "answer. Try again in a moment."
      )
      setState(Notification.permission === "denied" ? { kind: "denied" } : { kind: "off" })
    } finally {
      setBusy(false)
    }
  }

  const disable = async () => {
    if (busy) return
    setBusy(true)
    setFailure(null)
    try {
      const registration = await activeRegistration()
      const subscription = await registration?.pushManager.getSubscription()
      if (subscription) {
        // Server first: a row that outlives the browser's subscription is a
        // notification sent into nothing, and it takes five failures to notice.
        await sendJson(pushSubscribePath, "DELETE", {
          endpoint: subscription.endpoint,
        }).catch(() => {})
        await subscription.unsubscribe()
      }
      setState({ kind: "off" })
    } catch {
      setFailure("Couldn't turn them off. Try again in a moment.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="notifications-heading">
      <h2
        id="notifications-heading"
        className="border-b border-border pb-1.5 font-mono text-2xs font-medium tracking-caps text-muted-foreground uppercase"
      >
        Notifications
      </h2>

      <div className="pt-2.5">
        <p
          className={cn(
            "text-sm leading-relaxed",
            state.kind === "on" ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {state.kind === "on"
            ? "This device buzzes when someone opens, adds to, trims or exits a position."
            : "Get a nudge on this device when someone moves — the group trades while you're asleep."}
        </p>

        {state.kind === "off" || state.kind === "on" ? (
          <div className="pt-2.5">
            <Button
              variant={state.kind === "on" ? "ghost" : "outline"}
              size="sm"
              className={cn(state.kind === "on" && "-ml-2.5 text-muted-foreground")}
              disabled={busy}
              onClick={() => void (state.kind === "on" ? disable() : enable())}
            >
              {busy
                ? state.kind === "on"
                  ? "Turning off…"
                  : "Turning on…"
                : state.kind === "on"
                  ? "Turn off on this device"
                  : "Turn on for this device"}
            </Button>
          </div>
        ) : null}

        {failure ? (
          <p role="alert" className="pt-2.5 text-sm text-destructive">
            {failure}
          </p>
        ) : (
          <Footnote state={state} />
        )}
      </div>
    </section>
  )
}

/**
 * The line under the control, and the whole point of the section: whichever
 * state you are in, it says why and what would change it. Same quiet mono
 * treatment the Devices and Visibility sections use for their footnotes.
 */
function Footnote({ state }: { state: State }) {
  const copy = (): string => {
    switch (state.kind) {
      case "checking":
        return "Checking what this device can do…"
      case "unsupported":
        return state.reason
      case "unconfigured":
        return "The watcher has no notification keys set up yet. Nothing to turn on until it does."
      case "denied":
        return (
          "This browser is blocking notifications for the watcher. Turn them back " +
          "on in site settings — the padlock in the address bar, or Settings → " +
          "Notifications on a phone — then come back here."
        )
      case "on":
        return "Position moves only. Chat stays quiet, and nothing here ever shows an amount."
      case "off":
        return "One device at a time — turn it on again on your phone if you want it there too."
    }
  }

  return (
    <p className="pt-2.5 font-mono text-2xs leading-relaxed tracking-wide text-muted-foreground">
      {copy()}
    </p>
  )
}

/**
 * Why this browser can't, in the order the reasons actually bite. iOS is first
 * because it is the one with a fix: Safari has had Web Push since 16.4, but
 * only inside an app added to the home screen, and a tab there reports no
 * PushManager at all — indistinguishable from a browser that simply has none.
 */
function supportBlocker(standalone: boolean): string | null {
  if (isIOS() && !standalone) {
    return "iPhone and iPad only allow notifications from the installed app. Add the watcher to your home screen — Share, then Add to Home Screen — and open it from there."
  }
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return "This browser has no service worker, so it can't receive notifications."
  }
  if (!("PushManager" in window) || !("Notification" in window)) {
    return "This browser doesn't support web notifications."
  }
  return null
}

/**
 * The registration, or nothing. `serviceWorker.ready` never resolves when no
 * worker was registered — which is exactly the case in `vite dev`, where
 * main.tsx registers only in production builds — so it is raced against a
 * deadline rather than awaited. A section stuck on "Checking…" forever is worse
 * than one that says the worker isn't running.
 */
async function activeRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null
  const existing = await navigator.serviceWorker.getRegistration()
  if (existing) return existing
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 4000)),
  ])
}

/** Rejects if `work` hasn't settled in time. Nothing cancels; the tab is done with it. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      window.setTimeout(() => reject(new Error("timed out")), ms)
    ),
  ])
}

/** Best-effort cleanup after a half-finished enable. Never throws. */
async function unsubscribeQuietly(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.getRegistration()
    const subscription = await registration?.pushManager.getSubscription()
    await subscription?.unsubscribe()
  } catch {
    // Nothing useful to do: the next Enable will replace it anyway.
  }
}

/**
 * `applicationServerKey` wants the raw 65 octets, not the base64url the server
 * sends. Same decode as apps/server/src/push/webpush.ts, in eleven lines,
 * because a library for this would be larger than this file.
 */
function decodeKey(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="))
  // The explicit ArrayBuffer is load-bearing: `subscribe` wants a BufferSource
  // backed by one, and a bare Uint8Array could in principle be shared memory.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
