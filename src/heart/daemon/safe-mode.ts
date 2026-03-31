import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"

export const SAFE_MODE_OVERRIDE_FILENAME = "safe-mode-override.json"

/** 3+ crashes within this window triggers safe mode */
const CRASH_WINDOW_MS = 5 * 60 * 1000 // 5 minutes
const CRASH_THRESHOLD = 3

export interface SafeModeDetectionResult {
  active: boolean
  reason: string
  enteredAt: string
}

export interface DetectSafeModeOptions {
  now?: () => number
  devMode?: boolean
}

/**
 * Reads crash history from the tombstone file and determines if safe mode should be active.
 * Returns active if 3+ crashes occurred within 5 minutes.
 *
 * Safe mode is bypassed when:
 * - devMode is true
 * - A safe-mode override file exists (written by `ouro up --force`)
 */
export function detectSafeMode(
  tombstonePath: string,
  options?: DetectSafeModeOptions,
): SafeModeDetectionResult {
  const inactive: SafeModeDetectionResult = { active: false, reason: "", enteredAt: "" }

  // Dev mode: never enter safe mode
  if (options?.devMode) {
    return inactive
  }

  // Check for override file (--force)
  const overridePath = path.join(path.dirname(tombstonePath), SAFE_MODE_OVERRIDE_FILENAME)
  try {
    if (fs.existsSync(overridePath)) {
      return inactive
    }
  } catch {
    // Best-effort check
  }

  // Read tombstone
  let parsed: Record<string, unknown>
  try {
    const raw = fs.readFileSync(tombstonePath, "utf-8")
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return inactive
  }

  // Extract recentCrashes
  if (!Array.isArray(parsed.recentCrashes)) {
    return inactive
  }

  const nowMs = options?.now ? options.now() : Date.now()
  const windowStart = nowMs - CRASH_WINDOW_MS

  // Filter to valid string timestamps within the crash window
  const recentInWindow = (parsed.recentCrashes as unknown[]).filter((entry) => {
    if (typeof entry !== "string") return false
    const ts = new Date(entry).getTime()
    if (isNaN(ts)) return false
    return ts >= windowStart
  })

  if (recentInWindow.length < CRASH_THRESHOLD) {
    return inactive
  }

  const result: SafeModeDetectionResult = {
    active: true,
    reason: `crash loop detected: ${recentInWindow.length} crashes in last 5 minutes`,
    enteredAt: new Date(nowMs).toISOString(),
  }

  emitNervesEvent({
    level: "error",
    component: "daemon",
    event: "daemon.safe_mode_entered",
    message: result.reason,
    meta: {
      crashCount: recentInWindow.length,
      windowMs: CRASH_WINDOW_MS,
      tombstonePath,
    },
  })

  return result
}

/**
 * Prunes crash entries older than 5 minutes from the tombstone's recentCrashes.
 * Also removes the safe-mode override file if present.
 * Called after successful startup (uptime > stability threshold).
 */
export function pruneOldCrashes(
  tombstonePath: string,
  options?: { now?: () => number },
): void {
  // Remove override file
  const overridePath = path.join(path.dirname(tombstonePath), SAFE_MODE_OVERRIDE_FILENAME)
  try {
    if (fs.existsSync(overridePath)) {
      fs.unlinkSync(overridePath)
    }
  } catch {
    // Best-effort
  }

  // Read existing tombstone
  let parsed: Record<string, unknown>
  try {
    const raw = fs.readFileSync(tombstonePath, "utf-8")
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return
  }

  if (!Array.isArray(parsed.recentCrashes)) {
    return
  }

  const nowMs = options?.now ? options.now() : Date.now()
  const windowStart = nowMs - CRASH_WINDOW_MS

  // Keep only entries within the window
  const pruned = (parsed.recentCrashes as unknown[]).filter((entry) => {
    if (typeof entry !== "string") return false
    const ts = new Date(entry).getTime()
    if (isNaN(ts)) return false
    return ts >= windowStart
  })

  parsed.recentCrashes = pruned

  try {
    fs.writeFileSync(tombstonePath, JSON.stringify(parsed, null, 2) + "\n", "utf-8")
  } catch {
    // Best-effort
  }
}
