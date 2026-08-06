import * as React from "react"

import { chatPath, getJson, postJson } from "@/lib/api"
import type { ChatPage, Member, TimelineItem } from "@/lib/types"

/** How long a message can be; mirrors MAX_BODY_LENGTH in apps/server/src/chat.ts. */
export const MAX_MESSAGE_LENGTH = 2000

/** Cheap enough to feel live, slow enough that nobody notices the requests. */
const POLL_MS = 4000

/**
 * A timeline row plus the two states that only exist on this side of the wire:
 * a message that has been typed but not yet acknowledged, and one that failed
 * to send. Both are the client's problem, so neither is in the API shape.
 */
export type ChatItem = TimelineItem & { pending?: boolean; failed?: boolean }

export interface Chat {
  items: ChatItem[]
  /** True only before the first page lands — a poll failure never re-blanks it. */
  isLoading: boolean
  /** Set when the last sync failed; the timeline below it is still the truth. */
  error: Error | undefined
  /** When the last successful sync landed. */
  updatedAt: number | undefined
  send: (body: string) => void
  retry: (id: string) => void
  reload: () => void
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
 * Polling, not websockets: five friends and a four-second cadence do not earn a
 * socket, and a cursor makes the idle poll an empty body. Paused while the tab
 * is hidden — nobody is reading a backgrounded chat, and the phone battery is.
 */
export function useChat(member: Member): Chat {
  const [items, setItems] = React.useState<ChatItem[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [error, setError] = React.useState<Error | undefined>()
  const [updatedAt, setUpdatedAt] = React.useState<number | undefined>()

  // Cursor is a ref, not state: advancing it must not restart the poll loop.
  const cursor = React.useRef("")
  const inFlight = React.useRef(false)

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
      setError(undefined)
      setUpdatedAt(Date.now())
    } catch (cause) {
      if (signal?.aborted) return
      setError(cause instanceof Error ? cause : new Error(String(cause)))
    } finally {
      inFlight.current = false
      setIsLoading(false)
    }
  }, [])

  React.useEffect(() => {
    const controller = new AbortController()

    void sync(controller.signal)

    const timer = window.setInterval(() => {
      if (!document.hidden) void sync(controller.signal)
    }, POLL_MS)

    // Coming back to the tab should not cost a four-second wait.
    const onVisibility = () => {
      if (!document.hidden) void sync(controller.signal)
    }
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      controller.abort()
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [sync])

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

  const reload = React.useCallback(() => void sync(), [sync])

  return { items, isLoading, error, updatedAt, send, retry, reload }
}
