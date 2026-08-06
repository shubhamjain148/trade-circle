import * as React from "react"

import { Button, buttonVariants } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

import { ConnectionCard } from "@/components/connection-card"
import { GroupSection } from "@/components/group-section"
import { useSession } from "@/components/session-provider"
import { FEED_HREF, navigate, stripHashQuery } from "@/hooks/use-route"
import { connectErrorMessage, VISIBILITY_COPY } from "@/lib/account"
import { connectStartPath, patchJson, visibilityPath } from "@/lib/api"
import type { Account, Member, Visibility } from "@/lib/types"

interface SettingsViewProps {
  member: Member
  account: Account | null
  connected: boolean
  connectError: string | null
}

export function SettingsView({
  member,
  account,
  connected,
  connectError,
}: SettingsViewProps) {
  const { refresh, signOut } = useSession()

  // The OAuth return lands here as a query on the hash. Read once, cleared
  // once: a reload must not re-congratulate you, and Back must not either.
  const [outcome] = React.useState<"connected" | "error" | null>(
    connected ? "connected" : connectError ? "error" : null
  )

  React.useEffect(() => {
    if (!outcome) return
    stripHashQuery()
    // The card's status comes from /api/me, which is stale the moment the
    // callback ran — so the confirmation and the status arrive together.
    if (outcome === "connected") void refresh()
  }, [outcome, refresh])

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <a
          href={FEED_HREF}
          onClick={(event) => {
            event.preventDefault()
            navigate(FEED_HREF)
          }}
          className="-ml-0.5 inline-flex w-fit items-center gap-1 font-mono text-2xs tracking-caps text-muted-foreground uppercase transition-colors hover:text-foreground"
        >
          <span aria-hidden>←</span> Feed
        </a>
        <h1 className="font-heading text-base font-medium tracking-tight">
          Settings
        </h1>
        <p className="font-mono text-2xs tracking-wide text-muted-foreground">
          {member.name}
        </p>
      </header>

      <div className="flex flex-col gap-3">
        {outcome === "connected" ? <ConnectedConfirmation /> : null}
        {outcome === "error" && connectError ? (
          <ConnectFailure code={connectError} />
        ) : null}

        <ConnectionCard account={account} onChanged={() => void refresh()} />
      </div>

      <TrustSection />

      <VisibilitySection member={member} />

      {/* Admin only, and absent — not disabled — for everyone else: a control
          you can see but never use is a worse answer than no control. */}
      {member.role === "admin" ? <GroupSection /> : null}

      <section className="border-t border-border pt-5">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2.5 text-muted-foreground"
          onClick={() => void signOut()}
        >
          Log out
        </Button>
      </section>
    </div>
  )
}

/**
 * The confirmation is a state of the page, not a toast: you arrived here from
 * an external redirect, and a message that fades in three seconds is the wrong
 * shape for something you came back to read.
 */
function ConnectedConfirmation() {
  return (
    <div
      role="status"
      className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 duration-300 ease-out animate-in fade-in slide-in-from-bottom-1 motion-reduce:animate-none"
    >
      <span
        aria-hidden
        className="mt-[0.5rem] size-1.5 shrink-0 rounded-full bg-pos-up"
      />
      <p className="text-sm leading-relaxed">
        <span className="font-medium text-pos-up">Connected.</span>{" "}
        <span className="text-muted-foreground">
          You're in the feed from the watcher's next pass.
        </span>
      </p>
    </div>
  )
}

function ConnectFailure({ code }: { code: string }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-2 rounded-lg bg-card p-3 ring-1 ring-destructive/25"
    >
      <p className="text-sm">
        <span className="font-medium text-destructive">
          Connection didn't go through.
        </span>{" "}
        <span className="text-muted-foreground">
          {connectErrorMessage(code)}
        </span>
      </p>
      <p className="font-mono text-3xs tracking-caps text-muted-foreground uppercase">
        {code}
      </p>
      <a
        href={connectStartPath}
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        Try connecting again
      </a>
    </div>
  )
}

const TRUST_ROWS = [
  {
    label: "Access",
    body: "Read-only holdings. The watcher cannot place orders, move money, or see your bank.",
  },
  {
    label: "Shared",
    body: "Symbol, direction — opened, added, trimmed, exited — and size as a percentage of your portfolio.",
  },
  {
    label: "Never",
    body: "Amounts, portfolio value, order history, or anything outside this group.",
  },
  {
    label: "Revoke",
    body: "Disconnect above, or cut it from INDmoney's side: Profile → Connected apps → remove indmoney·watcher. Either one stops the polling.",
  },
]

