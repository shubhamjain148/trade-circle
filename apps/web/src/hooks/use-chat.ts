import * as React from "react"

import { chatPath, chatSocketUrl, getJson, postJson } from "@/lib/api"
import type {
  ChatPage,
  Member,
  RoomServerMessage,
  TimelineItem,
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
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<Error | undefined>()
  const [updatedAt, setUpdatedAt] = React.useState<number | undefined>()
  const [live, setLive] = React.useState(false)
  const [typing, setTyping] = React.useState<TypingMember[]>([])

  // Cursor is a ref, not state: advancing it must not restart the poll loop.
  const cursor = React.useRef("")
  const inFlight = React.useRef(false)
  /** Consecutive failed syncs — the only input to the poll interval. */
  const failures = React.useRef(0)
  /** Same fact as `live`, readable from the poll loop without restarting it. */
  const isLive = React.useRef(false)
  const socket = React.useRef<WebSocket | null>(null)
  const lastTypingSentAt = React.useRef(0)
  /** Re-arm the poll from now. Installed by the poll effect, called by the socket. */
  const poke = React.useRef<() => void>(() => {})

  const sync = React.useCallback(async (signal?: AbortSignal) => {
    if (inFlight.current) return
    inFlight.current = true

    try {
      const page = await getJson<ChatPage>(chatPath(cursor.current), signal)
      if (signal?.aborted) return

      cursor.current = page.cursor
      if (page.items.length > 0) {
        setItems((current) => merge(current, page.items))
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
  }, [])

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
  }, [member.id])

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
    isLoading,
    error,
    updatedAt,
    live,
    typing,
    send,
    retry,
    reload,
    notifyTyping,
  }
}
