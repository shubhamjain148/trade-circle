import type * as React from "react"

import { Button } from "@workspace/ui/components/button"
import { Skeleton } from "@workspace/ui/components/skeleton"

import { ConcentrationRow } from "@/components/concentration-row"
import { FeedNotice, POLLING_CADENCE } from "@/components/feed-states"
import { InstrumentStatRow } from "@/components/instrument-stat-row"
import {
  StatsSection,
  StatsSectionEmpty,
} from "@/components/stats-section"
import { useGroupStats } from "@/hooks/use-group-stats"
import { useNow } from "@/hooks/use-now"
import { navigate, SETTINGS_HREF } from "@/hooks/use-route"
import { absoluteTime, relativeTimeCompact } from "@/lib/format"
import { instrumentLabel } from "@/lib/instrument"
import type { GroupInstrument, GroupStats } from "@/lib/types"

/**
 * What the group holds in common — the screen that starts arguments.
 *
 * Four questions, four ruled bands, no cards and no charts: consensus picks,
 * how concentrated each portfolio is, what only one person is in, and one
 * sentence at the top naming the group's heaviest bet. Every number is a
 * percentage of somebody's own portfolio; there is no group total anywhere,
 * because summing weights across people would imply a shared pot that doesn't
 * exist — and amounts are not on the wire to begin with (src/stats.ts).
 */
export function GroupStatsView() {
  const { data, error, isLoading, reload } = useGroupStats()
  const now = useNow()

  if (isLoading && !data) return <StatsSkeleton />

  if (error || !data) {
    return (
      <FeedNotice
        tone="alert"
        title="Couldn't read the group's numbers"
        description="The watcher didn't answer. Nothing is wrong with your portfolio — this page just needs another try."
        action={
          <Button variant="outline" size="sm" onClick={reload}>
            Try again
          </Button>
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHead stats={data} now={now} />

      {/* A group of one is not an error and not an empty list — it is a group
          that hasn't happened yet, and every number below it would be a
          tautology ("100% of the portfolios hold NVDA"). */}
      {data.visibleMembers < 2 ? (
        <FeedNotice
          title="Stats need company"
          description="Overlap, consensus and concentration are all comparisons — with one portfolio on file there's nothing to compare it against. Invite the group and this page fills itself in."
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(SETTINGS_HREF)}
            >
              Invite the group
            </Button>
          }
        />
      ) : data.portfolios === 0 ? (
        <FeedNotice
          title="No holdings on file yet"
          description="Everyone's here, nobody's connected. The moment the watcher reads its first portfolio, this page has something to say."
          hint={POLLING_CADENCE}
        />
      ) : (
        <>
          <StatsSection
            id="stats-consensus"
            title="Consensus"
            count={data.overlaps.length}
            unit="avg % of own portfolio"
          >
            {data.overlaps.length === 0 ? (
              <StatsSectionEmpty>
                <span className="text-foreground">No overlap yet.</span> Nobody
                in the group holds the same thing as anyone else — which is
                either impressive independence or a group that needs to talk
                more.
              </StatsSectionEmpty>
            ) : (
              <ul>
                {data.overlaps.map((instrument) => (
                  <InstrumentStatRow
                    key={instrument.instrumentId}
                    instrument={instrument}
                    visibleMembers={data.visibleMembers}
                  />
                ))}
              </ul>
            )}
          </StatsSection>

          <StatsSection
            id="stats-concentration"
            title="Concentration"
            count={data.concentration.length}
            unit="top 3 of own portfolio"
          >
            <ul>
              {data.concentration.map((row, index) => (
                <ConcentrationRow
                  key={row.memberId ?? `anon-${index}`}
                  row={row}
                />
              ))}
            </ul>
          </StatsSection>

          <StatsSection
            id="stats-solo"
            title="Solo picks"
            count={data.solo.length}
            unit="% of own portfolio"
          >
            {data.solo.length === 0 ? (
              <StatsSectionEmpty>
                <span className="text-foreground">Nothing is held alone.</span>{" "}
                Every position in the group has at least one other believer.
              </StatsSectionEmpty>
            ) : (
              <ul>
                {data.solo.map((instrument) => (
                  <InstrumentStatRow
                    key={instrument.instrumentId}
                    instrument={instrument}
                    visibleMembers={data.visibleMembers}
                  />
                ))}
              </ul>
            )}
          </StatsSection>
        </>
      )}
    </div>
  )
}

