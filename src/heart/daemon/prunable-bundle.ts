import { existsSync, lstatSync, readdirSync, realpathSync } from "fs"
import { basename, dirname, join } from "path"

import { emitNervesEvent } from "../../nerves/runtime"

export interface PrunableBundleTarget {
  agentName: string
  bundleDir: string
  logsDir: string
}

export interface PrunableBundleFs {
  existsSync: (filePath: string) => boolean
  lstatSync: (filePath: string) => { isDirectory: () => boolean; isSymbolicLink: () => boolean }
  readdirSync: (dirPath: string) => string[]
  realpathSync: (filePath: string) => string
}

export interface PrunableLogsFs {
  lstatSync: (filePath: string) => {
    isDirectory: () => boolean
    isFile: () => boolean
    isSymbolicLink: () => boolean
  }
  readdirSync: (dirPath: string) => string[]
  realpathSync: (filePath: string) => string
}

export interface PrunableLogsInspection {
  entries: string[]
  logsReal: string
}

export interface PrunableBundleOptions {
  bundlesRoot: string
  fs?: PrunableBundleFs
}

export interface ResolvePrunableBundleOptions extends PrunableBundleOptions {
  agentName: string
}

const defaultFs: PrunableBundleFs = { existsSync, lstatSync, readdirSync, realpathSync }
const defaultLogsFs: PrunableLogsFs = { lstatSync, readdirSync, realpathSync }
const SAFE_AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function isSafePrunableAgentName(agentName: string): boolean {
  return SAFE_AGENT_NAME.test(agentName) && agentName !== "." && agentName !== ".."
}

function invalidTarget(agentName: string, reason: string): Error {
  return new Error(`agent ${JSON.stringify(agentName)} is not a prunable agent bundle: ${reason}`)
}

export function resolvePrunableAgentBundle(options: ResolvePrunableBundleOptions): PrunableBundleTarget {
  const io = options.fs ?? defaultFs
  const agentName = options.agentName
  if (!isSafePrunableAgentName(agentName)) {
    throw invalidTarget(agentName, "name must match [A-Za-z0-9][A-Za-z0-9._-]* and be at most 128 characters")
  }

  let rootReal: string
  try {
    rootReal = io.realpathSync(options.bundlesRoot)
  } catch {
    throw invalidTarget(agentName, "bundles root does not exist")
  }

  const bundleDir = join(options.bundlesRoot, `${agentName}.ouro`)
  let bundleStat: ReturnType<PrunableBundleFs["lstatSync"]>
  try {
    bundleStat = io.lstatSync(bundleDir)
  } catch {
    throw invalidTarget(agentName, "bundle does not exist")
  }
  if (bundleStat.isSymbolicLink() || !bundleStat.isDirectory()) {
    throw invalidTarget(agentName, "bundle must be a real directory, not a symlink or other entry")
  }

  let bundleReal: string
  try {
    bundleReal = io.realpathSync(bundleDir)
  } catch {
    throw invalidTarget(agentName, "bundle cannot be resolved")
  }
  if (dirname(bundleReal) !== rootReal || basename(bundleReal) !== `${agentName}.ouro`) {
    throw invalidTarget(agentName, "bundle must be a direct child of the bundles root")
  }

  if (!io.existsSync(join(bundleReal, "agent.json"))) {
    throw invalidTarget(agentName, "agent.json is not present")
  }

  const target = { agentName, bundleDir: bundleReal, logsDir: join(bundleReal, "state", "daemon", "logs") }
  emitNervesEvent({
    component: "nerves",
    event: "nerves.prunable_bundle_resolved",
    message: "resolved prunable agent bundle",
    meta: { agentName, bundleDir: bundleReal },
  })
  return target
}

export function listPrunableAgentBundles(options: PrunableBundleOptions): string[] {
  const io = options.fs ?? defaultFs
  let entries: string[]
  try {
    entries = io.readdirSync(options.bundlesRoot)
  } catch {
    entries = []
  }

  const agents: string[] = []
  for (const entry of entries) {
    if (!entry.endsWith(".ouro")) continue
    const agentName = entry.slice(0, -".ouro".length)
    if (!isSafePrunableAgentName(agentName)) continue
    try {
      resolvePrunableAgentBundle({ ...options, agentName })
      agents.push(agentName)
    } catch {
      // Invalid entries are not prune candidates.
    }
  }
  agents.sort((left, right) => left.localeCompare(right))
  emitNervesEvent({
    component: "nerves",
    event: "nerves.prunable_bundles_listed",
    message: "listed prunable agent bundles",
    meta: { bundlesRoot: options.bundlesRoot, count: agents.length },
  })
  return agents
}

export function isManagedDaemonLogEntry(name: string): boolean {
  const activeNdjson = name.endsWith(".ndjson") && !/\.\d+\.ndjson$/.test(name)
  const activeLog = name.endsWith(".log") && !/\.\d+\.log$/.test(name)
  return activeNdjson || activeLog ||
    /\.\d+\.ndjson(?:\.gz)?$/.test(name) ||
    /\.log\.\d+(?:\.gz)?$/.test(name) ||
    /\.\d+\.log$/.test(name)
}

export function validatePrunableLogEntry(
  filePath: string,
  logsReal: string,
  io: PrunableLogsFs = defaultLogsFs,
): void {
  const stat = io.lstatSync(filePath)
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`daemon log entry must be a regular non-symlink file: ${filePath}`)
  }
  /* v8 ignore next 3 -- defensive: a real direct-child file cannot escape after lstat absent a same-user path swap @preserve */
  if (dirname(io.realpathSync(filePath)) !== logsReal) {
    throw new Error(`daemon log entry escapes the canonical logs directory: ${filePath}`)
  }
}

export function validatePrunableLogsDirectory(
  logsDir: string,
  expectedCanonicalLogsDir?: string,
  io: PrunableLogsFs = defaultLogsFs,
): PrunableLogsInspection {
  const stat = io.lstatSync(logsDir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`daemon logs directory must be a real directory: ${logsDir}`)
  }
  const logsReal = io.realpathSync(logsDir)
  if (expectedCanonicalLogsDir && logsReal !== expectedCanonicalLogsDir) {
    throw new Error(`daemon logs directory must remain inside its canonical agent bundle: ${logsDir}`)
  }
  const entries = io.readdirSync(logsDir)
  for (const name of entries) {
    if (isManagedDaemonLogEntry(name)) validatePrunableLogEntry(join(logsDir, name), logsReal, io)
  }
  return { entries, logsReal }
}

export function validatePrunableLogsTarget(
  target: PrunableBundleTarget,
  io: PrunableLogsFs = defaultLogsFs,
): PrunableLogsInspection {
  return validatePrunableLogsDirectory(target.logsDir, target.logsDir, io)
}
