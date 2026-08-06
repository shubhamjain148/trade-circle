import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { cn } from "@workspace/ui/lib/utils"

import { MemberAvatar } from "@/components/member-avatar"
import { useSession } from "@/components/session-provider"
import { navigate, SETTINGS_HREF } from "@/hooks/use-route"
import { CONNECTION_COPY, connectionKey, needsAttention } from "@/lib/account"
import type { Account, Member } from "@/lib/types"

interface AccountMenuProps {
  member: Member
  account: Account | null
}

/**
 * You, in the top bar. Two destinations — there is nothing else to put here,
 * and inventing a third would be filling a menu rather than building one.
 */
export function AccountMenu({ member, account }: AccountMenuProps) {
  const { signOut } = useSession()
  const status = CONNECTION_COPY[connectionKey(account)]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${member.name} — account menu`}
        className="-mr-1 flex items-center gap-2 rounded-lg px-1 py-1 text-left transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-muted"
      >
        <span className="relative">
          <MemberAvatar name={member.name} seed={member.id} size="sm" />
          {/* A 1.5px dot, not a badge: the nudge belongs to the inline notice
              above the feed, this is only so the menu isn't the first you
              hear of it. */}
          {needsAttention(account) ? (
            <span
              aria-hidden
              className="absolute -top-px -right-px size-1.5 rounded-full bg-pos-down-dim ring-2 ring-background"
            />
          ) : null}
        </span>
        <span className="hidden max-w-28 truncate text-[0.8125rem] font-medium sm:inline">
          {member.name}
        </span>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={6} className="min-w-52">
        <div className="px-1.5 py-1.5">
          <p className="truncate text-sm font-medium">{member.name}</p>
          <p className="flex items-center gap-1.5 pt-0.5 font-mono text-3xs tracking-caps uppercase">
            <span
              aria-hidden
              className={cn("size-1 shrink-0 rounded-full", status.dot)}
            />
            <span className={status.tone}>{status.label}</span>
          </p>
        </div>

        <DropdownMenuSeparator />

        <DropdownMenuItem onClick={() => navigate(SETTINGS_HREF)}>
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void signOut()}>
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
