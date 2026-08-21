import { spawnSync } from "node:child_process"
import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { createConnection } from "node:net"
import * as path from "node:path"

import { emitNervesEvent } from "../../nerves/runtime"
import { createTelegramApprovalRuntime, type TelegramApprovalRuntime } from "../../senses/telegram-approval-runtime"
import { createTelegramBotApi, type TelegramBotApi, type TelegramUpdate } from "../../senses/telegram-client"
import { loadTelegramSenseCredentials, readOrCreateTelegramIdentityKey, type TelegramSenseCredentials } from "../../senses/telegram"
import { createSanctuaryToolContext } from "../../senses/sanctuary-runtime"
import { resolveToolDefinition } from "../../repertoire/tools"
import { getAgentRoot } from "../identity"
import { readApprovalsByScenarioHandleDigest } from "../approval-store"
import { readProviderCredentialRecord } from "../provider-credentials"
import { pingProvider, type PingResult } from "../provider-ping"
import { SANCTUARY_SCENARIO_GATES, SANCTUARY_SCENARIO_SOURCES, SANCTUARY_UNIT_16_EVIDENCE_LABELS, type SanctuaryUnit16EvidenceLabel } from "./sanctuary-acceptance-harness"
import { readSanctuaryAcceptanceMarker } from "./sanctuary-acceptance-marker"
import { createSanctuaryScenarioCapture, finalizeSanctuaryScenarioCapture, type SanctuaryHealthProbeReceipt, type SanctuaryScenarioFacts } from "./sanctuary-acceptance-scenarios"
import {
  mergeMachineRuntimeCredentialConfig,
  mergeRuntimeCredentialConfig,
  readMachineRuntimeCredentialConfig,
  refreshMachineRuntimeCredentialConfig,
  refreshRuntimeCredentialConfig,
} from "../runtime-credentials"
import type { RuntimeCredentialConfigReadResult } from "../runtime-credentials"

type JsonObject = Record<string, unknown>

export interface SanctuaryAcceptanceKeyMetadata {
  id: string
  name: string
  permissions: Array<{ resource: string; actions: string[] }>
  roles: string[]
}

export interface SanctuaryAcceptanceKeyRecord extends SanctuaryAcceptanceKeyMetadata {
  key: string
}

export interface SanctuaryAcceptanceAdapterDependencies {
  readKeyFiles(): SanctuaryAcceptanceKeyMetadata[]
  readKeyRecords?(): SanctuaryAcceptanceKeyRecord[]
  readDescriptor(): string
  execFile(executable: string, args: string[]): Promise<{ status: number; stdout: string }>
  fetch: typeof fetch
  readFixedFile?(path: string): string
  refreshRuntime?(agentName: string): Promise<RuntimeCredentialConfigReadResult>
  mergeRuntime?(agentName: string, patch: JsonObject): Promise<RuntimeCredentialConfigReadResult>
  refreshMachine?(agentName: string, machineId: string): Promise<RuntimeCredentialConfigReadResult>
  mergeMachine?(agentName: string, machineId: string, patch: JsonObject): Promise<RuntimeCredentialConfigReadResult>
  callbackProbe?(update: JsonObject, replay: boolean): Promise<{ settled: boolean; claimed: boolean; mutated: boolean }>
  hostRequest?(payload: JsonObject): Promise<unknown>
  captureScenario?(payload: JsonObject): Promise<unknown>
  finalizeScenarios?(): void | Promise<void>
  telegramCredentials?(): TelegramSenseCredentials
  readProviderCredential?: typeof readProviderCredentialRecord
  providerPing?: typeof pingProvider
  now?(): number
}

export interface SanctuaryAcceptanceVaultProbeDependencies {
  refresh(agentName: string, machineId: string): Promise<RuntimeCredentialConfigReadResult>
  readKeyRecords(): SanctuaryAcceptanceKeyRecord[]
  fetch: typeof fetch
}

