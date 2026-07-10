import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"
import {
  mergeRuntimeCredentialConfig,
  type RuntimeCredentialConfigReadResult,
  type RuntimeCredentialConfig,
} from "../heart/runtime-credentials"
import type { AislePlannerCredentials } from "./aisleplanner-client"

export const RSVP_CONFIG_POLICY_VERSION = "rsvp-config/v1" as const

export type RsvpMode = "shadow" | "live"

export interface RsvpNativeConfig {
  schemaVersion: 1
  policyVersion: typeof RSVP_CONFIG_POLICY_VERSION
  agent: string
  mode: RsvpMode
  source: {
    kind: "aisleplanner"
    weddingId: string
    eventId: string
  }
  credentialRef: {
    runtimeConfigItem: "runtime/config"
    runtimeConfigPath: "rsvp.aisleplanner"
  }
  bluebubblesRoute: {
    chatGuid: string
    chatIdentifier?: string
    accountId?: string
  }
  cutover?: {
    legacyRoot: string
  }
}

export type RsvpConfigReadResult =
  | { ok: true; config: RsvpNativeConfig; path: string }
  | { ok: false; reason: "missing" | "malformed"; path: string; message: string }

export interface RsvpReadinessCheck {
  id:
    | "rsvp.native_config"
    | "rsvp.aisleplanner_source"
    | "rsvp.aisleplanner_credentials"
    | "rsvp.bluebubbles_route"
    | "rsvp.bluebubbles_attachment"
  status: "pass" | "fail"
  actor: "agent-runnable" | "human-required"
  detail: string
}

export type RsvpReadinessResult =
  | {
    status: "ready"
    checks: RsvpReadinessCheck[]
    config: RsvpNativeConfig
    credentials: AislePlannerCredentials
    redacted: Record<string, unknown>
  }
  | {
    status: "blocked"
    checks: RsvpReadinessCheck[]
    config?: RsvpNativeConfig
    redacted: Record<string, unknown>
  }

export interface ValidateRsvpReadinessInput {
  agent: string
  agentRoot: string
  runtimeConfig: RuntimeCredentialConfigReadResult
  machineRuntimeConfig?: RuntimeCredentialConfigReadResult
  config?: RsvpConfigReadResult
}

export type ImportLegacyRsvpConfigFailureReason =
  | "confirmation_required"
  | "missing_legacy_config"
  | "malformed_legacy_config"
  | "missing_secret"
  | "missing_coordinates"
  | "vault_unavailable"
  | "write_failed"

export type ImportLegacyRsvpConfigResult =
  | {
    ok: true
    configPath: string
    runtimeConfigItem: string
    redactedConfig: {
      source: RsvpNativeConfig["source"]
      bluebubblesRoute: RsvpNativeConfig["bluebubblesRoute"]
      mode: RsvpMode
    }
  }
  | {
    ok: false
    reason: ImportLegacyRsvpConfigFailureReason
    actor: "agent-runnable" | "human-required"
    message: string
  }

export interface ImportLegacyRsvpConfigInput {
  agent: string
  agentRoot: string
  legacyRoot: string
  mode: RsvpMode
  confirm: boolean
  now?: Date
  mergeRuntimeConfig?: typeof mergeRuntimeCredentialConfig
}

type JsonRecord = Record<string, unknown>

export function rsvpConfigPath(agentRoot: string): string {
  return path.join(agentRoot, "rsvp", "config.json")
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function idText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim()
  return ""
}

function optionalText(value: unknown): string | undefined {
  const normalized = text(value)
  return normalized || undefined
}

