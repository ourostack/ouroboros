import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import { eventLogPath, type AppSessionRow, type AppSessionsOptions } from "./client"
import { appSessionsStateDir, readJson } from "./store"

const HEAD_BYTES = 16384
const RECENT_MS = 7 * 86_400_000
const HANDOFF_WORDS = /successor|hand-?off|handed off|carry on from/i

/**
 * Whether an oversize session has been handed off: it is in the oversize list, and a session newer than it opens by
 * naming it in a hand-off. Only the first bytes of each recent log are read, so no large history is loaded.
 */
export function isHandedOff(agentRoot: string, row: Pick<AppSessionRow, "id" | "createdAt">, options: AppSessionsOptions = {}): boolean {
  const flagged = readJson<{ sessions?: Record<string, unknown> }>(path.join(appSessionsStateDir(agentRoot), "oversize.json"), {}).sessions ?? {}
  if (!flagged[row.id]) return false
  const root = path.dirname(path.dirname(eventLogPath(row.id, options)))
  const born = Date.parse(String(row.createdAt))
  let names: string[]
  try {
    names = fs.readdirSync(root)
  } catch {
    return false
  }
  for (const name of names) {
    if (name === row.id) continue
    try {
      const file = path.join(root, name, "events.jsonl")
      const stat = fs.statSync(file)
      if (Date.now() - stat.mtimeMs > RECENT_MS || stat.birthtimeMs <= born) continue
      const fd = fs.openSync(file, "r")
      const buf = Buffer.alloc(HEAD_BYTES)
      const len = fs.readSync(fd, buf, 0, buf.length, 0)
      fs.closeSync(fd)
      const head = buf.toString("utf8", 0, len)
      if ((head.includes(row.id) || head.includes(row.id.slice(0, 8))) && HANDOFF_WORDS.test(head)) {
        emitNervesEvent({ component: "senses", event: "senses.app_sessions_handoff_found", message: "found the successor that a session was handed off to", meta: { session: row.id, successor: name } })
        return true
      }
    } catch {
      continue
    }
  }
  return false
}
