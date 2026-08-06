import { Button } from "@workspace/ui/components/button"

import { useTheme } from "@/components/theme-provider"

function prefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const isDark = theme === "system" ? prefersDark() : theme === "dark"

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title="Toggle theme (d)"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="-mr-2 size-10 text-muted-foreground"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-4"
        aria-hidden
      >
        {isDark ? (
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8.2 8.2 0 1 0 10.5 10.5Z" />
        ) : (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 3v1.6M12 19.4V21M4.9 4.9l1.1 1.1M18 18l1.1 1.1M3 12h1.6M19.4 12H21M4.9 19.1 6 18M18 6l1.1-1.1" />
          </>
        )}
      </svg>
    </Button>
  )
}