function parseRsvpConfig(value: unknown): RsvpNativeConfig | null {
  if (!isRecord(value)) return null
  if (value.schemaVersion !== 1) return null
  if (value.policyVersion !== RSVP_CONFIG_POLICY_VERSION) return null
  if (typeof value.agent !== "string") return null
  if (value.mode !== "shadow" && value.mode !== "live") return null
  const source = isRecord(value.source) ? value.source : null
  if (!source || source.kind !== "aisleplanner") return null
  if (typeof source.weddingId !== "string" || typeof source.eventId !== "string") return null
  const credentialRef = isRecord(value.credentialRef) ? value.credentialRef : null
  if (
    !credentialRef
    || credentialRef.runtimeConfigItem !== "runtime/config"
    || credentialRef.runtimeConfigPath !== "rsvp.aisleplanner"
  ) return null
  const route = isRecord(value.bluebubblesRoute) ? value.bluebubblesRoute : null
  if (!route || typeof route.chatGuid !== "string") return null
  if (route.chatIdentifier !== undefined && typeof route.chatIdentifier !== "string") return null
  if (route.accountId !== undefined && typeof route.accountId !== "string") return null
  const cutover = value.cutover === undefined ? undefined : isRecord(value.cutover) ? value.cutover : null
  if (cutover === null) return null
  if (cutover && typeof cutover.legacyRoot !== "string") return null
  return value as unknown as RsvpNativeConfig
}

export function readRsvpConfig(agentRoot: string): RsvpConfigReadResult {
  const configPath = rsvpConfigPath(agentRoot)
  if (!fs.existsSync(configPath)) {
    return { ok: false, reason: "missing", path: configPath, message: "missing native RSVP config" }
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown
    const config = parseRsvpConfig(parsed)
    if (!config) {
      return { ok: false, reason: "malformed", path: configPath, message: "native RSVP config is malformed" }
    }
    return { ok: true, config, path: configPath }
  } catch {
    return { ok: false, reason: "malformed", path: configPath, message: "native RSVP config is not valid JSON" }
  }
}

export function writeRsvpConfig(agentRoot: string, config: RsvpNativeConfig): string {
  const configPath = rsvpConfigPath(agentRoot)
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8")
  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.config_written",
    message: "wrote native RSVP config",
    meta: { agent: config.agent, mode: config.mode, configPath },
  })
  return configPath
}

function check(
  id: RsvpReadinessCheck["id"],
  status: RsvpReadinessCheck["status"],
  actor: RsvpReadinessCheck["actor"],
  detail: string,
): RsvpReadinessCheck {
  return { id, status, actor, detail }
}

function runtimeRsvpConfig(runtimeConfig: RuntimeCredentialConfigReadResult): JsonRecord | null {
  if (!runtimeConfig.ok) return null
  const rsvp = isRecord(runtimeConfig.config.rsvp) ? runtimeConfig.config.rsvp : null
  return isRecord(rsvp?.aisleplanner) ? rsvp.aisleplanner : null
}

function resolveCredentials(runtimeConfig: RuntimeCredentialConfigReadResult): AislePlannerCredentials | null {
  const aisleplanner = runtimeRsvpConfig(runtimeConfig)
  const username = text(aisleplanner?.username)
  const password = text(aisleplanner?.password)
  return username && password ? { username, password } : null
}

function bluebubblesAttachmentReady(machineRuntimeConfig: RuntimeCredentialConfigReadResult | undefined): boolean {
  if (!machineRuntimeConfig?.ok) return false
  const bluebubbles = isRecord(machineRuntimeConfig.config.bluebubbles) ? machineRuntimeConfig.config.bluebubbles : null
  return !!text(bluebubbles?.serverUrl) && !!text(bluebubbles?.password)
}

function redacted(config: RsvpNativeConfig | undefined, runtimeConfig: RuntimeCredentialConfigReadResult, machineRuntimeConfig: RuntimeCredentialConfigReadResult | undefined): Record<string, unknown> {
  return {
    config,
    credentials: {
      itemPath: runtimeConfig.itemPath,
      aisleplanner: resolveCredentials(runtimeConfig) ? "present" : "missing",
    },
    bluebubblesAttachment: {
      itemPath: machineRuntimeConfig?.itemPath ?? "missing",
      status: bluebubblesAttachmentReady(machineRuntimeConfig) ? "present" : "missing",
    },
  }
}

