import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { applyRuntimeCredentialBootstrapMessage } from "../runtime-credentials"
import { emitNervesEvent } from "../../nerves/runtime"

const MAX_BOOTSTRAP_BYTES = 128 * 1024

interface ContainerBootstrapEnvelope {
  schemaVersion: 1
  credentials: unknown[]
}

export interface ContainerCredentialBootstrapOptions {
  path?: string
  apply?: (message: unknown) => boolean
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

export function getDefaultContainerCredentialBootstrapPath(): string {
  return path.join(os.homedir(), ".ouro-cli", "container-credentials.json")
}

export function loadContainerCredentialBootstrap(
  enabledAgents: string[],
  options: ContainerCredentialBootstrapOptions = {},
): string[] {
  const filePath = options.path ?? getDefaultContainerCredentialBootstrapPath()
  const consumingPath = `${filePath}.consuming`
  try {
    const interrupted = fs.lstatSync(consumingPath)
    if (!interrupted.isFile() || interrupted.isSymbolicLink()) throw new Error("container credential consuming state must be a regular file")
    deleteDurably(consumingPath)
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
  }
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(filePath)
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return []
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("container credential bootstrap must be a regular file")
  if ((stat.mode & 0o077) !== 0) throw new Error("container credential bootstrap must have mode 0600")
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("container credential bootstrap must be owned by the runtime user")
  }
  if (stat.size > MAX_BOOTSTRAP_BYTES) throw new Error("container credential bootstrap is too large")

  const envelope = parseEnvelope(fs.readFileSync(filePath, "utf8"))
  const allowed = new Set(enabledAgents)
  const loaded = new Set<string>()
  for (const message of envelope.credentials) {
    if (!isRecord(message) || typeof message.agentName !== "string" || !allowed.has(message.agentName)) {
      throw new Error("container credential bootstrap agent is not enabled")
    }
    if (loaded.has(message.agentName)) throw new Error("container credential bootstrap contains a duplicate agent")
    loaded.add(message.agentName)
  }
  fs.renameSync(filePath, consumingPath)
  fsyncDirectory(path.dirname(filePath))
  deleteDurably(consumingPath)

  const apply = options.apply ?? applyRuntimeCredentialBootstrapMessage
  for (const message of envelope.credentials) {
    if (!apply(message)) throw new Error("container credential bootstrap message is invalid")
  }
  emitNervesEvent({
    component: "config/identity",
    event: "config.container_credentials_loaded",
    message: "loaded container credential bootstrap",
    meta: { agents: [...loaded].sort(), count: loaded.size },
  })
  return [...loaded].sort()
}
