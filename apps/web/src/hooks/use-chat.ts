import * as React from "react"

import {
  chatPath,
  chatReactionsPath,
  chatSocketUrl,
  getJson,
  postJson,
  writeJson,
} from "@/lib/api"
import {
  reactionKey,
  type ChatPage,
  type Member,
  type ReactionItemKind,
  type ReactionMap,
  type ReactionSummary,
  type ReactionUpdate,
  type RoomServerMessage,
  type TimelineItem,
} from "@/lib/types"

/** How long a message can be; mirrors MAX_BODY_LENGTH in apps/server/src/chat.ts. */
export const MAX_MESSAGE_LENGTH = 2000

/** Cheap enough to feel live, slow enough that nobody notices the requests. */
const POLL_MS = 4000

/**
 * The poll interval while the socket is up. Not zero: the socket is delivery,
 * not truth. A dropped frame, a message written by a runtime that couldn't
 * reach the room, a tab that suspended without noticing — all of them heal at
 * the next pass, and one request a minute is a cheap insurance premium.
 */
const SLOW_POLL_MS = 60_000

/** Reconnect backoff: doubles, caps, and never lands on the same tick twice. */
const SOCKET_BACKOFF_MS = 1000
const SOCKET_MAX_BACKOFF_MS = 30_000

/**
 * How many times to try before concluding this deployment simply has no socket.
 * The Node entry point answers /api/chat/ws with 501, and the browser reports
 * that as an indistinguishable failed handshake — so the tell is not the error,
 * it's that the socket never once opened. After that we stop asking and the
 * four-second poll is the product, exactly as it was before this existed.
 */
const SOCKET_COLD_ATTEMPTS = 3

/** At most one typing frame per this long, however fast anyone types. */
const TYPING_THROTTLE_MS = 2500

/** A typing signal is a claim about right now; four seconds later it isn't. */
const TYPING_TTL_MS = 4000

/**
 * A watcher that's down stays down for minutes, not seconds. Backing off keeps
 * a dead server from collecting one request every four seconds for as long as
 * the tab is open — on a phone that is the battery, and in the log it buries
 * the outage that caused it. Doubles to a minute, resets on the first success.
 */
const MAX_BACKOFF_MS = 60_000

/**
 * A timeline row plus the two states that only exist on this side of the wire:
 * a message that has been typed but not yet acknowledged, and one that failed
 * to send. Both are the client's problem, so neither is in the API shape.
 */
export type ChatItem = TimelineItem & { pending?: boolean; failed?: boolean }

/** Someone mid-sentence, with the moment their claim stops being true. */
export interface TypingMember {
  memberId: string
  name: string
  expiresAt: number
}

export interface Chat {
  items: ChatItem[]
  /** Keyed by reactionKey(); missing means "nobody has reacted to that item". */
  reactions: ReactionMap
  /** True only before the first page lands — a poll failure never re-blanks it. */
  isLoading: boolean
  /** Set when the last sync failed; the timeline below it is still the truth. */
  error: Error | undefined
  /** When the last successful sync landed. */
  updatedAt: number | undefined
  /** True while the socket is open. Nothing breaks when it isn't. */
  live: boolean
  /** Who is typing, you excluded. Empty without a socket, and that's fine. */
  typing: TypingMember[]
  send: (body: string) => void
  retry: (id: string) => void
  /**
   * Add or remove one of your reactions. Moves the pill immediately and reverts
   * it if the write fails — there is no pending state for a reaction, because a
   * pill that shows "maybe" is worse than one that briefly showed the wrong
   * count and then corrected itself.
   */
  react: (kind: ReactionItemKind, id: string, emoji: string, on: boolean) => void
  reload: () => void
  /** Call on every keystroke; the throttle is in here, not in the composer. */
  notifyTyping: () => void
}

let sequence = 0

function isUnsettled(item: ChatItem): boolean {
  return item.pending === true || item.failed === true
}

/**
 * Reconcile-on-poll: anything the server just handed us wins over the local
 * copy of the same id, and optimistic rows stay pinned to the end until their
 * own POST resolves. Ordering is otherwise the server's, never re-sorted here.
 */
