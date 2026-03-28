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
  const tombstone: DaemonTombstone = {
    reason,
    message: error?.message ?? reason,
    stack: error?.stack ?? null,
    timestamp: new Date().toISOString(),
    pid: process.pid,
    uptimeSeconds: Math.floor(process.uptime()),
  }

  const filePath = getTombstonePath()

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
    }
  } catch {
    return null
  }
}
