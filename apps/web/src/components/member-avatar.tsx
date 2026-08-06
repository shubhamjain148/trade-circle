import { Avatar, AvatarFallback } from "@workspace/ui/components/avatar"
import { cn } from "@workspace/ui/lib/utils"

import { avatarTone } from "@/lib/events"
import { initials } from "@/lib/format"

interface MemberAvatarProps {
  name: string
  seed?: string
  size?: "sm" | "default" | "lg"
  className?: string
}

export function MemberAvatar({
  name,
  seed,
  size = "default",
  className,
}: MemberAvatarProps) {
  return (
    <Avatar size={size} className={cn("shrink-0", className)}>
      <AvatarFallback
        className={cn(
          "font-heading text-2xs font-medium tracking-tight",
          avatarTone(seed ?? name)
        )}
      >
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  )
}
