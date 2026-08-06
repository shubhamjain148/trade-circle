import { useResource } from "@/hooks/use-resource"
import { groupStatsPath } from "@/lib/api"
import type { GroupStats } from "@/lib/types"

/**
 * The whole stats screen in one read. Deliberately not composed from the
 * per-member holdings the panel already fetches: overlap is a fact about the
 * group, and computing it client-side would mean asking for everyone's
 * portfolio and re-deriving the visibility rule in the browser.
 */
export function useGroupStats() {
  return useResource<GroupStats>(groupStatsPath)
}
