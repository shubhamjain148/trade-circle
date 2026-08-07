import * as React from "react"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

import { GateScreen } from "@/components/gate-screen"
import { useSession } from "@/components/session-provider"
import { FEED_HREF, navigate, SETTINGS_HREF } from "@/hooks/use-route"
import { ApiError, postJson, sessionPath } from "@/lib/api"
import type { Member, SessionResponse } from "@/lib/types"

type JoinPhase =
  | { phase: "exchanging" }
  | { phase: "welcome"; member: Member }
  /** The same handshake, spent on a device link: a member adding a screen. */
  | { phase: "linked"; member: Member }
  /** 410 — the link worked once already. */
  | { phase: "used" }
  /** 410 with link_used — a device link, not an invite: different sentence. */
  | { phase: "device-used" }
  /** 410 with link_expired — device links are worth fifteen minutes. */
  | { phase: "expired" }
  /** 400 — never a link this server issued, or mangled in transit. */
  | { phase: "invalid" }
  /** Missing token: someone typed #/join, or the link lost its query. */
  | { phase: "no-token" }
  | { phase: "failed" }

interface JoinViewProps {
  token: string | null
}

/**
 * The one screen in this app that is allowed to be a moment.
 *
 * You see it once — the first time you are let into your friends' group — and
 * it is the only place the delight budget is spent. It was already a 300ms fade
 * and rise on the block as a whole; the block is now three beats 75ms apart, so
 * the greeting lands, then the explanation, then the way out. Same curve, same
 * duration, no bounce: the stagger is the warmth, not an overshoot.
 *
 * Every failure screen below is deliberately still, because a person reading
 * "that invite has already been used" is not having a moment.
 */
const WELCOME =
  "duration-300 ease-out animate-in fade-in slide-in-from-bottom-1 fill-mode-backwards motion-reduce:animate-none motion-reduce:delay-0"

export function JoinView({ token }: JoinViewProps) {
  const { state, refresh } = useSession()
  // Snapshotted at mount: our own refresh() flips the session to signed-in
  // mid-flight, and the effect below must not read that as "you were already
  // in" and re-run. StrictMode's double-invoke is guarded the same way.
  const [entry] = React.useState(() =>
    state.status === "signed-in"
      ? ({ signedIn: true, member: state.member } as const)
      : ({ signedIn: false, member: null } as const)
  )

  const [join, setJoin] = React.useState<JoinPhase>(() =>
    entry.signedIn
      ? { phase: "welcome", member: entry.member }
      : token
        ? { phase: "exchanging" }
        : { phase: "no-token" }
  )

  // An invite is spendable once, so the request is guarded by a ref that
  // survives a remount. `alive` is a ref rather than a per-run flag for the
  // same reason: StrictMode tears the effect down and sets it back up while
  // the request is still in flight, and the answer must still land.
  const spent = React.useRef(false)
  const alive = React.useRef(true)

  React.useEffect(() => {
    alive.current = true

    if (!entry.signedIn && token && !spent.current) {
      spent.current = true

      void (async () => {
        try {
          const { member, device } = await postJson<SessionResponse>(
            sessionPath,
            { inviteToken: token }
          )
          // Seed the shell before the welcome lands, so the feed behind it is
          // already correct when they tap through.
          await refresh()
          // Which door this was is the server's answer, not the URL's: a link
          // pasted without its &device=1 must still land on the right screen.
          if (alive.current) {
            setJoin({ phase: device ? "linked" : "welcome", member })
          }
        } catch (cause) {
          if (!alive.current) return
          const status = cause instanceof ApiError ? cause.status : 0
          const code = cause instanceof ApiError ? cause.code : undefined
          setJoin({
            phase:
              code === "link_expired"
                ? "expired"
                : code === "link_used"
                  ? "device-used"
                  : status === 410
                    ? "used"
                    : status === 400
                      ? "invalid"
                      : "failed",
          })
        }
      })()
    }

    return () => {
      alive.current = false
    }
  }, [entry.signedIn, token, refresh])

  if (join.phase === "exchanging") {
    return (
      <GateScreen>
        <p
          role="status"
          aria-live="polite"
          className="font-mono text-2xs tracking-caps text-muted-foreground uppercase"
        >
          Opening your invite…
        </p>
      </GateScreen>
    )
  }

  // A device link is the same person arriving on a second screen, so this says
  // less than the invite welcome does: no connect push (they're connected on
  // the device they minted it from), no "you're in" — they were already in.
  if (join.phase === "linked") {
    return (
      <GateScreen>
        <div className="flex flex-col gap-5">
          <h1
            className={cn(
              WELCOME,
              "font-heading text-2xl leading-tight font-medium tracking-tight text-balance"
            )}
          >
            Device linked — you're in as {firstName(join.member.name)}.
          </h1>

          <p
            className={cn(
              WELCOME,
              "border-t border-border pt-4 text-sm leading-relaxed text-muted-foreground delay-75"
            )}
          >
            Your other device is still signed in. Nothing about your INDmoney
            connection changed — this screen just joins the ones you already
            read the feed on.
          </p>

          <div
            className={cn(
              WELCOME,
              "flex flex-wrap items-center gap-2 pt-1 delay-150"
            )}
          >
            <Button onClick={() => navigate(FEED_HREF)}>Go to the feed</Button>
            <Button variant="ghost" onClick={() => navigate(SETTINGS_HREF)}>
              Settings
            </Button>
          </div>
        </div>
      </GateScreen>
    )
  }

  if (join.phase === "welcome") {
    // Re-opening an invite on a second phone is a normal thing to do, and the
    // person doing it has already connected. Sending them to a connect screen
    // they've finished with reads as though the watcher forgot them.
    const connected =
      state.status === "signed-in" && state.account?.status === "active"

    return (
      <GateScreen>
        <div className="flex flex-col gap-5">
          <h1
            className={cn(
              WELCOME,
              "font-heading text-2xl leading-tight font-medium tracking-tight text-balance"
            )}
          >
            {connected ? "Welcome back" : "You're in"},{" "}
            {firstName(join.member.name)}.
          </h1>

          <p
            className={cn(
              WELCOME,
              "border-t border-border pt-4 text-sm leading-relaxed text-muted-foreground delay-75"
            )}
          >
            {connected
              ? "INDmoney is already connected on this account — the watcher is reading your holdings and posting changes to the group."
              : "One thing left: connect INDmoney so the group can see your moves. Read-only — percentages of your portfolio, never amounts."}
          </p>

          <div
            className={cn(
              WELCOME,
              "flex flex-wrap items-center gap-2 pt-1 delay-150"
            )}
          >
            {connected ? (
              <>
                <Button onClick={() => navigate(FEED_HREF)}>
                  Go to the feed
                </Button>
                <Button variant="ghost" onClick={() => navigate(SETTINGS_HREF)}>
                  Settings
                </Button>
              </>
            ) : (
              <>
                <Button onClick={() => navigate(SETTINGS_HREF)}>
                  Connect INDmoney
                </Button>
                <Button variant="ghost" onClick={() => navigate(FEED_HREF)}>
                  See the feed first
                </Button>
              </>
            )}
          </div>
        </div>
      </GateScreen>
    )
  }

  return <JoinFailure phase={join.phase} />
}

