import * as React from "react"

import { cn } from "@workspace/ui/lib/utils"

import { encodeQr } from "@/lib/qr"

interface QrCodeProps {
  value: string
  /** What the square *is*, for anyone who can't see it. */
  label: string
  className?: string
}

/**
 * The link as a square, so the phone flow is scan-not-type.
 *
 * Drawn as one SVG path of unit cells on a plate — no canvas, no image, no
 * request. The plate stays light in both themes on purpose: a QR inverted for
 * dark mode is legal in the spec and unreadable to a good half of the scanners
 * people actually hold, iOS Camera included. So the code keeps its polarity and
 * the *plate* does the theming — bright white against a light page, eased down
 * to a warm off-white in the dark so it reads as an object on the page rather
 * than a torch pointed at the room.
 */
export function QrCode({ value, label, className }: QrCodeProps) {
  const drawing = React.useMemo(() => {
    let matrix: boolean[][]
    try {
      matrix = encodeQr(value)
    } catch {
      // A link too long to encode is a bug, not a state worth designing: the
      // copy field beside this is the fallback, and it always works.
      return null
    }

    // The quiet zone is part of the symbol, not padding around it — a scanner
    // needs it, so it belongs inside the viewBox.
    const quiet = 3
    const span = matrix.length + quiet * 2
    const cells: string[] = []
    for (let y = 0; y < matrix.length; y++) {
      for (let x = 0; x < matrix.length; x++) {
        if (matrix[y][x]) cells.push(`M${x + quiet} ${y + quiet}h1v1h-1z`)
      }
    }
    return { span, path: cells.join("") }
  }, [value])

  if (!drawing) return null

  return (
    <svg
      viewBox={`0 0 ${drawing.span} ${drawing.span}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      className={cn(
        "size-40 rounded-md ring-1 ring-foreground/10 select-none",
        className
      )}
    >
      <rect
        width={drawing.span}
        height={drawing.span}
        className="fill-[oklch(0.99_0.004_158)] dark:fill-[oklch(0.93_0.006_158)]"
      />
      <path
        d={drawing.path}
        className="fill-[oklch(0.18_0.012_158)] dark:fill-[oklch(0.2_0.012_158)]"
      />
    </svg>
  )
}
