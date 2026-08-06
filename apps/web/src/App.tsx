import { AppShell } from "@/components/app-shell"
import { MemberSwitcher } from "@/components/member-switcher"
import { useFeedRoute } from "@/hooks/use-feed-route"
import { useMembers } from "@/hooks/use-watcher-data"
import { GroupFeedView } from "@/views/group-feed-view"
import { MemberFeedView } from "@/views/member-feed-view"

export function App() {
  const [view, setView] = useFeedRoute()
  const { data: members, isLoading: isLoadingMembers } = useMembers()

  return (
    <AppShell
      switcher={
        <MemberSwitcher
          members={members}
          isLoading={isLoadingMembers}
          view={view}
          onViewChange={setView}
        />
      }
    >
      {view.kind === "group" ? (
        <GroupFeedView members={members} />
      ) : (
        <MemberFeedView
          key={view.memberId}
          memberId={view.memberId}
          member={members?.find((member) => member.id === view.memberId)}
        />
      )}
    </AppShell>
  )
}
