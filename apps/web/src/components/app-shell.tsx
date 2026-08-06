import type * as React from "react"

import { Badge } from "@workspace/ui/components/badge"
import { cn } from "@workspace/ui/lib/utils"

import { ThemeToggle } from "@/components/theme-toggle"
import { Wordmark } from "@/components/wordmark"

interface AppShellProps {
  /** Member switcher lives in the top bar, under the app name. */
  switcher?: React.ReactNode
  /** Signed-in member — avatar and menu, top right. */
  account?: React.ReactNode
  /**
   * Chat mode: the shell is exactly one viewport tall and the content owns its
   * own scrolling, so the composer sits on the bottom edge instead of chasing
   * the page down. Feeds keep the ordinary document scroll and the footer.
   */
  fill?: boolean
  children: React.ReactNode
}

/**
 * One column, widened a step on laptops. The header rule and the content share
 * an edge at every breakpoint — a full-bleed border over a narrow column reads
 * as a line drawn to nowhere.
 */
const COLUMN = "mx-auto w-full max-w-2xl px-4 lg:max-w-3xl"

export function AppShell({
  switcher,
  account,
  fill = false,
  children,
}: AppShellProps) {
  return (
    <div
      className={cn(
        "bg-background",
        fill ? "flex h-svh flex-col overflow-hidden" : "min-h-svh"
      )}
    >
      <header
        className={cn(
          "z-20 border-b border-border",
          fill
            ? "shrink-0 bg-background"
            : "sticky top-0 bg-background/85 backdrop-blur-md"
        )}
      >
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

      <main
        className={cn(
          COLUMN,
          fill ? "flex min-h-0 flex-1 flex-col pt-4" : "py-6"
        )}
      >
        {children}
      </main>

      {fill ? null : (
        <footer className={`${COLUMN} pb-10`}>
          <p className="border-t border-border pt-4 font-mono text-3xs leading-relaxed tracking-wide text-muted-foreground">
            Sizes are portfolio weight only. Read-only feed — no advice, no
            orders, no money movement.
          </p>
        </footer>
      )}
    </div>
  )
}
