import { spawnSync } from "node:child_process"
import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { createConnection } from "node:net"
import * as path from "node:path"
import type OpenAI from "openai"

import { emitNervesEvent } from "../../nerves/runtime"
import { createTelegramApprovalRuntime, type TelegramApprovalRuntime } from "../../senses/telegram-approval-runtime"
import { createTelegramBotApi, type TelegramBotApi, type TelegramUpdate } from "../../senses/telegram-client"
import { executeSanctuaryInteractiveEngine, proveSanctuaryAttemptedRecoveryWithoutRetry, type SanctuaryInteractiveEngineDependencies } from "../../senses/sanctuary-interactive-control"
import { loadTelegramSenseCredentials, readOrCreateTelegramIdentityKey, sanctuaryTelegramTurnReceiptDigest, sanctuaryTelegramTurnReceiptMac, type TelegramSenseCredentials } from "../../senses/telegram"
import { createSanctuaryToolContext, runWithSanctuaryToolReceiptCollection } from "../../senses/sanctuary-runtime"
import { projectSanctuaryGrounding, sanctuaryGroundingDigest, type SanctuaryGroundingToolName, type SanctuaryToolGrounding } from "../../senses/sanctuary-grounding"
import { ponderTool, resolveToolDefinition, restTool, settleTool, speakTool } from "../../repertoire/tools"
import { runAgent, type ProviderRuntime, type ToolCallBoundaryReceipt } from "../core"
import { getAgentRoot } from "../identity"
import { readApprovalsByScenarioHandleDigest, type ApprovalAcceptanceProjection } from "../approval-store"
import { readProviderCredentialRecord } from "../provider-credentials"
import { pingProvider, type PingResult } from "../provider-ping"
import { SANCTUARY_SCENARIO_GATES, SANCTUARY_SCENARIO_SOURCES, SANCTUARY_UNIT_16_EVIDENCE_LABELS, type SanctuaryUnit16EvidenceLabel } from "./sanctuary-acceptance-harness"
import { readSanctuaryAcceptanceMarker } from "./sanctuary-acceptance-marker"
import { createSanctuaryScenarioCapture, finalizeSanctuaryScenarioCapture, type SanctuaryHealthProbeReceipt, type SanctuaryInteractiveDriverReceipt, type SanctuaryPostbootIntegritySnapshot, type SanctuaryReadOnlyDenialReceipt, type SanctuaryScenarioFacts } from "./sanctuary-acceptance-scenarios"
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
  interactiveRuntime?(payload: JsonObject): Promise<unknown>
  hostRequest?(payload: JsonObject): Promise<unknown>
  captureScenario?(payload: JsonObject): Promise<unknown>
  finalizeScenarios?(): void | Promise<void>
  telegramCredentials?(): TelegramSenseCredentials
  readProviderCredential?: typeof readProviderCredentialRecord
  providerPing?: typeof pingProvider
  readLiveGrounding?(toolName: SanctuaryGroundingToolName): Promise<{ toolName: SanctuaryGroundingToolName; groundingDigest: string; sourceIdentityDigest: string; observedAt: string; facts: Record<string, unknown> }>
  runProductionBoundaryProbe?(schemas: OpenAI.ChatCompletionFunctionTool[]): Promise<ToolCallBoundaryReceipt[]>
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

interface SanctuaryProviderReadinessContractInput {
  outward: { provider: string; model: string }
  inner: { provider: string; model: string }
  gemini: { provider: string; model: string; vaultItem: string }
  glm: { baseUrl: string; vaultItem: string; apiKey: string }
  geminiCredential: { baseUrl: string; apiKey: string }
  selectionPolicy: string
  identityKey: string
}