function merge(current: ChatItem[], incoming: TimelineItem[]): ChatItem[] {
  const arrived = new Set(incoming.map((item) => item.id))

  return [
    ...current.filter((item) => !isUnsettled(item) && !arrived.has(item.id)),
    ...incoming,
    ...current.filter(isUnsettled),
  ]
}

function settle(
  current: ChatItem[],
  pendingId: string,
  saved: TimelineItem
): ChatItem[] {
  const rest = current.filter(
    (item) => item.id !== pendingId && item.id !== saved.id
  )

  return [
    ...rest.filter((item) => !isUnsettled(item)),
    saved,
    ...rest.filter(isUnsettled),
  ]
}

/**
 * Apply a batch of authoritative summaries. Every source — poll, socket, the
 * toggle's own response — hands whole summaries per item, never deltas, so this
 * is a shallow overwrite and applying the same batch twice changes nothing.
 *
 * Empty arrays are written, not skipped: an item whose last reaction was just
 * removed arrives as `[]`, and dropping it would leave the pill on screen.
 */
function applyReactions(current: ReactionMap, incoming: ReactionMap): ReactionMap {
  const keys = Object.keys(incoming)
  if (keys.length === 0) return current
  // Nothing actually moved (an inclusive delta re-sending its boundary item is
  // the common case): keep the identity so nothing downstream re-renders.
  if (keys.every((key) => sameSummaries(current[key], incoming[key]))) return current
  return { ...current, ...incoming }
}

function sameSummaries(
  a: ReactionSummary[] | undefined,
  b: ReactionSummary[]
): boolean {
  if (a === undefined || a.length !== b.length) return false
  return a.every((entry, i) => {
    const other = b[i]
    return (
      entry.emoji === other.emoji &&
      entry.count === other.count &&
      entry.mine === other.mine &&
      entry.who.length === other.who.length &&
      entry.who.every((name, j) => name === other.who[j])
    )
  })
}

/**
 * The optimistic half of a toggle: move the pill now, reconcile later.
 *
 * `you` is inserted into (or removed from) `who` rather than only bumping the
 * count, because the names are what the pill's press-and-hold reveals — a
 * count that moved without a name behind it would read as a bug the moment
 * anyone looked.
 */
function toggleLocally(
  summaries: ReactionSummary[] | undefined,
  emoji: string,
  you: string,
  on: boolean
): ReactionSummary[] {
  const current = summaries ?? []
  const existing = current.find((entry) => entry.emoji === emoji)

  if (on) {
    if (existing?.mine) return current
    if (!existing) {
      return [...current, { emoji, count: 1, mine: true, who: [you] }]
    }
    return current.map((entry) =>
      entry.emoji === emoji
        ? { ...entry, count: entry.count + 1, mine: true, who: [...entry.who, you] }
        : entry
    )
  }

  if (!existing?.mine) return current
  // The last one out takes the pill with it.
  if (existing.count <= 1) return current.filter((entry) => entry.emoji !== emoji)
  return current.map((entry) =>
    entry.emoji === emoji
      ? {
          ...entry,
          count: entry.count - 1,
          mine: false,
          // One occurrence, not every match: two friends can share a first name,
          // and the server's next summary is the one that settles it anyway.
          who: withoutOne(entry.who, you),
        }
      : entry
  )
}

function withoutOne(names: string[], name: string): string[] {
  const at = names.indexOf(name)
  if (at < 0) return names
  return [...names.slice(0, at), ...names.slice(at + 1)]
}

/** Newest claim wins, and re-arms the four seconds. */
function noteTyping(
  current: TypingMember[],
  signal: { memberId: string; name: string },
  now: number
): TypingMember[] {
  const expiresAt = now + TYPING_TTL_MS
  const rest = current.filter(
    (t) => t.memberId !== signal.memberId && t.expiresAt > now
  )
  return [...rest, { ...signal, expiresAt }]
}

/**
 * Two layers, and the order matters: the poll is the one that is always right,
 * and the socket is the one that is usually first.
 *
 * The cursor poll is unchanged and still the reconciliation layer — it owns the
 * cursor, the backoff, the error banner and the tab-visibility rules. On top of
 * it sits a WebSocket that delivers the same rows the poll would have, through
 * the same merge, deduped by id; while it is open the poll relaxes to a minute.
 * Nothing in here is load-bearing: kill the socket and the product is exactly
 * what it was, four seconds slower.
 *
 * Sends still go over HTTP POST. A socket that could also write would need its
 * own acknowledgement, retry and ordering story, and the optimistic-row +
 * outbox machinery below already has one that works.
 */
