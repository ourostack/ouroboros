import { execSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"

/**
 * Forensic data captured at SIGTERM/SIGINT time so we can identify *who*
 * killed the daemon. process.ppid is set to 1 (init) for detached processes,
 * so on its own it's not actionable. We pair it with a `ps`-based snapshot
 * of all node and ouro processes running at the moment of death — that's
 * usually enough to fingerprint the killer (a vitest worker, a sibling
 * daemon's killOrphanProcesses sweep, a manual `kill`, etc.).
 */
export interface DaemonDeathForensics {
  /** PID of the parent at the time of death (1 if reparented to init). */
  parentPid: number | null
  /** Comm/argv of the parent process if we could fetch it. */
  parentCommand: string | null
  /** Snapshot of all node + ouro processes alive at death time, one per line. */
  processSnapshot: string | null
  /** Human-readable hint about the most likely killer, derived from the snapshot. */
  killerHint: string | null
}

export interface DaemonTombstone {
  reason: string
  message: string
  stack: string | null
  timestamp: string
  pid: number
  uptimeSeconds: number
  recentCrashes: string[]
  forensics?: DaemonDeathForensics
}

/** Maximum number of historical crash timestamps to retain in the tombstone. */
export const RECENT_CRASHES_MAX = 100

let _tombstonePath: string | null = null

export function getTombstonePath(): string {
  if (!_tombstonePath) {
    _tombstonePath = path.join(os.homedir(), ".ouro-cli", "daemon-death.json")
  }
  return _tombstonePath
}

/** Overrides the tombstone path for testing. Pass null to reset. */
export function setTombstonePath(p: string | null): void {
  _tombstonePath = p
}

export interface CaptureForensicsDeps {
  ppid: () => number
  runPs: (args: string[]) => string | null
}

/* v8 ignore start -- shells out to ps; covered via injected runPs in unit tests @preserve */
function defaultRunPs(args: string[]): string | null {
  try {
    return execSync(`ps ${args.join(" ")}`, { encoding: "utf-8", timeout: 2000 })
  } catch {
    return null
  }
}
/* v8 ignore stop */

const DEFAULT_FORENSICS_DEPS: CaptureForensicsDeps = {
  /* v8 ignore next -- defensive: process.ppid always exists in node @preserve */
  ppid: () => (typeof process !== "undefined" && typeof process.ppid === "number" ? process.ppid : 0),
  runPs: defaultRunPs,
}

/**
 * Capture forensic data about who is likely to have killed the daemon.
 * Synchronous and best-effort: never throws, always returns a structured
 * record (with nulls if anything failed). Called from inside SIGTERM/SIGINT
 * handlers, so it must be fast and have no async dependencies.
 */
export function captureDeathForensics(deps: CaptureForensicsDeps = DEFAULT_FORENSICS_DEPS): DaemonDeathForensics {
  const parentPid = (() => {
    try {
      const p = deps.ppid()
      return typeof p === "number" && p > 0 ? p : null
    } catch {
      return null
    }
  })()

  let parentCommand: string | null = null
  if (parentPid !== null) {
    const psParent = deps.runPs(["-p", String(parentPid), "-o", "command="])
    if (psParent !== null) {
      const trimmed = psParent.trim()
      parentCommand = trimmed.length > 0 ? trimmed : null
    }
  }

  const processSnapshot = (() => {
    const psAll = deps.runPs(["-eo", "pid,ppid,command"])
    if (psAll === null) return null
    const lines = psAll.split("\n")
    // Filter for relevant processes only — node, vitest, ouro, kill commands.
    // Keeps the snapshot small and human-scannable.
    const relevant = lines.filter((line) => {
      const lower = line.toLowerCase()
      return (
        lower.includes("node")
        || lower.includes("vitest")
        || lower.includes("ouro")
        || lower.includes("/kill ")
        || lower.includes("pkill")
        || lower.includes("killall")
      )
    })
    if (relevant.length === 0) return null
    return relevant.join("\n")
  })()

  const killerHint = deriveKillerHint(parentCommand, processSnapshot)

  return { parentPid, parentCommand, processSnapshot, killerHint }
}

function deriveKillerHint(parentCommand: string | null, snapshot: string | null): string | null {
  if (parentCommand !== null && parentCommand.toLowerCase().includes("launchd")) {
    return "process was reparented to launchd — likely killed by launchctl bootout, KeepAlive thrash, or memory pressure"
  }
  if (snapshot !== null) {
    const lower = snapshot.toLowerCase()
    if (lower.includes("vitest")) {
      return "vitest worker is running — possible test cleanup killing detached processes"
    }
    if (lower.includes("pkill") || lower.includes("killall")) {
      return "saw pkill/killall in process list — explicit kill command"
    }
  }
  return null
}

export function writeDaemonTombstone(
  reason: string,
  error?: Error,
  forensicsDeps?: CaptureForensicsDeps,
): void {
  const now = new Date().toISOString()
  const filePath = getTombstonePath()

  // Read existing recentCrashes from previous tombstone (best-effort)
  let existingCrashes: string[] = []
  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    const existing = JSON.parse(raw) as Record<string, unknown>
    if (Array.isArray(existing.recentCrashes)) {
      existingCrashes = existing.recentCrashes.filter(
        (entry: unknown): entry is string => typeof entry === "string"
      )
    }
  } catch {
    // No existing tombstone or unreadable — start fresh
  }

  // Append the new crash and cap at the most recent RECENT_CRASHES_MAX entries
  // so the tombstone doesn't grow without bound (we saw it hit 12,265 entries
  // after a March 31 crash-restart thrash loop).
  const recentCrashes = [...existingCrashes, now].slice(-RECENT_CRASHES_MAX)

  // Forensics: only meaningful for signal-driven deaths (sigterm/sigint).
  // For uncaughtException etc. we skip the snapshot to keep tombstone writes
  // fast on the unhappy path.
  const shouldCaptureForensics = reason === "sigterm" || reason === "sigint"
  const forensics = shouldCaptureForensics
    ? captureDeathForensics(forensicsDeps)
    : undefined

  const tombstone: DaemonTombstone = {
    reason,
    message: error?.message ?? reason,
    stack: error?.stack ?? null,
    timestamp: now,
    pid: process.pid,
    uptimeSeconds: Math.floor(process.uptime()),
    recentCrashes,
    ...(forensics ? { forensics } : {}),
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(tombstone, null, 2) + "\n", "utf-8")
  } catch {
    // Best-effort: if we can't write, we're already dying.
  }

  emitNervesEvent({
    level: "error",
    component: "daemon",
    event: "daemon.tombstone_written",
    message: `daemon tombstone written: ${reason}`,
    meta: {
      reason,
      errorMessage: error?.message ?? null,
      filePath,
      parentPid: forensics?.parentPid ?? null,
      killerHint: forensics?.killerHint ?? null,
    },
  })
}

