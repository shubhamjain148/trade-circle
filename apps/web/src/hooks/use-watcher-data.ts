import { feedPath, membersPath } from "@/lib/api"
import type { FeedEvent, Member } from "@/lib/types"
import { useResource } from "@/hooks/use-resource"

export function useMembers() {
  return useResource<Member[]>(membersPath)
}

/** Group feed when accountId is omitted, individual feed when present. */
export function useFeed(accountId?: string) {
  return useResource<FeedEvent[]>(feedPath(accountId))
}
