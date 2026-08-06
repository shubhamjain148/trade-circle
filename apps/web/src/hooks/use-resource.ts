import * as React from "react"

import { getJson } from "@/lib/api"

export interface Resource<T> {
  data: T | undefined
  error: Error | undefined
  isLoading: boolean
  /** When the current data landed — the feed's honest "as of". */
  updatedAt: number | undefined
  reload: () => void
}

interface Settled<T> {
  key: string
  data?: T
  error?: Error
  at?: number
}

/**
 * Minimal SWR-shaped fetch hook: one request per path, aborted on change.
 * State is only written from the request callbacks — a result that doesn't
 * match the current key simply reads as "still loading".
 * Deliberately dependency-free; swap for a real cache when the feed streams.
 */
export function useResource<T>(path: string): Resource<T> {
  const [nonce, setNonce] = React.useState(0)
  const [settled, setSettled] = React.useState<Settled<T>>({ key: "" })

  const key = `${nonce}:${path}`

  React.useEffect(() => {
    const controller = new AbortController()

    getJson<T>(path, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return
        setSettled({ key, data, at: Date.now() })
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setSettled({
          key,
          error: cause instanceof Error ? cause : new Error(String(cause)),
          at: Date.now(),
        })
      })

    return () => controller.abort()
  }, [path, key])

  const reload = React.useCallback(() => setNonce((n) => n + 1), [])

  const isCurrent = settled.key === key

  return {
    data: isCurrent ? settled.data : undefined,
    error: isCurrent ? settled.error : undefined,
    isLoading: !isCurrent,
    updatedAt: isCurrent ? settled.at : undefined,
    reload,
  }
}
