import * as React from "react"

import { AccountMenu } from "@/components/account-menu"
import { AppShell } from "@/components/app-shell"
import { ConnectionNotice } from "@/components/connection-notice"
import { MemberSwitcher } from "@/components/member-switcher"
import { useSession } from "@/components/session-provider"
import { feedHref } from "@/hooks/use-feed-route"
import { navigate, STATS_HREF, useRoute } from "@/hooks/use-route"
import { useMembers } from "@/hooks/use-watcher-data"
import { ApiError } from "@/lib/api"
import { GROUP_VIEW, type Account, type FeedView, type Member } from "@/lib/types"
import { BootView } from "@/views/boot-view"
import { GroupChatView } from "@/views/group-chat-view"
import { GroupStatsView } from "@/views/group-stats-view"
import { JoinView } from "@/views/join-view"
import { MemberFeedView } from "@/views/member-feed-view"
import { SettingsView } from "@/views/settings-view"
import { SignedOutView } from "@/views/signed-out-view"
import { UnreachableView } from "@/views/unreachable-view"

export function App() {
  const route = useRoute()
  const { state, refresh } = useSession()

  // Nothing renders until /api/me answers. A flash of the signed-out gate
  // followed by the feed is the one thing the gate must never do.
  if (state.status === "booting") {
    return <BootView />
  }

  if (state.status === "unreachable") {
    return <UnreachableView onRetry={() => void refresh()} />
  }

  // Join is reachable from either side of the gate: it's how you get through
  // it, and re-opening a spent link while signed in should still say hello.
  if (route.kind === "join") {
    return <JoinView token={route.token} />
  }

  if (state.status === "signed-out") {
    return <SignedOutView />
  }

  const { member, account } = state

  if (route.kind === "settings") {
    return (
      <AppShell account={<AccountMenu member={member} account={account} />}>
        <SettingsView
          member={member}
          account={account}
          connected={route.connected}
          connectError={route.connectError}
        />
      </AppShell>
    )
  }

  // Stats is a peer of the feeds, not a screen of its own: same shell, same
  // switcher, so the tab row never disappears under someone mid-scan.
  if (route.kind === "stats") {
    return (
      <FeedScreen view={GROUP_VIEW} stats member={member} account={account} />
    )
  }

  return <FeedScreen view={route.view} member={member} account={account} />
}

function FeedScreen({
  view,
  stats = false,
  member,
  account,
}: {
  view: FeedView
  stats?: boolean
  member: Member
  account: Account | null
}) {
  const { refresh } = useSession()
  const { data: members, isLoading: isLoadingMembers, error } = useMembers()

  // The chat is a viewport-tall column with its own scroller; the member feeds
  // are ordinary documents. The shell has to know which one it is holding.
  const chat = !stats && view.kind === "group"

  // A session that expires while the tab is open shows up as a 401 on the
  // next fetch. Send it back through /api/me rather than letting the feed
  // report "can't reach the watcher" for what is really a sign-out.
  React.useEffect(() => {
    if (error instanceof ApiError && error.status === 401) void refresh()
  }, [error, refresh])

  return (
    <AppShell
      fill={chat}
      account={<AccountMenu member={member} account={account} />}
      switcher={
        <MemberSwitcher
          members={members}
          isLoading={isLoadingMembers}
          view={view}
          onViewChange={(next) => navigate(feedHref(next))}
          isStats={stats}
          onStats={() => navigate(STATS_HREF)}
        />
      }
    >
      <div
        className={
          chat ? "flex min-h-0 flex-1 flex-col gap-4" : "flex flex-col gap-5"
        }
      >
        <ConnectionNotice account={account} />

        {stats ? (
          <GroupStatsView />
        ) : view.kind === "group" ? (
          <GroupChatView members={members} member={member} />
        ) : (
          <MemberFeedView
            key={view.memberId}
            memberId={view.memberId}
            member={members?.find((m) => m.id === view.memberId)}
          />
        )}
      </div>
    </AppShell>
  )
}
