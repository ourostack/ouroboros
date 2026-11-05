import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"

/** One upstream Anthropic API key. The label is the file name without `.key`; it is safe to log, the key is not. */
export interface GatewayUpstreamKey {
  label: string
  key: string
}

export interface GatewayKeys {
  masterKey: string
  /** Upstream keys in the order the gateway uses them: file names sorted. */
  upstream: GatewayUpstreamKey[]
}

/** `exhausted` maps a key label to the ISO time until which the gateway skips that key. */
export interface GatewayState {
  exhausted: Record<string, string>
}

const MASTER_KEY_FILE = "master.key"
const KEY_SUFFIX = ".key"

function readTrimmed(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8").trim()
  } catch {
    return ""
  }
}

/**
 * Reads the master key and the upstream keys from a directory, once. Every `*.key` file other than
 * `master.key` is an upstream key; the gateway drains them in file-name order.
 */
export function loadGatewayKeys(keysDir: string): GatewayKeys {
  let entries: string[]
  try {
    entries = fs.readdirSync(keysDir)
  } catch (error) {
    /* v8 ignore next -- defensive: fs always throws Error instances @preserve */
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`gateway: cannot read keys directory ${keysDir}: ${reason}`)
  }
  const masterKey = readTrimmed(path.join(keysDir, MASTER_KEY_FILE))
  if (!masterKey) throw new Error(`gateway: ${path.join(keysDir, MASTER_KEY_FILE)} is missing or empty`)
  const upstream: GatewayUpstreamKey[] = []
  for (const name of entries.filter((entry) => entry.endsWith(KEY_SUFFIX) && entry !== MASTER_KEY_FILE).sort()) {
    const key = readTrimmed(path.join(keysDir, name))
    if (!key) throw new Error(`gateway: upstream key file ${path.join(keysDir, name)} is empty`)
    upstream.push({ label: name.slice(0, -KEY_SUFFIX.length), key })
  }
  if (upstream.length === 0) throw new Error(`gateway: no upstream *.key files in ${keysDir} (besides master.key)`)
  emitNervesEvent({
    component: "gateway",
    event: "gateway.keys_loaded",
    message: "credit gateway keys loaded",
    meta: { keysDir, labels: upstream.map((entry) => entry.label) },
  })
  return { masterKey, upstream }
}

/** Loads the skip list. A missing or corrupt file starts empty; entries that are not valid times are dropped. */
export function loadGatewayState(statePath: string): GatewayState {
  const exhausted: Record<string, string> = {}
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, "utf8"))
  } catch {
    return { exhausted }
  }
  const raw = parsed && typeof parsed === "object" ? (parsed as { exhausted?: unknown }).exhausted : undefined
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [label, until] of Object.entries(raw)) {
      if (typeof until === "string" && Number.isFinite(Date.parse(until))) exhausted[label] = until
    }
  }
  return { exhausted }
}

/** Writes the skip list with mode 0600, through a temporary file so a crash never leaves half a file. */
export function saveGatewayState(statePath: string, state: GatewayState): void {
  const tmpPath = `${statePath}.${process.pid}.tmp`
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(tmpPath, 0o600)
  fs.renameSync(tmpPath, statePath)
  emitNervesEvent({
    component: "gateway",
    event: "gateway.state_saved",
    message: "credit gateway state saved",
    meta: { statePath, exhausted: Object.keys(state.exhausted) },
  })
}