export function evaluateSanctuaryProviderReadinessContract(input: SanctuaryProviderReadinessContractInput): {
  modelsExact: boolean; baseUrlsExact: boolean; vaultCoordinatesExact: boolean; credentialIdentitiesDistinct: boolean
} {
  const credentialIdentity = (_provider: string, secret: string): Buffer => createHmac("sha256", input.identityKey)
    .update(`sanctuary-provider-credential-v1\0${secret}`).digest()
  const glmIdentity = credentialIdentity("openai-compatible", input.glm.apiKey)
  const geminiIdentity = credentialIdentity("openai-compatible-gemini", input.geminiCredential.apiKey)
  return {
    modelsExact: input.outward.provider === "openai-compatible" && input.outward.model === "glm-5.2"
      && input.inner.provider === "openai-compatible" && input.inner.model === "glm-5.2"
      && input.gemini.provider === "openai-compatible-gemini" && input.gemini.model === "gemini-3.6-flash",
    baseUrlsExact: input.glm.baseUrl === "https://api.z.ai/api/paas/v4/"
      && input.geminiCredential.baseUrl === "https://generativelanguage.googleapis.com/v1beta/openai/",
    vaultCoordinatesExact: input.glm.vaultItem === "providers/openai-compatible"
      && input.gemini.vaultItem === "providers/openai-compatible-gemini"
      && input.selectionPolicy === "explicit-same-lane-only",
    credentialIdentitiesDistinct: !timingSafeEqual(glmIdentity, geminiIdentity),
  }
}
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
const PROCESS_BINDING_DIGEST_FILE = "/run/ouro-acceptance/process-binding-digest"
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
    interactiveRuntime: executeSanctuaryInteractiveRuntimeOperation,
    hostRequest: options.hostRequest ?? ((payload) => defaultHostRequest(payload, hostBrokerSocket, adapterTimeoutMs)),
    telegramCredentials: () => loadTelegramSenseCredentials(TARGET_ID),
    readLiveGrounding: readIndependentSanctuaryGrounding,
    runProductionBoundaryProbe: runSanctuaryProductionBoundaryProbe,
  }
  const healthDriver = createSanctuaryHealthAcceptanceScenarioDriver(dependencies.hostRequest!)
  const scenarioAgentRoot = options.scenarioCapture?.agentRoot ?? getAgentRoot(TARGET_ID)
  const interactiveDriver = createSanctuaryInteractiveAcceptanceScenarioDriver({
    agentRoot: scenarioAgentRoot,
    hostRequest: dependencies.hostRequest!,
  })
  const denialDriver = createSanctuaryReadOnlyDenialScenarioDriver({
    agentRoot: scenarioAgentRoot,
    runProbe: (label, scenarioHandleDigest) => executeSanctuaryReadOnlyDenialProbe(label, scenarioHandleDigest, scenarioAgentRoot, dependencies),
  })
  dependencies.captureScenario = createSanctuaryScenarioCapture({
    now: Date.now,
    readFacts: (label, scenarioHandleDigest, readOptions) => readDefaultSanctuaryScenarioFacts(label, scenarioHandleDigest, dependencies, options.scenarioCapture?.agentRoot, readOptions),
    healthDriver,
    interactiveDriver,
    denialDriver,
    receiptRoot: options.scenarioCapture?.receiptRoot,
    gateStatusPath: options.scenarioCapture?.gateStatusPath,
  }) as (payload: JsonObject) => Promise<unknown>
  dependencies.finalizeScenarios = createSanctuaryAcceptanceScenarioFinalizer({
    readActiveScenario: () => readSanctuaryAcceptanceMarker(TARGET_ID),
    recoverHealthScenario: healthDriver.recover,
    finalizeInteractiveScenario: (label, scenarioHandleDigest) => {
      interactiveDriver.complete(label, scenarioHandleDigest)
      return "preserve"
    },
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
    "schemaVersion", "containerId", "imageId", "running", "health", "user", "liveProcessUser", "processBindingDigest", "readOnlyRoot", "mountCount",
    "mountsDigest", "mountsExact", "publishedPortCount", "networkMode", "securityExact", "writableKeyExposure",
    "restartPolicy", "restartCount", "autostartExact", "updaterDisabled", "vaultUnlocked", "manualAuthRequired",
    "recoveryMilestones",
  ], "health probe owner snapshot")
  const milestones = object(snapshot.recoveryMilestones, "health probe owner recovery milestones")
  exactKeys(milestones, ["hostReady", "arrayReady", "dockerReady", "butlerReady", "tailscaleReady", "sshReady"], "health probe owner recovery milestones")
  if (snapshot.schemaVersion !== 1 || typeof snapshot.containerId !== "string" || !SHA256.test(snapshot.containerId)
    || typeof snapshot.imageId !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(snapshot.imageId)
    || typeof snapshot.running !== "boolean" || typeof snapshot.health !== "string" || !["healthy", "starting", "unhealthy", "missing"].includes(snapshot.health)
    || typeof snapshot.user !== "string" || snapshot.user.length < 1 || snapshot.user.length > 64 || snapshot.liveProcessUser !== "10001:10001"
    || typeof snapshot.processBindingDigest !== "string" || !SHA256.test(snapshot.processBindingDigest)
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

type InteractiveLabel = "unit-16k-timeout-stale" | "unit-16l-duplicate-callback" | "unit-16m-restart-continuation"

function isInteractiveLabel(label: string): label is InteractiveLabel {
  return label === "unit-16k-timeout-stale" || label === "unit-16l-duplicate-callback" || label === "unit-16m-restart-continuation"
}

function currentInteractiveProposal(records: ApprovalAcceptanceProjection[], label: InteractiveLabel): ApprovalAcceptanceProjection | null {
  const matches = records.filter(({ approval }) => (approval.state === "proposed" || (label === "unit-16k-timeout-stale" && approval.state === "expired")) && approval.toolName === "unraid_restart_container"
    && approval.arguments.container === "calibre-web" && approval.transport === "telegram")
  if (matches.length > 1) throw new Error("interactive acceptance proposal is ambiguous")
  return matches[0] ?? null
}

export function createSanctuaryInteractiveAcceptanceScenarioDriver(options: {
  agentRoot: string
  readApprovals?: (databasePath: string, scenarioHandleDigest: string) => ApprovalAcceptanceProjection[]
  readPending?: () => unknown[]
  hostRequest: (payload: JsonObject) => Promise<unknown>
}): {
  poll(label: SanctuaryUnit16EvidenceLabel, scenarioHandleDigest: string): Promise<{ state: "waiting" | "driven" }>
  complete(label: SanctuaryUnit16EvidenceLabel, scenarioHandleDigest: string): "complete" | "preserve"
  cleanup(label: SanctuaryUnit16EvidenceLabel, scenarioHandleDigest: string): void
} {
  const receiptRoot = path.join(options.agentRoot, "state/acceptance/interactive-driver-receipts")
  const receiptPath = (scenarioHandleDigest: string): string => path.join(receiptRoot, `${scenarioHandleDigest}.json`)
  const approvals = options.readApprovals ?? readApprovalsByScenarioHandleDigest
  return {
    async poll(label, scenarioHandleDigest) {
      if (!isInteractiveLabel(label)) return { state: "waiting" }
      const filePath = receiptPath(scenarioHandleDigest)
      if (existsSync(filePath)) {
        const existing = object(JSON.parse(readFileSync(filePath, "utf8")) as unknown, "interactive driver receipt")
        if (existing.label !== label || existing.scenarioHandleDigest !== scenarioHandleDigest) throw new Error("interactive driver receipt binding mismatch")
        if (existing.phase === "complete") return { state: "driven" }
      }
      const projection = currentInteractiveProposal(approvals(path.join(options.agentRoot, "state/approvals/approvals.sqlite"), scenarioHandleDigest), label)
      if (!projection) return { state: "waiting" }
      const { approval } = projection
      if (!approval.suspendedSessionRevision || !SHA256.test(approval.checkpointDigest)) throw new Error("interactive acceptance checkpoint is invalid")
      const operation = label === "unit-16k-timeout-stale" ? "drive_timeout_stale"
        : label === "unit-16l-duplicate-callback" ? "drive_duplicate_callbacks" : "drive_restart_continuation"
      const response = object(await options.hostRequest({ operation, targetId: TARGET_ID, label, scenarioHandleDigest }), "interactive scenario driver response")
      if (label === "unit-16k-timeout-stale" && response.state === "waiting") {
        exactKeys(response, ["state"], "interactive scenario driver response")
        return { state: "waiting" }
      }
      if (label === "unit-16m-restart-continuation") {
        if (response.state === "waiting") {
          exactKeys(response, ["state"], "interactive scenario driver response")
          return { state: "waiting" }
        }
        if (response.state === "failed") {
          exactKeys(response, ["state", "errorDigest"], "interactive scenario driver response")
          if (typeof response.errorDigest !== "string" || !SHA256.test(response.errorDigest)) throw new Error("interactive scenario driver failure is invalid")
          throw new Error(`interactive scenario driver failed (${response.errorDigest})`)
        }
        exactKeys(response, ["state", "receipt"], "interactive scenario driver response")
        if (response.state !== "complete" || !parseInteractiveDriverReceipt(JSON.stringify(response.receipt), label, scenarioHandleDigest)) {
          throw new Error("interactive scenario driver receipt is invalid")
        }
        return { state: "driven" }
      }
      if (!parseInteractiveDriverReceipt(JSON.stringify(response), label, scenarioHandleDigest)) {
        throw new Error("interactive scenario driver receipt is invalid")
      }
      return { state: "driven" }
    },
    complete(label, scenarioHandleDigest) {
      if (!isInteractiveLabel(label)) return "complete"
      const filePath = receiptPath(scenarioHandleDigest)
      if (existsSync(filePath)) {
        const existing = object(JSON.parse(readFileSync(filePath, "utf8")) as unknown, "interactive driver receipt")
        if (existing.label !== label || existing.scenarioHandleDigest !== scenarioHandleDigest) throw new Error("interactive driver receipt binding mismatch")
        if (existing.phase !== "complete") return "preserve"
      }
      return "complete"
    },
    cleanup(label, scenarioHandleDigest) {
      if (!isInteractiveLabel(label)) return
      const filePath = receiptPath(scenarioHandleDigest)
      if (!existsSync(filePath)) return
      const existing = object(JSON.parse(readFileSync(filePath, "utf8")) as unknown, "interactive driver receipt")
      if (existing.label !== label || existing.scenarioHandleDigest !== scenarioHandleDigest || existing.phase !== "complete") {
        throw new Error("interactive driver receipt is not cleanup-ready")
      }
      unlinkSync(filePath)
      const directory = openSync(receiptRoot, "r")
      try { fsyncSync(directory) } finally { closeSync(directory) }
    },
  }
}

export function createSanctuaryAcceptanceScenarioFinalizer(dependencies: {
  readActiveScenario(): { label: string; scenarioHandleDigest: string } | null
  recoverHealthScenario(label: string, scenarioHandleDigest: string): Promise<void>
  finalizeInteractiveScenario?(label: SanctuaryUnit16EvidenceLabel, scenarioHandleDigest: string): "complete" | "preserve" | Promise<"complete" | "preserve">
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
    let preserveInteractive = false
    if (active && isInteractiveLabel(active.label) && dependencies.finalizeInteractiveScenario) {
      preserveInteractive = true
      try { await dependencies.finalizeInteractiveScenario(active.label, active.scenarioHandleDigest) } catch (error) { appendErrorLeaves(errors, error) }
    }
    if (preserveInteractive) errors.push(new Error("interactive scenario requires inspect-before-retry"))
    else try { dependencies.finalizeLocal() } catch (error) { appendErrorLeaves(errors, error) }
    if (errors.length > 0) throw new AggregateError(errors, preserveInteractive
      ? "Sanctuary scenario recovery and finalization failed: interactive scenario requires inspect-before-retry"
      : "Sanctuary scenario recovery and finalization failed")
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

function parseAuditLedger(raw: string): SanctuaryScenarioFacts["events"] {
  return boundedLines(raw, "Telegram audit ledger", { bytes: 32 * 1024 * 1024, rows: 100_000, rowBytes: 64 * 1024 }).map((line) => {
    const entry = object(JSON.parse(line) as unknown, "Telegram audit entry")
    const meta = object(entry.meta, "Telegram audit meta")
    if (!canonicalIso(entry.ts) || typeof entry.event !== "string" || entry.event.length < 1 || entry.event.length > 256) throw new Error("Telegram audit ledger row is invalid")
    return { event: entry.event, at: Date.parse(entry.ts), meta }
  })
}

function parseRestartAttempts(raw: string, scenarioHandleDigest: string | null): SanctuaryScenarioFacts["restartAttempts"] {
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
    if (scenarioHandleDigest !== null && attempt.scenarioHandleDigest !== scenarioHandleDigest) return []
    return [{ state: attempt.state as SanctuaryScenarioFacts["restartAttempts"][number]["state"], actionDigest: String(attempt.actionDigest), argumentDigest: String(attempt.argumentDigest), target: containerRecord.name, targetId: containerRecord.id, beforeState: attempt.beforeState, scenarioHandleDigest: attempt.scenarioHandleDigest, approvalId: attempt.approvalId, attemptId: attempt.attemptId, observedAt: Date.parse(attempt.observedAt), mutationAcknowledged: attempt.mutationAcknowledged, afterState: attempt.afterState as string | null }]
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

function buildPostbootIntegritySnapshot(input: {
  offsetRaw: string | null; checkpointsRaw: string | null; restartAttempts: SanctuaryScenarioFacts["restartAttempts"]
  cronRaw: string | null; health: JsonObject | null; auditLedgerEntries: SanctuaryScenarioFacts["events"]
  activeScenarioHandleDigest: string | null
}): SanctuaryPostbootIntegritySnapshot {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
    if (value && typeof value === "object") return `{${Object.keys(value as JsonObject).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as JsonObject)[key])}`).join(",")}}`
    return JSON.stringify(value) ?? "null"
  }
  const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex")
  const offset = input.offsetRaw === null ? { nextUpdateId: 0 } : object(JSON.parse(input.offsetRaw) as unknown, "Telegram offset state")
  if (JSON.stringify(Object.keys(offset).sort()) !== JSON.stringify(["nextUpdateId"]) || !Number.isSafeInteger(offset.nextUpdateId) || Number(offset.nextUpdateId) < 0) {
    throw new Error("Telegram offset state is invalid")
  }
  const checkpoints = input.checkpointsRaw === null ? {} : object(JSON.parse(input.checkpointsRaw) as unknown, "approval checkpoint state")
  const approvalCheckpoints = Object.entries(checkpoints).map(([id, record]) => ({ idDigest: digest(id), recordDigest: digest(record) }))
    .sort((left, right) => left.idDigest.localeCompare(right.idDigest))
  const sweeps = (input.health?.sweepReceipts as JsonObject[] | undefined ?? []).map((row) => ({
    idDigest: digest(row.sweepId), recordDigest: digest(row), scenarioHandleDigest: typeof row.scenarioHandleDigest === "string" ? row.scenarioHandleDigest : null,
    deliveryIdDigest: typeof row.deliveryId === "string" ? digest(row.deliveryId) : null,
  }))
  const deliveries = (input.health?.deliveredReceipts as JsonObject[] | undefined ?? []).map((row) => ({ idDigest: digest(row.deliveryId), recordDigest: digest(row) }))
  const scenarioRelevantEvents = new Set(["telegram.callback_settled", "telegram.update_dropped", "approval.acceptance_transition", "senses.sanctuary_read_receipt", "senses.telegram_approved_restart_end"])
  const restartAttempts = input.restartAttempts.map((row) => ({
    idDigest: digest(row.attemptId), recordDigest: digest(row), state: row.state,
  }))
  return {
    schemaVersion: "sanctuary-postboot-integrity-v2", activeScenarioHandleDigest: input.activeScenarioHandleDigest,
    telegramNextUpdateId: Number(offset.nextUpdateId), approvalCheckpoints,
    approvalExecutionCount: new Set(restartAttempts.filter((row) => row.state !== "attempt_not_started").map((row) => row.idDigest)).size, restartAttempts,
    fingerprintDigest: digest(input.cronRaw), sweeps, deliveries,
    audits: input.auditLedgerEntries.map((row) => ({ idDigest: digest(row), recordDigest: digest(row), scenarioHandleDigest: typeof row.meta.scenarioHandleDigest === "string" ? row.meta.scenarioHandleDigest : null, scenarioRelevant: scenarioRelevantEvents.has(row.event) })),
  }
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

export function auditContainsSensitiveMaterial(raw: string, credentials?: TelegramSenseCredentials): boolean {
  const knownValues = credentials ? [credentials.botToken, credentials.authorizedUserId, credentials.authorizedChatId] : []
  return knownValues.some((value) => value.length > 0 && raw.includes(value))
    || /\b\d{5,16}:[A-Za-z0-9_-]{20,}\b/u.test(raw)
    || /"(?:authorized_?user_?id|authorized_?chat_?id|transport_?user_?id|transport_?chat_?id|user_?id|chat_?id|update_?id|message_?id)"\s*:\s*"?\d{5,16}"?/iu.test(raw)
    || /"(?:botToken|apiKey|password|secret)"\s*:\s*"(?!\[REDACTED\])[^"\n]+"/u.test(raw)
    || /\b(?:bearer\s+|sk-|AIza|xox[baprs]-)[A-Za-z0-9_-]{10,}\b/iu.test(raw)
    || /\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*(?!\[REDACTED\])\S{8,}/iu.test(raw)
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

function parseTelegramTurnReceipts(raw: string, scenarioHandleDigest: string, identityKey: string | null): SanctuaryScenarioFacts["telegramTurns"] {
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error("Telegram turn receipt ledger exceeds its bound")
  const lines = raw.split("\n").filter(Boolean)
  if (lines.length > 500 || lines.some((line) => Buffer.byteLength(line) > 16 * 1024)) throw new Error("Telegram turn receipt ledger exceeds its bound")
  return lines.flatMap((line) => {
    const receipt = object(JSON.parse(line) as unknown, "Telegram turn receipt")
    const grounded = receipt.schemaVersion === "sanctuary-telegram-turn-receipt-v4"
    const exactKeys = ["completedAt", "deliveries", "deliveryCount", "errorCategory", "providerInvocationCount", "responseDigest", "scenarioHandleDigest", "schemaVersion", "sequenceDigest", "status", "toolInvocationCount", "toolResultDigests", "updateDigest", ...(grounded ? ["receiptMac", "toolGroundings"] : [])].sort()
    const deliveries = receipt.deliveries
    const authenticatedDeliveries = grounded && typeof identityKey === "string" && /^[A-Za-z0-9_-]{43}$/u.test(identityKey) && Array.isArray(deliveries)
      && deliveries.every((value) => {
        const delivery = object(value, "Telegram authenticated delivery receipt")
        return typeof delivery.redactedText === "string" && delivery.chunkDigest === sanctuaryTelegramTurnReceiptDigest(identityKey, "sanctuary-telegram-turn-receipt-v4", "chunk", delivery.redactedText)
      })
      && receipt.responseDigest === sanctuaryTelegramTurnReceiptDigest(identityKey, "sanctuary-telegram-turn-receipt-v4", "response", JSON.stringify(deliveries))
      && receipt.receiptMac === sanctuaryTelegramTurnReceiptMac(identityKey, receipt)
    if (JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(exactKeys)
      || (!grounded && receipt.schemaVersion !== "sanctuary-telegram-turn-receipt-v3")
      || typeof receipt.scenarioHandleDigest !== "string" || !SHA256.test(receipt.scenarioHandleDigest)
      || (receipt.status !== "success" && receipt.status !== "error")
      || (receipt.status === "success" ? receipt.errorCategory !== null : typeof receipt.errorCategory !== "string" || receipt.errorCategory.length < 1 || receipt.errorCategory.length > 128)
      || ![receipt.updateDigest, receipt.sequenceDigest, receipt.responseDigest].every((value) => typeof value === "string" && SHA256.test(value))
      || !Array.isArray(receipt.toolResultDigests) || receipt.toolResultDigests.length > 100 || !receipt.toolResultDigests.every((value) => typeof value === "string" && SHA256.test(value))
      || !Array.isArray(deliveries) || deliveries.length > 100 || !deliveries.every((value) => {
        const delivery = object(value, "Telegram delivery receipt")
        return JSON.stringify(Object.keys(delivery).sort()) === JSON.stringify(grounded ? ["chunkDigest", "messageIdDigest", "redactedText", "utf16Units"] : ["chunkDigest", "messageIdDigest"])
          && typeof delivery.messageIdDigest === "string" && SHA256.test(delivery.messageIdDigest)
          && typeof delivery.chunkDigest === "string" && SHA256.test(delivery.chunkDigest)
          && (!grounded || (typeof delivery.redactedText === "string" && delivery.redactedText.length === delivery.utf16Units && Number(delivery.utf16Units) <= 1_200))
      })
      || (grounded && !authenticatedDeliveries)
      || (grounded && (typeof receipt.receiptMac !== "string" || !SHA256.test(receipt.receiptMac)))
      || (grounded && (!Array.isArray(receipt.toolGroundings) || receipt.toolGroundings.length !== 1 || !receipt.toolGroundings.every((raw) => {
        const grounding = object(raw, "Telegram tool grounding")
        if (JSON.stringify(Object.keys(grounding).sort()) !== JSON.stringify(["facts", "groundingDigest", "observedAt", "resultDigest", "sourceIdentityDigest", "toolName"]) || (grounding.toolName !== "unraid_get_system" && grounding.toolName !== "unraid_get_storage")
          || typeof grounding.resultDigest !== "string" || !SHA256.test(grounding.resultDigest) || typeof grounding.groundingDigest !== "string" || !SHA256.test(grounding.groundingDigest)
          || typeof grounding.sourceIdentityDigest !== "string" || !SHA256.test(grounding.sourceIdentityDigest) || typeof grounding.observedAt !== "string" || !Number.isFinite(Date.parse(grounding.observedAt)) || new Date(Date.parse(grounding.observedAt)).toISOString() !== grounding.observedAt
          || !grounding.facts || typeof grounding.facts !== "object" || Array.isArray(grounding.facts)) return false
        return sanctuaryGroundingDigest(grounding.facts as Record<string, unknown>) === grounding.groundingDigest && (receipt.toolResultDigests as unknown[]).includes(grounding.resultDigest)
      })))
      || ![receipt.providerInvocationCount, receipt.toolInvocationCount].every((value) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000)
      || !Number.isSafeInteger(receipt.deliveryCount) || receipt.deliveryCount !== deliveries.length
      || typeof receipt.completedAt !== "string" || receipt.completedAt.length > 30 || !Number.isFinite(Date.parse(receipt.completedAt)) || new Date(Date.parse(receipt.completedAt)).toISOString() !== receipt.completedAt) {
      throw new Error("Telegram turn receipt ledger row is invalid")
    }
    if (receipt.scenarioHandleDigest !== scenarioHandleDigest) return []
    const responseText = grounded ? (deliveries as JsonObject[]).map((delivery) => String(delivery.redactedText)).join("") : undefined
    const toolGroundings = grounded ? structuredClone(receipt.toolGroundings) as SanctuaryToolGrounding[] : undefined
    return [{
      status: receipt.status, updateDigest: String(receipt.updateDigest), sequenceDigest: String(receipt.sequenceDigest), responseDigest: String(receipt.responseDigest),
      toolResultDigests: receipt.toolResultDigests as string[], providerTurnCount: Number(receipt.providerInvocationCount),
      toolInvocationCount: Number(receipt.toolInvocationCount), deliveryCount: Number(receipt.deliveryCount),
      telegramMessageIdDigests: deliveries.map((delivery) => String((delivery as JsonObject).messageIdDigest)), completedAt: Date.parse(receipt.completedAt),
      ...(grounded ? { responseText, responseUtf16Units: responseText!.length, toolGroundings } : {}),
    }]
  })
}

async function readIndependentSanctuaryGrounding(toolName: SanctuaryGroundingToolName): Promise<{ toolName: SanctuaryGroundingToolName; groundingDigest: string; sourceIdentityDigest: string; observedAt: string; facts: Record<string, unknown> }> {
  const sanctuary = createSanctuaryToolContext(TARGET_ID).sanctuary!
  const result = toolName === "unraid_get_system" ? await sanctuary.getSystem() : await sanctuary.getStorage()
  const facts = projectSanctuaryGrounding(toolName, result)
  if (!facts) throw new Error("independent Sanctuary grounding is unavailable")
  const sourceIdentityDigest = (result as { data?: { sourceIdentityDigest?: unknown } }).data?.sourceIdentityDigest
  if (typeof sourceIdentityDigest !== "string" || !SHA256.test(sourceIdentityDigest)) throw new Error("independent Sanctuary source identity is unavailable")
  return { toolName, groundingDigest: sanctuaryGroundingDigest(facts), sourceIdentityDigest, observedAt: new Date().toISOString(), facts }
}

export function canonicalDockerIdFromUnraidPrefixedId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}:[0-9a-f]{64}$/u.test(value)) throw new Error("Unraid Docker PrefixedID is invalid")
  return value.slice(65)
}

export async function runSanctuaryProductionBoundaryProbe(telegramSchemas: OpenAI.ChatCompletionFunctionTool[]): Promise<ToolCallBoundaryReceipt[]> {
  const excludedNames = ["shell", "read_file", "edit_file", "vault_get", "mcp_call", "exec", "credential_get"]
  const turns = [
    { content: "", toolCalls: excludedNames.map((name, index) => ({ id: `sanctuary-excluded-${index}`, name, arguments: "{}" })), outputItems: [] },
    { content: "", toolCalls: [{ id: "sanctuary-valid-system", name: "unraid_get_system", arguments: "{}" }], outputItems: [] },
    { content: "", toolCalls: [{ id: "sanctuary-boundary-settle", name: "settle", arguments: JSON.stringify({ answer: "boundary complete" }) }], outputItems: [] },
  ]
  let turn = 0
  const controlOutputs: string[] = []
  const providerRuntime: ProviderRuntime = {
    id: "minimax", model: "sanctuary-production-boundary-probe", client: null, capabilities: new Set(),
    streamTurn: async () => turns[turn++] ?? (() => { throw new Error("production boundary probe exceeded its turn budget") })(),
    appendToolOutput: (callId, output) => { if (callId === "sanctuary-valid-system") controlOutputs.push(output) }, resetTurnState: () => undefined, ping: async () => undefined, classifyError: () => "unknown",
  }
  const receipts: ToolCallBoundaryReceipt[] = []
  const sanctuary = createSanctuaryToolContext(TARGET_ID).sanctuary
  const observed = await runWithSanctuaryToolReceiptCollection(() => runAgent([{ role: "user", content: "Run the bounded production tool authorization probe." }], {
      onModelStart: () => undefined, onModelStreamStart: () => undefined, onTextChunk: () => undefined, onReasoningChunk: () => undefined,
      onToolStart: () => undefined, onToolEnd: () => undefined, onError: () => undefined, onClearText: () => undefined,
    }, "telegram", undefined, {
      tools: telegramSchemas, providerRuntimeOverride: providerRuntime, toolBoundaryObserver: (receipt) => receipts.push(receipt),
      toolContext: { signin: async () => undefined, sanctuary },
    }))
  const controlReceipts = receipts.filter((receipt) => receipt.name === "unraid_get_system")
  if (observed.result.outcome !== "settled" || controlReceipts.length !== 1
    || controlReceipts[0]!.reason !== "dispatched" || !controlReceipts[0]!.invoked || controlReceipts[0]!.sideEffect
    || observed.toolResultDigests.length !== 1 || controlOutputs.length !== 1
    || createHash("sha256").update(controlOutputs[0]!).digest("hex") !== observed.toolResultDigests[0]) {
    throw new Error("production boundary valid control did not dispatch with one live Sanctuary read receipt")
  }
  const controlResult = object(JSON.parse(controlOutputs[0]!) as unknown, "production boundary control result")
  const controlData = object(controlResult.data, "production boundary control data")
  if (controlResult.ok !== true || typeof controlData.sourceIdentityDigest !== "string" || !SHA256.test(controlData.sourceIdentityDigest)) {
    throw new Error("production boundary valid control result is invalid")
  }
  return receipts.filter((receipt) => receipt.name !== "settle")
}

function parseInteractiveDriverReceipt(raw: string | null, label: SanctuaryUnit16EvidenceLabel, scenarioHandleDigest: string): SanctuaryInteractiveDriverReceipt | undefined {
  if (raw === null) return undefined
  const receipt = object(JSON.parse(raw) as unknown, "interactive driver receipt")
  const expectedSchema = label === "unit-16k-timeout-stale" ? "sanctuary-timeout-stale-driver-receipt-v1" : "sanctuary-interactive-driver-receipt-v2"
  if (receipt.schemaVersion !== expectedSchema || receipt.phase !== "complete"
    || receipt.label !== label || receipt.scenarioHandleDigest !== scenarioHandleDigest) throw new Error("interactive driver receipt binding is invalid")
  const common = ["schemaVersion", "phase", "label", "scenarioHandleDigest", "approvalIdDigest", "checkpointDigest", "suspendedSessionRevisionDigest", "approvalEpochBefore"]
  const digests = [receipt.approvalIdDigest, receipt.checkpointDigest, receipt.suspendedSessionRevisionDigest]
  if (!digests.every((value) => typeof value === "string" && SHA256.test(value)) || !Number.isSafeInteger(receipt.approvalEpochBefore) || Number(receipt.approvalEpochBefore) < 0) {
    throw new Error("interactive driver receipt common coordinates are invalid")
  }
  if (label === "unit-16k-timeout-stale") {
    exactKeys(receipt, [...common, "callbackAttempts", "distinctQueryCount", "callbackDataDigest", "settledCount", "claimCount", "mutationCount", "staleAcknowledged", "promptTerminal"], "timeout stale driver receipt")
    if (receipt.callbackAttempts !== 1 || receipt.distinctQueryCount !== 1 || typeof receipt.callbackDataDigest !== "string" || !SHA256.test(receipt.callbackDataDigest)
      || receipt.settledCount !== 1 || receipt.claimCount !== 0 || receipt.mutationCount !== 0 || receipt.staleAcknowledged !== true || receipt.promptTerminal !== true) {
      throw new Error("timeout stale driver receipt is invalid")
    }
  } else if (label === "unit-16l-duplicate-callback") {
    exactKeys(receipt, [...common, "callbackAttempts", "distinctQueryCount", "callbackDataDigest", "barrierObserved", "settledCount", "claimCount", "mutationCount", "staleReplayAttempts", "staleReplaySettled", "staleReplayMutationCount", "promptTerminal", "writeCredentialObserved"], "duplicate callback driver receipt")
    if (receipt.callbackAttempts !== 2 || receipt.distinctQueryCount !== 2 || typeof receipt.callbackDataDigest !== "string" || !SHA256.test(receipt.callbackDataDigest)
      || receipt.barrierObserved !== true || receipt.settledCount !== 2 || receipt.claimCount !== 1 || receipt.mutationCount !== 1
      || receipt.staleReplayAttempts !== 1 || receipt.staleReplaySettled !== true || receipt.staleReplayMutationCount !== 0
      || receipt.promptTerminal !== true || receipt.writeCredentialObserved !== false) throw new Error("duplicate callback driver receipt is invalid")
  } else if (label === "unit-16m-restart-continuation") {
    exactKeys(receipt, [...common, "approvalEpochAfterRestart", "continuationEpochAfter", "ownerImageDigest", "ownerContainerDigest", "restartCountBefore", "restartCountAfter", "pendingDigestBefore", "pendingDigestAfter", "pendingRestored", "callbackAttempts", "mutationCount", "indeterminateRecoveryObserved", "indeterminateRetryCount"], "restart continuation driver receipt")
    if (![receipt.ownerImageDigest, receipt.ownerContainerDigest, receipt.pendingDigestBefore, receipt.pendingDigestAfter].every((value) => typeof value === "string" && SHA256.test(value))
      || ![receipt.approvalEpochAfterRestart, receipt.continuationEpochAfter, receipt.restartCountBefore, receipt.restartCountAfter].every((value) => Number.isSafeInteger(value) && Number(value) >= 0)
      || receipt.pendingRestored !== true || receipt.callbackAttempts !== 1 || receipt.mutationCount !== 1
      || receipt.indeterminateRecoveryObserved !== true || receipt.indeterminateRetryCount !== 0) throw new Error("restart continuation driver receipt is invalid")
  } else return undefined
  const { phase: _phase, ...validated } = receipt
  return validated as unknown as SanctuaryInteractiveDriverReceipt
}

type SanctuaryReadOnlyDenialLabel = "unit-16e-1-stop-denial" | "unit-16e-2-restart-denial"

function parseReadOnlyDenialReceipt(raw: string | null, label: SanctuaryUnit16EvidenceLabel, scenarioHandleDigest: string): SanctuaryReadOnlyDenialReceipt | undefined {
  if (raw === null) return undefined
  const receipt = object(JSON.parse(raw) as unknown, "read-only denial receipt")
  exactKeys(receipt, ["schemaVersion", "phase", "label", "scenarioHandleDigest", "operation", "targetDigest", "attemptCount", "httpStatus", "errorCode", "before", "after"], "read-only denial receipt")
  const expectedOperation = label === "unit-16e-1-stop-denial" ? "stop" : label === "unit-16e-2-restart-denial" ? "restart" : null
  if (receipt.schemaVersion !== "sanctuary-read-only-denial-receipt-v1" || receipt.phase !== "complete" || receipt.label !== label
    || receipt.scenarioHandleDigest !== scenarioHandleDigest || expectedOperation === null || receipt.operation !== expectedOperation
    || typeof receipt.targetDigest !== "string" || !SHA256.test(receipt.targetDigest) || receipt.attemptCount !== 1
    || ![200, 401, 403].includes(Number(receipt.httpStatus)) || (receipt.errorCode !== "FORBIDDEN" && receipt.errorCode !== "PERMISSION_DENIED")) {
    throw new Error("read-only denial receipt binding is invalid")
  }
  const boundaryKeys = ["ownerSnapshotDigest", "targetSnapshotDigest", "targetRestartCount", "targetContainerIdDigest", "auditCursorDigest", "providerUsageCursorDigest", "sessionCursorDigest", "toolActionCursorDigest"]
  const parseBoundary = (rawBoundary: unknown, boundaryLabel: string) => {
    const boundary = object(rawBoundary, boundaryLabel)
    exactKeys(boundary, boundaryKeys, boundaryLabel)
    if (![boundary.ownerSnapshotDigest, boundary.targetSnapshotDigest, boundary.targetContainerIdDigest, boundary.auditCursorDigest, boundary.providerUsageCursorDigest, boundary.sessionCursorDigest, boundary.toolActionCursorDigest]
      .every((value) => typeof value === "string" && SHA256.test(value)) || !Number.isSafeInteger(boundary.targetRestartCount) || Number(boundary.targetRestartCount) < 0) {
      throw new Error(`${boundaryLabel} is invalid`)
    }
    return boundary
  }
  const before = parseBoundary(receipt.before, "read-only denial before boundary")
  const after = parseBoundary(receipt.after, "read-only denial after boundary")
  if (receipt.targetDigest !== before.targetContainerIdDigest || receipt.targetDigest !== after.targetContainerIdDigest) throw new Error("read-only denial target binding is invalid")
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("read-only denial boundary drift was observed")
  return receipt as unknown as SanctuaryReadOnlyDenialReceipt
}

function durablePrivateJson(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  let fileFd: number | null = null
  try {
    fileFd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    writeFileSync(fileFd, `${JSON.stringify(value)}\n`)
    fsyncSync(fileFd)
    closeSync(fileFd)
    fileFd = null
    renameSync(temporary, filePath)
    fsyncSync(directoryFd)
  } finally {
    if (fileFd !== null) closeSync(fileFd)
    if (existsSync(temporary)) unlinkSync(temporary)
    closeSync(directoryFd)
  }
}

export function createSanctuaryReadOnlyDenialScenarioDriver(options: {
  agentRoot: string
  runProbe(label: SanctuaryReadOnlyDenialLabel, scenarioHandleDigest: string): Promise<SanctuaryReadOnlyDenialReceipt>
}) {
  const receiptPath = (scenarioHandleDigest: string) => pathFor(options.agentRoot, `state/acceptance/denial-receipts/${scenarioHandleDigest}.json`)
  const attemptPath = (scenarioHandleDigest: string) => pathFor(options.agentRoot, `state/acceptance/denial-attempts/${scenarioHandleDigest}.json`)
  const attemptsRoot = pathFor(options.agentRoot, "state/acceptance/denial-attempts")
  const assertNoIndeterminateAttempt = (label: SanctuaryReadOnlyDenialLabel): void => {
    try {
      const entries = readdirSync(attemptsRoot, { withFileTypes: true })
      if (entries.length > 100) throw new Error("read-only denial attempt inventory exceeds its bound")
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) throw new Error("read-only denial attempt inventory is invalid")
        const attempt = object(JSON.parse(readFileSync(pathFor(attemptsRoot, entry.name), "utf8")) as unknown, "read-only denial attempt")
        exactKeys(attempt, ["schemaVersion", "phase", "label", "scenarioHandleDigest"], "read-only denial attempt")
        if (attempt.schemaVersion !== "sanctuary-read-only-denial-attempt-v1" || attempt.phase !== "attempting"
          || typeof attempt.scenarioHandleDigest !== "string" || !SHA256.test(attempt.scenarioHandleDigest)) throw new Error("read-only denial attempt is invalid")
        if (attempt.label === label) throw new Error("read-only denial attempt is attempted or indeterminate; inspect-before-retry is required")
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  }
  return {
    async poll(rawLabel: SanctuaryUnit16EvidenceLabel, scenarioHandleDigest: string): Promise<{ state: "driven" }> {
      if (rawLabel !== "unit-16e-1-stop-denial" && rawLabel !== "unit-16e-2-restart-denial") throw new Error("read-only denial label is invalid")
      const label = rawLabel as SanctuaryReadOnlyDenialLabel
      const existingReceipt = receiptPath(scenarioHandleDigest)
      if (existsSync(existingReceipt)) {
        parseReadOnlyDenialReceipt(readFileSync(existingReceipt, "utf8"), label, scenarioHandleDigest)
        return { state: "driven" }
      }
      assertNoIndeterminateAttempt(label)
      const attempt = attemptPath(scenarioHandleDigest)
      durablePrivateJson(attempt, { schemaVersion: "sanctuary-read-only-denial-attempt-v1", phase: "attempting", label, scenarioHandleDigest })
      const receipt = await options.runProbe(label, scenarioHandleDigest)
      parseReadOnlyDenialReceipt(JSON.stringify(receipt), label, scenarioHandleDigest)
      durablePrivateJson(existingReceipt, receipt)
      return { state: "driven" }
    },
    complete(_label: SanctuaryUnit16EvidenceLabel, scenarioHandleDigest: string): void {
      for (const filePath of [receiptPath(scenarioHandleDigest), attemptPath(scenarioHandleDigest)]) if (existsSync(filePath)) unlinkSync(filePath)
    },
  }
}

function digestOptionalFiles(filePaths: string[]): string {
  const digest = createHash("sha256")
  for (const filePath of filePaths) {
    digest.update(filePath)
    try { digest.update(readFileSync(filePath)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      digest.update("[absent]")
    }
  }
  return digest.digest("hex")
}

async function captureReadOnlyDenialBoundary(agentRoot: string, deps: SanctuaryAcceptanceAdapterDependencies) {
  const ownerSnapshot = object(await dependency(deps.hostRequest, "Sanctuary host broker")({ operation: "container_snapshot", targetId: TARGET_ID }), "denial owner snapshot")
  const targetSnapshot = object(await dependency(deps.hostRequest, "Sanctuary host broker")({ operation: "denial_target_snapshot", targetId: TARGET_ID }), "denial target snapshot")
  exactKeys(targetSnapshot, ["containerIdDigest", "imageDigest", "running", "status", "restartCount", "startedAtDigest"], "denial target snapshot")
  if (![targetSnapshot.containerIdDigest, targetSnapshot.imageDigest, targetSnapshot.startedAtDigest].every((value) => typeof value === "string" && SHA256.test(value))
    || typeof targetSnapshot.running !== "boolean" || typeof targetSnapshot.status !== "string"
    || !Number.isSafeInteger(targetSnapshot.restartCount) || Number(targetSnapshot.restartCount) < 0) throw new Error("denial target snapshot is invalid")
  const auditPath = TELEGRAM_AUDIT
  const providerPath = pathFor(agentRoot, "state/acceptance/telegram-turns.ndjson")
  const toolPath = pathFor(agentRoot, "state/acceptance/restart-attempts.ndjson")
  const approvalDatabase = pathFor(agentRoot, "state/approvals/approvals.sqlite")
  return {
    ownerSnapshotDigest: createHash("sha256").update(JSON.stringify(ownerSnapshot)).digest("hex"),
    targetSnapshotDigest: createHash("sha256").update(JSON.stringify(targetSnapshot)).digest("hex"),
    targetRestartCount: Number(targetSnapshot.restartCount),
    targetContainerIdDigest: String(targetSnapshot.containerIdDigest),
    auditCursorDigest: digestOptionalFiles([auditPath]),
    providerUsageCursorDigest: digestOptionalFiles([providerPath]),
    sessionCursorDigest: createHash("sha256").update(JSON.stringify(readBoundedIdentitySurfaces(agentRoot))).digest("hex"),
    toolActionCursorDigest: digestOptionalFiles([toolPath, approvalDatabase, `${approvalDatabase}-wal`, `${approvalDatabase}-shm`]),
  }
}

async function executeSanctuaryReadOnlyDenialProbe(
  label: SanctuaryReadOnlyDenialLabel,
  scenarioHandleDigest: string,
  agentRoot: string,
  deps: SanctuaryAcceptanceAdapterDependencies,
): Promise<SanctuaryReadOnlyDenialReceipt> {
  const runtime = readMachineRuntimeCredentialConfig(TARGET_ID)
  if (!runtime.ok) throw new Error("read-only denial probe requires an unlocked machine runtime credential")
  const endpoint = exactLoopbackGraphqlEndpoint(runtime.config.unraidGraphqlUrl)
  const readKey = text(runtime.config.unraidReadApiKey, "read-only Unraid credential")
  const topologyQuery = "query AcceptanceDenialTarget { docker { containers(skipCache: true) { id names state status } } }"
  const topologyResponse = await deps.fetch(endpoint.href, { method: "POST", headers: { "content-type": "application/json", "x-api-key": readKey }, body: JSON.stringify({ query: topologyQuery, variables: {} }), signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) })
  const topologyEnvelope = object(await topologyResponse.json(), "read-only denial target response")
  const docker = object(object(topologyEnvelope.data, "read-only denial target data").docker, "read-only denial target docker")
  if (!Array.isArray(docker.containers)) throw new Error("read-only denial target list is invalid")
  const matches = docker.containers.map((entry) => object(entry, "read-only denial target"))
    .filter((entry) => Array.isArray(entry.names) && entry.names.some((name) => name === "calibre-web" || name === "/calibre-web"))
  if (matches.length !== 1 || typeof matches[0]!.id !== "string") throw new Error("read-only denial target is absent or ambiguous")
  const targetId = text(matches[0]!.id, "read-only denial target id")
  const canonicalTargetId = canonicalDockerIdFromUnraidPrefixedId(targetId)
  const before = await captureReadOnlyDenialBoundary(agentRoot, deps)
  if (before.targetContainerIdDigest !== createHash("sha256").update(canonicalTargetId).digest("hex")) throw new Error("read-only denial target identity is invalid")
  const query = label === "unit-16e-1-stop-denial"
    ? "mutation AcceptanceStopDenial($id: PrefixedID!) { docker { stop(id: $id) { id } } }"
    : WRITE_PROBE
  const response = await deps.fetch(endpoint.href, { method: "POST", headers: { "content-type": "application/json", "x-api-key": readKey }, body: JSON.stringify({ query, variables: { id: targetId } }), signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) })
  const envelope = object(await response.json(), "read-only mutation denial response")
  const codes = Array.isArray(envelope.errors) ? envelope.errors.map((raw) => object(raw, "read-only denial error")).flatMap((error) => {
    const extensions = error.extensions && typeof error.extensions === "object" && !Array.isArray(error.extensions) ? error.extensions as JsonObject : {}
    return typeof extensions.code === "string" ? [extensions.code] : []
  }) : []
  const errorCode = codes.includes("FORBIDDEN") ? "FORBIDDEN" : codes.includes("PERMISSION_DENIED") ? "PERMISSION_DENIED" : "UNCLASSIFIED"
  const after = await captureReadOnlyDenialBoundary(agentRoot, deps)
  if (after.targetContainerIdDigest !== createHash("sha256").update(canonicalTargetId).digest("hex")) throw new Error("read-only denial target identity drifted")
  return {
    schemaVersion: "sanctuary-read-only-denial-receipt-v1", phase: "complete", label, scenarioHandleDigest,
    operation: label === "unit-16e-1-stop-denial" ? "stop" : "restart",
    targetDigest: createHash("sha256").update(canonicalTargetId).digest("hex"), attemptCount: 1,
    httpStatus: response.status, errorCode, before, after,
  }
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
  const interactiveDriverRaw = optionalFixedFile(deps, pathFor(agentRoot, `state/acceptance/interactive-driver-receipts/${scenarioHandleDigest}.json`))
  const denialReceiptRaw = optionalFixedFile(deps, pathFor(agentRoot, `state/acceptance/denial-receipts/${scenarioHandleDigest}.json`))
  const agentConfig = parsedJson(optionalFixedFile(deps, pathFor(agentRoot, "agent.json")))
  const readinessPolicy = parsedJson(optionalFixedFile(deps, pathFor(agentRoot, "provider-readiness.json")))
  const rebootRaw = optionalFixedFile(deps, "/evidence/reboot.json")
  const expectedImageId = optionalFixedFile(deps, IMAGE_DIGEST_FILE)?.trim()
  let stopDenied = false
  let restartDenied = false
  let denialAuditCount = 0
  let denialStateUnchanged = false
  let denialProbeCompleted = false
  const denialReceipt = parseReadOnlyDenialReceipt(denialReceiptRaw, label, scenarioHandleDigest)
  if (denialReceipt) {
    denialStateUnchanged = JSON.stringify(denialReceipt.before) === JSON.stringify(denialReceipt.after)
    denialProbeCompleted = true
    denialAuditCount = denialReceipt.attemptCount
    if (label === "unit-16e-1-stop-denial") stopDenied = true
    else if (label === "unit-16e-2-restart-denial") restartDenied = true
  }
  const auditLedgerEntries = parseAuditLedger(auditRaw)
  const auditEntries = auditLedgerEntries.filter((entry) => entry.meta.scenarioHandleDigest === scenarioHandleDigest)
  const toolProfiles = parsedJson(optionalFixedFile(deps, SANCTUARY_TOOL_PROFILES_FILE))
  const profiles = toolProfiles ? object(toolProfiles.profiles, "Sanctuary tool profiles") : null
  const telegramProfile = profiles?.["sanctuary-telegram"]
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
    checkpointDigest: record.checkpointDigest,
    approvalEpoch: record.epoch,
    continuationEpoch: continuation?.continuationEpoch ?? null,
    continuationState: continuation?.continuationState ?? null,
    suspendedSessionRevision: record.suspendedSessionRevision,
    })
  })
  const restartAttempts = parseRestartAttempts(restartAttemptsRaw, scenarioHandleDigest)
  const telegramTurns = parseTelegramTurnReceipts(telegramTurnsRaw, scenarioHandleDigest, identityRaw?.trim() ?? null)
  const groundingTool = label === "unit-16d-whats-up" ? "unraid_get_system" : label === "unit-16d-1-space" ? "unraid_get_storage" : null
  const liveGrounding = groundingTool && deps.readLiveGrounding ? await deps.readLiveGrounding(groundingTool) : undefined
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
    && typeof rebootCheckpoint.idempotencyDigest === "string" && SHA256.test(rebootCheckpoint.idempotencyDigest)
    && typeof rebootCheckpoint.processBindingDigest === "string" && SHA256.test(rebootCheckpoint.processBindingDigest)
    && Number.isSafeInteger(rebootCheckpoint.unrelatedHostOperations) && Number(rebootCheckpoint.unrelatedHostOperations) >= 0) {
    reboot = {
      phase: "preflight", requestDigest: rebootCheckpoint.idempotencyDigest, processBindingDigest: rebootCheckpoint.processBindingDigest, requestCount: 0, checkpointPersisted: true, unrelatedHostOperations: Number(rebootCheckpoint.unrelatedHostOperations),
      bootIdentityChanged: false, hostReady: false, arrayReady: false, dockerReady: false, butlerReady: false, tailscaleReady: false, sshReady: false,
    }
  } else if (rebootCheckpoint?.operation === "reboot" && ["requested", "complete"].includes(String(rebootCheckpoint.phase))
    && typeof rebootCheckpoint.requestId === "string" && SHA256.test(rebootCheckpoint.requestId)
    && typeof rebootCheckpoint.prebootDigest === "string" && SHA256.test(rebootCheckpoint.prebootDigest)
    && typeof rebootCheckpoint.processBindingDigest === "string" && SHA256.test(rebootCheckpoint.processBindingDigest)
    && Number.isSafeInteger(rebootCheckpoint.unrelatedHostOperations) && Number(rebootCheckpoint.unrelatedHostOperations) >= 0) {
    const milestones = container && container.recoveryMilestones && typeof container.recoveryMilestones === "object" && !Array.isArray(container.recoveryMilestones)
      ? container.recoveryMilestones as JsonObject : {}
    const complete = rebootCheckpoint.phase === "complete" && typeof rebootCheckpoint.postbootDigest === "string" && SHA256.test(rebootCheckpoint.postbootDigest)
    reboot = {
      phase: rebootCheckpoint.phase as "requested" | "complete", requestDigest: createHash("sha256").update(rebootCheckpoint.requestId).digest("hex"), processBindingDigest: rebootCheckpoint.processBindingDigest, requestCount: 1, checkpointPersisted: true, unrelatedHostOperations: Number(rebootCheckpoint.unrelatedHostOperations),
      bootIdentityChanged: complete && rebootCheckpoint.postbootDigest !== rebootCheckpoint.prebootDigest,
      hostReady: milestones.hostReady === true, arrayReady: milestones.arrayReady === true, dockerReady: milestones.dockerReady === true,
      butlerReady: milestones.butlerReady === true, tailscaleReady: milestones.tailscaleReady === true, sshReady: milestones.sshReady === true,
    }
  }
  const health = parseHealthAcceptanceState(healthRaw)
  const activeMarker = readSanctuaryAcceptanceMarker(TARGET_ID)
  const postbootIntegrity = buildPostbootIntegritySnapshot({ offsetRaw, checkpointsRaw, restartAttempts: parseRestartAttempts(restartAttemptsRaw, null), cronRaw, health, auditLedgerEntries, activeScenarioHandleDigest: activeMarker?.scenarioHandleDigest ?? null })
  const prebootIntegrity = rebootCheckpoint && typeof rebootCheckpoint.prebootIntegrity === "object" && !Array.isArray(rebootCheckpoint.prebootIntegrity)
    ? rebootCheckpoint.prebootIntegrity as unknown as SanctuaryPostbootIntegritySnapshot : undefined
  const healthProbe = parseHealthProbeReceipt(healthProbeRaw, label, scenarioHandleDigest)
  const interactiveDriver = parseInteractiveDriverReceipt(interactiveDriverRaw, label, scenarioHandleDigest)
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
    const readinessProviders = readinessPolicy.providers.map((entry) => object(entry, "provider readiness candidate"))
    const glmReadiness = readinessProviders.find((entry) => entry.provider === "openai-compatible")
    const candidate = readinessProviders
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
      const glmCredentials = glmRecord.ok ? glmRecord.record.credentials as Record<string, unknown> : {}
      const geminiCredentials = geminiRecord.ok ? geminiRecord.record.credentials as Record<string, unknown> : {}
      const glmRecordConfig = glmRecord.ok ? glmRecord.record.config as Record<string, unknown> : {}
      const geminiRecordConfig = geminiRecord.ok ? geminiRecord.record.config as Record<string, unknown> : {}
      const exactContract = typeof identityRaw === "string" && typeof glmCredentials.apiKey === "string" && typeof geminiCredentials.apiKey === "string"
        ? evaluateSanctuaryProviderReadinessContract({
            outward: { provider: text(outwardConfig.provider, "outward provider"), model: outwardModel },
            inner: { provider: text(innerConfig.provider, "inner provider"), model: innerModel },
            glm: { baseUrl: text(glmRecordConfig.baseUrl, "GLM credential base URL"), vaultItem: typeof glmReadiness?.vaultItem === "string" ? glmReadiness.vaultItem : "", apiKey: glmCredentials.apiKey },
            gemini: { provider: text(candidate.provider, "Gemini provider"), model: geminiModel, vaultItem: text(candidate.vaultItem, "Gemini vault item") },
            geminiCredential: { baseUrl: text(geminiRecordConfig.baseUrl, "Gemini credential base URL"), apiKey: geminiCredentials.apiKey },
            selectionPolicy: text(readinessPolicy.selectionPolicy, "provider selection policy"), identityKey: identityRaw.trim(),
          })
        : { modelsExact: false, baseUrlsExact: false, vaultCoordinatesExact: false, credentialIdentitiesDistinct: false }
      liveProvider = {
        outwardReady: outwardPing.ok,
        innerReady: innerPing.ok,
        geminiCandidateReady: geminiPing.ok,
        providersDistinct: candidate.provider !== outwardConfig.provider,
        silentFallback: readinessPolicy.selectionPolicy !== "explicit-same-lane-only",
        credentialRevisionsPresent: glmRecord.ok && geminiRecord.ok && Boolean(glmRecord.record.revision) && Boolean(geminiRecord.record.revision),
        requestSemanticsExact,
        fallbackAttemptCount,
        ...exactContract,
        pingReceipts,
      }
    }
  }
  let containment: SanctuaryScenarioFacts["containment"]
  if (label === "unit-16e-containment-audit" || label === "unit-16d-2-unauthorized") {
    const inventoryEnvelope = object(await dependency(deps.hostRequest, "Sanctuary host broker")({ operation: "inventory_keys", targetServerId: TARGET_SERVER_ID }), "containment key inventory")
    if (!Array.isArray(inventoryEnvelope.keys)) throw new Error("containment key inventory is invalid")
    const rawInventory = inventoryEnvelope.keys.map((entry) => object(entry, "containment key record"))
    const inventory = rawInventory.map(normalizeKey)
    const redactedInventory = inventory.map((record) => ({
      idDigest: createHash("sha256").update(record.id).digest("hex"),
      name: record.name,
      permissions: flattenedPermissions(record),
      roles: [...record.roles].sort(),
    })).sort((left, right) => left.name.localeCompare(right.name))
    const readRecord = inventory.find((record) => record.name === "Butler RO")
    const writeRecord = inventory.find((record) => record.name === "Butler RW")
    const telegramNames = Array.isArray(telegramProfile) ? telegramProfile.filter((name): name is string => typeof name === "string") : []
    const privateRaw = profiles?.["sanctuary-health-private"]
    const privateNames = Array.isArray(privateRaw) ? privateRaw.filter((name): name is string => typeof name === "string") : []
    const flowSchemas = new Map([ponderTool, settleTool, speakTool, restTool].map((tool) => [tool.function.name, tool]))
    const schemasFor = (names: string[]) => names.flatMap((name) => {
      const schema = resolveToolDefinition(name)?.tool ?? flowSchemas.get(name)
      return schema ? [schema] : []
    })
    const telegramSchemas = schemasFor(telegramNames)
    const privateSchemas = schemasFor(privateNames)
    const handlerResolves = (name: string): boolean => typeof resolveToolDefinition(name)?.handler === "function" || flowSchemas.has(name)
    const excludedNames = ["shell", "read_file", "edit_file", "vault_get", "mcp_call", "exec", "credential_get"]
    const excludedSchemaIntersection = excludedNames.filter((name) => telegramNames.includes(name) || privateNames.includes(name))
    const productionBoundaryReceipts = await dependency(deps.runProductionBoundaryProbe, "production tool boundary probe")(telegramSchemas)
    const excludedAttempts = productionBoundaryReceipts.filter((receipt) => excludedNames.includes(receipt.name))
    const restartDefinition = resolveToolDefinition("unraid_restart_container")
    const writeApprovalPolicy = restartDefinition?.approvalPolicy?.({ container: "calibre-web" }) ?? { kind: "not_required" }
    let lifecycleBalance = 0
    let lifecyclePairs = 0
    for (const entry of auditLedgerEntries) {
      if (entry.event === "senses.telegram_turn_start") lifecycleBalance += 1
      if (entry.event === "senses.telegram_turn_end" && lifecycleBalance > 0) { lifecycleBalance -= 1; lifecyclePairs += 1 }
    }
    const rawWriteMaterialFieldCount = rawInventory.reduce((count, record) => count
      + Object.keys(record).filter((field) => /^(?:key|credential|secret|token)$/iu.test(field)).length, 0)
    containment = {
      schemaVersion: "sanctuary-containment-audit-v1",
      keyCount: inventory.length,
      keyInventoryDigest: createHash("sha256").update(JSON.stringify(redactedInventory)).digest("hex"),
      readScopeDigest: createHash("sha256").update(JSON.stringify(readRecord ? flattenedPermissions(readRecord) : [])).digest("hex"),
      writeScopeDigest: createHash("sha256").update(JSON.stringify(writeRecord ? flattenedPermissions(writeRecord) : [])).digest("hex"),
      keyRoleAssignmentCount: inventory.reduce((count, record) => count + record.roles.length, 0),
      telegramToolCount: telegramNames.length,
      telegramProfileDigest: createHash("sha256").update(JSON.stringify(telegramNames)).digest("hex"),
      telegramSchemaDigest: createHash("sha256").update(JSON.stringify(telegramSchemas)).digest("hex"),
      privateToolCount: privateNames.length,
      privateProfileDigest: createHash("sha256").update(JSON.stringify(privateNames)).digest("hex"),
      privateSchemaDigest: createHash("sha256").update(JSON.stringify(privateSchemas)).digest("hex"),
      resolvedHandlerCount: [...telegramNames, ...privateNames].filter(handlerResolves).length,
      excludedToolCount: excludedNames.length,
      excludedSchemaIntersectionCount: excludedSchemaIntersection.length,
      fabricatedHandlerInvocationCount: excludedSchemaIntersection.filter(handlerResolves).length,
      excludedToolAttemptCount: excludedAttempts.length,
      excludedToolRejectedCount: excludedAttempts.filter((attempt) => attempt.reason === "profile_excluded").length,
      excludedToolInvokedCount: excludedAttempts.filter((attempt) => attempt.invoked).length,
      excludedToolSideEffectCount: excludedAttempts.filter((attempt) => attempt.sideEffect).length,
      globallyResolvableExcludedToolCount: excludedAttempts.filter((attempt) => attempt.globallyResolvable).length,
      auditPathDigest: createHash("sha256").update(TELEGRAM_AUDIT).digest("hex"),
      auditLedgerDigest: createHash("sha256").update(JSON.stringify(auditLedgerEntries)).digest("hex"),
      auditRecordCount: auditLedgerEntries.length,
      auditLifecyclePairCount: lifecyclePairs,
      containerUser: typeof container?.user === "string" ? container.user : "",
      liveProcessUser: typeof container?.liveProcessUser === "string" ? container.liveProcessUser : "",
      mountCount: Number(container?.mountCount ?? -1),
      publishedPortCount: Number(container?.publishedPortCount ?? -1),
      networkMode: typeof container?.networkMode === "string" ? container.networkMode : "",
      readOnlyRoot: container?.readOnlyRoot === true,
      mountsExact: container?.mountsExact === true,
      securityExact: container?.securityExact === true,
      updaterDisabled: container?.updaterDisabled === true,
      writableKeyExposure: container?.writableKeyExposure !== false,
      rawWriteMaterialFieldCount,
      typedWriteExecutorCount: telegramNames.filter((name) => name === "unraid_restart_container" && writeApprovalPolicy.kind === "required").length,
      writeApprovalPolicyDigest: createHash("sha256").update(JSON.stringify(writeApprovalPolicy)).digest("hex"),
      sensitiveMaterialObserved: auditContainsSensitiveMaterial(auditRaw, deps.telegramCredentials?.()) || rawWriteMaterialFieldCount > 0 || container?.writableKeyExposure === true,
      stopDenied, restartDenied, denialAuditCount, denialStateUnchanged, denialProbeCompleted,
    }
  }
  const sourceValues: Record<string, unknown> = {
    "identity-key": identityRaw, "telegram-audit": auditEntries, "telegram-offset": offsetRaw,
    "approval-journal": approvals, "approval-checkpoints": checkpointsRaw, "container-inspect": container,
    "provider-live-check": liveProvider ?? null, "cron-runtime": cronRaw, "health-runtime": health, "restart-attempt-ledger": restartAttempts,
    "digest-runtime": health, "reboot-checkpoint": rebootCheckpoint, "telegram-turn-receipts": telegramTurns, "read-only-denial-receipt": denialReceipt ?? null,
    "identity-surface-audit": identity ? { inspectedRecordCount: identity.inspectedRecordCount, opaqueSubjectCount: identity.opaqueSubjectCount, mismatchCount: identity.mismatchCount, rawLeakCount: identity.rawLeakCount, surfaceDigest: identity.surfaceDigest } : null,
    "containment-audit": containment ?? null,
    "health-probe-receipt": healthProbe ?? null,
    "interactive-driver-receipt": parsedJson(interactiveDriverRaw),
    "live-grounding-read": liveGrounding ?? null,
  }
  return {
    capturedAt: deps.now?.() ?? Date.now(),
    sourceValues,
    postbootIntegrity,
    prebootIntegrity,
    events: auditEntries,
    approvals,
    restartAttempts,
    telegramTurns,
    liveGrounding,
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
    interactiveDriver,
    denial: denialReceipt,
    cron: cronRaw ? { registered: canonicalSanctuaryHealthCronRegistered(cronRaw), fingerprint: createHash("sha256").update(cronRaw).digest("hex"), receiptDigest: createHash("sha256").update(JSON.stringify(health?.deliveredReceipts ?? null)).digest("hex"), sweepCount: healthSweeps.length } : undefined,
    health: health ? { transitionCount: healthSweeps.filter((receipt) => Number(receipt.opened) > 0 || Number(receipt.recovered) > 0).length, alertCount: scenarioDeliveries.filter((receipt) => receipt.kind === "transition" || receipt.kind === "transition_and_digest").length, productionRestored: container?.running === true && container.health === "healthy" } : undefined,
    digest: health && digestFiredWithinMs !== null ? { scheduleObserved: Boolean(cronRaw && canonicalSanctuaryHealthCronRegistered(cronRaw)), messageCount: scenarioDeliveries.filter((receipt) => receipt.kind === "digest" || receipt.kind === "transition_and_digest").length, firedWithinMs: digestFiredWithinMs, productionRestored: container?.running === true && container.health === "healthy" } : undefined,
    reboot,
    containment: containment ?? {
      schemaVersion: "sanctuary-containment-audit-v1", keyCount: 0, keyInventoryDigest: "", readScopeDigest: "", writeScopeDigest: "", keyRoleAssignmentCount: 0,
      telegramToolCount: 0, telegramProfileDigest: "", telegramSchemaDigest: "", privateToolCount: 0, privateProfileDigest: "", privateSchemaDigest: "", resolvedHandlerCount: 0,
      excludedToolCount: 0, excludedSchemaIntersectionCount: 0, fabricatedHandlerInvocationCount: 0, excludedToolAttemptCount: 0, excludedToolRejectedCount: 0, excludedToolInvokedCount: 0, excludedToolSideEffectCount: 0, globallyResolvableExcludedToolCount: 0, auditPathDigest: "", auditLedgerDigest: "", auditRecordCount: 0, auditLifecyclePairCount: 0,
      containerUser: "", liveProcessUser: "", mountCount: 0, publishedPortCount: 0, networkMode: "", readOnlyRoot: false, mountsExact: false, securityExact: false, updaterDisabled: false,
      writableKeyExposure: container?.writableKeyExposure === true, rawWriteMaterialFieldCount: 0, typedWriteExecutorCount: 0, writeApprovalPolicyDigest: "",
      sensitiveMaterialObserved: auditContainsSensitiveMaterial(auditRaw) || container?.writableKeyExposure === true,
      stopDenied, restartDenied, denialAuditCount, denialStateUnchanged, denialProbeCompleted,
    },
  }
}

function postbootIntegritySnapshot(deps: SanctuaryAcceptanceAdapterDependencies): SanctuaryPostbootIntegritySnapshot {
  const agentRoot = getAgentRoot(TARGET_ID)
  const auditRaw = optionalFixedFile(deps, TELEGRAM_AUDIT) ?? ""
  const restartAttemptsRaw = optionalFixedFile(deps, pathFor(agentRoot, "state/acceptance/restart-attempts.ndjson")) ?? ""
  return buildPostbootIntegritySnapshot({
    offsetRaw: optionalFixedFile(deps, TELEGRAM_OFFSET), checkpointsRaw: optionalFixedFile(deps, pathFor(agentRoot, "state/approvals/checkpoints.json")),
    restartAttempts: parseRestartAttempts(restartAttemptsRaw, null), cronRaw: optionalFixedFile(deps, "/home/ouro/.ouro-cli/scheduler/sanctuary.crontab"),
    health: parseHealthAcceptanceState(optionalFixedFile(deps, pathFor(agentRoot, "state/health/sanctuary-health.json"))), auditLedgerEntries: parseAuditLedger(auditRaw),
    activeScenarioHandleDigest: readSanctuaryAcceptanceMarker(TARGET_ID)?.scenarioHandleDigest ?? null,
  })
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

async function interactiveRuntimeOperation(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  exactKeys(payload, ["operation", "label", "scenarioHandleDigest"], "interactive runtime payload")
  const operation = text(payload.operation, "interactive runtime operation")
  const label = text(payload.label, "interactive runtime label")
  const scenarioHandleDigest = text(payload.scenarioHandleDigest, "interactive runtime scenario digest")
  if (!SHA256.test(scenarioHandleDigest)) throw new Error("interactive runtime scenario digest is invalid")
  const expectedLabel = operation === "drive_timeout_stale" ? "unit-16k-timeout-stale"
    : operation === "drive_duplicate_callbacks" ? "unit-16l-duplicate-callback"
      : "unit-16m-restart-continuation"
  if (label !== expectedLabel) throw new Error("interactive runtime label is invalid")
  return dependency(deps.interactiveRuntime, "interactive production runtime")({ operation, label, scenarioHandleDigest })
}

async function interactiveRuntimeReady(payload: JsonObject): Promise<unknown> {
  exactKeys(payload, ["operation", "label", "scenarioHandleDigest"], "interactive readiness payload")
  if (payload.label !== "unit-16m-restart-continuation" || typeof payload.scenarioHandleDigest !== "string" || !SHA256.test(payload.scenarioHandleDigest)) {
    throw new Error("interactive readiness coordinates are invalid")
  }
  const agentRoot = getAgentRoot(TARGET_ID)
  const socketPath = path.join(agentRoot, "state", "acceptance", "telegram-control.sock")
  try {
    const response = object(await defaultHostRequest(payload, socketPath, 2_000), "interactive readiness response")
    exactKeys(response, ["ready"], "interactive readiness response")
    return { ready: response.ready === true }
  } catch {
    return { ready: false }
  }
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
  const preflightDigest = text(payload.preflightDigest, "preflightDigest")
  const processBindingDigest = text(payload.processBindingDigest, "processBindingDigest")
  if (!/^[0-9a-f]{32}$/u.test(idempotencyKey)) throw new Error("idempotencyKey is invalid")
  if (!SHA256.test(preflightDigest) || !SHA256.test(processBindingDigest)) throw new Error("reboot binding digest is invalid")
  const response = object(await dependency(deps.hostRequest, "Sanctuary host broker")({
    operation: "request_reboot", targetId: TARGET_ID, idempotencyKey, preflightDigest, processBindingDigest,
  }), "host reboot staging")
  const requestId = text(response.requestId, "host reboot requestId")
  const reservationId = text(response.reservationId, "host reboot reservationId")
  const prebootId = text(response.prebootId, "host reboot prebootId")
  if (response.accepted !== true || response.staged !== true || response.targetId !== TARGET_ID || response.preflightDigest !== preflightDigest || response.processBindingDigest !== processBindingDigest
    || requestId !== sha256(`sanctuary-reboot\0${idempotencyKey}`)
    || reservationId !== sha256(`sanctuary-reboot-reservation\0${requestId}`)) throw new Error("host reboot staging attestation is invalid")
  return { accepted: true, targetId: TARGET_ID, requestId, reservationId, prebootId, preflightDigest, processBindingDigest }
}

async function rebootPreflight(payload: JsonObject, deps: SanctuaryAcceptanceAdapterDependencies): Promise<unknown> {
  if (text(payload.targetId, "targetId") !== TARGET_ID) throw new Error("targetId is invalid")
  const processBindingDigest = fixedFile(deps, PROCESS_BINDING_DIGEST_FILE).trim()
  if (!SHA256.test(processBindingDigest)) throw new Error("process binding digest is invalid")
  const result = object(await dependency(deps.hostRequest, "Sanctuary host broker")({ operation: "reboot_preflight_snapshot", targetId: TARGET_ID, processBindingDigest }), "host reboot preflight")
  const digest = text(result.digest, "host reboot preflight digest")
  if (!SHA256.test(digest) || result.processBindingDigest !== processBindingDigest || result.safe !== true || result.arrayReady !== true || result.parityActive !== false || result.moverActive !== false || result.mutationActive !== false) {
    throw new Error("host reboot preflight attestation is invalid")
  }
  return result
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
      case "drive_timeout_stale": result = await interactiveRuntimeOperation(payload, deps); break
      case "drive_duplicate_callbacks": result = await interactiveRuntimeOperation(payload, deps); break
      case "prepare_restart_continuation": result = await interactiveRuntimeOperation(payload, deps); break
      case "reconcile_restart_continuation": result = await interactiveRuntimeOperation(payload, deps); break
      case "interactive_runtime_ready": result = await interactiveRuntimeReady(payload); break
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
      case "reboot_preflight_snapshot": result = await rebootPreflight(payload, deps); break
      case "postboot_integrity_snapshot": result = postbootIntegritySnapshot(deps); break
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

export type SanctuaryInteractiveRuntimeDependencies = SanctuaryInteractiveEngineDependencies

export const proveAttemptedRecoveryWithoutRetry = proveSanctuaryAttemptedRecoveryWithoutRetry

export async function executeSanctuaryInteractiveRuntimeOperation(
  rawPayload: JsonObject,
  supplied?: Partial<SanctuaryInteractiveRuntimeDependencies>,
): Promise<unknown> {
  exactKeys(rawPayload, ["operation", "label", "scenarioHandleDigest"], "interactive runtime payload")
  const agentRoot = supplied?.agentRoot ?? getAgentRoot(TARGET_ID)
  if (!supplied) return defaultHostRequest(rawPayload, path.join(agentRoot, "state", "acceptance", "telegram-control.sock"), ADAPTER_TIMEOUT_MS)
  const deps: SanctuaryInteractiveEngineDependencies = {
    agentRoot,
    readApprovals: supplied.readApprovals ?? ((digest) => readApprovalsByScenarioHandleDigest(path.join(agentRoot, "state", "approvals", "approvals.sqlite"), digest)),
    readPending: dependency(supplied.readPending, "daemon-owned pending approval reader"),
    createSession: supplied.createSession ?? (async () => { throw new Error("daemon-owned interactive callback session is unavailable") }),
    proveIndeterminateRecovery: supplied.proveIndeterminateRecovery ?? proveSanctuaryAttemptedRecoveryWithoutRetry,
    writeCredentialObserved: supplied.writeCredentialObserved ?? (() => /credential|api[_-]?key|token|secret/iu.test(JSON.stringify(rawPayload))),
    timeoutCoordinates: supplied.timeoutCoordinates ?? new Map(),
  }
  return executeSanctuaryInteractiveEngine(rawPayload, deps)
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
