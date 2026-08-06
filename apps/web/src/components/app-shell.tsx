import type * as React from "react"

import { Badge } from "@workspace/ui/components/badge"

import { ThemeToggle } from "@/components/theme-toggle"
import { Wordmark } from "@/components/wordmark"

interface AppShellProps {
  /** Member switcher lives in the top bar, under the app name. */
  switcher?: React.ReactNode
  /** Signed-in member — avatar and menu, top right. */
  account?: React.ReactNode
  children: React.ReactNode
}

/**
 * One column, widened a step on laptops. The header rule and the content share
 * an edge at every breakpoint — a full-bleed border over a narrow column reads
 * as a line drawn to nowhere.
 */
const COLUMN = "mx-auto w-full max-w-2xl px-4 lg:max-w-3xl"

export function AppShell({ switcher, account, children }: AppShellProps) {
  return (
    <div className="min-h-svh bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur-md">
        <div className={COLUMN}>
          <div className="flex h-12 items-center gap-2">
            <Wordmark />
            <Badge
              variant="outline"
              /* Dropped on phones: the account control earns that space more. */
              className="ml-2 hidden font-mono text-3xs tracking-caps text-muted-foreground uppercase sm:inline-flex"
            >
              Read-only
            </Badge>
            <div className="ml-auto flex items-center gap-0.5">
              <ThemeToggle />
              {account}
            </div>
          </div>
          {/* Settings has no switcher; the header keeps its single-row height
              rather than reserving space for a control that isn't there. */}
          {switcher ? <div className="pb-1.5">{switcher}</div> : null}
        </div>
      </header>

      <main className={`${COLUMN} py-6`}>{children}</main>

      <footer className={`${COLUMN} pb-10`}>
        <p className="border-t border-border pt-4 font-mono text-3xs leading-relaxed tracking-wide text-muted-foreground">
          Sizes are portfolio weight only. Read-only feed — no advice, no
          orders, no money movement.
        </p>
      </footer>
    </div>
  )
}