export function readDaemonTombstone(): DaemonTombstone | null {
  const filePath = getTombstonePath()
  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    const parsed = JSON.parse(raw) as Record<string, unknown>

    if (typeof parsed.reason !== "string" || typeof parsed.timestamp !== "string") {
      return null
    }

    emitNervesEvent({
      component: "daemon",
      event: "daemon.tombstone_read",
      message: "read daemon tombstone",
      meta: { filePath },
    })

    const forensics = parseForensics(parsed.forensics)

    return {
      reason: parsed.reason,
      message: typeof parsed.message === "string" ? parsed.message : String(parsed.reason),
      stack: typeof parsed.stack === "string" ? parsed.stack : null,
      timestamp: parsed.timestamp,
      pid: typeof parsed.pid === "number" ? parsed.pid : 0,
      uptimeSeconds: typeof parsed.uptimeSeconds === "number" ? parsed.uptimeSeconds : 0,
      recentCrashes: Array.isArray(parsed.recentCrashes)
        ? (parsed.recentCrashes as unknown[]).filter((e): e is string => typeof e === "string")
        : [],
      ...(forensics ? { forensics } : {}),
    }
  } catch {
    return null
  }
}

function parseForensics(value: unknown): DaemonDeathForensics | null {
  if (value === null || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  return {
    parentPid: typeof v.parentPid === "number" ? v.parentPid : null,
    parentCommand: typeof v.parentCommand === "string" ? v.parentCommand : null,
    processSnapshot: typeof v.processSnapshot === "string" ? v.processSnapshot : null,
    killerHint: typeof v.killerHint === "string" ? v.killerHint : null,
  }
}
