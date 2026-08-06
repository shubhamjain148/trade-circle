import { Tabs, TabsList, TabsTrigger } from "@workspace/ui/components/tabs"
import { Skeleton } from "@workspace/ui/components/skeleton"

import { ANONYMOUS_NAME } from "@/lib/account"
import type { FeedView, Member } from "@/lib/types"

const GROUP_VALUE = "group"

/**
 * The hit box is a thumb (44px tall), the type stays terminal-small. These are
 * the only navigation in the product and they get tapped one-handed at night.
 */
const TRIGGER = "flex-none px-2.5 text-[0.8125rem]"

interface MemberSwitcherProps {
  members: Member[] | undefined
  isLoading: boolean
  view: FeedView
  onViewChange: (view: FeedView) => void
}

/**
 * Segmented control over "Group" plus one tab per member. Reads/writes a
 * FeedView value, so a router can drive it later without touching this file.
 */
export function MemberSwitcher({
  members,
  isLoading,
  view,
  onViewChange,
}: MemberSwitcherProps) {
  if (isLoading && !members) {
    return (
      <div className="flex h-11 items-center gap-1.5">
        <Skeleton className="h-7 w-16 rounded-md" />
        <Skeleton className="h-7 w-20 rounded-md" />
        <Skeleton className="h-7 w-20 rounded-md" />
      </div>
    )
  }

  const value = view.kind === "group" ? GROUP_VALUE : view.memberId

  // A deep link (or a failed members fetch) can put us on a member the list
  // doesn't contain. Keep a tab for it so the control still shows where we are.
  const roster = members ?? []
  const tabs =
    view.kind === "member" && !roster.some((m) => m.id === view.memberId)
      ? [...roster, { id: view.memberId, name: "Member", visibility: "named" } satisfies Member]
      : roster

  return (
    <Tabs
      value={value}
      onValueChange={(next) => {
        const nextValue = String(next)
        onViewChange(
          nextValue === GROUP_VALUE
            ? { kind: "group" }
            : { kind: "member", memberId: nextValue }
        )
      }}
    >
      <TabsList
        variant="line"
        /* justify-start, not the variant's justify-center: once the roster
           overflows, centring pushes "Group" off the left edge into space the
           scroller can't reach. */
        className="-mx-1 max-w-full flex-nowrap justify-start gap-0.5 overflow-x-auto px-1 [scrollbar-width:none] group-data-horizontal/tabs:h-11 [&::-webkit-scrollbar]:hidden"
      >
        <TabsTrigger value={GROUP_VALUE} className={TRIGGER}>
          Group
        </TabsTrigger>
        {tabs.map((member) => (
          <TabsTrigger key={member.id} value={member.id} className={TRIGGER}>
            {member.visibility === "anonymous" ? ANONYMOUS_NAME : member.name}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
