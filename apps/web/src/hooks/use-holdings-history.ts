import * as React from "react"

import { useResource } from "@/hooks/use-resource"
import { memberPositionsHistoryPath } from "@/lib/api"
import type { HoldingHistory, HoldingsHistory } from "@/lib/types"

export interface HoldingsHistoryIndex {
  /** Every day in the window, oldest first — the axis every series is drawn on. */
  days: string[]
  /** instrumentId → its series, or undefined when the holding has no history. */
  seriesFor: (instrumentId: string) => HoldingHistory | undefined
  /** True until the first answer lands, so rows can hold their space quietly. */
  isLoading: boolean
}

const EMPTY: HoldingsHistory = { days: [], series: [] }

/**
 * The sparkline data for one member's holdings panel.
 *
 * Its own request, fired in parallel with the positions read rather than folded
 * into it: the rows are the page, and they must not wait on a month of snapshot
 * payloads to render. When this resolves the marks appear inside rows that are
 * already on screen and already the right height — the sparkline cell reserves
 * its width from the first paint, so nothing reflows.
 *
 * A failure is deliberately silent. There is no error branch and no retry
 * button: the panel above it already handles "we couldn't read the holdings",
 * and a second alarm for a decoration that failed while the data behind it
 * arrived fine would be noise. Missing sparklines simply don't draw.
 */
export function useHoldingsHistory(memberId: string): HoldingsHistoryIndex {
  const { data, isLoading } = useResource<HoldingsHistory>(
    memberPositionsHistoryPath(memberId)
  )

  const history = data ?? EMPTY

  const byInstrument = React.useMemo(() => {
    const index = new Map<string, HoldingHistory>()
    for (const series of history.series) index.set(series.instrumentId, series)
    return index
  }, [history])

  const seriesFor = React.useCallback(
    (instrumentId: string) => byInstrument.get(instrumentId),
    [byInstrument]
  )

  return { days: history.days, seriesFor, isLoading }
}