function TrustSection() {
  return (
    <section aria-labelledby="trust-heading">
      <h2
        id="trust-heading"
        className="border-b border-border pb-1.5 font-mono text-2xs font-medium tracking-caps text-muted-foreground uppercase"
      >
        What this connection does
      </h2>

      <dl className="divide-y divide-border">
        {TRUST_ROWS.map((row) => (
          <div
            key={row.label}
            className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 py-2.5"
          >
            <dt className="font-mono text-2xs tracking-caps text-muted-foreground uppercase">
              {row.label}
            </dt>
            <dd className="text-sm leading-relaxed text-muted-foreground">
              {row.body}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

const MODES: Visibility[] = ["named", "anonymous", "paused"]

/**
 * Three modes, one of them on. Real radios behind the rows rather than buttons
 * with aria-checked: arrow keys, the group's roving tab stop and the label/hit
 * area all come free, and the whole row is the target — this gets tapped with a
 * thumb.
 *
 * The write is optimistic and reverts on failure. Visibility governs what the
 * group can see about you; a control that lags a round trip behind your tap
 * invites a second tap, and a second tap here is a state you didn't choose.
 */
function VisibilitySection({ member }: { member: Member }) {
  const { setMember } = useSession()
  const [pending, setPending] = React.useState<Visibility | null>(null)
  const [failure, setFailure] = React.useState<string | null>(null)

  const select = async (mode: Visibility) => {
    if (mode === member.visibility || pending) return

    const previous = member
    setPending(mode)
    setFailure(null)
    setMember({ ...member, visibility: mode })

    try {
      const saved = await patchJson<{ member: Member }>(visibilityPath, {
        visibility: mode,
      })
      setMember(saved.member)
    } catch {
      // Put it back exactly as it was: a half-applied privacy setting is the
      // one outcome worse than the change not happening.
      setMember(previous)
      setFailure(
        "Couldn't change that — the watcher didn't answer. You're still " +
          `${VISIBILITY_COPY[previous.visibility].label.toLowerCase()}.`
      )
    } finally {
      setPending(null)
    }
  }

  return (
    <section aria-labelledby="visibility-heading">
      <h2
        id="visibility-heading"
        className="border-b border-border pb-1.5 font-mono text-2xs font-medium tracking-caps text-muted-foreground uppercase"
      >
        How you appear
      </h2>

      <div role="radiogroup" aria-labelledby="visibility-heading">
        <div className="divide-y divide-border">
          {MODES.map((mode) => {
            const isCurrent = mode === member.visibility
            const copy = VISIBILITY_COPY[mode]

            return (
              <label
                key={mode}
                className={cn(
                  "-mx-2 grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 rounded-md px-2 py-2.5 transition-colors",
                  "hover:bg-foreground/[0.035] has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50",
                  pending && "cursor-progress"
                )}
              >
                <input
                  type="radio"
                  name="visibility"
                  value={mode}
                  checked={isCurrent}
                  disabled={pending !== null}
                  onChange={() => void select(mode)}
                  className="sr-only"
                />

                <p
                  className={cn(
                    "text-sm font-medium",
                    !isCurrent && "text-muted-foreground"
                  )}
                >
                  {copy.label}
                </p>

                {pending === mode ? (
                  <span className="font-mono text-3xs tracking-caps text-muted-foreground uppercase">
                    Saving…
                  </span>
                ) : isCurrent ? (
                  <span className="font-mono text-3xs tracking-caps text-pos-up uppercase">
                    Current
                  </span>
                ) : null}

                <p className="col-span-2 pt-0.5 text-sm leading-relaxed text-muted-foreground">
                  {copy.summary}
                </p>
              </label>
            )
          })}
        </div>
      </div>

      {failure ? (
        <p role="alert" className="pt-2.5 text-sm text-destructive">
          {failure}
        </p>
      ) : (
        /* When it applies matters as much as what it does: this is read-time,
           not a flag on new events, so the feed's past changes with it. */
        <p className="pt-2.5 font-mono text-2xs leading-relaxed tracking-wide text-muted-foreground">
          Applies straight away, to what's already in the feed as well as
          what's next.
        </p>
      )}
    </section>
  )
}