const KEY_ID = /^[A-Za-z0-9._:-]+$/u
const AUTH_PROBE = "query AcceptanceAuthProbe { info { os { hostname } } }"
const WRITE_PROBE = "mutation AcceptanceWriteProbe($id: PrefixedID!) { docker { restart(id: $id) { id } } }"
const MISSING_CONTAINER_ID = "Docker:ouro-acceptance-guaranteed-missing"
// container_snapshot may execute bounded 20s inspect + 30s vault + 30s recovery
// probes + 10s GraphQL + 20s image-policy checks sequentially in the host broker.
const ADAPTER_TIMEOUT_MS = 240_000
const NETWORK_TIMEOUT_MS = 10_000
const KEY_DIRECTORY = "/boot/config/plugins/dynamix.my.servers/keys"
const SELECTED_KEY_RECORD = "/run/ouro-acceptance/unraid-key.json"
const TELEGRAM_OFFSET = "/home/ouro/AgentBundles/sanctuary.ouro/state/senses/telegram/offset.json"
const TELEGRAM_AUDIT = "/home/ouro/AgentBundles/sanctuary.ouro/state/daemon/logs/telegram.ndjson"
const IMAGE_DIGEST_FILE = "/run/ouro-acceptance/image-digest"
const CONTAINER_DIGEST_FILE = "/run/ouro-acceptance/container-digest"
const POSTBOOT_HEALTH_FILE = "/run/ouro-acceptance/postboot-health.json"
const BOOT_ID_FILE = "/run/ouro-acceptance/boot-id"
const TELEGRAM_POLLER_COUNT_FILE = "/run/ouro-acceptance/telegram-poller-count.json"
const CONTRACT_FILE = "/opt/ouro/deploy/unraid/sanctuary-acceptance-contract.json"
const SANCTUARY_TOOL_PROFILES_FILE = "/opt/ouro/deploy/unraid/sanctuary.ouro/tool-profiles.json"
const CLOSED_INVENTORY_FILE = "/run/ouro-acceptance/closed-inventory.json"
const HOST_BROKER_SOCKET = "/run/ouro-host-acceptance/adapter.sock"
const MAX_BROKER_RESPONSE = 256 * 1024
const TARGET_SERVER_ID = "sanctuary-unraid"
const TARGET_ID = "sanctuary"
const SHA256 = /^[0-9a-f]{64}$/u
const HEALTH_ACCEPTANCE_LABELS = new Set<SanctuaryUnit16EvidenceLabel>([
  "unit-16f-cron-fingerprint",
  "unit-16g-health-transition",
  "unit-16h-daily-digest",
])
const TELEGRAM_SUBJECT_DOMAIN = "ouroboros.telegram.subject.v1"
const PERMISSION_RESOURCES = new Set([
  "ACTIVATION_CODE", "API_KEY", "ARRAY", "CLOUD", "CONFIG", "CONNECT", "CONNECT__REMOTE_ACCESS",
  "CUSTOMIZATIONS", "DASHBOARD", "DISK", "DISPLAY", "DOCKER", "FLASH", "INFO", "LOGS", "ME",
  "NETWORK", "NOTIFICATIONS", "ONLINE", "OS", "OWNER", "PERMISSION", "REGISTRATION", "SERVERS",
  "SERVICES", "SHARE", "VARS", "VMS", "WELCOME",
])
const PERMISSION_ACTIONS = new Set(["CREATE_ANY", "CREATE_OWN", "READ_ANY", "READ_OWN", "UPDATE_ANY", "UPDATE_OWN", "DELETE_ANY", "DELETE_OWN"])
const RO_PERMISSIONS = ["ARRAY", "DASHBOARD", "DISK", "DOCKER", "INFO", "LOGS", "NOTIFICATIONS", "SHARE", "VARS"]
  .map((resource) => `${resource}:READ_ANY`).sort()

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as JsonObject
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be nonempty text`)
  return value.trim()
}

function keyId(value: unknown): string {
  const result = text(value, "keyId")
  if (!KEY_ID.test(result)) throw new Error("keyId is invalid")
  return result
}

function readRawKeyDirectory(keyDirectory: string): JsonObject[] {
  return readdirSync(keyDirectory, { withFileTypes: true })
    .map((entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json")) throw new Error("unexpected key directory entry")
      return entry
    })
    .map((entry) => object(JSON.parse(readFileSync(`${keyDirectory}/${entry.name}`, "utf8")) as unknown, "Unraid key file"))
}

function readKeyDirectory(keyDirectory: string): SanctuaryAcceptanceKeyMetadata[] {
  return readRawKeyDirectory(keyDirectory).map(normalizeKey)
}

function readKeyRecords(keyDirectory: string): SanctuaryAcceptanceKeyRecord[] {
  return readRawKeyDirectory(keyDirectory).map((raw) => ({
    ...normalizeKey(raw),
    key: text(raw.key, "Unraid key descriptor"),
  }))
}

function readSelectedKeyRecord(keyRecordPath: string): SanctuaryAcceptanceKeyRecord {
  const raw = object(JSON.parse(readFileSync(keyRecordPath, "utf8")) as unknown, "selected Unraid key file")
  return { ...normalizeKey(raw), key: text(raw.key, "Unraid key descriptor") }
}

export function createSanctuaryAcceptanceVaultProbeDependencies(
  options: { keyRecordPath: string },
): SanctuaryAcceptanceVaultProbeDependencies {
  const keyRecordPath = options.keyRecordPath
  return {
    refresh: refreshMachineRuntimeCredentialConfig,
    readKeyRecords: () => [readSelectedKeyRecord(keyRecordPath)],
    fetch,
  }
}

async function defaultExecFile(executable: string, args: string[], timeoutMs: number): Promise<{ status: number; stdout: string }> {
  const result = spawnSync(executable, args, {
    cwd: "/",
    encoding: "utf8",
    env: { PATH: "/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin" },
    maxBuffer: 1_048_576,
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "ignore"],
  })
  if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") throw new Error("acceptance adapter subprocess timed out")
  if (result.error || result.status !== 0) throw new Error("acceptance adapter subprocess failed")
  return { status: result.status, stdout: result.stdout }
}

async function defaultHostRequest(payload: JsonObject, socketPath: string, timeoutMs: number): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let response = ""
    let settled = false
    const fail = () => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error("Sanctuary host acceptance operation failed"))
    }
    socket.setEncoding("utf8")
    socket.setTimeout(timeoutMs, fail)
    socket.on("error", fail)
    socket.on("data", (chunk) => {
      response += chunk
      if (Buffer.byteLength(response) > MAX_BROKER_RESPONSE) fail()
    })
    socket.on("end", () => {
      if (settled) return
      try {
        const envelope = object(JSON.parse(response) as unknown, "host broker response")
        if (JSON.stringify(Object.keys(envelope).sort()) !== JSON.stringify(envelope.ok === true ? ["ok", "result"] : ["error", "ok"])) fail()
        else if (envelope.ok !== true) fail()
        else {
          settled = true
          resolve(envelope.result)
        }
      } catch { fail() }
    })
    socket.end(`${JSON.stringify(payload)}\n`)
  })
}

export function createSanctuaryAcceptanceAdapterDependencies(
  secretFd = 3,
  options: {
    keyDirectory?: string
    adapterTimeoutMs?: number
    hostBrokerSocket?: string
    hostRequest?: (payload: JsonObject) => Promise<unknown>
    scenarioCapture?: { agentRoot?: string; receiptRoot?: string; gateStatusPath?: string }
  } = {},
): SanctuaryAcceptanceAdapterDependencies {
  const keyDirectory = options.keyDirectory ?? KEY_DIRECTORY
  const adapterTimeoutMs = options.adapterTimeoutMs ?? ADAPTER_TIMEOUT_MS
  const hostBrokerSocket = options.hostBrokerSocket ?? HOST_BROKER_SOCKET
  const dependencies: SanctuaryAcceptanceAdapterDependencies = {
    readKeyFiles: () => readKeyDirectory(keyDirectory),
    readKeyRecords: () => readKeyRecords(keyDirectory),
    readDescriptor: () => readFileSync(secretFd, "utf8"),
    execFile: (executable, args) => defaultExecFile(executable, args, adapterTimeoutMs),
    fetch,
    readFixedFile: (filePath) => readFileSync(filePath, "utf8"),
    refreshRuntime: refreshRuntimeCredentialConfig,
    mergeRuntime: mergeRuntimeCredentialConfig,
    refreshMachine: refreshMachineRuntimeCredentialConfig,
    mergeMachine: mergeMachineRuntimeCredentialConfig,
    callbackProbe: executeSanctuaryAcceptanceCallbackProbe,
    hostRequest: options.hostRequest ?? ((payload) => defaultHostRequest(payload, hostBrokerSocket, adapterTimeoutMs)),
    telegramCredentials: () => loadTelegramSenseCredentials(TARGET_ID),
  }
  const healthDriver = createSanctuaryHealthAcceptanceScenarioDriver(dependencies.hostRequest!)
  dependencies.captureScenario = createSanctuaryScenarioCapture({
    now: Date.now,
    readFacts: (label, scenarioHandleDigest, readOptions) => readDefaultSanctuaryScenarioFacts(label, scenarioHandleDigest, dependencies, options.scenarioCapture?.agentRoot, readOptions),
    healthDriver,
    receiptRoot: options.scenarioCapture?.receiptRoot,
    gateStatusPath: options.scenarioCapture?.gateStatusPath,
  }) as (payload: JsonObject) => Promise<unknown>
  dependencies.finalizeScenarios = createSanctuaryAcceptanceScenarioFinalizer({
    readActiveScenario: () => readSanctuaryAcceptanceMarker(TARGET_ID),
    recoverHealthScenario: healthDriver.recover,
    finalizeLocal: finalizeSanctuaryScenarioCapture,
  })
  return dependencies
}

function healthScenarioCoordinates(label: string, scenarioHandleDigest: string): {
  label: SanctuaryUnit16EvidenceLabel
  scenarioHandleDigest: string
} {
  if (!SANCTUARY_UNIT_16_EVIDENCE_LABELS.includes(label as SanctuaryUnit16EvidenceLabel)
    || !HEALTH_ACCEPTANCE_LABELS.has(label as SanctuaryUnit16EvidenceLabel)) throw new Error("health probe label is invalid")
  if (!SHA256.test(scenarioHandleDigest)) throw new Error("health probe scenario handle is invalid")
  return { label: label as SanctuaryUnit16EvidenceLabel, scenarioHandleDigest }
}

function ownerContainerSnapshot(value: unknown): JsonObject {
  const snapshot = object(value, "health probe owner snapshot")
  exactKeys(snapshot, [
    "schemaVersion", "containerId", "imageId", "running", "health", "user", "readOnlyRoot", "mountCount",
    "mountsDigest", "mountsExact", "publishedPortCount", "networkMode", "securityExact", "writableKeyExposure",
    "restartPolicy", "restartCount", "autostartExact", "updaterDisabled", "vaultUnlocked", "manualAuthRequired",
    "recoveryMilestones",
  ], "health probe owner snapshot")
  const milestones = object(snapshot.recoveryMilestones, "health probe owner recovery milestones")
  exactKeys(milestones, ["hostReady", "arrayReady", "dockerReady", "butlerReady", "tailscaleReady", "sshReady"], "health probe owner recovery milestones")
  if (snapshot.schemaVersion !== 1 || typeof snapshot.containerId !== "string" || !SHA256.test(snapshot.containerId)
    || typeof snapshot.imageId !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(snapshot.imageId)
    || typeof snapshot.running !== "boolean" || typeof snapshot.health !== "string" || !["healthy", "starting", "unhealthy", "missing"].includes(snapshot.health)
    || typeof snapshot.user !== "string" || snapshot.user.length < 1 || snapshot.user.length > 64
    || typeof snapshot.readOnlyRoot !== "boolean" || !Number.isSafeInteger(snapshot.mountCount) || Number(snapshot.mountCount) < 0
    || typeof snapshot.mountsDigest !== "string" || !SHA256.test(snapshot.mountsDigest) || typeof snapshot.mountsExact !== "boolean"
    || !Number.isSafeInteger(snapshot.publishedPortCount) || Number(snapshot.publishedPortCount) < 0
    || typeof snapshot.networkMode !== "string" || snapshot.networkMode.length < 1 || snapshot.networkMode.length > 64
    || typeof snapshot.securityExact !== "boolean" || typeof snapshot.writableKeyExposure !== "boolean"
    || typeof snapshot.restartPolicy !== "string" || snapshot.restartPolicy.length < 1 || snapshot.restartPolicy.length > 64
    || !Number.isSafeInteger(snapshot.restartCount) || Number(snapshot.restartCount) < 0
    || typeof snapshot.autostartExact !== "boolean" || typeof snapshot.updaterDisabled !== "boolean"
    || typeof snapshot.vaultUnlocked !== "boolean" || typeof snapshot.manualAuthRequired !== "boolean"
    || Object.values(milestones).some((entry) => typeof entry !== "boolean")) throw new Error("health probe owner snapshot schema is invalid")
  return snapshot
}

export function createSanctuaryHealthAcceptanceScenarioDriver(
  hostRequest: (payload: JsonObject) => Promise<unknown>,
): {
  begin(label: string, scenarioHandleDigest: string): Promise<void>
  poll(label: string, scenarioHandleDigest: string): Promise<{ state: "waiting" } | { state: "ready"; containerSnapshot: JsonObject }>
  recover(label: string, scenarioHandleDigest: string): Promise<void>
} {
  const payload = (operation: "start_health_probe" | "health_probe_status" | "recover_health_probe", label: string, scenarioHandleDigest: string): JsonObject => {
    const coordinates = healthScenarioCoordinates(label, scenarioHandleDigest)
    return { operation, targetId: TARGET_ID, ...coordinates }
  }
  return {
    begin: async (label, scenarioHandleDigest) => {
      const response = object(await hostRequest(payload("start_health_probe", label, scenarioHandleDigest)), "health probe start response")
      exactKeys(response, ["state", "operationDigest"], "health probe start response")
      if (response.state !== "started" || typeof response.operationDigest !== "string" || !SHA256.test(response.operationDigest)) {
        throw new Error("health probe start response is invalid")
      }
    },
    poll: async (label, scenarioHandleDigest) => {
      const response = object(await hostRequest(payload("health_probe_status", label, scenarioHandleDigest)), "health probe status response")
      if (response.state === "running") {
        exactKeys(response, ["state"], "health probe status response")
        return { state: "waiting" }
      }
      if (response.state === "complete") {
        exactKeys(response, ["state", "containerSnapshot"], "health probe status response")
        return { state: "ready", containerSnapshot: ownerContainerSnapshot(response.containerSnapshot) }
      }
      throw new Error("health probe status state is invalid")
    },
    recover: async (label, scenarioHandleDigest) => {
      const response = object(await hostRequest(payload("recover_health_probe", label, scenarioHandleDigest)), "health probe recovery response")
      exactKeys(response, ["recovered"], "health probe recovery response")
      if (response.recovered !== true) throw new Error("health probe recovery response is invalid")
    },
  }
}

export function createSanctuaryAcceptanceScenarioFinalizer(dependencies: {
  readActiveScenario(): { label: string; scenarioHandleDigest: string } | null
  recoverHealthScenario(label: string, scenarioHandleDigest: string): Promise<void>
  finalizeLocal(): void
}): () => Promise<void> {
  const appendErrorLeaves = (errors: unknown[], error: unknown): void => {
    if (error instanceof AggregateError) {
      for (const nested of error.errors) appendErrorLeaves(errors, nested)
    } else errors.push(error)
  }
  return async () => {
    const errors: unknown[] = []
    let active: { label: string; scenarioHandleDigest: string } | null = null
    try { active = dependencies.readActiveScenario() } catch (error) { appendErrorLeaves(errors, error) }
    if (active && HEALTH_ACCEPTANCE_LABELS.has(active.label as SanctuaryUnit16EvidenceLabel)) {
      try { await dependencies.recoverHealthScenario(active.label, active.scenarioHandleDigest) } catch (error) { appendErrorLeaves(errors, error) }
    }
    try { dependencies.finalizeLocal() } catch (error) { appendErrorLeaves(errors, error) }
    if (errors.length > 0) throw new AggregateError(errors, "Sanctuary scenario recovery and finalization failed")
  }
}

function optionalFixedFile(deps: SanctuaryAcceptanceAdapterDependencies, filePath: string): string | null {
  try { return deps.readFixedFile ? deps.readFixedFile(filePath) : readFileSync(filePath, "utf8") }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

function parsedJson(raw: string | null): JsonObject | null {
  if (raw === null) return null
  return object(JSON.parse(raw) as unknown, "scenario source")
}

function canonicalIso(value: unknown): value is string {
  return typeof value === "string" && value.length <= 30 && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value
}

function boundedLines(raw: string, label: string, limits: { bytes: number; rows: number; rowBytes: number }): string[] {
  if (Buffer.byteLength(raw) > limits.bytes) throw new Error(`${label} exceeds its bound`)
  const lines = raw.split("\n").filter(Boolean)
  if (lines.length > limits.rows || lines.some((line) => Buffer.byteLength(line) > limits.rowBytes)) throw new Error(`${label} exceeds its bound`)
  return lines
}

function parseScenarioAudit(raw: string, scenarioHandleDigest: string): SanctuaryScenarioFacts["events"] {
  return boundedLines(raw, "Telegram audit ledger", { bytes: 32 * 1024 * 1024, rows: 100_000, rowBytes: 64 * 1024 }).flatMap((line) => {
    const entry = object(JSON.parse(line) as unknown, "Telegram audit entry")
    const meta = object(entry.meta, "Telegram audit meta")
    if (!canonicalIso(entry.ts) || typeof entry.event !== "string" || entry.event.length < 1 || entry.event.length > 256) throw new Error("Telegram audit ledger row is invalid")
    return meta.scenarioHandleDigest === scenarioHandleDigest ? [{ event: entry.event, at: Date.parse(entry.ts), meta }] : []
  })
}

function parseRestartAttempts(raw: string, scenarioHandleDigest: string): SanctuaryScenarioFacts["restartAttempts"] {
  const exactKeys = ["actionDigest", "afterState", "approvalId", "argumentDigest", "attemptId", "beforeState", "container", "mutationAcknowledged", "observedAt", "scenarioHandleDigest", "state"].sort()
  return boundedLines(raw, "restart attempt ledger", { bytes: 4 * 1024 * 1024, rows: 500, rowBytes: 8 * 1024 }).flatMap((line) => {
    const attempt = object(JSON.parse(line) as unknown, "restart attempt")
    const containerRecord = object(attempt.container, "restart target")
    if (JSON.stringify(Object.keys(attempt).sort()) !== JSON.stringify(exactKeys)
      || JSON.stringify(Object.keys(containerRecord).sort()) !== JSON.stringify(["id", "name"])
      || typeof containerRecord.id !== "string" || containerRecord.id.length < 1 || containerRecord.id.length > 128
      || typeof containerRecord.name !== "string" || containerRecord.name.length < 1 || containerRecord.name.length > 128
      || !["attempt_not_started", "attempting", "succeeded", "attempted_or_indeterminate"].includes(String(attempt.state))
      || !canonicalIso(attempt.observedAt) || !SHA256.test(String(attempt.actionDigest)) || !SHA256.test(String(attempt.argumentDigest))
      || typeof attempt.scenarioHandleDigest !== "string" || !SHA256.test(attempt.scenarioHandleDigest)
      || typeof attempt.approvalId !== "string" || attempt.approvalId.length < 1 || attempt.approvalId.length > 128
      || typeof attempt.attemptId !== "string" || attempt.attemptId.length < 1 || attempt.attemptId.length > 128
      || typeof attempt.beforeState !== "string" || attempt.beforeState.length > 64 || typeof attempt.mutationAcknowledged !== "boolean"
      || (attempt.afterState !== null && (typeof attempt.afterState !== "string" || attempt.afterState.length > 64))) throw new Error("restart attempt ledger row is invalid")
    if (attempt.scenarioHandleDigest !== scenarioHandleDigest) return []
    return [{ state: attempt.state as SanctuaryScenarioFacts["restartAttempts"][number]["state"], actionDigest: String(attempt.actionDigest), argumentDigest: String(attempt.argumentDigest), target: containerRecord.name, approvalId: attempt.approvalId, attemptId: attempt.attemptId, observedAt: Date.parse(attempt.observedAt), mutationAcknowledged: attempt.mutationAcknowledged, afterState: attempt.afterState as string | null }]
  })
}

function parseHealthAcceptanceState(raw: string | null): JsonObject | null {
  if (raw === null) return null
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error("Sanctuary health state exceeds its bound")
  const health = object(JSON.parse(raw) as unknown, "Sanctuary health state")
  const rootKeys = ["deliveredReceipts", "incidents", "indeterminateDeliveries", "lastDigestDay", "outbox", "sweepReceipts", "updatedAt"].sort()
  if (JSON.stringify(Object.keys(health).sort()) !== JSON.stringify(rootKeys)
    || !health.incidents || typeof health.incidents !== "object" || Array.isArray(health.incidents)
    || (health.lastDigestDay !== null && typeof health.lastDigestDay !== "string") || !canonicalIso(health.updatedAt)
    || (health.outbox !== null && (typeof health.outbox !== "object" || Array.isArray(health.outbox)))
    || !Array.isArray(health.indeterminateDeliveries)) throw new Error("Sanctuary health state schema is invalid")
  if (!Array.isArray(health.deliveredReceipts) || health.deliveredReceipts.length > 100 || !health.deliveredReceipts.every((rawReceipt) => {
    const receipt = object(rawReceipt, "health delivery receipt")
    return JSON.stringify(Object.keys(receipt).sort()) === JSON.stringify(["deliveredAt", "deliveryId", "kind", "messageIds"])
      && typeof receipt.deliveryId === "string" && receipt.deliveryId.length > 0 && receipt.deliveryId.length <= 128
      && ["transition", "digest", "transition_and_digest", "legacy_unknown"].includes(String(receipt.kind)) && canonicalIso(receipt.deliveredAt)
      && Array.isArray(receipt.messageIds) && receipt.messageIds.length > 0 && receipt.messageIds.length <= 100 && receipt.messageIds.every((id) => Number.isSafeInteger(id) && Number(id) > 0)
  })) throw new Error("Sanctuary health delivery receipts are invalid")
  if (!Array.isArray(health.sweepReceipts) || health.sweepReceipts.length > 500 || !health.sweepReceipts.every((rawReceipt) => {
    const receipt = object(rawReceipt, "health sweep receipt")
    const expectedKeys = ["completedAt", "digestDue", "incidentDigest", "opened", "recovered", "startedAt", "sweepId", ...(receipt.deliveryId === undefined ? [] : ["deliveryId"]), ...(receipt.scenarioHandleDigest === undefined ? [] : ["scenarioHandleDigest"])].sort()
    return JSON.stringify(Object.keys(receipt).sort()) === JSON.stringify(expectedKeys)
      && typeof receipt.sweepId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(receipt.sweepId)
      && canonicalIso(receipt.startedAt) && canonicalIso(receipt.completedAt) && typeof receipt.incidentDigest === "string" && SHA256.test(receipt.incidentDigest)
      && Number.isSafeInteger(receipt.opened) && Number(receipt.opened) >= 0 && Number.isSafeInteger(receipt.recovered) && Number(receipt.recovered) >= 0 && typeof receipt.digestDue === "boolean"
      && (receipt.deliveryId === undefined || (typeof receipt.deliveryId === "string" && receipt.deliveryId.length > 0 && receipt.deliveryId.length <= 128))
      && (receipt.scenarioHandleDigest === undefined || (typeof receipt.scenarioHandleDigest === "string" && SHA256.test(receipt.scenarioHandleDigest)))
  })) throw new Error("Sanctuary health sweep receipts are invalid")
  return health
}

function parseHealthProbeReceipt(raw: string | null, label: SanctuaryUnit16EvidenceLabel, scenarioHandleDigest: string): SanctuaryHealthProbeReceipt | undefined {
  if (raw === null) return undefined
  if (Buffer.byteLength(raw) > 128 * 1024) throw new Error("Sanctuary health probe receipt exceeds its bound")
  const receipt = object(JSON.parse(raw) as unknown, "Sanctuary health probe receipt")
  const exactKeys = ["beforeStateDigest", "clockMode", "cronDegradedAfter", "cronDegradedBefore", "cronFingerprintAfter", "cronFingerprintBefore", "cronRegisteredAfter", "cronRegisteredBefore", "deliveryCount", "effectiveNow", "fixtureSequenceDigest", "label", "ownerContainerDigestAfter", "ownerContainerDigestBefore", "ownerImageDigestAfter", "ownerImageDigestBefore", "phases", "privateTurnCount", "productionRestored", "providerInvocationCount", "realCheckEquivalent", "restoredStateDigest", "scenarioHandleDigest", "schemaVersion", "snapshotAbsent", "socketAbsent", "workspaceAbsent"].sort()
  const supportedLabel = label === "unit-16f-cron-fingerprint" || label === "unit-16g-health-transition" || label === "unit-16h-daily-digest"
  const digestFields = ["ownerImageDigestBefore", "ownerImageDigestAfter", "ownerContainerDigestBefore", "ownerContainerDigestAfter", "beforeStateDigest", "restoredStateDigest", "cronFingerprintBefore", "cronFingerprintAfter", "fixtureSequenceDigest"] as const
  const booleanFields = ["cronRegisteredBefore", "cronRegisteredAfter", "cronDegradedBefore", "cronDegradedAfter", "workspaceAbsent", "socketAbsent", "snapshotAbsent", "realCheckEquivalent", "productionRestored"] as const
  if (!supportedLabel || JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(exactKeys) || receipt.schemaVersion !== "sanctuary-health-probe-receipt-v1"
    || receipt.label !== label || receipt.scenarioHandleDigest !== scenarioHandleDigest || !SHA256.test(scenarioHandleDigest)
    || !digestFields.every((field) => typeof receipt[field] === "string" && SHA256.test(receipt[field]))
    || !booleanFields.every((field) => typeof receipt[field] === "boolean") || !canonicalIso(receipt.effectiveNow)
    || (receipt.clockMode !== "ambient" && receipt.clockMode !== "local-daily-boundary")
    || !Number.isSafeInteger(receipt.privateTurnCount) || Number(receipt.privateTurnCount) < 0 || Number(receipt.privateTurnCount) > 1_000
    || !Number.isSafeInteger(receipt.providerInvocationCount) || Number(receipt.providerInvocationCount) < Number(receipt.privateTurnCount) || Number(receipt.providerInvocationCount) > 1_000
    || !Number.isSafeInteger(receipt.deliveryCount) || Number(receipt.deliveryCount) < 0 || Number(receipt.deliveryCount) > 1_000
    || !Array.isArray(receipt.phases) || receipt.phases.length < 1 || receipt.phases.length > 8) throw new Error("Sanctuary health probe receipt schema is invalid")
  const phases = receipt.phases.map((rawPhase, index) => {
    const phase = object(rawPhase, "Sanctuary health probe phase")
    const phaseKeys = ["deliveryKind", "deliveryReceiptDigest", "digestDue", "fixtureStatus", "name", "opened", "ordinal", "recovered", "sweepReceiptDigest", "trigger"].sort()
    if (JSON.stringify(Object.keys(phase).sort()) !== JSON.stringify(phaseKeys) || phase.ordinal !== index + 1
      || typeof phase.name !== "string" || phase.name.length < 1 || phase.name.length > 64 || (phase.trigger !== "cron" && phase.trigger !== "acceptance")
      || (phase.fixtureStatus !== null && phase.fixtureStatus !== 200 && phase.fixtureStatus !== 503)
      || !Number.isSafeInteger(phase.opened) || Number(phase.opened) < 0 || !Number.isSafeInteger(phase.recovered) || Number(phase.recovered) < 0
      || typeof phase.digestDue !== "boolean" || (phase.deliveryKind !== null && !["transition", "digest", "transition_and_digest"].includes(String(phase.deliveryKind)))
      || typeof phase.sweepReceiptDigest !== "string" || !SHA256.test(phase.sweepReceiptDigest)
      || (phase.deliveryReceiptDigest !== null && (typeof phase.deliveryReceiptDigest !== "string" || !SHA256.test(phase.deliveryReceiptDigest)))) throw new Error("Sanctuary health probe phase is invalid")
    return phase as unknown as SanctuaryHealthProbeReceipt["phases"][number]
  })
  const fixtureSequence = phases.flatMap((phase) => phase.fixtureStatus === null ? [] : [phase.fixtureStatus])
  const expectedSequenceDigest = createHash("sha256").update(JSON.stringify(fixtureSequence)).digest("hex")
  const deliveryCount = phases.filter((phase) => phase.deliveryReceiptDigest !== null).length
  if (receipt.fixtureSequenceDigest !== expectedSequenceDigest || receipt.deliveryCount !== deliveryCount) throw new Error("Sanctuary health probe receipt counters are invalid")
  if (receipt.ownerImageDigestBefore !== receipt.ownerImageDigestAfter || receipt.ownerContainerDigestBefore !== receipt.ownerContainerDigestAfter
    || receipt.beforeStateDigest !== receipt.restoredStateDigest || receipt.cronFingerprintBefore !== receipt.cronFingerprintAfter
    || receipt.cronRegisteredBefore !== true || receipt.cronRegisteredAfter !== true || receipt.cronDegradedBefore !== false || receipt.cronDegradedAfter !== false
    || receipt.workspaceAbsent !== true || receipt.socketAbsent !== true || receipt.snapshotAbsent !== true || receipt.realCheckEquivalent !== true || receipt.productionRestored !== true) {
    throw new Error("Sanctuary health probe did not restore its exact production owner and state")
  }
  if (label === "unit-16h-daily-digest") {
    const effective = new Date(receipt.effectiveNow as string)
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(effective)
    const part = (type: string): number => Number(parts.find((entry) => entry.type === type)?.value ?? NaN)
    if (receipt.clockMode !== "local-daily-boundary" || part("hour") !== 9 || part("minute") !== 0 || part("second") !== 0 || effective.getUTCMilliseconds() !== 0) throw new Error("Sanctuary health digest clock is not the exact local daily boundary")
  } else if (receipt.clockMode !== "ambient") throw new Error("Sanctuary health probe clock mode is invalid")
  const { schemaVersion: _schemaVersion, ...validated } = receipt
  return { ...validated, phases } as SanctuaryHealthProbeReceipt
}

function auditContainsSensitiveMaterial(raw: string): boolean {
  return /\b\d{5,16}:[A-Za-z0-9_-]{20,}\b/u.test(raw)
    || /"(?:authorizedUserId|authorizedChatId|transportUserId|transportChatId|userId|chatId)"\s*:\s*"?\d{5,16}"?/u.test(raw)
    || /"(?:botToken|apiKey|password|secret)"\s*:\s*"(?!\[REDACTED\])[^"\n]+"/u.test(raw)
}

function millisecondsAfterLocalNine(timestamp: number): number | null {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(timestamp))
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? NaN)
  const milliseconds = ((value("hour") - 9) * 60 * 60 + value("minute") * 60 + value("second")) * 1_000
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : null
}

function canonicalSanctuaryHealthCronRegistered(raw: string): boolean {
  const lines = raw.split(/\r?\n/u)
  const marker = "# ouro:habit:sanctuary:sanctuary:sanctuary-health"
  const command = "*/15 * * * * /usr/local/bin/node /opt/ouro/dist/heart/daemon/ouro-entry.js poke sanctuary --habit sanctuary-health --trigger cron"
  const index = lines.indexOf(marker)
  return index >= 0 && lines[index + 1] === command
}

function readBoundedIdentitySurfaces(agentRoot: string): string[] {
  const roots = [
    pathFor(agentRoot, "state/senses/telegram/identity-subjects.json"),
    pathFor(agentRoot, "friends"),
    pathFor(agentRoot, "state/sessions"),
    pathFor(agentRoot, "state/pending"),
    pathFor(agentRoot, "state/daemon/logs"),
  ]
  const records: string[] = []
  let totalBytes = 0
  let visitedFiles = 0
  const visit = (target: string, depth: number): void => {
    if (depth > 6) throw new Error("identity surface audit exceeds its depth bound")
    try {
      const entries = readdirSync(target, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        if (entry.isSymbolicLink()) throw new Error("identity surface audit refuses symbolic links")
        const child = pathFor(target, entry.name)
        if (entry.isDirectory()) visit(child, depth + 1)
        else if (entry.isFile()) {
          visitedFiles += 1
          if (visitedFiles > 2_000) throw new Error("identity surface audit exceeds its file-count bound")
          const raw = readFileSync(child, "utf8")
          totalBytes += Buffer.byteLength(raw)
          if (totalBytes > 16 * 1024 * 1024 || Buffer.byteLength(raw) > 1024 * 1024) throw new Error("identity surface audit exceeds its bound")
          if (entry.name.endsWith(".json")) JSON.parse(raw)
          records.push(path.relative(agentRoot, child), raw)
        } else throw new Error("identity surface audit found an unsupported filesystem entry")
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
        try {
          const raw = readFileSync(target, "utf8")
          totalBytes += Buffer.byteLength(raw)
          if (totalBytes > 16 * 1024 * 1024 || Buffer.byteLength(raw) > 1024 * 1024) throw new Error("identity surface audit exceeds its bound")
          JSON.parse(raw)
          records.push(path.relative(agentRoot, target), raw)
        } catch (fileError) { if ((fileError as NodeJS.ErrnoException).code !== "ENOENT") throw fileError }
      } else throw error
    }
  }
  for (const root of roots) visit(root, 0)
  return records
}

function parseTelegramTurnReceipts(raw: string, scenarioHandleDigest: string): SanctuaryScenarioFacts["telegramTurns"] {
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error("Telegram turn receipt ledger exceeds its bound")
  const lines = raw.split("\n").filter(Boolean)
  if (lines.length > 500 || lines.some((line) => Buffer.byteLength(line) > 16 * 1024)) throw new Error("Telegram turn receipt ledger exceeds its bound")
  const exactKeys = ["completedAt", "deliveries", "deliveryCount", "errorCategory", "providerInvocationCount", "responseDigest", "scenarioHandleDigest", "schemaVersion", "sequenceDigest", "status", "toolInvocationCount", "toolResultDigests", "updateDigest"].sort()
  return lines.flatMap((line) => {
    const receipt = object(JSON.parse(line) as unknown, "Telegram turn receipt")
    const deliveries = receipt.deliveries
    if (JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(exactKeys)
      || receipt.schemaVersion !== "sanctuary-telegram-turn-receipt-v3"
      || typeof receipt.scenarioHandleDigest !== "string" || !SHA256.test(receipt.scenarioHandleDigest)
      || (receipt.status !== "success" && receipt.status !== "error")
      || (receipt.status === "success" ? receipt.errorCategory !== null : typeof receipt.errorCategory !== "string" || receipt.errorCategory.length < 1 || receipt.errorCategory.length > 128)
      || ![receipt.updateDigest, receipt.sequenceDigest, receipt.responseDigest].every((value) => typeof value === "string" && SHA256.test(value))
      || !Array.isArray(receipt.toolResultDigests) || receipt.toolResultDigests.length > 100 || !receipt.toolResultDigests.every((value) => typeof value === "string" && SHA256.test(value))
      || !Array.isArray(deliveries) || deliveries.length > 100 || !deliveries.every((value) => {
        const delivery = object(value, "Telegram delivery receipt")
        return JSON.stringify(Object.keys(delivery).sort()) === JSON.stringify(["chunkDigest", "messageIdDigest"])
          && typeof delivery.messageIdDigest === "string" && SHA256.test(delivery.messageIdDigest)
          && typeof delivery.chunkDigest === "string" && SHA256.test(delivery.chunkDigest)
      })
      || ![receipt.providerInvocationCount, receipt.toolInvocationCount].every((value) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000)
      || !Number.isSafeInteger(receipt.deliveryCount) || receipt.deliveryCount !== deliveries.length
      || typeof receipt.completedAt !== "string" || receipt.completedAt.length > 30 || !Number.isFinite(Date.parse(receipt.completedAt)) || new Date(Date.parse(receipt.completedAt)).toISOString() !== receipt.completedAt) {
      throw new Error("Telegram turn receipt ledger row is invalid")
    }
    if (receipt.scenarioHandleDigest !== scenarioHandleDigest) return []
    return [{
      status: receipt.status, updateDigest: String(receipt.updateDigest), sequenceDigest: String(receipt.sequenceDigest), responseDigest: String(receipt.responseDigest),
      toolResultDigests: receipt.toolResultDigests as string[], providerTurnCount: Number(receipt.providerInvocationCount),
      toolInvocationCount: Number(receipt.toolInvocationCount), deliveryCount: Number(receipt.deliveryCount),
      telegramMessageIdDigests: deliveries.map((delivery) => String((delivery as JsonObject).messageIdDigest)), completedAt: Date.parse(receipt.completedAt),
    }]
  })
}

export async function readDefaultSanctuaryScenarioFacts(
  label: (typeof SANCTUARY_UNIT_16_EVIDENCE_LABELS)[number],
  scenarioHandleDigest: string,
  deps: SanctuaryAcceptanceAdapterDependencies,
  configuredAgentRoot = getAgentRoot(TARGET_ID),
  options: { skipContainerSnapshot?: boolean; containerSnapshot?: JsonObject } = {},
): Promise<SanctuaryScenarioFacts> {
  if (options.skipContainerSnapshot === true && options.containerSnapshot !== undefined) throw new Error("container snapshot options are mutually exclusive")
  const agentRoot = configuredAgentRoot
  const identityRaw = optionalFixedFile(deps, pathFor(agentRoot, "state/senses/telegram/identity.key"))
  const auditRaw = optionalFixedFile(deps, TELEGRAM_AUDIT) ?? ""
  const offsetRaw = optionalFixedFile(deps, TELEGRAM_OFFSET)
  const checkpointsRaw = optionalFixedFile(deps, pathFor(agentRoot, "state/approvals/checkpoints.json"))
  const restartAttemptsRaw = optionalFixedFile(deps, pathFor(agentRoot, "state/acceptance/restart-attempts.ndjson")) ?? ""
  const telegramTurnsRaw = optionalFixedFile(deps, pathFor(agentRoot, "state/acceptance/telegram-turns.ndjson")) ?? ""
  const cronRaw = optionalFixedFile(deps, "/home/ouro/.ouro-cli/scheduler/sanctuary.crontab")
  const healthRaw = optionalFixedFile(deps, pathFor(agentRoot, "state/health/sanctuary-health.json"))
  const healthProbeRaw = optionalFixedFile(deps, pathFor(agentRoot, `state/acceptance/health-probe-receipts/${scenarioHandleDigest}.json`))
  const agentConfig = parsedJson(optionalFixedFile(deps, pathFor(agentRoot, "agent.json")))
  const readinessPolicy = parsedJson(optionalFixedFile(deps, pathFor(agentRoot, "provider-readiness.json")))
  const rebootRaw = optionalFixedFile(deps, "/evidence/reboot.json")
  const expectedImageId = optionalFixedFile(deps, IMAGE_DIGEST_FILE)?.trim()
  let stopDenied = false
  let restartDenied = false
  let denialAuditCount = 0
  let denialStateUnchanged = false
  let denialProbeCompleted = false
  let denialReceipt: JsonObject | null = null
  if (label === "unit-16e-1-stop-denial" || label === "unit-16e-2-restart-denial") {
    const runtime = readMachineRuntimeCredentialConfig(TARGET_ID)
    if (runtime.ok) {
      const endpoint = exactLoopbackGraphqlEndpoint(runtime.config.unraidGraphqlUrl)
      const readKey = text(runtime.config.unraidReadApiKey, "read-only Unraid credential")
      const topologyQuery = "query AcceptanceDenialTarget { docker { containers(skipCache: true) { id names state status } } }"
      const readTarget = async (): Promise<JsonObject> => {
        const targetResponse = await deps.fetch(endpoint.href, { method: "POST", headers: { "content-type": "application/json", "x-api-key": readKey }, body: JSON.stringify({ query: topologyQuery, variables: {} }), signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) })
        const targetEnvelope = object(await targetResponse.json(), "read-only denial target response")
        const docker = object(object(targetEnvelope.data, "read-only denial target data").docker, "read-only denial target docker")
        if (!Array.isArray(docker.containers)) throw new Error("read-only denial target list is invalid")
        const matches = docker.containers.map((entry) => object(entry, "read-only denial target")).filter((entry) => Array.isArray(entry.names) && entry.names.some((name) => name === "ouro-butler" || name === "/ouro-butler"))
        if (matches.length !== 1 || typeof matches[0]!.id !== "string") throw new Error("read-only denial target is absent or ambiguous")
        return matches[0]!
      }
      const beforeTarget = await readTarget()
      const targetId = text(beforeTarget.id, "read-only denial target id")
      const query = label === "unit-16e-1-stop-denial"
        ? "mutation AcceptanceStopDenial($id: PrefixedID!) { docker { stop(id: $id) { id } } }"
        : WRITE_PROBE
      const response = await deps.fetch(endpoint.href, { method: "POST", headers: { "content-type": "application/json", "x-api-key": readKey }, body: JSON.stringify({ query, variables: { id: targetId } }), signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) })
      const envelope = object(await response.json(), "read-only mutation denial response")
      const codes = Array.isArray(envelope.errors) ? envelope.errors.map((raw) => object(raw, "read-only denial error")).map((error) => {
        const extensions = error.extensions && typeof error.extensions === "object" && !Array.isArray(error.extensions) ? error.extensions as JsonObject : {}
        return extensions.code
      }) : []
      const denied = !envelope.data && (response.status === 403 || codes.includes("FORBIDDEN") || codes.includes("PERMISSION_DENIED"))
      const afterTarget = await readTarget()
      const beforeDigest = createHash("sha256").update(JSON.stringify(beforeTarget)).digest("hex")
      const afterDigest = createHash("sha256").update(JSON.stringify(afterTarget)).digest("hex")
      denialStateUnchanged = beforeDigest === afterDigest
      denialProbeCompleted = true
      denialReceipt = { operation: label === "unit-16e-1-stop-denial" ? "stop" : "restart", targetDigest: createHash("sha256").update(targetId).digest("hex"), beforeDigest, afterDigest, denied, probeCompleted: denialProbeCompleted }
      if (label === "unit-16e-1-stop-denial") stopDenied = denied
      else restartDenied = denied
      denialAuditCount = denied ? 1 : 0
    }
  }
  const auditEntries = parseScenarioAudit(auditRaw, scenarioHandleDigest)
  const expectedTelegramTools = ["unraid_list_containers", "unraid_get_container_logs", "unraid_get_storage", "unraid_get_disks", "unraid_get_notifications", "unraid_get_system", "unraid_restart_container", "ponder", "settle", "speak"]
  const toolProfiles = parsedJson(optionalFixedFile(deps, SANCTUARY_TOOL_PROFILES_FILE))
  const profiles = toolProfiles ? object(toolProfiles.profiles, "Sanctuary tool profiles") : null
  const telegramProfile = profiles?.["sanctuary-telegram"]
  const toolSurfaceExact = Array.isArray(telegramProfile) && JSON.stringify(telegramProfile) === JSON.stringify(expectedTelegramTools)
    && expectedTelegramTools.every((name) => resolveToolDefinition(name) !== undefined)
  let approvalRecords = [] as ReturnType<typeof readApprovalsByScenarioHandleDigest>
  const approvalDatabasePath = pathFor(agentRoot, "state/approvals/approvals.sqlite")
  if (existsSync(approvalDatabasePath)) approvalRecords = readApprovalsByScenarioHandleDigest(approvalDatabasePath, scenarioHandleDigest)
  const approvals = approvalRecords.map(({ approval: record, continuation }) => {
    const boundEvents = auditEntries.filter((entry) => entry.meta.approvalId === record.approvalId)
    const terminalized = boundEvents.some((entry) => entry.event === "telegram.approval_prompt_terminalized" && entry.meta.buttonsRemoved === true)
    const callbackEvents = boundEvents.filter((entry) => entry.event === "telegram.callback_settled")
    const claimCount = boundEvents.filter((entry) => entry.event === "approval.acceptance_transition" && entry.meta.state === "claimed").length
    const restartExecutionCount = boundEvents.filter((entry) => entry.event === "senses.telegram_approved_restart_end").length
    return ({
    approvalId: record.approvalId,
    state: record.state,
    toolName: record.toolName,
    createdAt: Date.parse(record.createdAt),
    expiresAt: Date.parse(record.expiresAt),
    updatedAt: Date.parse(record.updatedAt),
    attempted: record.attemptedAt !== null,
    continuationCompleted: continuation?.continuationState === "completed",
    buttonsRemoved: terminalized,
    terminalPrompt: terminalized,
    callbackCount: callbackEvents.length,
    settledCount: callbackEvents.length,
    claimCount,
    replayMutationCount: Math.max(0, restartExecutionCount - (record.state === "succeeded" ? 1 : 0)),
    staleAcknowledged: callbackEvents.some((entry) => entry.meta.reason === "stale_callback" || entry.meta.reason === "expired"),
    argumentDigest: record.argumentDigest,
    target: typeof record.arguments.container === "string" ? record.arguments.container : null,
    })
  })
  const restartAttempts = parseRestartAttempts(restartAttemptsRaw, scenarioHandleDigest)
  const telegramTurns = parseTelegramTurnReceipts(telegramTurnsRaw, scenarioHandleDigest)
  let identity: SanctuaryScenarioFacts["identity"]
  if (identityRaw && /^[A-Za-z0-9_-]{43}\n?$/u.test(identityRaw)) {
    const credentials = deps.telegramCredentials ? deps.telegramCredentials() : loadTelegramSenseCredentials(TARGET_ID)
    const identityKey = identityRaw.trim()
    const identityPayload = [
      TELEGRAM_SUBJECT_DOMAIN,
      `user:${credentials.authorizedUserId.length}:${credentials.authorizedUserId}`,
      `chat:${credentials.authorizedChatId.length}:${credentials.authorizedChatId}`,
    ].join("\0")
    const expectedSubject = `tg_${createHmac("sha256", identityKey).update(identityPayload, "utf8").digest("base64url")}`
    const observedSubjects = auditEntries.flatMap((entry) => typeof entry.meta.subject === "string" ? [entry.meta.subject] : [])
    const approvalSubjects = approvalRecords.map((projection) => projection.approval).filter((record) => record.transport === "telegram").map((record) => record.requesterId)
    const rawValues = [...new Set([credentials.botToken, credentials.authorizedUserId, credentials.authorizedChatId])]
    const surfaceRecords = [...readBoundedIdentitySurfaces(agentRoot), auditRaw, JSON.stringify(approvalRecords)]
    const surfaceSubjects = surfaceRecords.flatMap((raw) => raw.match(/tg_[A-Za-z0-9_-]{43}/gu) ?? [])
    const structuredRawId = /"(?:authorizedUserId|authorizedChatId|transportUserId|transportChatId|userId|chatId|updateId|messageId)"\s*:\s*"?\d{1,20}"?/gu
    const rawLeakCount = surfaceRecords.reduce((count, raw) => count + rawValues.filter((value) => raw.includes(value)).length + (raw.match(structuredRawId)?.length ?? 0), 0)
    const mismatchCount = [...surfaceSubjects, ...observedSubjects, ...approvalSubjects].filter((subject) => subject !== expectedSubject).length
    identity = {
      keyPresent: true,
      subjectOpaque: /^tg_[A-Za-z0-9_-]{43}$/u.test(expectedSubject)
        && mismatchCount === 0,
      rawIdentityAbsent: rawLeakCount === 0,
      liveSubjectObserved: observedSubjects.includes(expectedSubject) && telegramTurns.some((turn) => turn.status === "success"),
      inspectedRecordCount: surfaceRecords.length,
      opaqueSubjectCount: [...surfaceSubjects, ...observedSubjects, ...approvalSubjects].filter((subject) => subject === expectedSubject).length,
      mismatchCount,
      rawLeakCount,
      surfaceDigest: createHash("sha256").update(JSON.stringify(surfaceRecords)).digest("hex"),
    }
  }
  const container = options.skipContainerSnapshot === true
    ? null
    : options.containerSnapshot !== undefined
      ? ownerContainerSnapshot(options.containerSnapshot)
      : deps.hostRequest ? object(await deps.hostRequest({ operation: "container_snapshot", targetId: TARGET_ID }), "container snapshot") : null
  const rebootCheckpoint = parsedJson(rebootRaw)
  let reboot: SanctuaryScenarioFacts["reboot"]
  if (rebootCheckpoint?.operation === "reboot" && rebootCheckpoint.phase === "preflight" && rebootCheckpoint.targetId === TARGET_ID
    && typeof rebootCheckpoint.idempotencyDigest === "string" && SHA256.test(rebootCheckpoint.idempotencyDigest)) {
    reboot = {
      phase: "preflight", requestDigest: rebootCheckpoint.idempotencyDigest, requestCount: 0, checkpointPersisted: true, unrelatedHostOperations: 0,
      bootIdentityChanged: false, hostReady: false, arrayReady: false, dockerReady: false, butlerReady: false, tailscaleReady: false, sshReady: false,
    }
  } else if (rebootCheckpoint?.operation === "reboot" && ["requested", "complete"].includes(String(rebootCheckpoint.phase))
    && typeof rebootCheckpoint.requestId === "string" && SHA256.test(rebootCheckpoint.requestId)
    && typeof rebootCheckpoint.prebootDigest === "string" && SHA256.test(rebootCheckpoint.prebootDigest)) {
    const milestones = container && container.recoveryMilestones && typeof container.recoveryMilestones === "object" && !Array.isArray(container.recoveryMilestones)
      ? container.recoveryMilestones as JsonObject : {}
    const complete = rebootCheckpoint.phase === "complete" && typeof rebootCheckpoint.postbootDigest === "string" && SHA256.test(rebootCheckpoint.postbootDigest)
    reboot = {
      phase: rebootCheckpoint.phase as "requested" | "complete", requestDigest: createHash("sha256").update(rebootCheckpoint.requestId).digest("hex"), requestCount: 1, checkpointPersisted: true, unrelatedHostOperations: 0,
      bootIdentityChanged: complete && rebootCheckpoint.postbootDigest !== rebootCheckpoint.prebootDigest,
      hostReady: milestones.hostReady === true, arrayReady: milestones.arrayReady === true, dockerReady: milestones.dockerReady === true,
      butlerReady: milestones.butlerReady === true, tailscaleReady: milestones.tailscaleReady === true, sshReady: milestones.sshReady === true,
    }
  }
  const health = parseHealthAcceptanceState(healthRaw)
  const healthProbe = parseHealthProbeReceipt(healthProbeRaw, label, scenarioHandleDigest)
  const healthSweeps = health ? (health.sweepReceipts as JsonObject[]).filter((receipt) => receipt.scenarioHandleDigest === scenarioHandleDigest) : []
  const healthDeliveries = health ? health.deliveredReceipts as JsonObject[] : []
  const scenarioDeliveryIds = new Set(healthSweeps.flatMap((receipt) => typeof receipt.deliveryId === "string" ? [receipt.deliveryId] : []))
  const scenarioDeliveries = healthDeliveries.filter((receipt) => typeof receipt.deliveryId === "string" && scenarioDeliveryIds.has(receipt.deliveryId))
  const digestSweep = healthSweeps.findLast((receipt) => receipt.digestDue === true && typeof receipt.completedAt === "string")
  const digestFiredWithinMs = digestSweep ? millisecondsAfterLocalNine(Date.parse(String(digestSweep.completedAt))) : null
  let liveProvider: SanctuaryScenarioFacts["provider"]
  if (agentConfig && readinessPolicy && Array.isArray(readinessPolicy.providers)) {
    const outwardConfig = object(agentConfig.humanFacing, "outward provider")
    const innerConfig = object(agentConfig.agentFacing, "inner provider")
    const candidate = readinessPolicy.providers.map((entry) => object(entry, "provider readiness candidate"))
      .find((entry) => entry.provider === "openai-compatible-gemini")
    if (candidate && outwardConfig.provider === "openai-compatible" && innerConfig.provider === "openai-compatible") {
      const readCredential = deps.readProviderCredential ?? readProviderCredentialRecord
      const checkProvider = deps.providerPing ?? pingProvider
      const [glmRecord, geminiRecord] = await Promise.all([
        readCredential(TARGET_ID, "openai-compatible", { refreshIfMissing: false }),
        readCredential(TARGET_ID, "openai-compatible-gemini", { refreshIfMissing: false }),
      ])
      const outwardModel = text(outwardConfig.model, "outward model")
      const innerModel = text(innerConfig.model, "inner model")
      const glmConfig = glmRecord.ok ? { ...glmRecord.record.credentials, ...glmRecord.record.config } as unknown as Parameters<typeof pingProvider>[1] : null
      const unavailablePing: PingResult = { ok: false, classification: "auth-failure", message: "credential unavailable", attempts: [] }
      const [outwardPing, innerPing, geminiPing] = await Promise.all([
        glmConfig ? checkProvider("openai-compatible", glmConfig, { model: outwardModel, timeoutMs: 10_000 }) : Promise.resolve(unavailablePing),
        glmConfig ? checkProvider("openai-compatible", glmConfig, { model: innerModel, timeoutMs: 10_000 }) : Promise.resolve(unavailablePing),
        geminiRecord.ok ? checkProvider("openai-compatible-gemini", { ...geminiRecord.record.credentials, ...geminiRecord.record.config } as unknown as Parameters<typeof pingProvider>[1], { model: text(candidate.model, "Gemini candidate model"), timeoutMs: 10_000 }) : Promise.resolve(unavailablePing),
      ])
      const geminiModel = text(candidate.model, "Gemini candidate model")
      const pingReceipts = [
        { lane: "outward", provider: "openai-compatible", model: outwardModel, credentialRevision: glmRecord.ok ? glmRecord.record.revision : null, ok: outwardPing.ok, attempts: outwardPing.attempts?.map(({ provider, model, operation, ok }) => ({ provider, model, operation, ok })) ?? [] },
        { lane: "inner", provider: "openai-compatible", model: innerModel, credentialRevision: glmRecord.ok ? glmRecord.record.revision : null, ok: innerPing.ok, attempts: innerPing.attempts?.map(({ provider, model, operation, ok }) => ({ provider, model, operation, ok })) ?? [] },
        { lane: "candidate", provider: "openai-compatible-gemini", model: geminiModel, credentialRevision: geminiRecord.ok ? geminiRecord.record.revision : null, ok: geminiPing.ok, attempts: geminiPing.attempts?.map(({ provider, model, operation, ok }) => ({ provider, model, operation, ok })) ?? [] },
      ]
      const requestSemanticsExact = pingReceipts.every((receipt) => receipt.ok && receipt.attempts.length >= 1 && receipt.attempts.length <= 3
        && receipt.attempts.every((attempt) => attempt.provider === receipt.provider && attempt.model === receipt.model && attempt.operation === "ping" && typeof attempt.ok === "boolean")
        && receipt.attempts.at(-1)?.ok === true)
      const fallbackAttemptCount = pingReceipts.reduce((count, receipt) => count + receipt.attempts.filter((attempt) => attempt.provider !== receipt.provider || attempt.model !== receipt.model).length, 0)
      liveProvider = {
        outwardReady: outwardPing.ok,
        innerReady: innerPing.ok,
        geminiCandidateReady: geminiPing.ok,
        providersDistinct: candidate.provider !== outwardConfig.provider,
        silentFallback: readinessPolicy.selectionPolicy !== "explicit-same-lane-only",
        credentialRevisionsPresent: glmRecord.ok && geminiRecord.ok && Boolean(glmRecord.record.revision) && Boolean(geminiRecord.record.revision),
        requestSemanticsExact,
        fallbackAttemptCount,
        pingReceipts,
      }
    }
  }
  const sourceValues: Record<string, unknown> = {
    "identity-key": identityRaw, "telegram-audit": auditEntries, "telegram-offset": offsetRaw,
    "approval-journal": approvals, "approval-checkpoints": checkpointsRaw, "container-inspect": container,
    "provider-live-check": liveProvider ?? null, "cron-runtime": cronRaw, "health-runtime": health, "restart-attempt-ledger": restartAttempts,
    "digest-runtime": health, "reboot-checkpoint": rebootCheckpoint, "telegram-turn-receipts": telegramTurns, "read-only-denial-receipt": denialReceipt,
    "identity-surface-audit": identity ? { inspectedRecordCount: identity.inspectedRecordCount, opaqueSubjectCount: identity.opaqueSubjectCount, mismatchCount: identity.mismatchCount, rawLeakCount: identity.rawLeakCount, surfaceDigest: identity.surfaceDigest } : null,
    "containment-audit": { toolSurfaceExact, mountsExact: container?.mountsExact, securityExact: container?.securityExact, networkMode: container?.networkMode, writableKeyExposure: container?.writableKeyExposure },
    "health-probe-receipt": healthProbe ?? null,
  }
  return {
    capturedAt: deps.now?.() ?? Date.now(),
    sourceValues,
    events: auditEntries,
    approvals,
    restartAttempts,
    telegramTurns,
    identity,
    container: container ? {
      exactImage: typeof expectedImageId === "string" && SHA256.test(expectedImageId) && container.imageId === `sha256:${expectedImageId}`, running: container.running === true,
      healthy: container.health === "healthy", user: text(container.user, "container user"), readOnlyRoot: container.readOnlyRoot === true,
      mountCount: Number(container.mountCount), publishedPortCount: Number(container.publishedPortCount), restartPolicy: text(container.restartPolicy, "restart policy"), restartCount: Number(container.restartCount),
      autostartExact: container.autostartExact === true, updaterDisabled: container.updaterDisabled === true,
      vaultUnlocked: container.vaultUnlocked === true, manualAuthRequired: container.manualAuthRequired === true,
    } : undefined,
    provider: liveProvider,
    healthProbe,
    cron: cronRaw ? { registered: canonicalSanctuaryHealthCronRegistered(cronRaw), fingerprint: createHash("sha256").update(cronRaw).digest("hex"), receiptDigest: createHash("sha256").update(JSON.stringify(health?.deliveredReceipts ?? null)).digest("hex"), sweepCount: healthSweeps.length } : undefined,
    health: health ? { transitionCount: healthSweeps.filter((receipt) => Number(receipt.opened) > 0 || Number(receipt.recovered) > 0).length, alertCount: scenarioDeliveries.filter((receipt) => receipt.kind === "transition" || receipt.kind === "transition_and_digest").length, productionRestored: container?.running === true && container.health === "healthy" } : undefined,
    digest: health && digestFiredWithinMs !== null ? { scheduleObserved: Boolean(cronRaw && canonicalSanctuaryHealthCronRegistered(cronRaw)), messageCount: scenarioDeliveries.filter((receipt) => receipt.kind === "digest" || receipt.kind === "transition_and_digest").length, firedWithinMs: digestFiredWithinMs, productionRestored: container?.running === true && container.health === "healthy" } : undefined,
    reboot,
    containment: {
      auditComplete: Boolean(container && toolSurfaceExact && container.mountsExact === true && container.securityExact === true && container.networkMode === "host" && container.writableKeyExposure === false),
      readOnlyBoundaryHeld: Boolean(container?.readOnlyRoot === true && container.mountsExact === true && container.securityExact === true),
      sensitiveMaterialObserved: auditContainsSensitiveMaterial(auditRaw) || container?.writableKeyExposure === true,
      stopDenied, restartDenied, denialAuditCount, denialStateUnchanged, denialProbeCompleted,
    },
  }
}

function pathFor(root: string, suffix: string): string { return `${root}/${suffix}` }

async function captureAcceptanceScenario(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  const phase = text(payload.phase, "scenario phase")
  if (phase !== "begin" && phase !== "poll") throw new Error("scenario phase is invalid")
  exactKeys(payload, phase === "begin" ? ["operation", "phase", "label", "externalGate", "sources"] : ["operation", "phase", "label", "externalGate", "sources", "checkpointDigest"], "scenario payload")
  const label = text(payload.label, "scenario label") as SanctuaryUnit16EvidenceLabel
  if (!SANCTUARY_UNIT_16_EVIDENCE_LABELS.includes(label)) throw new Error("scenario label is invalid")
  const externalGate = text(payload.externalGate, "scenario external gate")
  if (externalGate !== SANCTUARY_SCENARIO_GATES[label]) throw new Error("scenario external gate is invalid")
  if (!Array.isArray(payload.sources) || JSON.stringify(payload.sources) !== JSON.stringify(SANCTUARY_SCENARIO_SOURCES[label])) throw new Error("scenario sources are invalid")
  if (!deps.captureScenario) throw new Error("scenario capture is unavailable")
  return deps.captureScenario({ phase, label, externalGate, sources: payload.sources, ...(phase === "poll" ? { checkpointDigest: text(payload.checkpointDigest, "scenario checkpoint digest") } : {}) })
}

function normalizePermission(value: unknown): { resource: string; actions: string[] } {
  const permission = object(value, "Unraid key permission")
  if (JSON.stringify(Object.keys(permission).sort()) !== JSON.stringify(["actions", "resource"])) throw new Error("Unraid key permission fields are invalid")
  const resource = text(permission.resource, "Unraid key permission resource")
  if (!PERMISSION_RESOURCES.has(resource)) throw new Error("Unraid key permission resource is invalid")
  if (!Array.isArray(permission.actions) || permission.actions.length === 0) throw new Error("Unraid key permission actions are invalid")
  const actions = permission.actions.map((action) => text(action, "Unraid key permission action"))
  if (new Set(actions).size !== actions.length || actions.some((action) => !PERMISSION_ACTIONS.has(action))) throw new Error("Unraid key permission actions are invalid")
  return { resource, actions: [...actions].sort() }
}

function normalizeKey(value: SanctuaryAcceptanceKeyMetadata | JsonObject): SanctuaryAcceptanceKeyMetadata {
  const key = value as unknown as JsonObject
  if (!Array.isArray(key.permissions)) throw new Error("Unraid key permissions are invalid")
  if (!Array.isArray(key.roles) || !key.roles.every((role) => typeof role === "string")) throw new Error("Unraid key roles are invalid")
  return {
    id: keyId(key.id),
    name: text(key.name, "Unraid key name"),
    permissions: key.permissions.map(normalizePermission),
    roles: [...key.roles],
  }
}

function scope(key: SanctuaryAcceptanceKeyMetadata): "read-only" | "bounded-write" | "legacy-write" {
  const flattened = key.permissions.flatMap((permission) => permission.actions.map((action) => `${permission.resource}:${action}`)).sort()
  if (JSON.stringify(flattened) === JSON.stringify(RO_PERMISSIONS)) return "read-only"
  if (JSON.stringify(flattened) === JSON.stringify([...RO_PERMISSIONS, "DOCKER:UPDATE_ANY"].sort())) return "bounded-write"
  return "legacy-write"
}

function sameSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8")
  const rightBytes = Buffer.from(right, "utf8")
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function exactLoopbackGraphqlEndpoint(value: unknown): URL {
  const endpoint = new URL(text(value, "endpoint"))
  if ((endpoint.protocol !== "http:" && endpoint.protocol !== "https:")
    || (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "localhost" && endpoint.hostname !== "::1")
    || endpoint.pathname !== "/graphql" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("probe endpoint must be an exact loopback GraphQL endpoint")
  }
  return endpoint
}

function inventory(deps: SanctuaryAcceptanceAdapterDependencies): SanctuaryAcceptanceKeyMetadata[] {
  const keys = deps.readKeyFiles().map(normalizeKey)
  if (new Set(keys.map((key) => key.id)).size !== keys.length) throw new Error("Unraid key inventory contains duplicate IDs")
  if (new Set(keys.map((key) => key.name)).size !== keys.length) throw new Error("Unraid key inventory contains duplicate names")
  return keys
}

async function vaultBackedCapabilityVerify(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  const id = keyId(payload.keyId)
  const capability = text(payload.capability, "capability")
  if (capability !== "read-only" && capability !== "bounded-write") throw new Error("capability is invalid")
  const args = [
    "exec", "-i", "ouro-butler-staging",
    "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
    "vault-probe", id, capability,
  ]
  const result = await deps.execFile("/usr/bin/docker", args)
  const response = object(JSON.parse(result.stdout) as unknown, "vault probe result")
  if (response.valid !== true || response.keyId !== id || response.capability !== capability) throw new Error("vault-backed capability verification failed")
  return { verified: true, keyId: id, capability }
}

function closedInventory(deps: SanctuaryAcceptanceAdapterDependencies): unknown {
  return {
    keys: inventory(deps).map((key) => ({
      id: key.id,
      scope: scope(key),
      roles: key.roles.length === 0 ? "none" : "present",
    })).sort((left, right) => left.id.localeCompare(right.id)),
  }
}

async function exactIdRevoke(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  const id = keyId(payload.keyId)
  const matches = inventory(deps).filter((key) => key.id === id)
  if (matches.length !== 1) throw new Error("exact Unraid key ID is absent or ambiguous")
  const target = matches[0]!
  const result = await deps.execFile("/usr/local/sbin/unraid-api", ["apikey", "--name", target.name, "--delete", "--json"])
  const response = object(JSON.parse(result.stdout) as unknown, "Unraid revoke result")
  if (response.deleted !== 1 || !Array.isArray(response.keys) || response.keys.length !== 1) throw new Error("Unraid revoke result is invalid")
  const deleted = object(response.keys[0], "deleted Unraid key")
  if (deleted.id !== id || deleted.name !== target.name) throw new Error("Unraid revoke did not return the exact key ID")
  return { revoked: true, id }
}

async function revokedKeyAuthRejection(
  payload: JsonObject,
  deps: Pick<SanctuaryAcceptanceAdapterDependencies, "readDescriptor" | "fetch">,
): Promise<unknown> {
  const id = keyId(payload.keyId)
  const endpoint = exactLoopbackGraphqlEndpoint(payload.endpoint)
  const descriptorPayload = object(JSON.parse(deps.readDescriptor()) as unknown, "revoked-key descriptor")
  if (JSON.stringify(Object.keys(descriptorPayload).sort()) !== JSON.stringify(["descriptor", "keyId"])) throw new Error("revoked-key descriptor shape is invalid")
  if (keyId(descriptorPayload.keyId) !== id) throw new Error("revoked-key descriptor ID mismatch")
  const descriptor = text(descriptorPayload.descriptor, "revoked-key descriptor value")
  const signal = AbortSignal.timeout(NETWORK_TIMEOUT_MS)
  const response = await deps.fetch(endpoint.href, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": descriptor },
    body: JSON.stringify({ query: AUTH_PROBE, variables: {} }),
    signal,
  })
  if (response.status !== 401 && response.status !== 403) throw new Error("revoked Unraid key did not receive an authentication rejection")
  return { rejected: true, id, status: response.status }
}

function dependency<T>(value: T | undefined, label: string): T {
  if (!value) throw new Error(`${label} is unavailable`)
  return value
}

function exactKeys(value: JsonObject, keys: string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(`${label} shape is invalid`)
}

function positiveDecimal(value: unknown, label: string): string {
  const result = text(value, label)
  if (!/^[1-9][0-9]*$/u.test(result)) throw new Error(`${label} is invalid`)
  return result
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function fixedFile(deps: SanctuaryAcceptanceAdapterDependencies, filePath: string): string {
  return dependency(deps.readFixedFile, "fixed file reader")(filePath)
}

async function runtimeConfig(
  reader: ((...args: string[]) => Promise<RuntimeCredentialConfigReadResult>) | undefined,
  label: string,
  ...args: string[]
): Promise<JsonObject> {
  const result = await dependency(reader, label)(...args)
  if (!result.ok) throw new Error(`${label} is unavailable`)
  return result.config
}

async function storeTelegramBootstrap(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  const patch = {
    telegramBotToken: text(payload.botToken, "Telegram bot credential"),
    telegramAuthorizedUserId: positiveDecimal(payload.authorizedUserId, "Telegram authorized user"),
    telegramAuthorizedChatId: positiveDecimal(payload.authorizedChatId, "Telegram authorized chat"),
  }
  const stored = await dependency(deps.mergeRuntime, "runtime vault writer")(TARGET_ID, patch)
  if (!stored.ok || Object.entries(patch).some(([key, value]) => stored.config[key] !== value)) {
    throw new Error("Telegram bootstrap vault readback failed")
  }
  return { stored: true }
}

function cursorSnapshot(deps: SanctuaryAcceptanceAdapterDependencies): { offsetDigest: string; auditCursorDigest: string } {
  const offsetRaw = fixedFile(deps, TELEGRAM_OFFSET)
  const offset = object(JSON.parse(offsetRaw) as unknown, "Telegram offset")
  if (!Number.isSafeInteger(offset.nextUpdateId) || (offset.nextUpdateId as number) < 0) throw new Error("Telegram offset is invalid")
  return {
    offsetDigest: sha256(JSON.stringify({ nextUpdateId: offset.nextUpdateId })),
    auditCursorDigest: sha256(fixedFile(deps, TELEGRAM_AUDIT)),
  }
}

function telegramPollerQuiescence(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): unknown {
  if (payload.expectedState !== "stopped" || JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(["expectedState", "operation"])) {
    throw new Error("Telegram poller quiescence request is invalid")
  }
  const fact = object(JSON.parse(fixedFile(deps, TELEGRAM_POLLER_COUNT_FILE)) as unknown, "Telegram poller count")
  exactKeys(fact, ["activePollers", "productionContainerStopped"], "Telegram poller count")
  if (fact.activePollers !== 0 || fact.productionContainerStopped !== true) throw new Error("Telegram poller is not quiescent")
  return { quiesced: true, activePollers: 0 }
}

function callbackUpdate(value: unknown): JsonObject {
  const update = object(value, "callback update")
  object(update.callback_query, "callback update callback_query")
  return update
}

async function concurrentCallbackProbe(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  const update = callbackUpdate(payload.update)
  if (!Number.isSafeInteger(payload.concurrency) || (payload.concurrency as number) < 2 || (payload.concurrency as number) > 16) {
    throw new Error("callback concurrency is invalid")
  }
  const probe = dependency(deps.callbackProbe, "callback probe")
  const results = await Promise.all(Array.from({ length: payload.concurrency as number }, () => probe(update, false)))
  return { results }
}

async function callbackReplay(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  return dependency(deps.callbackProbe, "callback probe")(callbackUpdate(payload.update), true)
}

function requireTargetServer(payload: JsonObject): void {
  if (text(payload.targetServerId, "targetServerId") !== TARGET_SERVER_ID) throw new Error("targetServerId is invalid")
}

function flattenedPermissions(record: SanctuaryAcceptanceKeyMetadata): string[] {
  return record.permissions.flatMap((permission) => permission.actions.map((action) => `${permission.resource}:${action}`)).sort()
}

async function keyInventory(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  requireTargetServer(payload)
  const response = object(await dependency(deps.hostRequest, "Sanctuary host broker")({
    operation: "inventory_keys", targetServerId: TARGET_SERVER_ID,
  }), "host key inventory")
  if (!Array.isArray(response.keys)) throw new Error("host key inventory is invalid")
  const keys = response.keys.map(normalizeKey)
  if (new Set(keys.map(({ id }) => id)).size !== keys.length || new Set(keys.map(({ name }) => name)).size !== keys.length) {
    throw new Error("host key inventory is ambiguous")
  }
  return { keys: keys.map((record) => ({
    id: record.id, name: record.name, permissions: flattenedPermissions(record), roles: [...record.roles].sort(),
  })).sort((left, right) => left.id.localeCompare(right.id)) }
}

function permissionStrings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("permissions are invalid")
  const result = value.map((permission) => text(permission, "permission"))
  if (new Set(result).size !== result.length || result.some((permission) => !/^[A-Z_]+:(?:CREATE|READ|UPDATE|DELETE)_(?:ANY|OWN)$/u.test(permission))) {
    throw new Error("permissions are invalid")
  }
  return [...result].sort()
}

async function createKey(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  requireTargetServer(payload)
  const name = text(payload.name, "Unraid key name")
  if (!/^Butler (?:RO|RW)(?: Rotation [0-9a-f]{16})?$/u.test(name)) throw new Error("Unraid key name is invalid")
  const permissions = permissionStrings(payload.permissions)
  const field = name.startsWith("Butler RO") ? "unraidReadApiKey" : "unraidWriteApiKey"
  const expected = field === "unraidReadApiKey" ? RO_PERMISSIONS : [...RO_PERMISSIONS, "DOCKER:UPDATE_ANY"].sort()
  if (JSON.stringify(permissions) !== JSON.stringify(expected)) throw new Error("Unraid key scope is invalid")
  const raw = object(await dependency(deps.hostRequest, "Sanctuary host broker")({
    operation: "create_key", targetServerId: TARGET_SERVER_ID, name, permissions,
  }), "created Unraid key")
  const created = normalizeKey(raw)
  const id = created.id
  const key = text(raw.key, "created Unraid key credential")
  if (created.name !== name || JSON.stringify(flattenedPermissions(created)) !== JSON.stringify(permissions)
    || created.roles.length !== 0) throw new Error("created Unraid key scope mismatch")
  const stored = await dependency(deps.mergeMachine, "machine vault writer")(TARGET_ID, TARGET_ID, {
    [field]: key,
    sanctuaryAcceptanceKeyHandles: { [id]: key },
  })
  if (!stored.ok || stored.config[field] !== key) throw new Error("created Unraid key vault readback failed")
  return { id, name, key: `unraid-key:${id}:${field}`, permissions, roles: [] }
}

async function storeKey(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  requireTargetServer(payload)
  const id = keyId(payload.keyId)
  const field = text(payload.vaultField, "vaultField")
  if (field !== "unraidReadApiKey" && field !== "unraidWriteApiKey") throw new Error("vaultField is invalid")
  const handle = text(payload.key, "Unraid key handle")
  if (handle !== `unraid-key:${id}:${field}`) throw new Error("Unraid key handle is invalid")
  const stored = await runtimeConfig(deps.refreshMachine, "Sanctuary machine runtime config", TARGET_ID, TARGET_ID)
  const handles = object(stored.sanctuaryAcceptanceKeyHandles, "vault-backed acceptance key handles")
  if (text(handles[id], "vault-backed Unraid credential") !== text(stored[field], "vault-backed Unraid credential")) {
    throw new Error("Unraid key handle does not bind to the active vault field")
  }
  return { stored: true, keyId: id }
}

async function probeKey(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  requireTargetServer(payload)
  const id = keyId(payload.id)
  const handle = text(payload.key, "Unraid key handle")
  const config = await runtimeConfig(deps.refreshMachine, "Sanctuary machine runtime config", TARGET_ID, TARGET_ID)
  const handleMatch = /^unraid-key:([A-Za-z0-9._:-]+):(unraidReadApiKey|unraidWriteApiKey)$/u.exec(handle)
  if (!handleMatch || handleMatch[1] !== id) throw new Error("Unraid key handle is invalid")
  const handles = object(config.sanctuaryAcceptanceKeyHandles, "vault-backed acceptance key handles")
  const key = text(handles[id], "vault-backed Unraid credential")
  const endpoint = exactLoopbackGraphqlEndpoint(config.unraidGraphqlUrl)
  let response: Response
  try {
    response = await deps.fetch(endpoint.href, {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ query: AUTH_PROBE, variables: {} }), signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    })
  } catch { throw new Error("Unraid key readiness probe failed") }
  const envelope = object(await response.json(), "Unraid key readiness response")
  if (!response.ok || !envelope.data || envelope.errors) throw new Error("Unraid key readiness probe failed")
  return { valid: true }
}

async function readOldKey(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  requireTargetServer(payload)
  const id = keyId(payload.id)
  const raw = object(await dependency(deps.hostRequest, "Sanctuary host broker")({
    operation: "read_key_record", targetServerId: TARGET_SERVER_ID, keyId: id,
  }), "old Unraid key record")
  const record = { ...normalizeKey(raw), key: text(raw.key, "old Unraid key credential") }
  if (record.id !== id) throw new Error("old Unraid key ID does not match the host record")
  const stored = await dependency(deps.mergeMachine, "machine vault writer")(TARGET_ID, TARGET_ID, { sanctuaryAcceptanceKeyHandles: { [id]: record.key } })
  if (!stored.ok) throw new Error("old Unraid key recovery storage failed")
  return { key: `unraid-key:${id}:legacy` }
}

async function revokeKey(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  requireTargetServer(payload)
  const id = keyId(payload.id)
  const response = object(await dependency(deps.hostRequest, "Sanctuary host broker")({
    operation: "revoke_key", targetServerId: TARGET_SERVER_ID, keyId: id,
  }), "host key revoke")
  if (response.revoked !== true || response.id !== id) throw new Error("host key revoke did not attest the exact ID")
  return { revoked: true, id }
}

async function probeRevokedKey(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  requireTargetServer(payload)
  const id = keyId(payload.id)
  const handle = text(payload.key, "revoked Unraid key handle")
  if (handle !== `unraid-key:${id}:legacy` && !handle.startsWith(`unraid-key:${id}:unraid`)) throw new Error("revoked Unraid key handle is invalid")
  const response = object(await dependency(deps.hostRequest, "Sanctuary host broker")({
    operation: "probe_revoked_key", targetServerId: TARGET_SERVER_ID, keyId: id,
  }), "revoked key host proof")
  if (response.valid !== false || response.id !== id || (response.status !== 401 && response.status !== 403)) {
    throw new Error("revoked Unraid key still authenticates")
  }
  const cleared = await dependency(deps.mergeMachine, "machine vault writer")(TARGET_ID, TARGET_ID, { sanctuaryAcceptanceKeyHandles: { [id]: "" } })
  if (!cleared.ok) throw new Error("revoked Unraid key recovery cleanup failed")
  return { valid: false, status: response.status, id }
}

function provenance(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): unknown {
  if (payload.schema !== "sanctuary-unit-16-provenance-v1") throw new Error("provenance schema is invalid")
  const imageDigest = fixedFile(deps, IMAGE_DIGEST_FILE).trim()
  const containerDigest = fixedFile(deps, CONTAINER_DIGEST_FILE).trim()
  if (!SHA256.test(imageDigest) || !SHA256.test(containerDigest)) throw new Error("live provenance digest is invalid")
  const cursor = cursorSnapshot(deps)
  return { imageDigest, containerDigest, cursorDigest: sha256(`${cursor.offsetDigest}\0${cursor.auditCursorDigest}`) }
}

function evidenceSnapshot(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): unknown {
  if (payload.schema !== "postboot-health-v1") throw new Error("evidence schema is invalid")
  const health = object(JSON.parse(fixedFile(deps, POSTBOOT_HEALTH_FILE)) as unknown, "postboot health")
  exactKeys(health, ["healthy"], "postboot health")
  if (typeof health.healthy !== "boolean") throw new Error("postboot health is invalid")
  const imageDigest = fixedFile(deps, IMAGE_DIGEST_FILE).trim()
  if (!SHA256.test(imageDigest)) throw new Error("container image digest is invalid")
  return { healthy: health.healthy, containerImageDigest: imageDigest, telegramOffsetDigest: cursorSnapshot(deps).offsetDigest }
}

function bootId(deps: SanctuaryAcceptanceAdapterDependencies): string {
  const value = fixedFile(deps, BOOT_ID_FILE).trim()
  if (!/^[A-Za-z0-9-]{4,128}$/u.test(value)) throw new Error("boot identity is invalid")
  return value
}

async function requestReboot(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  if (text(payload.targetId, "targetId") !== TARGET_ID) throw new Error("targetId is invalid")
  const idempotencyKey = text(payload.idempotencyKey, "idempotencyKey")
  if (!/^[0-9a-f]{32}$/u.test(idempotencyKey)) throw new Error("idempotencyKey is invalid")
  const response = object(await dependency(deps.hostRequest, "Sanctuary host broker")({
    operation: "request_reboot", targetId: TARGET_ID, idempotencyKey,
  }), "host reboot staging")
  const requestId = text(response.requestId, "host reboot requestId")
  const prebootId = text(response.prebootId, "host reboot prebootId")
  if (response.accepted !== true || response.staged !== true || response.targetId !== TARGET_ID
    || requestId !== sha256(`sanctuary-reboot\0${idempotencyKey}`)) throw new Error("host reboot staging attestation is invalid")
  return { accepted: true, targetId: TARGET_ID, requestId, prebootId }
}

function pollReboot(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): unknown {
  if (text(payload.targetId, "targetId") !== TARGET_ID) throw new Error("targetId is invalid")
  const requestId = text(payload.requestId, "requestId")
  if (!SHA256.test(requestId)) throw new Error("requestId is invalid")
  return { targetId: TARGET_ID, requestId, state: "ready", bootId: bootId(deps) }
}

function materializeConfig(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): unknown {
  const command = text(payload.command, "materializer command")
  const contract = object(JSON.parse(fixedFile(deps, CONTRACT_FILE)) as unknown, "acceptance contract")
  const templates = object(contract.configTemplates, "acceptance config templates")
  const template = object(templates[command], "acceptance config template")
  const config = { ...object(template.fixed, "acceptance fixed config") }
  const adapterPath = "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh"
  if (command === "telegram-bootstrap") {
    const offset = object(JSON.parse(fixedFile(deps, TELEGRAM_OFFSET)) as unknown, "Telegram offset")
    if (!Number.isSafeInteger(offset.nextUpdateId) || (offset.nextUpdateId as number) < 0) throw new Error("Telegram offset is invalid")
    Object.assign(config, { expectedBotId: "8541786263", expectedUsername: "MendelowCloudButlerBot", currentOffset: offset.nextUpdateId })
  } else if (command === "cursor-snapshot") {
    const phase = text(payload.phase, "cursor snapshot phase")
    if (phase !== "before" && phase !== "after") throw new Error("cursor snapshot phase is invalid")
    config.evidencePath = `/evidence/cursor-${phase}.json`
  } else if (command === "unraid-key-rotate") {
    const closed = object(JSON.parse(fixedFile(deps, CLOSED_INVENTORY_FILE)) as unknown, "closed Unraid inventory")
    if (!Array.isArray(closed.keys) || closed.keys.length === 0) throw new Error("closed Unraid inventory is empty")
    const ids = closed.keys.map((raw) => keyId(object(raw, "closed Unraid key").id))
    if (new Set(ids).size !== ids.length) throw new Error("closed Unraid inventory IDs are ambiguous")
    config.oldKeys = ids.sort().map((id) => ({ id, secretAdapter: adapterPath }))
  } else if (command === "evidence-bundle-index") {
    config.entries = SANCTUARY_UNIT_16_EVIDENCE_LABELS.map((label) => ({ label, path: `/evidence/${label}.json` }))
  }
  return config
}

export async function executeSanctuaryAcceptanceAdapter(
  rawPayload: unknown,
  deps: SanctuaryAcceptanceAdapterDependencies = createSanctuaryAcceptanceAdapterDependencies(),
): Promise<unknown> {
  const payload = object(rawPayload, "acceptance adapter payload")
  const operation = text(payload.operation, "operation")
  emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_acceptance_adapter_start", message: "Sanctuary acceptance adapter started", meta: { operation } })
  try {
    let result: unknown
    switch (operation) {
      case "vault-backed-capability-verify": result = await vaultBackedCapabilityVerify(payload, deps); break
      case "closed-inventory": result = closedInventory(deps); break
      case "exact-id-revoke": result = await exactIdRevoke(payload, deps); break
      case "revoked-key-auth-rejection": result = await revokedKeyAuthRejection(payload, deps); break
      case "store_telegram_bootstrap": result = await storeTelegramBootstrap(payload, deps); break
      case "quiesce_telegram_poller": result = telegramPollerQuiescence(payload, deps); break
      case "snapshot": result = cursorSnapshot(deps); break
      case "inject_callbacks_concurrently": result = await concurrentCallbackProbe(payload, deps); break
      case "inject_callback_replay": result = await callbackReplay(payload, deps); break
      case "inventory_keys": result = await keyInventory(payload, deps); break
      case "create_key": result = await createKey(payload, deps); break
      case "store_key": result = await storeKey(payload, deps); break
      case "probe_new_key": result = await probeKey(payload, deps); break
      case "read_old_key": result = await readOldKey(payload, deps); break
      case "revoke_key": result = await revokeKey(payload, deps); break
      case "probe_revoked_key": result = await probeRevokedKey(payload, deps); break
      case "evidence_snapshot": result = evidenceSnapshot(payload, deps); break
      case "capture_evidence_provenance": result = provenance(payload, deps); break
      case "capture_acceptance_scenario": result = await captureAcceptanceScenario(payload, deps); break
      case "finalize_acceptance_scenarios":
        exactKeys(payload, ["operation"], "scenario finalization payload")
        if (!deps.finalizeScenarios) throw new Error("scenario finalization is unavailable")
        await deps.finalizeScenarios()
        result = { finalized: true }
        break
      case "request_reboot": result = await requestReboot(payload, deps); break
      case "poll_reboot": result = pollReboot(payload, deps); break
      case "materialize_config": result = materializeConfig(payload, deps); break
      default: throw new Error("unknown Sanctuary acceptance adapter operation")
    }
    emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_acceptance_adapter_end", message: "Sanctuary acceptance adapter completed", meta: { operation } })
    return result
  } catch (error) {
    emitNervesEvent({ level: "error", component: "daemon", event: "daemon.sanctuary_acceptance_adapter_error", message: "Sanctuary acceptance adapter failed", meta: { operation, category: error instanceof Error ? error.name : "unknown" } })
    throw error
  }
}

export async function executeSanctuaryAcceptanceVaultProbe(
  keyIdValue: unknown,
  capabilityValue: unknown,
  deps: SanctuaryAcceptanceVaultProbeDependencies = createSanctuaryAcceptanceVaultProbeDependencies({ keyRecordPath: SELECTED_KEY_RECORD }),
): Promise<unknown> {
  const id = keyId(keyIdValue)
  const capability = text(capabilityValue, "capability")
  if (capability !== "read-only" && capability !== "bounded-write") throw new Error("capability is invalid")
  const refreshed = await deps.refresh("sanctuary", "sanctuary")
  if (!refreshed.ok) throw new Error("Sanctuary machine runtime credentials are unavailable")
  const endpoint = exactLoopbackGraphqlEndpoint(refreshed.config.unraidGraphqlUrl)
  const field = capability === "read-only" ? "unraidReadApiKey" : "unraidWriteApiKey"
  const descriptor = text(refreshed.config[field], "vault-backed Unraid descriptor")
  const matches = deps.readKeyRecords().filter((record) => sameSecret(record.key, descriptor))
  if (matches.length !== 1 || matches[0]!.id !== id) throw new Error("vault descriptor does not bind to the exact key ID")
  const matched = matches[0]!
  const expectedName = capability === "read-only" ? "Butler RO" : "Butler RW"
  if (matched.name !== expectedName || matched.roles.length !== 0 || scope(matched) !== capability) {
    throw new Error("vault-backed Unraid key metadata scope is invalid")
  }
  const headers = { "content-type": "application/json", "x-api-key": descriptor }
  const readResponse = await deps.fetch(endpoint.href, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: AUTH_PROBE, variables: {} }),
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  })
  if (!readResponse.ok) throw new Error("vault-backed Unraid capability probe failed")
  const readEnvelope = object(await readResponse.json(), "vault-backed Unraid response")
  if (!readEnvelope.data || readEnvelope.errors) throw new Error("vault-backed Unraid capability probe was rejected")
  const writeResponse = await deps.fetch(endpoint.href, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: WRITE_PROBE, variables: { id: MISSING_CONTAINER_ID } }),
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  })
  const writeEnvelope = object(await writeResponse.json(), "vault-backed Unraid write response")
  const errors = Array.isArray(writeEnvelope.errors) ? writeEnvelope.errors.map((value) => object(value, "GraphQL error")) : []
  const codes = errors.map((error) => {
    const extensions = error.extensions && typeof error.extensions === "object" && !Array.isArray(error.extensions)
      ? error.extensions as JsonObject
      : {}
    return typeof extensions.code === "string" ? extensions.code : ""
  })
  if (capability === "read-only") {
    if (writeEnvelope.data || (writeResponse.status !== 403 && !codes.includes("FORBIDDEN") && !codes.includes("PERMISSION_DENIED"))) {
      throw new Error("read-only Unraid key did not prove write permission denial")
    }
    return { valid: true, keyId: id, capability, proof: "read-authorized-write-denied" }
  }
  if (writeEnvelope.data || !writeResponse.ok || !codes.includes("NOT_FOUND")) {
    throw new Error("bounded-write Unraid key did not reach deterministic not-found")
  }
  return { valid: true, keyId: id, capability, proof: "read-authorized-write-reached-not-found" }
}

export async function executeSanctuaryAcceptanceRevokedProbe(
  keyIdValue: unknown,
  endpointValue: unknown,
  rawKeyFile: string,
  deps: Pick<SanctuaryAcceptanceAdapterDependencies, "fetch"> = { fetch },
): Promise<unknown> {
  const id = keyId(keyIdValue)
  const raw = object(JSON.parse(rawKeyFile) as unknown, "revoked Unraid key file")
  if (keyId(raw.id) !== id) throw new Error("revoked Unraid key file ID mismatch")
  const descriptor = text(raw.key, "revoked Unraid key descriptor")
  return revokedKeyAuthRejection({ keyId: id, endpoint: endpointValue }, {
    readDescriptor: () => JSON.stringify({ keyId: id, descriptor }),
    fetch: deps.fetch,
  })
}

export interface SanctuaryAcceptanceCallbackProbeDependencies {
  refresh(agentName: string): Promise<RuntimeCredentialConfigReadResult>
  credentials(agentName: string): TelegramSenseCredentials
  identityKey(agentRoot: string): string
  createApi(options: { token: string }): TelegramBotApi
  createRuntime(input: Parameters<typeof createTelegramApprovalRuntime>[0]): Pick<TelegramApprovalRuntime, "transport" | "close">
  toolContext(agentName: string): ReturnType<typeof createSanctuaryToolContext>
}

export async function executeSanctuaryAcceptanceCallbackProbe(
  rawUpdate: unknown,
  _replay: boolean,
  deps: SanctuaryAcceptanceCallbackProbeDependencies = {
    refresh: refreshRuntimeCredentialConfig,
    credentials: loadTelegramSenseCredentials,
    identityKey: readOrCreateTelegramIdentityKey,
    createApi: createTelegramBotApi,
    createRuntime: createTelegramApprovalRuntime,
    toolContext: createSanctuaryToolContext,
  },
): Promise<{ settled: boolean; claimed: boolean; mutated: boolean }> {
  const update = callbackUpdate(rawUpdate) as unknown as TelegramUpdate
  const refreshed = await deps.refresh(TARGET_ID)
  if (!refreshed.ok) throw new Error("Telegram runtime credentials are unavailable")
  const credentials = deps.credentials(TARGET_ID)
  const identityKey = deps.identityKey(getAgentRoot(TARGET_ID))
  const payload = [
    TELEGRAM_SUBJECT_DOMAIN,
    `user:${credentials.authorizedUserId.length}:${credentials.authorizedUserId}`,
    `chat:${credentials.authorizedChatId.length}:${credentials.authorizedChatId}`,
  ].join("\0")
  const subject = `tg_${createHmac("sha256", identityKey).update(payload, "utf8").digest("base64url")}`
  const api = deps.createApi({ token: credentials.botToken })
  const runtime = deps.createRuntime({
    agentName: TARGET_ID,
    api,
    authorizedUserId: credentials.authorizedUserId,
    authorizedChatId: credentials.authorizedChatId,
    subject,
    toolContext: deps.toolContext(TARGET_ID),
  })
  try {
    const result = await runtime.transport.handleUpdate(update)
    return {
      settled: result.handled,
      claimed: result.reason === "accepted" || result.reason === "decision_refused",
      mutated: result.accepted,
    }
  } finally {
    runtime.close()
    api.stop()
  }
}
