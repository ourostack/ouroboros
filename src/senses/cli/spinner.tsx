import React, { useState } from "react"
import { Text, Box } from "ink"

/**
 * Enhanced spinner with ouroboros/snake-themed animation.
 *
 * Features:
 * - Snake-themed animation frames (serpent eating its own tail)
 * - Elapsed time display
 * - Color interpolation: normal -> amber (>15s) -> red (>45s)
 * - Output token counter during streaming
 * - Phrase rotation (driven externally via props)
 * - Reduced-motion: static text, no animation
 */

// Ouroboros brand palette
const OURO_GREEN = "#2ecc40"
const COLOR_AMBER = "#f39c12"
const COLOR_RED = "#e74c3c"

// Ouroboros snake-themed spinner frames
// The serpent cycles through eating its own tail
const SNAKE_FRAMES = [
  "\u{1F40D}",   // snake emoji
  "\u25E0",      // upper half circle
  "\u25D4",      // circle with upper right quadrant
  "\u25D1",      // circle with right half
  "\u25D5",      // circle with all but upper left quadrant
  "\u25E1",      // lower half circle
  "\u25CB",      // white circle (tail swallowed)
  "\u25CF",      // black circle (digesting)
]

// Static indicator for reduced-motion
const STATIC_INDICATOR = "\u2022" // bullet

interface EnhancedSpinnerProps {
  /** Elapsed seconds for current operation */
  readonly elapsedSeconds: number
  /** Current phrase to display */
  readonly phrase: string
  /** Output tokens generated (shown during streaming) */
  readonly outputTokens?: number
  /** If true, use static indicator instead of animation */
  readonly reducedMotion?: boolean
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h${m}m`
  if (m > 0) return `${m}m${s}s`
  return `${s}s`
}

function stallColor(seconds: number): string {
  if (seconds >= 45) return COLOR_RED
  if (seconds >= 15) return COLOR_AMBER
  return OURO_GREEN
}

export function EnhancedSpinner({
  elapsedSeconds,
  phrase,
  outputTokens,
  reducedMotion,
}: EnhancedSpinnerProps): React.ReactElement {
  const [frame, setFrame] = useState(0)

  // Animate spinner (unless reduced-motion)
  React.useEffect(() => {
    if (reducedMotion) return
    const iv = setInterval(() => {
      setFrame(f => (f + 1) % SNAKE_FRAMES.length)
    }, 120)
    return () => clearInterval(iv)
  }, [reducedMotion])

  const color = stallColor(elapsedSeconds)
  const timeStr = formatTime(elapsedSeconds)
  const indicator = reducedMotion ? STATIC_INDICATOR : SNAKE_FRAMES[frame % SNAKE_FRAMES.length]

  return (
    <Box>
      <Text color={color}>{indicator} </Text>
      <Text color={color}>{phrase}</Text>
      <Text dimColor>{` ${timeStr}`}</Text>
      {outputTokens !== undefined ? (
        <Text dimColor>{` ${outputTokens} tok`}</Text>
      ) : null}
    </Box>
  )
}
