import type * as React from "react"

import { Badge } from "@workspace/ui/components/badge"
import { cn } from "@workspace/ui/lib/utils"

import { InstallHint } from "@/components/install-hint"
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

/**
 * Installed on iOS the page runs under the status bar and the home indicator
 * (viewport-fit=cover, black-translucent). The insets are paid back here — at
 * the shell's edges — so nothing inside has to know it might be a home-screen
 * app. All four are zero in a browser tab, and the sides are zero except in
 * landscape on a notched phone.
 */
const SAFE_SIDES =
  "pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
const SAFE_TOP = "pt-[env(safe-area-inset-top)]"

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
        SAFE_SIDES,
        fill ? "flex h-svh flex-col overflow-hidden" : "min-h-svh"
      )}
    >
      <header
        className={cn(
          "z-20 border-b border-border",
          SAFE_TOP,
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

      {fill ? (
        /* The chat's disclaimer already lives under the composer, so the only
           thing left for the bottom edge is the home-indicator inset — and the
           install line, which is the one place it can go in a viewport-tall
           layout without floating over the thread. */
        <div
          className={cn(
            COLUMN,
            "shrink-0 pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
          )}
        >
          <InstallHint />
        </div>
      ) : (
        <footer
          className={cn(
            COLUMN,
            "pb-[calc(2.5rem+env(safe-area-inset-bottom))]"
          )}
        >
          <p className="border-t border-border pt-4 font-mono text-3xs leading-relaxed tracking-wide text-muted-foreground">
            Sizes are portfolio weight only. Read-only feed — no advice, no
            orders, no money movement.
          </p>
          <InstallHint />
        </footer>
      )}
    </div>
  )
}
