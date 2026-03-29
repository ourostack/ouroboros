import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"

export interface DaemonTombstone {
  reason: string
  message: string
  stack: string | null
  timestamp: string
  pid: number
  uptimeSeconds: number
  recentCrashes: string[]
}

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

export function writeDaemonTombstone(reason: string, error?: Error): void {
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

  const tombstone: DaemonTombstone = {
    reason,
    message: error?.message ?? reason,
    stack: error?.stack ?? null,
    timestamp: now,
    pid: process.pid,
    uptimeSeconds: Math.floor(process.uptime()),
    recentCrashes: [...existingCrashes, now],
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
    meta: { reason, errorMessage: error?.message ?? null, filePath },
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
    }
  } catch {
    return null
  }
}
