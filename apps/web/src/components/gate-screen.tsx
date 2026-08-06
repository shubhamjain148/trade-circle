import type * as React from "react"

import { Wordmark } from "@/components/wordmark"

/**
 * The layout for every screen you can reach without a feed: boot, signed out,
 * and the invite handshake. A single narrow column, held just above centre —
 * optically centred beats mathematically centred when there's one block of
 * text on a tall phone.
 */
const COLUMN = "mx-auto w-full max-w-sm sm:max-w-md"

export function GateScreen({
  children,
  footer,
}: {
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <div className="flex min-h-svh flex-col bg-background px-6 py-10">
      {/* Wordmark, message and footnote share one column edge at every width.
          A top-left wordmark over a centred block reads as two layouts. */}
      <header className={COLUMN}>
        <Wordmark size="lg" />
      </header>

      <div className="flex flex-1 items-center py-10">
        <div className={`${COLUMN} -translate-y-4`}>{children}</div>
      </div>

      <footer className={COLUMN}>
        {footer ?? (
          <p className="font-mono text-3xs leading-relaxed tracking-wide text-muted-foreground">
            Read-only. Portfolio weight only — never amounts.
          </p>
        )}
      </footer>
    </div>
  )
}
