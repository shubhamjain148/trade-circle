import * as React from "react"

import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

import { QrCode } from "@/components/qr-code"
import { useNow } from "@/hooks/use-now"
import { deviceLinkPath, postJson } from "@/lib/api"
import type { DeviceLink, Member } from "@/lib/types"

/**
 * "Link another device" — everyone's, not the admin's.
 *
 * The gap this closes: the only way onto a second screen was the invite an
 * admin minted once, months ago, and spent. Someone signed in on their laptop
 * and wanting the same feed on their phone had to ask another person for it,
 * which is a strange thing to have to ask for your own account.
 *
 * It is a pairing, not an invitation, and the section says so twice: nothing
 * here names anyone else, and the session that minted the link keeps working.
 */
export function DevicesSection({ member }: { member: Member }) {
  const [link, setLink] = React.useState<DeviceLink | null>(null)
  const [minting, setMinting] = React.useState(false)
  const [failure, setFailure] = React.useState<string | null>(null)

  const mint = async () => {
    if (minting) return
    setMinting(true)
    setFailure(null)
    try {
      setLink(await postJson<DeviceLink>(deviceLinkPath, {}))
    } catch {
      setFailure("Couldn't make a link — the watcher didn't answer.")
    } finally {
      setMinting(false)
    }
  }

  return (
    <section aria-labelledby="devices-heading">
      <h2
        id="devices-heading"
        className="border-b border-border pb-1.5 font-mono text-2xs font-medium tracking-caps text-muted-foreground uppercase"
      >
        Devices
      </h2>

      <div className="pt-2.5">
        <p className="text-sm leading-relaxed text-muted-foreground">
          Open the watcher on your phone as well as here. The link below signs
          in as you — it adds a device, it never signs this one out.
        </p>

        <div className="pt-2.5">
          <Button
            variant={link ? "ghost" : "outline"}
            size="sm"
            className={cn(link && "-ml-2.5 text-muted-foreground")}
            disabled={minting}
            onClick={() => void mint()}
          >
            {minting
              ? "Making a link…"
              : link
                ? "New link"
                : "Link another device"}
          </Button>
        </div>

        {link ? (
          <DeviceLinkBand key={link.expiresAt} link={link} name={member.name} />
        ) : null}

        {failure ? (
          <p role="alert" className="pt-2.5 text-sm text-destructive">
            {failure}
          </p>
        ) : (
          <p className="pt-2.5 font-mono text-2xs leading-relaxed tracking-wide text-muted-foreground">
            Valid 15 minutes, single use. Whoever opens it is signed in as you —
            scan it with your own phone, and send it to nobody.
          </p>
        )}
      </div>
    </section>
  )
}

/**
 * The band the admin invite uses, with the square added: on a phone you scan,
 * on a laptop you copy, and the countdown says how long either is worth doing.
 */
function DeviceLinkBand({ link, name }: { link: DeviceLink; name: string }) {
  const field = React.useRef<HTMLInputElement>(null)
  const [copied, setCopied] = React.useState(false)
  const [manual, setManual] = React.useState(false)
  // A second-resolution clock, alive only while a link is on screen — this is
  // the one place in the app where the minute hand is too coarse to be honest.
  const now = useNow(1_000)

  const remaining = Date.parse(link.expiresAt) - now
  const expired = remaining <= 0

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
      await navigator.clipboard.writeText(link.url)
      setManual(false)
      setCopied(true)
    } catch {
      setManual(true)
    }
  }

  return (
    <div className="mt-2.5 flex flex-col gap-2.5 rounded-lg bg-card p-2.5 ring-1 ring-foreground/10 duration-200 ease-out animate-in fade-in slide-in-from-top-1 motion-reduce:animate-none">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-start">
        {/* The square goes dim rather than away when the clock runs out: it is
            the thing the eye is on, and having it vanish mid-scan reads as a
            bug rather than as an expiry. */}
        <QrCode
          value={link.url}
          label={`QR code linking another device to ${name}'s account`}
          className={cn(
            "shrink-0 self-center transition-opacity sm:self-start",
            expired && "opacity-25"
          )}
        />

        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center gap-2">
            <input
              ref={field}
              readOnly
              value={link.url}
              aria-label="Link for another device"
              onFocus={(event) => event.currentTarget.select()}
              onClick={(event) => event.currentTarget.select()}
              className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 py-1 font-mono text-2xs outline-none selection:bg-foreground/20 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
            />
            <Button
              size="sm"
              variant={copied ? "outline" : "default"}
              disabled={expired}
              className={cn(
                "shrink-0 transition-colors",
                copied && "border-pos-up/40 text-pos-up"
              )}
              onClick={() => void copy()}
            >
              {copied ? "Copied ✓" : "Copy"}
            </Button>
          </div>

          <p
            aria-live="polite"
            className="font-mono text-3xs leading-relaxed tracking-wide text-muted-foreground tabular-nums"
          >
            {expired ? (
              <span className="text-destructive">
                This link expired. Make a new one.
              </span>
            ) : copied ? (
              `Copied. Open it on the other device — expires in ${countdown(remaining)}.`
            ) : manual ? (
              "Couldn't reach the clipboard. The link is selected — copy it with ⌘C / Ctrl+C."
            ) : (
              `Scan it, or open the link on the other device. Expires in ${countdown(remaining)} · single use.`
            )}
          </p>
        </div>
      </div>
    </div>
  )
}

/** "14:02" — mm:ss, because at this scale minutes alone stop meaning anything. */
function countdown(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}
