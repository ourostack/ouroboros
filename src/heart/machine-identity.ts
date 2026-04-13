import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"

export interface MachineIdentity {
  schemaVersion: 1
  machineId: string
  createdAt: string
  updatedAt: string
  hostnameAliases: string[]
}

export interface MachineIdentityDeps {
  homeDir?: string
  now?: () => Date
  hostname?: () => string
  randomId?: () => string
}

function nowIso(deps: MachineIdentityDeps): string {
  return (deps.now?.() ?? new Date()).toISOString()
}

function currentHostname(deps: MachineIdentityDeps): string {
  return (deps.hostname?.() ?? os.hostname()).trim()
}

function defaultRandomId(): string {
  return `machine_${crypto.randomUUID()}`
}

function normalizeAliases(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const aliases: string[] = []
  for (const alias of value) {
    if (typeof alias !== "string") continue
    const trimmed = alias.trim()
    if (trimmed && !aliases.includes(trimmed)) aliases.push(trimmed)
  }
  return aliases
}

function parseMachineIdentity(value: unknown): MachineIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const aliases = normalizeAliases(record.hostnameAliases)
  if (
    record.schemaVersion !== 1 ||
    typeof record.machineId !== "string" ||
    record.machineId.trim().length === 0 ||
    typeof record.createdAt !== "string" ||
    record.createdAt.trim().length === 0 ||
    typeof record.updatedAt !== "string" ||
    record.updatedAt.trim().length === 0
  ) {
    return null
  }

  return {
    schemaVersion: 1,
    machineId: record.machineId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    hostnameAliases: aliases,
  }
}

function writeMachineIdentity(machinePath: string, identity: MachineIdentity): void {
  fs.mkdirSync(path.dirname(machinePath), { recursive: true, mode: 0o700 })
  fs.writeFileSync(machinePath, `${JSON.stringify(identity, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 })
}

export function getMachineIdentityPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".ouro-cli", "machine.json")
}

export function loadOrCreateMachineIdentity(deps: MachineIdentityDeps = {}): MachineIdentity {
  const homeDir = deps.homeDir ?? os.homedir()
  const machinePath = getMachineIdentityPath(homeDir)
  const hostname = currentHostname(deps)

  let existing: MachineIdentity | null = null
  let hadInvalidFile = false
  try {
    existing = parseMachineIdentity(JSON.parse(fs.readFileSync(machinePath, "utf-8")) as unknown)
    if (!existing) hadInvalidFile = true
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? (error as NodeJS.ErrnoException).code
      : undefined
    if (code !== "ENOENT") hadInvalidFile = true
  }

  if (hadInvalidFile) {
    emitNervesEvent({
      level: "warn",
      component: "config/identity",
      event: "config.machine_identity_invalid",
      message: "machine identity file is invalid; replacing it",
      meta: { path: machinePath },
    })
  }

  if (existing) {
    if (hostname && !existing.hostnameAliases.includes(hostname)) {
      const updated = {
        ...existing,
        updatedAt: nowIso(deps),
        hostnameAliases: [...existing.hostnameAliases, hostname],
      }
      writeMachineIdentity(machinePath, updated)
      emitNervesEvent({
        component: "config/identity",
        event: "config.machine_identity_alias_added",
        message: "recorded hostname alias for stable machine identity",
        meta: { machineId: updated.machineId, hostname },
      })
      return updated
    }

    emitNervesEvent({
      component: "config/identity",
      event: "config.machine_identity_loaded",
      message: "loaded stable machine identity",
      meta: { machineId: existing.machineId },
    })
    return existing
  }

  const timestamp = nowIso(deps)
  const identity: MachineIdentity = {
    schemaVersion: 1,
    machineId: (deps.randomId?.() ?? defaultRandomId()).trim() || defaultRandomId(),
    createdAt: timestamp,
    updatedAt: timestamp,
    hostnameAliases: hostname ? [hostname] : [],
  }
  writeMachineIdentity(machinePath, identity)
  emitNervesEvent({
    component: "config/identity",
    event: "config.machine_identity_created",
    message: "created stable machine identity",
    meta: { machineId: identity.machineId },
  })
  return identity
}
