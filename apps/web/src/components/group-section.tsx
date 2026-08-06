import * as React from "react"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

import { useNow } from "@/hooks/use-now"
import { useResource } from "@/hooks/use-resource"
import { CONNECTION_COPY, rosterKey } from "@/lib/account"
import {
  adminInvitePath,
  adminMembersPath,
  pollPath,
  postJson,
  send,
} from "@/lib/api"
import { absoluteTime, relativeTimeCompact } from "@/lib/format"
import type { AdminMember, PollResult } from "@/lib/types"

/**
 * The group roster — admin only, and rendered nowhere else. Until now the only
 * way to add a friend was a shell on the box the watcher runs on, which made
 * one person with a terminal the bottleneck for the whole group.
 *
 * Deliberately the same shape as the sections above it: a mono caps rule, rows
 * divided by hairlines, no cards. This is a list of five people, not a console.
 */
export function GroupSection() {
  const roster = useResource<AdminMember[]>(adminMembersPath)
  const now = useNow()

  // Minted links live here, not in the row data: the server hands the token
  // back exactly once and never again, so this is the only place it exists.
  const [links, setLinks] = React.useState<Record<string, string>>({})
  const [busy, setBusy] = React.useState<string | null>(null)
  const [failure, setFailure] = React.useState<string | null>(null)

  const members = roster.data

  const mint = async (member: AdminMember) => {
    setBusy(member.id)
    setFailure(null)
    try {
      const { url } = await postJson<{ url: string }>(
        adminInvitePath(member.id),
        {}
      )
      setLinks((current) => ({ ...current, [member.id]: url }))
      roster.reload()
    } catch {
      setFailure(`Couldn't make a link for ${member.name}.`)
    } finally {
      setBusy(null)
    }
  }

  const voidInvite = async (member: AdminMember) => {
    setBusy(member.id)
    setFailure(null)
    try {
      await send(adminInvitePath(member.id), "DELETE")
      // The link on screen is dead now; leaving it visible would invite a copy.
      setLinks((current) => {
        const next = { ...current }
        delete next[member.id]
        return next
      })
      roster.reload()
    } catch {
      setFailure(`Couldn't void ${member.name}'s link.`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-labelledby="group-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border pb-1.5">
        <h2
          id="group-heading"
          className="font-mono text-2xs font-medium tracking-caps text-muted-foreground uppercase"
        >
          Group
        </h2>
        {members ? (
          <p className="font-mono text-3xs tracking-caps text-muted-foreground uppercase tabular-nums">
            {members.length} {members.length === 1 ? "member" : "members"}
          </p>
        ) : null}
      </div>

      {roster.isLoading ? (
        <p className="py-3 font-mono text-2xs tracking-caps text-muted-foreground uppercase">
          Reading the roster…
        </p>
      ) : roster.error ? (
        <div className="flex flex-col items-start gap-2 py-3" role="alert">
          <p className="text-sm text-muted-foreground">
            Couldn't read the group — the watcher didn't answer.
          </p>
          <Button variant="outline" size="sm" onClick={roster.reload}>
            Try again
          </Button>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {members?.map((member) => (
            <MemberRow
              key={member.id}
              member={member}
              now={now}
              link={links[member.id]}
              busy={busy === member.id}
              onInvite={() => void mint(member)}
              onVoid={() => void voidInvite(member)}
            />
          ))}
        </ul>
      )}

      <AddMember onAdded={roster.reload} />

      <PollNow onPolled={roster.reload} />

      {failure ? (
        <p role="alert" className="pt-2.5 text-sm text-destructive">
          {failure}
        </p>
      ) : (
        <p className="pt-2.5 font-mono text-2xs leading-relaxed tracking-wide text-muted-foreground">
          Invite links work once, and whoever opens one is signed in as that
          member. Send each link to that person only.
        </p>
      )}
    </section>
  )
}

interface MemberRowProps {
  member: AdminMember
  now: number
  /** Present only in the moment between minting a link and leaving the page. */
  link: string | undefined
  busy: boolean
  onInvite: () => void
  onVoid: () => void
}

function MemberRow({
  member,
  now,
  link,
  busy,
  onInvite,
  onVoid,
}: MemberRowProps) {
  const status = CONNECTION_COPY[rosterKey(member.status)]
  const pending = member.invite?.status === "pending"

  return (
    <li className="py-2.5">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-2.5">
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 translate-y-[-0.15rem] rounded-full", status.dot)}
        />

        <div className="min-w-0">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="truncate text-sm font-medium">{member.name}</span>
            {member.role === "admin" ? (
              <span className="font-mono text-3xs tracking-caps text-muted-foreground uppercase">
                Admin
              </span>
            ) : null}
            {pending ? (
              /* Full strength, unlike the muted ADMIN marker beside it: an
                 unspent link is the one row state that wants doing something
                 about, and it is a fact rather than a warning. */
              <span className="font-mono text-3xs tracking-caps text-foreground uppercase">
                Invite pending
              </span>
            ) : null}
          </p>

          {/* Status and last pass on one mono line — the same two facts the
              connection card gives you about yourself, at roster density. */}
          <p className="pt-0.5 font-mono text-3xs tracking-wide text-muted-foreground tabular-nums">
            <span className={status.tone}>{status.label.toLowerCase()}</span>
            {member.lastPolledAt ? (
              <>
                {" · "}
                <time
                  dateTime={member.lastPolledAt}
                  title={absoluteTime(member.lastPolledAt)}
                >
                  synced {relativeTimeCompact(member.lastPolledAt, now)}
                </time>
              </>
            ) : (
              " · no pass yet"
            )}
            {member.invite?.status === "used" ? " · joined" : null}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={onInvite}
          >
            {busy
              ? "…"
              : pending || member.invite?.status === "used"
                ? "New link"
                : "Invite"}
          </Button>
          {pending ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              className="text-muted-foreground"
              onClick={onVoid}
            >
              Void
            </Button>
          ) : null}
        </div>
      </div>

      {link ? <InviteLink url={link} name={member.name} /> : null}
    </li>
  )
}

/**
 * The copy moment. A link that exists but isn't in your clipboard yet is the
 * only part of this flow that can silently fail, so it gets a whole band: the
 * URL selectable in full, one button, and an unambiguous answer either way.
 */
function InviteLink({ url, name }: { url: string; name: string }) {
  const field = React.useRef<HTMLInputElement>(null)
  const [copied, setCopied] = React.useState(false)
  const [manual, setManual] = React.useState(false)

  // Auto-select on arrival: even before the button is tapped, the link is
  // already grabbable with one keystroke.
  React.useEffect(() => {
    field.current?.select()
  }, [])

  React.useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 2400)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    field.current?.select()
    try {
      // Insecure origins and denied permissions both land in the catch, where
      // the text is already selected and the instruction is one line.
      await navigator.clipboard.writeText(url)
      setManual(false)
      setCopied(true)
    } catch {
      setManual(true)
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg bg-card p-2.5 ring-1 ring-foreground/10 duration-200 ease-out animate-in fade-in slide-in-from-top-1 motion-reduce:animate-none">
      <div className="flex items-center gap-2">
        <input
          ref={field}
          readOnly
          value={url}
          aria-label={`Invite link for ${name}`}
          onFocus={(event) => event.currentTarget.select()}
          onClick={(event) => event.currentTarget.select()}
          className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 py-1 font-mono text-2xs outline-none selection:bg-foreground/20 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
        />
        <Button
          size="sm"
          variant={copied ? "outline" : "default"}
          className={cn(
            "shrink-0 transition-colors",
            copied && "border-pos-up/40 text-pos-up"
          )}
          onClick={() => void copy()}
        >
          {copied ? "Copied ✓" : "Copy link"}
        </Button>
      </div>

      <p
        aria-live="polite"
        className="font-mono text-3xs leading-relaxed tracking-wide text-muted-foreground"
      >
        {copied
          ? `Copied. Send it to ${name} — it signs them in once, as them.`
          : manual
            ? "Couldn't reach the clipboard. The link is selected — copy it with ⌘C / Ctrl+C."
            : `Single-use. Whoever opens it is signed in as ${name}.`}
      </p>
    </div>
  )
}

