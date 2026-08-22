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
  machineIdMigration?: {
    sourceMachineId: string
    targetMachineId: string
    discardProviderCredentialRecords?: {
      providers: string[]
    }
  }
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
  if (value.credentials.length === 0) {
    throw new Error("container credential bootstrap must contain at least one credential")
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
  if (claimedStat) assertSafeBootstrapFile(claimedStat, "consuming state")
  let stat: fs.Stats
  if (sourceStat) {
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error("container credential bootstrap must be a regular file")
    }
    fs.renameSync(filePath, consumingPath)
    fsyncDirectory(path.dirname(filePath))
    stat = sourceStat
  } else if (claimedStat) {
    stat = claimedStat
  } else {
    return []
  }
  assertSafeBootstrapFile(stat, claimedStat ? "consuming state" : "bootstrap")

  const envelope = parseEnvelope(fs.readFileSync(consumingPath, "utf8"))
  const allowed = new Set(enabledAgents)
  const loaded = new Set<string>()
  for (const message of envelope.credentials) {
    if (!isRecord(message) || typeof message.agentName !== "string" || !allowed.has(message.agentName)) {
      throw new Error("container credential bootstrap agent is not enabled")
    }
    if (loaded.has(message.agentName)) throw new Error("container credential bootstrap contains a duplicate agent")
    loaded.add(message.agentName)
  }

  const migration = options.machineIdMigration
  const discardProviderCredentialRecords = migration?.discardProviderCredentialRecords
  if (discardProviderCredentialRecords === undefined) {
    for (const message of envelope.credentials) {
      if (!isRuntimeCredentialBootstrapMessage(message)) {
        throw new Error("container credential bootstrap message is invalid")
      }
    }
  }
  const machineId = loadOrCreateMachineIdentity().machineId
  let messages = envelope.credentials
  let discardedProviderRecordCount = 0
  if (migration) {
    const { sourceMachineId, targetMachineId } = migration
    if (
      !sourceMachineId
      || !targetMachineId
      || sourceMachineId !== sourceMachineId.trim()
      || targetMachineId !== targetMachineId.trim()
      || sourceMachineId === targetMachineId
    ) {
      throw new Error("container credential bootstrap machineId migration is invalid")
    }
    if (machineId !== targetMachineId) {
      throw new Error("container credential bootstrap machineId migration target does not match this machine")
    }
    for (const message of messages) {
      if (!isRecord(message) || message.machineId !== sourceMachineId) {
        throw new Error("container credential bootstrap machineId migration source does not match")
      }
    }
    if (discardProviderCredentialRecords !== undefined) {
      if (!isRecord(discardProviderCredentialRecords) || !Array.isArray(discardProviderCredentialRecords.providers)) {
        throw new Error("container credential bootstrap provider discard policy is invalid")
      }
      const configuredProviders = discardProviderCredentialRecords.providers
      if (
        configuredProviders.length === 0
        || configuredProviders.some((provider) => (
          typeof provider !== "string" || provider.length === 0 || provider !== provider.trim()
        ))
        || new Set(configuredProviders).size !== configuredProviders.length
      ) {
        throw new Error("container credential bootstrap provider discard allowlist is invalid")
      }
      const legacyProviders: string[] = []
      for (const message of messages) {
        const records = (message as Record<string, unknown>).providerCredentialRecords
        if (records === undefined) continue
        if (!Array.isArray(records) || records.length === 0) {
          throw new Error("container credential bootstrap discarded provider records are invalid")
        }
        for (const record of records) {
          if (!isRecord(record) || typeof record.provider !== "string" || record.provider.length === 0) {
            throw new Error("container credential bootstrap discarded provider record is invalid")
          }
          legacyProviders.push(record.provider)
        }
      }
      if (new Set(legacyProviders).size !== legacyProviders.length) {
        throw new Error("container credential bootstrap discarded providers contain duplicates")
      }
      if (
        [...legacyProviders].sort().join(",")
        !== [...configuredProviders].sort().join(",")
      ) {
        throw new Error("container credential bootstrap discarded providers do not match the allowlist")
      }
      discardedProviderRecordCount = legacyProviders.length
    }
    messages = messages.map((message) => {
      const projected: Record<string, unknown> = { ...(message as Record<string, unknown>), machineId: targetMachineId }
      if (discardProviderCredentialRecords !== undefined) delete projected.providerCredentialRecords
      return projected
    })
  } else {
    for (const message of messages) {
      if (isRecord(message) && typeof message.machineId === "string" && message.machineId !== machineId) {
        throw new Error("container credential bootstrap machineId does not match this machine")
      }
    }
  }
  if (discardProviderCredentialRecords !== undefined) {
    for (const message of messages) {
      if (!isRuntimeCredentialBootstrapMessage(message)) {
        throw new Error("container credential bootstrap message is invalid")
      }
    }
  }

  const persist = options.persist ?? ((message: unknown) => persistRuntimeCredentialBootstrapMessage(message, {
    machineId,
  }))
  try {
    for (const message of messages) {
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
    for (const message of messages) {
      if (!options.apply(message)) throw new Error("container credential bootstrap message is invalid")
    }
  }
  deleteDurably(consumingPath)
  if (discardedProviderRecordCount > 0) {
    emitNervesEvent({
      component: "config/identity",
      event: "config.container_provider_credentials_discarded",
      message: "discarded allowlisted legacy provider credentials during container migration",
      meta: {
        agentCount: loaded.size,
        recordCount: discardedProviderRecordCount,
        mode: "machine-id-migration",
      },
    })
  }
  emitNervesEvent({
    component: "config/identity",
    event: "config.container_credentials_loaded",
    message: "loaded container credential bootstrap",
    meta: { agents: [...loaded].sort(), count: loaded.size },
  })
  return [...loaded].sort()
}
