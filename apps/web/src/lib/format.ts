const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now" · "12m ago" · "2h ago" · "3d ago" · "14 Jul" */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const timestamp = new Date(iso).getTime()
  if (Number.isNaN(timestamp)) return ""

  const elapsed = Math.max(0, now - timestamp)

  if (elapsed < MINUTE) return "just now"
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d ago`

  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  })
}

/** Column-friendly form: "now" · "12m" · "2h" · "3d" · "14 Jul" */
export function relativeTimeCompact(
  iso: string,
  now: number = Date.now()
): string {
  const value = relativeTime(iso, now)
  if (value === "just now") return "now"
  return value.replace(" ago", "")
}

export function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })
}

const startOfDay = (value: number) => {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Stable key for grouping a feed into day sections. */
export function dayKey(iso: string): string {
  return new Date(iso).toDateString()
}

/** "Today" · "Yesterday" · "Mon, 4 Aug" */
export function dayLabel(iso: string, now: number = Date.now()): string {
  // floor, not round: a timestamp a few minutes ahead of the client clock
  // (watcher/browser skew is normal) must still read as "Today", and must not
  // round a late-evening event into the wrong bucket.
  const days = Math.floor(
    (startOfDay(now) - startOfDay(new Date(iso).getTime())) / DAY
  )

  if (days <= 0) return "Today"
  if (days === 1) return "Yesterday"

  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  })
}

/** Portfolio weights only — the product never renders currency. */
export function formatPortfolioPct(value: number): string {
  return `${value.toFixed(1)}% of portfolio`
}

/** 0.25 -> "+25% qty", -0.4 -> "−40% qty" */
export function formatQtyChange(value: number): string {
  const pct = Math.round(Math.abs(value) * 100)
  return `${value < 0 ? "−" : "+"}${pct}% qty`
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("")
}
