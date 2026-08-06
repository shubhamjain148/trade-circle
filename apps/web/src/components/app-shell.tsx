import type * as React from "react"

import { Badge } from "@workspace/ui/components/badge"

import { ThemeToggle } from "@/components/theme-toggle"

interface AppShellProps {
  /** Member switcher lives in the top bar, under the app name. */
  switcher: React.ReactNode
  children: React.ReactNode
}

/**
 * One column, widened a step on laptops. The header rule and the content share
 * an edge at every breakpoint — a full-bleed border over a narrow column reads
 * as a line drawn to nowhere.
 */
const COLUMN = "mx-auto w-full max-w-2xl px-4 lg:max-w-3xl"

export function AppShell({ switcher, children }: AppShellProps) {
  return (
    <div className="min-h-svh bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur-md">
        <div className={COLUMN}>
          <div className="flex h-12 items-center gap-2">
            {/* Wordmark bullet only. It used to be semantic green, which read as
                a liveness lamp the app never actually verified. */}
            <span
              aria-hidden
              className="size-1.5 rounded-full bg-muted-foreground/60"
            />
            <h1 className="font-heading text-sm font-medium tracking-tight">
              indmoney
              <span className="px-px text-muted-foreground">·</span>
              watcher
            </h1>
            <Badge
              variant="outline"
              className="ml-2 font-mono text-3xs tracking-caps text-muted-foreground uppercase"
            >
              Read-only
            </Badge>
            <div className="ml-auto">
              <ThemeToggle />
            </div>
          </div>
          <div className="pb-1.5">{switcher}</div>
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
