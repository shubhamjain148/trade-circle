// Cadence per docs/RESEARCH.md decision 3: hourly during US market hours, plus
// one pre-open and one post-close pass. Expressed in UTC because the US session
// defines the window: 19:00–02:30 IST == 13:30–21:00 UTC, and the weekday test
// is unambiguous there (an IST-local test straddles midnight).
//
// Zero-dep on purpose — plain setTimeout math, no node-cron.
// DST caveat: under EST the US session starts an hour later (14:30 UTC); the
// extra 13:30 pass is a harmless no-op the probe short-circuits.

const PRE_OPEN_UTC = 13 * 60; // 18:30 IST
const SESSION_START_UTC = 13 * 60 + 30; // 19:00 IST
const SESSION_END_UTC = 21 * 60; // 02:30 IST next day
const POST_CLOSE_UTC = 21 * 60 + 15; // 02:45 IST next day

export function runMinutesUtc(): number[] {
  const minutes = [PRE_OPEN_UTC];
  for (let m = SESSION_START_UTC; m <= SESSION_END_UTC; m += 60) minutes.push(m);
  minutes.push(POST_CLOSE_UTC);
  return minutes;
}

/** Strictly after `from`; skips Saturday and Sunday (UTC). */
export function nextRunAt(from: Date): Date {
  const minutes = runMinutesUtc();
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const day = new Date(
      Date.UTC(
        from.getUTCFullYear(),
        from.getUTCMonth(),
        from.getUTCDate() + dayOffset,
      ),
    );
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    for (const m of minutes) {
      const at = new Date(day.getTime() + m * 60_000);
      if (at.getTime() > from.getTime()) return at;
    }
  }
  throw new Error("no run slot found within 8 days");
}

export function isMarketWindow(at: Date): boolean {
  const weekday = at.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
  return minute >= SESSION_START_UTC && minute <= SESSION_END_UTC;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  nextAt(): Date | null;
}

/**
 * Self-rescheduling timer. Deployments without a long-lived process use their
 * platform's cron instead — on Workers that is `scheduled()` in worker.ts, not
 * an HTTP call: POST /api/poll is an admin control now, not a machine hook.
 */
export function createScheduler(
  onTick: () => Promise<unknown>,
  now: () => Date = () => new Date(),
): Scheduler {
  let timer: NodeJS.Timeout | null = null;
  let next: Date | null = null;

  const schedule = () => {
    next = nextRunAt(now());
    const delay = Math.max(0, next.getTime() - now().getTime());
    timer = setTimeout(() => {
      void onTick()
        .catch((err) => console.error("poll tick failed", err))
        .finally(schedule);
    }, delay);
    timer.unref?.();
  };

  return {
    start() {
      if (timer) return;
      schedule();
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      next = null;
    },
    nextAt: () => next,
  };
}