export function useChat(member: Member): Chat {
  const [items, setItems] = React.useState<ChatItem[]>([])
  const [reactions, setReactions] = React.useState<ReactionMap>({})
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<Error | undefined>()
  const [updatedAt, setUpdatedAt] = React.useState<number | undefined>()
  const [live, setLive] = React.useState(false)
  const [typing, setTyping] = React.useState<TypingMember[]>([])

  // Cursor is a ref, not state: advancing it must not restart the poll loop.
  const cursor = React.useRef("")
  /**
   * The second cursor, and the reason reactions on old rows work at all. Kept
   * separate from `cursor` because the two advance for different reasons: one
   * tracks what has been *said*, the other what has been *reacted to*, and an
   * hour-old message can move on the second axis long after it stopped moving
   * on the first.
   */
  const reactionCursor = React.useRef("")
  /**
   * The same map as `reactions`, readable synchronously. The optimistic toggle
   * has to know what was on screen *before* it moved anything so it can put it
   * back on failure, and reading that out of a `setState` updater would be a
   * side effect inside a function React is allowed to call twice.
   */
  const reactionsRef = React.useRef<ReactionMap>({})
  const inFlight = React.useRef(false)
  /** Consecutive failed syncs — the only input to the poll interval. */
  const failures = React.useRef(0)
  /** Same fact as `live`, readable from the poll loop without restarting it. */
  const isLive = React.useRef(false)
  const socket = React.useRef<WebSocket | null>(null)
  const lastTypingSentAt = React.useRef(0)
  /** Re-arm the poll from now. Installed by the poll effect, called by the socket. */
  const poke = React.useRef<() => void>(() => {})

  /** The one write path for reactions — ref and state move together, always. */
  const applyReactionBatch = React.useCallback((incoming: ReactionMap) => {
    const next = applyReactions(reactionsRef.current, incoming)
    if (next === reactionsRef.current) return
    reactionsRef.current = next
    setReactions(next)
  }, [])

  const sync = React.useCallback(async (signal?: AbortSignal) => {
    if (inFlight.current) return
    inFlight.current = true

    try {
      const page = await getJson<ChatPage>(
        chatPath(cursor.current, reactionCursor.current),
        signal
      )
      if (signal?.aborted) return

      cursor.current = page.cursor
      if (page.items.length > 0) {
        setItems((current) => merge(current, page.items))
      }
      // Tolerant of a server that predates this field: an old deploy answering
      // a new tab leaves the pills alone rather than wiping them.
      if (page.reactions) applyReactionBatch(page.reactions)
      if (typeof page.reactionCursor === "string") {
        reactionCursor.current = page.reactionCursor
      }
      failures.current = 0
      setError(undefined)
      setUpdatedAt(Date.now())
    } catch (cause) {
      if (signal?.aborted) return
      failures.current += 1
      setError(cause instanceof Error ? cause : new Error(String(cause)))
    } finally {
      inFlight.current = false
      setIsLoading(false)
    }
    // applyReactionBatch is stable (its own useCallback holds no dependencies),
    // so naming it here does not make this callback churn — and a churning
    // `sync` would restart the poll loop on every render.
  }, [applyReactionBatch])

  React.useEffect(() => {
    const controller = new AbortController()
    let timer = 0

    // Self-scheduling rather than setInterval: the gap has to depend on how the
    // last request went — and now on whether anything else is delivering — and
    // an interval can't be told either.
    function delay(): number {
      if (failures.current > 0) {
        return Math.min(POLL_MS * 2 ** failures.current, MAX_BACKOFF_MS)
      }
      return isLive.current ? SLOW_POLL_MS : POLL_MS
    }

    function schedule() {
      if (controller.signal.aborted) return
      timer = window.setTimeout(() => void run(), delay())
    }

    async function run() {
      if (!document.hidden) await sync(controller.signal)
      schedule()
    }

    void sync(controller.signal).then(schedule)

    // Coming back to the tab should not cost a four-second wait — and, after an
    // outage, should not cost the whole backoff either. Re-arm from now.
    const onVisibility = () => {
      if (document.hidden) return
      window.clearTimeout(timer)
      void run()
    }
    document.addEventListener("visibilitychange", onVisibility)

    // The same re-arm, for the socket to pull: opening one leaves a gap between
    // the last poll and the first frame, and losing one leaves a timer set a
    // minute out when the interval has just dropped back to four seconds.
    poke.current = () => {
      window.clearTimeout(timer)
      void run()
    }

    return () => {
      controller.abort()
      window.clearTimeout(timer)
      poke.current = () => {}
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [sync])

  /**
   * The socket. One per mount, reconnecting with capped jittered backoff for as
   * long as it has ever worked, and giving up quietly if it never has — see
   * SOCKET_COLD_ATTEMPTS. Everything it delivers goes through merge(), the same
   * function a poll response goes through, and the cursor is deliberately not
   * advanced: the next poll re-delivers these rows and dedupes them by id,
   * which is the cheapest possible guarantee that nothing is ever stepped over.
   */
  React.useEffect(() => {
    let current: WebSocket | null = null
    let timer = 0
    let attempts = 0
    let everOpened = false
    let stopped = false

    const goOffline = () => {
      if (!isLive.current) return
      isLive.current = false
      setLive(false)
      setTyping([])
    }

    function schedule() {
      if (stopped) return
      // Never opened, and we've asked enough times: this deployment has no
      // room. Stop knocking; the poll loop was never depending on us.
      if (!everOpened && attempts >= SOCKET_COLD_ATTEMPTS) return

      attempts += 1
      const capped = Math.min(
        SOCKET_BACKOFF_MS * 2 ** (attempts - 1),
        SOCKET_MAX_BACKOFF_MS
      )
      // Jitter within the cap, never beyond it: five tabs that lost the same
      // server must not come back in lockstep.
      timer = window.setTimeout(connect, capped * (0.5 + Math.random() * 0.5))
    }

    function connect() {
      if (stopped) return

      let ws: WebSocket
      try {
        ws = new WebSocket(chatSocketUrl())
      } catch {
        schedule()
        return
      }
      current = ws
      socket.current = ws

      ws.onopen = () => {
        everOpened = true
        attempts = 0
        isLive.current = true
        setLive(true)
        // Anything that landed between the last poll and this handshake.
        poke.current()
      }

      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return
        let payload: RoomServerMessage
        try {
          payload = JSON.parse(event.data) as RoomServerMessage
        } catch {
          return
        }

        if (payload.type === "items") {
          if (payload.items.length > 0) {
            setItems((rows) => merge(rows, payload.items))
          }
          setUpdatedAt(Date.now())
          return
        }

        if (payload.type === "reactions") {
          // Whole summaries, `mine` already resolved for this socket's member,
          // through the same apply the poll uses. The reaction cursor is
          // deliberately *not* advanced: the next poll re-delivers this and the
          // overwrite is a no-op, which is the cheapest possible guarantee that
          // a dropped frame heals instead of stranding a pill.
          applyReactionBatch(payload.reactions)
          setUpdatedAt(Date.now())
          return
        }

        if (payload.type === "typing") {
          // Your own other tab is not news, and the room already skips the
          // socket that sent the signal.
          if (payload.memberId === member.id) return
          setTyping((rows) => noteTyping(rows, payload, Date.now()))
        }
      }

      // A failed handshake fires error then close; close is where the retry
      // lives, so this only exists to stop the browser logging it as unhandled.
      ws.onerror = () => {}

      ws.onclose = () => {
        if (socket.current === ws) socket.current = null
        current = null
        if (stopped) return
        goOffline()
        // Back to the fast poll immediately rather than a minute from now.
        poke.current()
        schedule()
      }
    }

    connect()

    return () => {
      stopped = true
      window.clearTimeout(timer)
      isLive.current = false
      socket.current = null
      current?.close()
    }
    // Same note as `sync`: stable, so the socket is not reconnected for it.
  }, [applyReactionBatch, member.id])

  // Typing claims expire on their own, so something has to notice. Only armed
  // while somebody is typing — an idle chat runs no timer at all.
  React.useEffect(() => {
    if (typing.length === 0) return
    const soonest = Math.min(...typing.map((t) => t.expiresAt))
    const timer = window.setTimeout(
      () => setTyping((rows) => rows.filter((t) => t.expiresAt > Date.now())),
      Math.max(0, soonest - Date.now()) + 50
    )
    return () => window.clearTimeout(timer)
  }, [typing])

  // What was typed, keyed by its optimistic id, until the server has it. Retry
  // reads the body from here rather than from the rendered list, so neither
  // send nor retry has to depend on (and churn with) every poll.
  const outbox = React.useRef(new Map<string, string>())

  const post = React.useCallback(
    async (body: string, pendingId: string) => {
      // The cursor is deliberately not advanced here: the next poll re-delivers
      // this message and merge() dedupes it by id. Skipping it forward would
      // risk stepping over an event stamped in the same instant.
      try {
        const saved = await postJson<TimelineItem>(chatPath(), { body })
        outbox.current.delete(pendingId)
        setItems((current) => settle(current, pendingId, saved))
      } catch {
        setItems((current) =>
          current.map((item) =>
            item.id === pendingId
              ? { ...item, pending: false, failed: true }
              : item
          )
        )
      }
    },
    []
  )

  const send = React.useCallback(
    (body: string) => {
      const text = body.trim().slice(0, MAX_MESSAGE_LENGTH)
      if (!text) return

      sequence += 1
      const pendingId = `pending:${sequence}`
      outbox.current.set(pendingId, text)

      setItems((current) => [
        ...current,
        {
          kind: "message",
          id: pendingId,
          memberId: member.id,
          authorName: member.name,
          body: text,
          createdAt: new Date().toISOString(),
          pending: true,
        },
      ])

      void post(text, pendingId)
    },
    [member.id, member.name, post]
  )

  const retry = React.useCallback(
    (id: string) => {
      const body = outbox.current.get(id)
      if (body === undefined) return

      setItems((current) =>
        current.map((item) =>
          item.id === id ? { ...item, pending: true, failed: false } : item
        )
      )
      void post(body, id)
    },
    [post]
  )

  /**
   * The toggle. Optimistic, and revertible because the revert is exact: the
   * summary that was on screen before the tap is captured and put back on
   * failure, rather than the count being decremented a second time.
   *
   * The request itself is idempotent at both ends, so a tap that races the poll
   * or the socket settles on the same row whichever lands last. The response is
   * applied anyway — it is the authoritative summary and may carry a reaction
   * someone else added in the same second.
   */
  const react = React.useCallback(
    (kind: ReactionItemKind, id: string, emoji: string, on: boolean) => {
      const key = reactionKey(kind, id)
      const restore = reactionsRef.current[key] ?? []
      const next = toggleLocally(restore, emoji, member.name, on)
      // Already in the state being asked for — a double tap, or a stale render.
      // Nothing to write, nothing to revert.
      if (next === restore) return

      applyReactionBatch({ [key]: next })

      void writeJson<ReactionUpdate>(chatReactionsPath, on ? "PUT" : "DELETE", {
        itemKind: kind,
        itemId: id,
        emoji,
      }).then(
        (update) => applyReactionBatch({ [key]: update.reactions }),
        // Put back exactly what was there, rather than inverting the toggle: by
        // now a poll may have moved this item, and re-inverting would compound.
        () => applyReactionBatch({ [key]: restore })
      )
    },
    [applyReactionBatch, member.name]
  )

  // An explicit "try again" is a fresh start, not the next step of a backoff.
  const reload = React.useCallback(() => {
    failures.current = 0
    void sync()
  }, [sync])

  /**
   * One frame per 2.5 s at most, and none at all without a socket. The throttle
   * is here rather than in the composer so there is exactly one of it however
   * many places end up calling this, and so the number lives next to the four
   * seconds it has to stay under.
   */
  const notifyTyping = React.useCallback(() => {
    const ws = socket.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    const now = Date.now()
    if (now - lastTypingSentAt.current < TYPING_THROTTLE_MS) return
    lastTypingSentAt.current = now

    try {
      ws.send(JSON.stringify({ type: "typing" }))
    } catch {
      // A socket that died mid-keystroke is the close handler's problem.
    }
  }, [])

  return {
    items,
    reactions,
    isLoading,
    error,
    updatedAt,
    live,
    typing,
    send,
    retry,
    react,
    reload,
    notifyTyping,
  }
}
