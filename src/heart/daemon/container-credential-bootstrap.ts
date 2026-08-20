import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {
  isRuntimeCredentialBootstrapMessage,
  persistRuntimeCredentialBootstrapMessage,
} from "../runtime-credentials"
import { emitNervesEvent } from "../../nerves/runtime"
import { loadOrCreateMachineIdentity } from "../machine-identity"

const MAX_BOOTSTRAP_BYTES = 128 * 1024

interface ContainerBootstrapEnvelope {
  schemaVersion: 1
  credentials: unknown[]
}

export interface ContainerCredentialBootstrapOptions {
  path?: string
  apply?: (message: unknown) => boolean
  persist?: (message: unknown) => Promise<boolean>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function parseEnvelope(raw: string): ContainerBootstrapEnvelope {
  const value = JSON.parse(raw) as unknown
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.credentials)) {
    throw new Error("container credential bootstrap envelope is invalid")
  }
  if (Object.keys(value).sort().join(",") !== "credentials,schemaVersion") {
    throw new Error("container credential bootstrap has unsupported fields")
  }
  return value as unknown as ContainerBootstrapEnvelope
}

function fsyncDirectory(directoryPath: string): void {
  const descriptor = fs.openSync(directoryPath, "r")
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
}

function deleteDurably(filePath: string): void {
  fs.unlinkSync(filePath)
  fsyncDirectory(path.dirname(filePath))
}

function assertSafeBootstrapFile(stat: fs.Stats, label: "bootstrap" | "consuming state"): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`container credential ${label} must be a regular file`)
  }
  if ((stat.mode & 0o077) !== 0) throw new Error("container credential bootstrap must have mode 0600")
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("container credential bootstrap must be owned by the runtime user")
  }
  if (stat.size > MAX_BOOTSTRAP_BYTES) throw new Error("container credential bootstrap is too large")
}

export function getDefaultContainerCredentialBootstrapPath(): string {
  return path.join(os.homedir(), ".ouro-cli", "container-credentials.json")
}

function optionalStat(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath)
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null
    throw error
  }
}

export async function loadContainerCredentialBootstrap(
  enabledAgents: string[],
  options: ContainerCredentialBootstrapOptions = {},
): Promise<string[]> {
  const filePath = options.path ?? getDefaultContainerCredentialBootstrapPath()
  const consumingPath = `${filePath}.consuming`
  let sourceStat = optionalStat(filePath)
  const claimedStat = optionalStat(consumingPath)
  if (sourceStat && claimedStat) {
    assertSafeBootstrapFile(sourceStat, "bootstrap")
    assertSafeBootstrapFile(claimedStat, "consuming state")
    const sourceBytes = fs.readFileSync(filePath)
    const claimedBytes = fs.readFileSync(consumingPath)
    if (!sourceBytes.equals(claimedBytes)) {
      throw new Error(
        "human-required: container credential source and claim differ; securely compare and quarantine them without printing their contents",
      )
    }
    deleteDurably(filePath)
    sourceStat = null
  }
  if (!sourceStat && !claimedStat) return []
  if (claimedStat) assertSafeBootstrapFile(claimedStat, "consuming state")
  let stat = claimedStat
  if (sourceStat) {
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error("container credential bootstrap must be a regular file")
    }
    fs.renameSync(filePath, consumingPath)
    fsyncDirectory(path.dirname(filePath))
    stat = sourceStat
  }
  /* v8 ignore next -- source/claimed absence returns above, so a stat always exists here @preserve */
  if (!stat) throw new Error("container credential bootstrap claim is unavailable")
  assertSafeBootstrapFile(stat, claimedStat ? "consuming state" : "bootstrap")

  const envelope = parseEnvelope(fs.readFileSync(consumingPath, "utf8"))
  const allowed = new Set(enabledAgents)
  const loaded = new Set<string>()
  for (const message of envelope.credentials) {
    if (!isRecord(message) || typeof message.agentName !== "string" || !allowed.has(message.agentName)) {
      throw new Error("container credential bootstrap agent is not enabled")
    }
    if (loaded.has(message.agentName)) throw new Error("container credential bootstrap contains a duplicate agent")
    if (!isRuntimeCredentialBootstrapMessage(message)) throw new Error("container credential bootstrap message is invalid")
    loaded.add(message.agentName)
  }

  const machineId = loadOrCreateMachineIdentity().machineId
  for (const message of envelope.credentials) {
    if (isRecord(message) && typeof message.machineId === "string" && message.machineId.trim() !== machineId) {
      throw new Error("container credential bootstrap machineId does not match this machine")
    }
  }

  const persist = options.persist ?? ((message: unknown) => persistRuntimeCredentialBootstrapMessage(message, {
    machineId,
  }))
  try {
    for (const message of envelope.credentials) {
      if (!await persist(message)) throw new Error("invalid bootstrap message")
    }
  } catch {
    emitNervesEvent({
      level: "error",
      component: "config/identity",
      event: "config.container_credentials_persist_error",
      message: "container credential bootstrap persistence failed; recoverable claim retained",
      meta: { agents: [...loaded].sort(), count: loaded.size, claimedPath: consumingPath },
    })
    throw new Error("container credential bootstrap persistence failed; recoverable claim retained for reconciliation")
  }

  if (options.apply) {
    for (const message of envelope.credentials) {
      if (!options.apply(message)) throw new Error("container credential bootstrap message is invalid")
    }
  }
  deleteDurably(consumingPath)
  emitNervesEvent({
    component: "config/identity",
    event: "config.container_credentials_loaded",
    message: "loaded container credential bootstrap",
    meta: { agents: [...loaded].sort(), count: loaded.size },
  })
  return [...loaded].sort()
}
