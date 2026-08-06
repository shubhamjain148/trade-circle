import { describeSeries } from "@/lib/sparkline"
import type { HoldingHistory } from "@/lib/types"

/**
 * One holding's weight over the last month, drawn inside its row.
 *
 * The panel already answers "how much of the portfolio is this?" in the column
 * to the right. This answers the question that column can't: *how did it get
 * there* — the difference between a position someone has been building for
 * three weeks and one they opened yesterday at the same size. It is the whole
 * point of keeping snapshot history.
 *
 * ── Design decisions (dataviz skill) ─────────────────────────────────────────
 *
 * **Form.** Change over time, one series, no comparison across rows → a line.
 * No axes, no gridlines, no legend: a legend for one series restates the row
 * label beside it, and an axis on a 44px mark is ink where the % column already
 * carries the number. Nothing here is color-encoded.
 *
 * **Color.** Neutral foreground, not the app's semantic green/red. Weight is not
 * direction: a holding's share of a portfolio rises when the stock rises and
 * falls when a *neighbour* rises, so painting an upward slope green would read
 * as "he's winning" when it can equally mean "everything else fell". The
 * skill's own spec for a trend mark is the de-emphasis hue, and the product's
 * rule is that its two saturated colors mean entry and exit and nothing else.
 * Same token in both themes — `foreground` is already tuned per theme.
 *
 * **Scale.** Auto-scaled per row, with a floor: a series whose whole range is
 * under MIN_SPAN percentage points is drawn against a MIN_SPAN window centred on
 * it, so a holding that drifted 0.2% does not draw the same mountain as one that
 * doubled. Per-row rather than one shared scale because a 3% position on a
 * portfolio-wide axis is a flat line at the floor — its shape, which is the only
 * thing this mark is for, would be invisible. Magnitude is not this mark's job;
 * it is the column next to it, and the screen-reader description below carries
 * the real numbers so nothing is gated behind the picture.
 *
 * **Baseline is not zero, and that is stated.** Auto-scaling means the line's
 * height is relative, never absolute. The sr-only sentence gives the actual
 * start, end, low and high, and the `<title>` puts the same sentence under a
 * mouse pointer.
 *
 * **States.** A flat series draws a straight horizontal rule through the middle
 * — deliberate, and distinguishable from "broken" because the line still spans
 * the full width and the caption/description say "steady". A holding with no
 * history at all (bought since the last daily pass) gets no line: one point is
 * not a trend, so it gets a single quiet dot at the "now" end and the row says
 * "new".
 */

/** The mark's box, in user units = CSS px. */
const WIDTH = 44
const HEIGHT = 14
/** Half the stroke, so round caps at the extremes aren't clipped by the box. */
const INSET = 1

/**
 * The smallest weight range a full-height line is allowed to represent, in
 * percentage points. Below this the series is centred inside a MIN_SPAN window
 * instead of being stretched — the difference between reporting a move and
 * amplifying float noise into one.
 */
const MIN_SPAN = 2

interface HoldingSparklineProps {
  /** The series for this instrument, or undefined when there is no history. */
  history: HoldingHistory | undefined
  /** Every day in the window, oldest first — the shared x-axis. */
  days: string[]
}

export function HoldingSparkline({ history, days }: HoldingSparklineProps) {
  const points = history?.points ?? []

  // One reading is a fact, not a trend. Drawing a dot-with-no-line is the
  // honest rendering, and the row's "new" caption says the rest in words.
  if (points.length < 2 || days.length < 2) {
    return (
      <svg
        aria-hidden
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width={WIDTH}
        height={HEIGHT}
        className="overflow-visible"
      >
        <circle
          cx={WIDTH - INSET}
          cy={HEIGHT / 2}
          r={1.5}
          className="fill-foreground/35"
        />
      </svg>
    )
  }

  const values = points.map((p) => p.pct)
  const low = Math.min(...values)
  const high = Math.max(...values)
  const [floor, ceiling] = paddedDomain(low, high)

  const span = days.length - 1
  const plotHeight = HEIGHT - INSET * 2
  const plotWidth = WIDTH - INSET * 2

  const coords = points.map((point) => {
    // Positioned on the window's day axis, not on this series' own index: a
    // position opened halfway through the month starts halfway across.
    const day = days.indexOf(point.d)
    const x = INSET + (day / span) * plotWidth
    const y =
      INSET + plotHeight - ((point.pct - floor) / (ceiling - floor)) * plotHeight
    return `${round(x)},${round(y)}`
  })

  const last = coords[coords.length - 1].split(",")

  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      width={WIDTH}
      height={HEIGHT}
      className="overflow-visible"
    >
      {/* Same sentence a screen reader gets, for a mouse pointer. No JS
          tooltip: the row is four numbers wide and the value is already on it. */}
      <title>{describeSeries(points)}</title>
      <polyline
        points={coords.join(" ")}
        fill="none"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-foreground/45"
      />
      {/* Where the line ends is "now" — the one point worth marking, and it
          ties the mark to the % beside it. */}
      <circle cx={last[0]} cy={last[1]} r={1.5} className="fill-foreground/70" />
    </svg>
  )
}

/**
 * The y-window a series is drawn against. Never zero-based (a portfolio weight
 * rarely visits zero and the shape is the story) but never tighter than
 * MIN_SPAN either, which is what keeps a steady holding looking steady.
 */
function paddedDomain(low: number, high: number): [number, number] {
  const span = high - low
  if (span >= MIN_SPAN) return [low, high]

  const middle = (low + high) / 2
  return [middle - MIN_SPAN / 2, middle + MIN_SPAN / 2]
}

/** Two decimals of a pixel is plenty, and keeps the path attribute short. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}