/**
 * The manual tick. Normally nobody needs this — the watcher runs on its own
 * clock and a fresh connect fetches itself — so it reads as an admin's escape
 * hatch rather than a control panel: one button, one line of outcome.
 *
 * "Force" is the same tick without the cheap-probe gate, kept adjacent and
 * quiet because it costs a full holdings pull for every friend.
 */
function PollNow({ onPolled }: { onPolled: () => void }) {
  const [running, setRunning] = React.useState<"normal" | "force" | null>(null)
  const [outcome, setOutcome] = React.useState<string | null>(null)

  const run = async (force: boolean) => {
    if (running) return

    setRunning(force ? "force" : "normal")
    setOutcome(null)
    try {
      setOutcome(summarise(await postJson<PollResult>(pollPath(force), {})))
      onPolled()
    } catch {
      setOutcome("The watcher didn't answer.")
    } finally {
      setRunning(null)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-2.5">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2.5 text-muted-foreground"
        disabled={running !== null}
        onClick={() => void run(false)}
      >
        {running === "normal" ? "Polling…" : "Poll now"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="font-mono text-3xs tracking-caps text-muted-foreground uppercase"
        title="Skip the cheap change-probe and pull full holdings for everyone"
        disabled={running !== null}
        onClick={() => void run(true)}
      >
        {running === "force" ? "Forcing…" : "Force"}
      </Button>

      {outcome ? (
        <p
          aria-live="polite"
          className="font-mono text-3xs tracking-wide text-muted-foreground tabular-nums"
        >
          {outcome}
        </p>
      ) : null}
    </div>
  )
}

/** "polled 3 · 2 events · 1 unchanged" — counts, never holdings. */
function summarise(result: PollResult): string {
  const parts = [`polled ${result.polled.length}`]
  if (result.events) parts.push(`${result.events} events`)
  if (result.unchanged.length) parts.push(`${result.unchanged.length} unchanged`)
  if (result.skipped.length) parts.push(`${result.skipped.length} skipped`)
  if (result.errors.length) parts.push(`${result.errors.length} failed`)
  if (parts.length === 1 && !result.polled.length) return "nothing to poll"
  return parts.join(" · ")
}

/** Long enough for a full name; matches the server's cap. */
const MAX_NAME_LENGTH = 60

/**
 * Inline, not a modal. Adding a friend is one field and one decision, and a
 * dialog for it would be ceremony — the same call ConfirmDisconnect makes.
 */
function AddMember({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [failure, setFailure] = React.useState<string | null>(null)
  const field = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (open) field.current?.focus()
  }, [open])

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed || saving) return

    setSaving(true)
    setFailure(null)
    try {
      await postJson<{ member: AdminMember }>(adminMembersPath, {
        name: trimmed,
      })
      setName("")
      setOpen(false)
      onAdded()
    } catch {
      setFailure("Couldn't add them — the watcher didn't answer.")
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <div className="pt-2.5">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2.5 text-muted-foreground"
          onClick={() => setOpen(true)}
        >
          Add member
        </Button>
      </div>
    )
  }

  return (
    <div className="pt-2.5">
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <input
          ref={field}
          value={name}
          maxLength={MAX_NAME_LENGTH}
          disabled={saving}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false)
          }}
          placeholder="Their name"
          aria-label="New member's name"
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
        />
        <Button type="submit" size="sm" disabled={saving || !name.trim()}>
          {saving ? "Adding…" : "Add"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={saving}
          className="text-muted-foreground"
          onClick={() => {
            setOpen(false)
            setFailure(null)
          }}
        >
          Cancel
        </Button>
      </form>

      {failure ? (
        <p role="alert" className="pt-2 text-sm text-destructive">
          {failure}
        </p>
      ) : (
        <p className="pt-2 font-mono text-2xs leading-relaxed tracking-wide text-muted-foreground">
          Adds them to the group. They're in the feed once you send them a link
          and they connect INDmoney themselves.
        </p>
      )}
    </div>
  )
}
