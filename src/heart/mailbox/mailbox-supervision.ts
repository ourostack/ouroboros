import * as fs from "node:fs"
import * as path from "node:path"
import {
  buildShepherdSupervisionView,
  isShepherdSupervisionSnapshot,
  SHEPHERD_OBSERVATION_FILE,
  SHEPHERD_OBSERVATION_MAX_BYTES,
  type ShepherdSupervisionView,
} from "../shepherd/supervision"

function owned(metadata: fs.Stats): void {
  if (!process.getuid || metadata.uid !== process.getuid()) throw new Error("Observation requires current-user ownership")
}
function directory(candidate: string, privateMode: boolean): boolean {
  const metadata = fs.lstatSync(candidate, { throwIfNoEntry: false })
  if (!metadata) return false
  owned(metadata)
  if (!metadata.isDirectory() || (privateMode ? (metadata.mode & 0o7777) !== 0o700 : (metadata.mode & 0o022) !== 0)) {
    throw new Error("Observation requires unlinked private directories and non-writable ancestors")
  }
  return true
}
function regular(metadata: fs.Stats): void {
  owned(metadata)
  if (!metadata.isFile() || (metadata.mode & 0o7777) !== 0o600 || metadata.nlink !== 1
    || metadata.size > SHEPHERD_OBSERVATION_MAX_BYTES) throw new Error("Observation requires a bounded private regular file")
}
function unavailable(agentName: string, nowMs: number, code: string): ShepherdSupervisionView {
  const view = buildShepherdSupervisionView({
    schemaVersion: 1, agentName, observedAt: new Date(nowMs).toISOString(),
    sourceHealth: { host: "missing", guidance: "missing", mandates: "missing", returns: "missing", custody: "missing", notices: "missing" },
    sessions: { totalCount: null, truncated: true, items: [] },
    timeline: { totalCount: null, truncated: true, items: [] },
    custody: { revision: null, bytes: null, capacity: "unknown", claims: { totalCount: null, truncated: true, items: [] } },
    sourceErrors: [{ source: "replica", code, detail: code === "observation_missing"
      ? "No Shepherd observation is available. Check that the Shepherd sense is running."
      : "The Shepherd observation could not be read safely or has an invalid schema." }],
  }, nowMs)
  view.freshness = { status: "unknown", observedAt: null, ageMs: null }
  return view
}

/** A bounded read-only replica, never an authority file or a live terminal access path. */
export function readMailboxSupervision(agentName: string, options: { agentRoot: string; nowMs?: number }): ShepherdSupervisionView {
  const nowMs = options.nowMs ?? Date.now()
  try {
    let current = path.resolve(options.agentRoot)
    if (!directory(current, false)) return unavailable(agentName, nowMs, "observation_missing")
    for (const name of ["state", "senses", "shepherd"]) {
      current = path.join(current, name)
      if (!directory(current, name === "shepherd")) return unavailable(agentName, nowMs, "observation_missing")
    }
    const file = path.join(current, SHEPHERD_OBSERVATION_FILE)
    const before = fs.lstatSync(file, { throwIfNoEntry: false })
    if (!before) return unavailable(agentName, nowMs, "observation_missing")
    regular(before)
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    let raw: string
    try {
      const opened = fs.fstatSync(fd)
      regular(opened)
      if (opened.ino !== before.ino || opened.dev !== before.dev) throw new Error("Observation changed during read")
      const buffer = Buffer.alloc(SHEPHERD_OBSERVATION_MAX_BYTES + 1)
      let size = 0
      while (size < buffer.length) {
        const received = fs.readSync(fd, buffer, size, buffer.length - size, null)
        if (!received) break
        size += received
      }
      if (size > SHEPHERD_OBSERVATION_MAX_BYTES) throw new Error("Observation exceeds read limit")
      const after = fs.fstatSync(fd)
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
        throw new Error("Observation changed during read")
      }
      raw = buffer.toString("utf8", 0, size)
    } finally { fs.closeSync(fd) }
    const snapshot: unknown = JSON.parse(raw)
    if (!isShepherdSupervisionSnapshot(snapshot) || snapshot.agentName !== agentName) throw new Error("Invalid observation identity or schema")
    return buildShepherdSupervisionView(snapshot, nowMs)
  } catch {
    // Do not echo untrusted file contents, paths or operating-system errors into the browser.
    return unavailable(agentName, nowMs, "observation_invalid")
  }
}