export function validateRsvpReadiness(input: ValidateRsvpReadinessInput): RsvpReadinessResult {
  const configResult = input.config ?? readRsvpConfig(input.agentRoot)
  const checks: RsvpReadinessCheck[] = []
  let config: RsvpNativeConfig | undefined

  if (!configResult.ok) {
    checks.push(check("rsvp.native_config", "fail", "agent-runnable", `${configResult.message}: ${configResult.path}`))
    return {
      status: "blocked",
      checks,
      redacted: redacted(undefined, input.runtimeConfig, input.machineRuntimeConfig),
    }
  }

  config = configResult.config
  checks.push(check("rsvp.native_config", "pass", "agent-runnable", configResult.path))

  const missingSource = []
  if (!text(config.source.weddingId)) missingSource.push("weddingId")
  if (!text(config.source.eventId)) missingSource.push("eventId")
  checks.push(missingSource.length === 0
    ? check("rsvp.aisleplanner_source", "pass", "agent-runnable", `${config.source.weddingId}/${config.source.eventId}`)
    : check("rsvp.aisleplanner_source", "fail", "agent-runnable", `missing ${missingSource.join("/")}`))

  const credentials = resolveCredentials(input.runtimeConfig)
  if (credentials) {
    checks.push(check("rsvp.aisleplanner_credentials", "pass", "human-required", `${input.runtimeConfig.itemPath}: present`))
  } else if (input.runtimeConfig.ok) {
    checks.push(check("rsvp.aisleplanner_credentials", "fail", "human-required", `${input.runtimeConfig.itemPath}: missing rsvp.aisleplanner username/password`))
  } else {
    checks.push(check("rsvp.aisleplanner_credentials", "fail", "human-required", `${input.runtimeConfig.itemPath}: ${input.runtimeConfig.error}`))
  }

  const chatGuid = text(config.bluebubblesRoute.chatGuid)
  checks.push(chatGuid
    ? check("rsvp.bluebubbles_route", "pass", "agent-runnable", chatGuid)
    : check("rsvp.bluebubbles_route", "fail", "agent-runnable", "missing bluebubblesRoute.chatGuid"))

  if (bluebubblesAttachmentReady(input.machineRuntimeConfig)) {
    checks.push(check("rsvp.bluebubbles_attachment", "pass", "agent-runnable", `${input.machineRuntimeConfig!.itemPath}: present`))
  } else if (input.machineRuntimeConfig?.ok) {
    checks.push(check("rsvp.bluebubbles_attachment", "fail", "agent-runnable", `${input.machineRuntimeConfig.itemPath}: missing bluebubbles.serverUrl/password`))
  } else {
    checks.push(check("rsvp.bluebubbles_attachment", "fail", "agent-runnable", `${input.machineRuntimeConfig?.itemPath ?? "machine runtime/config"}: ${input.machineRuntimeConfig?.error ?? "missing"}`))
  }

  const status = checks.every((entry) => entry.status === "pass") ? "ready" : "blocked"
  const base = {
    status,
    checks,
    config,
    redacted: redacted(config, input.runtimeConfig, input.machineRuntimeConfig),
  }
  return status === "ready" && credentials
    ? { ...base, status: "ready", credentials }
    : { ...base, status: "blocked" }
}

function fail(reason: ImportLegacyRsvpConfigFailureReason, actor: "agent-runnable" | "human-required", message: string): ImportLegacyRsvpConfigResult {
  return { ok: false, reason, actor, message }
}

function redactKnownSecrets(message: string, secrets: string[]): string {
  let redactedMessage = message
  for (const secret of secrets.filter((value) => value.length > 0)) {
    redactedMessage = redactedMessage.split(secret).join("[redacted]")
  }
  return redactedMessage
}

