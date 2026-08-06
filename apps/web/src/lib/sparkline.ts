/**
 * The words behind the holdings sparkline — see components/holding-sparkline.tsx
 * for the mark itself and the design reasoning.
 *
 * These live apart from the component for two reasons. They are the version of
 * the chart that people who don't read charts get (a screen-reader sentence, a
 * "held 3w" caption), so they deserve to be readable and testable without a
 * renderer. And the component file stays a component file, which is what keeps
 * fast refresh honest.
 */

/** "41.5%" — the panel's precision, everywhere. */
function pct(value: number): string {
  return `${value.toFixed(1)}%`
}

/**
 * The plain-English version of the mark, and the only version some readers get.
 *
 * It carries the absolute numbers the line cannot: the sparkline is auto-scaled
 * per row, so its height is relative and its baseline is not zero. Start, end,
 * low and high are all here, so nothing the picture shows is gated behind
 * seeing it.
 */
export function describeSeries(points: { pct: number }[]): string {
  if (points.length === 0) return "No weight history yet."
  if (points.length === 1) {
    return `First reading: ${pct(points[0].pct)} of portfolio. No history yet.`
  }

  const values = points.map((p) => p.pct)
  const first = values[0]
  const last = values[values.length - 1]
  const low = Math.min(...values)
  const high = Math.max(...values)
  const window = `over the last ${points.length} days`

  // Under a tenth of a point across the whole window is a holding that has not
  // moved. Saying "up from 12.0% to 12.0%" would be worse than saying nothing.
  if (high - low < 0.1) {
    return `Weight ${window}: steady at ${pct(last)} of portfolio.`
  }

  const direction = last > first ? "up" : last < first ? "down" : "back"
  return `Weight ${window}: ${direction} from ${pct(first)} to ${pct(last)} of portfolio, between ${pct(low)} and ${pct(high)}.`
}

/**
 * "held 3w" · "held 5d" — how long ago the watcher saw this position open.
 *
 * null when `openedAt` is null, which is the server's way of saying the position
 * predates the history window: the honest answer is then "at least a month", and
 * a row that printed "held 30d" would be reporting the window's edge as a fact
 * about someone's portfolio.
 */
export function heldFor(
  openedAt: string | null,
  now = Date.now()
): string | null {
  if (!openedAt) return null

  const opened = Date.parse(`${openedAt}T00:00:00Z`)
  if (Number.isNaN(opened)) return null

  const days = Math.max(0, Math.floor((now - opened) / 86_400_000))
  if (days < 1) return "held today"
  // Days up to a fortnight, then weeks: "held 9d" is a real answer, "held 23d"
  // is arithmetic the reader has to do themselves.
  if (days < 14) return `held ${days}d`
  return `held ${Math.floor(days / 7)}w`
}