function PageHead({ stats, now }: { stats: GroupStats; now: number }) {
  return (
    <header className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-heading text-base font-medium tracking-tight">
          Group stats
        </h2>
        <span className="shrink-0 font-mono text-3xs tracking-caps text-muted-foreground uppercase tabular-nums">
          {stats.asOf ? (
            <time dateTime={stats.asOf} title={absoluteTime(stats.asOf)}>
              as of {relativeTimeCompact(stats.asOf, now)}
            </time>
          ) : (
            "no readings yet"
          )}
        </span>
      </div>

      <p className="font-mono text-2xs tracking-wide text-muted-foreground tabular-nums">
        {stats.visibleMembers}{" "}
        {stats.visibleMembers === 1 ? "member" : "members"}
        <span className="px-1 opacity-50">·</span>
        {stats.portfolios}{" "}
        {stats.portfolios === 1 ? "portfolio" : "portfolios"} on file
      </p>

      {/* Suppressed for a group of one: "the group's heaviest weight" over a
          single portfolio is just that portfolio's largest holding, said
          grandly, two lines above a notice explaining there is no group yet. */}
      {stats.favorite && stats.visibleMembers > 1 ? (
        <FavoriteLede
          favorite={stats.favorite}
          visibleMembers={stats.visibleMembers}
        />
      ) : null}
    </header>
  )
}

/**
 * The page's one sentence. A ranked list answers "what", and nothing on it
 * answers "so what" — this does, in the voice someone would use pasting it into
 * the WhatsApp thread. It is prose, not a tile: no border, no icon, no number
 * set in display type.
 */
function FavoriteLede({
  favorite,
  visibleMembers,
}: {
  favorite: GroupInstrument
  visibleMembers: number
}) {
  const label = instrumentLabel(favorite.symbol, favorite.name)
  const shared = favorite.holderCount > 1

  return (
    <p className="max-w-xl pt-1 text-sm leading-relaxed text-muted-foreground">
      <Ticker label={label.primary} isTicker={label.isTicker} /> carries the
      group's heaviest weight —{" "}
      {shared ? (
        <>
          held by{" "}
          <Figure>
            {favorite.holderCount} of {visibleMembers}
          </Figure>
          , averaging <Figure>{favorite.averageWeight.toFixed(1)}%</Figure> of
          each holder's portfolio.
        </>
      ) : (
        <>
          and only {favorite.holders[0].name} is in it, at{" "}
          <Figure>{favorite.averageWeight.toFixed(1)}%</Figure> of their
          portfolio.
        </>
      )}
    </p>
  )
}

function Ticker({ label, isTicker }: { label: string; isTicker: boolean }) {
  return (
    <span
      className={
        isTicker
          ? "font-mono font-semibold text-foreground"
          : "font-heading font-semibold text-foreground"
      }
    >
      {label}
    </span>
  )
}

function Figure({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-foreground tabular-nums">{children}</span>
  )
}

function StatsSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="flex flex-col gap-6"
    >
      <div aria-hidden className="flex flex-col gap-2">
        <Skeleton className="h-4 w-28 rounded-sm" />
        <Skeleton className="h-3 w-44 rounded-sm" />
        <Skeleton className="h-3.5 w-full max-w-md rounded-sm" />
      </div>

      {[0, 1].map((section) => (
        <div key={section} aria-hidden>
          <div className="flex items-baseline justify-between border-b border-border pb-1.5">
            <Skeleton className="h-2.5 w-24 rounded-sm" />
            <Skeleton className="h-2.5 w-28 rounded-sm" />
          </div>
          <ul>
            {[0, 1, 2].map((row) => (
              /* py-2 matches the real row, so nothing jolts on arrival. */
              <li
                key={row}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-b border-border py-2"
              >
                <div className="space-y-1.5">
                  <Skeleton
                    className="h-3.5 rounded-sm"
                    style={{ width: `${40 - row * 6}%` }}
                  />
                  <Skeleton
                    className="h-2.5 rounded-sm"
                    style={{ width: `${28 - row * 4}%` }}
                  />
                </div>
                <Skeleton className="h-3.5 w-12 rounded-sm" />
              </li>
            ))}
          </ul>
        </div>
      ))}

      <span className="sr-only">Reading the group's numbers…</span>
    </div>
  )
}