function readLegacyConfig(legacyRoot: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(legacyRoot, "config.json"), "utf-8")) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function legacyConfigExists(legacyRoot: string): boolean {
  return fs.existsSync(path.join(legacyRoot, "config.json"))
}

export async function importLegacyRsvpConfig(input: ImportLegacyRsvpConfigInput): Promise<ImportLegacyRsvpConfigResult> {
  if (!input.confirm) {
    return fail("confirmation_required", "human-required", "legacy RSVP config import requires explicit confirmation")
  }
  if (!legacyConfigExists(input.legacyRoot)) {
    return fail("missing_legacy_config", "agent-runnable", "legacy RSVP config.json is missing")
  }
  const legacy = readLegacyConfig(input.legacyRoot)
  if (!legacy) return fail("malformed_legacy_config", "agent-runnable", "legacy RSVP config.json is malformed")

  const aisleplanner = isRecord(legacy.aisleplanner) ? legacy.aisleplanner : null
  const bluebubbles = isRecord(legacy.bluebubbles) ? legacy.bluebubbles : null
  const username = text(aisleplanner?.username)
  const password = text(aisleplanner?.password)
  if (!username || !password) {
    return fail("missing_secret", "human-required", "legacy RSVP config is missing AislePlanner username/password")
  }
  const weddingId = idText(aisleplanner?.wedding_id)
  const eventId = idText(aisleplanner?.event_id)
  const chatGuid = text(bluebubbles?.chat_guid)
  if (!weddingId || !eventId || !chatGuid) {
    return fail("missing_coordinates", "agent-runnable", "legacy RSVP config is missing wedding_id/event_id/bluebubbles.chat_guid")
  }

  const now = input.now ?? new Date()
  const merge = input.mergeRuntimeConfig ?? mergeRuntimeCredentialConfig
  let runtimeConfig: Awaited<ReturnType<typeof mergeRuntimeCredentialConfig>>
  try {
    runtimeConfig = await merge(input.agent, {
      rsvp: {
        aisleplanner: {
          username,
          password,
        },
      },
    } satisfies RuntimeCredentialConfig, now)
  } catch (error) {
    const message = redactKnownSecrets(String(error), [username, password])
    return fail("vault_unavailable", "human-required", `could not write AislePlanner credentials to runtime/config: ${message}`)
  }

  const nativeConfig: RsvpNativeConfig = {
    schemaVersion: 1,
    policyVersion: RSVP_CONFIG_POLICY_VERSION,
    agent: input.agent,
    mode: input.mode,
    source: {
      kind: "aisleplanner",
      weddingId,
      eventId,
    },
    credentialRef: {
      runtimeConfigItem: "runtime/config",
      runtimeConfigPath: "rsvp.aisleplanner",
    },
    bluebubblesRoute: {
      chatGuid,
      ...(optionalText(bluebubbles?.account_id) ? { accountId: optionalText(bluebubbles?.account_id) } : {}),
    },
    cutover: {
      legacyRoot: input.legacyRoot,
    },
  }

  let configPath: string
  try {
    configPath = writeRsvpConfig(input.agentRoot, nativeConfig)
  } catch (error) {
    const message = String(error)
    return fail("write_failed", "agent-runnable", `could not write native RSVP config: ${message}`)
  }

  emitNervesEvent({
    component: "rsvp",
    event: "rsvp.legacy_config_imported",
    message: "imported legacy RSVP config into native config and runtime credentials",
    meta: { agent: input.agent, mode: input.mode, configPath, runtimeConfigItem: runtimeConfig.itemPath },
  })

  return {
    ok: true,
    configPath,
    runtimeConfigItem: runtimeConfig.itemPath,
    redactedConfig: {
      source: nativeConfig.source,
      bluebubblesRoute: nativeConfig.bluebubblesRoute,
      mode: nativeConfig.mode,
    },
  }
}