const FAILURES: Record<
  "used" | "device-used" | "expired" | "invalid" | "no-token" | "failed",
  { title: string; body: string; hint: string }
> = {
  expired: {
    title: "That link expired — mint a fresh one.",
    body: "Device links are good for fifteen minutes. On the device you're already signed in on, open Settings → Devices and tap Link another device.",
    hint: "Fifteen minutes, single use.",
  },
  "device-used": {
    title: "That device link has already been used.",
    body: "It signs in one device, once. If this isn't the device you scanned it on, mint another from Settings → Devices on a screen you're already signed in on.",
    hint: "One link, one device, once.",
  },
  used: {
    title: "That invite has already been used.",
    body: "Invite links work once. If this was you on another phone, sign in there — otherwise ask whoever runs the watcher for a fresh link.",
    hint: "One link, one member, once.",
  },
  invalid: {
    title: "That invite link isn't valid.",
    body: "It may have been cut short by a chat app, or it was never issued by this watcher. Ask for a fresh link and open it whole.",
    hint: "Copy the whole link, including everything after the #.",
  },
  "no-token": {
    title: "This link is missing its invite code.",
    body: "The part after ?token= didn't make it. Ask whoever runs the watcher to send the link again.",
    hint: "Copy the whole link, including everything after the #.",
  },
  failed: {
    title: "Couldn't check that invite.",
    body: "The watcher didn't answer, so we don't know whether the link is good. Nothing was used up — try again in a moment.",
    hint: "Your invite is untouched until the server confirms it.",
  },
}

function JoinFailure({ phase }: { phase: keyof typeof FAILURES }) {
  const copy = FAILURES[phase]

  return (
    <GateScreen>
      <div className="flex flex-col items-start gap-5" role="alert">
        <h1 className="font-heading text-xl leading-snug font-medium tracking-tight text-balance">
          {copy.title}
        </h1>

        <p className="border-t border-border pt-4 text-sm leading-relaxed text-muted-foreground">
          {copy.body}
        </p>

        <p className="font-mono text-2xs leading-relaxed tracking-wide text-muted-foreground">
          {copy.hint}
        </p>

        {phase === "failed" ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.location.reload()}
          >
            Try again
          </Button>
        ) : null}
      </div>
    </GateScreen>
  )
}

/** "You're in, Rahul" — the greeting is a greeting, not a record lookup. */
function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name
}
