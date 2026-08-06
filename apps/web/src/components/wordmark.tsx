import { cn } from "@workspace/ui/lib/utils"

/**
 * The app's name, one component so the signed-out gate and the signed-in shell
 * can't drift. `size="lg"` is the standalone-screen setting, where the
 * wordmark is the only thing on the page and has to carry it.
 */
export function Wordmark({
  size = "sm",
  className,
}: {
  size?: "sm" | "lg"
  className?: string
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      {/* Bullet only — never a semantic colour, which would read as a liveness
          lamp the app doesn't actually verify. */}
      <span
        aria-hidden
        className={cn(
          "rounded-full bg-muted-foreground/60",
          size === "lg" ? "size-2" : "size-1.5"
        )}
      />
      <span
        className={cn(
          "font-heading font-medium tracking-tight",
          size === "lg" ? "text-base" : "text-sm"
        )}
      >
        indmoney
        <span className="px-px text-muted-foreground">·</span>
        watcher
      </span>
    </span>
  )
}
