import { createHash, randomBytes as nodeRandomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { constants as fsConstants } from "node:fs"
import * as path from "node:path"

import { emitNervesEvent } from "../../nerves/runtime"

const MAX_ADAPTER_OUTPUT = 1_048_576
const DEFAULT_ADAPTER_TIMEOUT_MS = 240_000
const DEFAULT_TELEGRAM_TIMEOUT_MS = 10_000
const PACKAGED_PROVENANCE_ADAPTER = "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh"
const OPAQUE_DIGEST = /^[0-9a-f]{64}$/u
type FixedEvidenceSchema = "telegram-cursor-v1" | "postboot-health-v1"

type JsonObject = Record<string, unknown>

export interface AcceptanceHarnessDependencies {
  readSecret(): string
  runAdapter(executable: string, payload: unknown, timeoutMs?: number): Promise<unknown>
  realpath(filePath: string): string
  fetch: typeof fetch
  now(): number
  randomBytes(size: number): Buffer
  sleep(milliseconds: number): Promise<void>
  telegramTimeoutMs?: number
}

export function resolveSanctuaryAdapterTimeoutMs(configured?: number, remaining?: number): number {
  const maximum = configured ?? DEFAULT_ADAPTER_TIMEOUT_MS
  return Math.max(1, Math.min(maximum, remaining ?? maximum))
}

export function createSanctuaryAcceptanceHarnessDependencies(
  secretFd = 3,
  options: { adapterTimeoutMs?: number; telegramTimeoutMs?: number } = {},
): AcceptanceHarnessDependencies {
  const adapterTimeoutMs = options.adapterTimeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS
  const telegramTimeoutMs = options.telegramTimeoutMs ?? DEFAULT_TELEGRAM_TIMEOUT_MS
  return {
    readSecret: () => readFileSync(secretFd, "utf8"),
    runAdapter: async (executable, payload, remainingMs) => {
      requireAbsoluteExecutable(executable)
      const result = spawnSync(executable, [], {
        input: `${JSON.stringify(payload)}\n`,
        encoding: "utf8",
        maxBuffer: MAX_ADAPTER_OUTPUT,
        timeout: resolveSanctuaryAdapterTimeoutMs(adapterTimeoutMs, remainingMs),
        cwd: "/",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        stdio: ["pipe", "pipe", "ignore"],
      })
      if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT") throw new Error("Sanctuary acceptance adapter timed out")
      if (result.error && "code" in result.error && result.error.code === "ENOBUFS") throw new Error("Sanctuary acceptance adapter output exceeded the limit")
      if (result.error || result.status !== 0) throw new Error("Sanctuary acceptance adapter failed")
      const stdout = result.stdout
      try {
        return JSON.parse(stdout) as unknown
      } catch {
        throw new Error("Sanctuary acceptance adapter returned invalid JSON")
      }
    },
    realpath: realpathSync,
    fetch,
    now: Date.now,
    randomBytes: nodeRandomBytes,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    telegramTimeoutMs,
  }
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as JsonObject
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be nonempty text`)
  return value.trim()
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} must be a safe integer >= ${minimum}`)
  return value as number
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`)
  return value
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) throw new Error(`${label} must be nonempty strings`)
  return value.map((item) => item.trim())
}

function requireAbsoluteExecutable(executable: string): void {
  if (!path.isAbsolute(executable)) throw new Error("adapter executable must be an absolute path")
}

function adapter(value: unknown, label: string): string {
  const executable = text(value, label)
  requireAbsoluteExecutable(executable)
  return executable
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function processUid(): number {
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error("acceptance harness requires an operating-system user identity")
  return uid
}

function privateAllowedRoot(config: JsonObject): string {
  const configured = text(config.allowedRoot, "allowedRoot")
  if (!path.isAbsolute(configured)) throw new Error("allowed root must be absolute")
  const resolved = path.resolve(configured)
  const metadata = lstatSync(resolved)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("allowed root must be a nonsymlink directory")
  if (metadata.uid !== processUid()) throw new Error("allowed root must be owned by the harness user")
  if ((metadata.mode & 0o077) !== 0) throw new Error("allowed root must be private")
  if (realpathSync(resolved) !== resolved) throw new Error("allowed root must be canonical")
  return resolved
}

function confinedPath(root: string, value: unknown, label: string): string {
  const configured = text(value, label)
  if (!path.isAbsolute(configured)) throw new Error(`${label} must be absolute`)
  const resolved = path.resolve(configured)
  const relative = path.relative(root, resolved)
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain within the allowed root`)
  }
  let cursor = root
  for (const segment of path.dirname(relative).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    const metadata = lstatSync(cursor)
    if (metadata.isSymbolicLink()) throw new Error(`${label} ancestor must not be a symlink`)
    if (!metadata.isDirectory() || metadata.uid !== processUid() || (metadata.mode & 0o077) !== 0) {
      throw new Error(`${label} ancestor must be an owned private directory`)
    }
  }
  return resolved
}

function requirePrivateRegularFile(root: string, value: unknown, label: string): string {
  const filePath = confinedPath(root, value, label)
  const metadata = lstatSync(filePath)
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${label} must be a nonsymlink regular file`)
  if (metadata.uid !== processUid() || (metadata.mode & 0o777) !== 0o600) throw new Error(`${label} must be an owned private file`)
  return filePath
}

function pathEntryExists(filePath: string): boolean {
  try {
    lstatSync(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

function syncDirectory(directory: string): void {
  const handle = openSync(directory, "r")
  try { fsyncSync(handle) } finally { closeSync(handle) }
}

function writeAtomicPrivateJson(root: string, filePath: string, value: unknown, replace: boolean): void {
  const confined = confinedPath(root, filePath, "checkpoint path")
  const temporary = `${confined}.tmp-${process.pid}-${nodeRandomBytes(8).toString("hex")}`
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 })
    const handle = openSync(temporary, "r")
    try { fsyncSync(handle) } finally { closeSync(handle) }
    if (replace) {
      requirePrivateRegularFile(root, confined, "checkpoint path")
      renameSync(temporary, confined)
      chmodSync(confined, 0o600)
      syncDirectory(path.dirname(confined))
      return
    }
    try {
      linkSync(temporary, confined)
    } catch {
      throw new Error("acceptance checkpoint claim failed; inspect-before-retry is required")
    }
    unlinkSync(temporary)
    syncDirectory(path.dirname(confined))
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

function writeAtomicPrivateText(root: string, filePath: string, value: string): void {
  const confined = confinedPath(root, filePath, "private text path")
  const temporary = `${confined}.tmp-${process.pid}-${nodeRandomBytes(8).toString("hex")}`
  try {
    writeFileSync(temporary, value, { flag: "wx", mode: 0o600 })
    const handle = openSync(temporary, "r")
    try { fsyncSync(handle) } finally { closeSync(handle) }
    try { linkSync(temporary, confined) } catch { throw new Error("private text claim failed; inspect-before-retry is required") }
    unlinkSync(temporary)
    syncDirectory(path.dirname(confined))
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

function initializeCheckpoint(root: string, filePath: string, value: JsonObject): void {
  writeAtomicPrivateJson(root, filePath, value, false)
}

function refuseExistingCheckpoint(root: string, filePath: string): void {
  const confined = confinedPath(root, filePath, "checkpoint path")
  if (pathEntryExists(confined)) throw new Error("acceptance checkpoint exists; inspect-before-retry is required")
}

function replaceCheckpoint(root: string, filePath: string, value: JsonObject): void {
  writeAtomicPrivateJson(root, filePath, value, true)
}

function readCheckpoint(root: string, filePath: unknown): JsonObject {
  const confined = requirePrivateRegularFile(root, filePath, "acceptance checkpoint")
  return object(JSON.parse(readFileSync(confined, "utf8")) as unknown, "acceptance checkpoint")
}

function safeErrorCategory(error: unknown): string {
  if (!(error instanceof Error)) return "unknown"
  if (/timed out/iu.test(error.message)) return "timeout"
  if (/adapter/iu.test(error.message)) return "adapter"
  if (/checkpoint|inspect-before-retry/iu.test(error.message)) return "checkpoint"
  return "validation"
}

function failedCheckpoint(root: string, filePath: string, base: JsonObject, error: unknown): void {
  replaceCheckpoint(root, filePath, { ...base, phase: "failed", errorCategory: safeErrorCategory(error) })
}

async function telegramRequest(
  deps: AcceptanceHarnessDependencies,
  token: string,
  method: string,
  body?: JsonObject,
  requestTimeoutMs = deps.telegramTimeoutMs ?? DEFAULT_TELEGRAM_TIMEOUT_MS,
): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs)
  let response: Response
  try {
    response = await deps.fetch(`https://api.telegram.org/bot${token}/${method}`, {
      ...(body ? {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      } : {}),
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Telegram request timed out")
    throw error
  } finally {
    clearTimeout(timeout)
  }
  let envelope: JsonObject
  try { envelope = object(await response.json(), "Telegram response") }
  catch { throw new Error("Telegram returned invalid JSON") }
  if (!response.ok || envelope.ok !== true) throw new Error("Telegram request failed")
  return envelope.result
}

export const SANCTUARY_UNIT_16_EVIDENCE_LABELS = [
  "unit-12c-1-opaque-identity",
  "unit-14b-3-opaque-identity-live",
  "unit-15c-1-no-callback-terminalization",
  "unit-16a-pre-reboot-checkpoint",
  "unit-16a-reboot-request",
  "unit-16a-boot-recovery-milestones",
  "unit-16b-runtime-vault-containment",
  "unit-16c-provider-readiness",
  "unit-16d-whats-up",
  "unit-16d-1-space",
  "unit-16d-2-unknown-admission",
  "unit-16e-containment-audit",
  "unit-16e-1-stop-denial",
  "unit-16e-2-restart-denial",
  "unit-16f-cron-fingerprint",
  "unit-16g-health-transition",
  "unit-16h-acceptance-delivery-probe",
  "unit-16i-delayed-approval",
  "unit-16j-denial",
  "unit-16k-timeout-stale",
  "unit-16l-duplicate-callback",
  "unit-16m-restart-continuation",
] as const

export type SanctuaryUnit16EvidenceLabel = typeof SANCTUARY_UNIT_16_EVIDENCE_LABELS[number]

const SANCTUARY_SCENARIO_ADAPTER_OPERATION = "capture_acceptance_scenario"
const SANCTUARY_SCENARIO_COMMAND = "evidence-snapshot"
const SCENARIO_CLEANUP_RESERVE_MS = 5_000
const MAX_SCENARIO_INTERVAL_MS = 30_000
const SCENARIO_CAPTURE_ADAPTER_TIMEOUT_MS = 210_000
const APPROVAL_TTL_MS = 300_000
const STALE_CALLBACK_INJECTION_TIMEOUT_MS = 120_000
const TIMEOUT_STALE_SCENARIO_MS =
  SCENARIO_CAPTURE_ADAPTER_TIMEOUT_MS
  + APPROVAL_TTL_MS
  + STALE_CALLBACK_INJECTION_TIMEOUT_MS
  + MAX_SCENARIO_INTERVAL_MS
  + SCENARIO_CAPTURE_ADAPTER_TIMEOUT_MS
  + SCENARIO_CLEANUP_RESERVE_MS
const REBOOT_SCENARIO_LABELS = new Set<SanctuaryUnit16EvidenceLabel>([
  "unit-16a-pre-reboot-checkpoint",
  "unit-16a-reboot-request",
  "unit-16a-boot-recovery-milestones",
])
const MAX_MATRIX_TIMEOUT_MS = 7_200_000

export function sanctuaryScenarioTimeoutBudget(label: SanctuaryUnit16EvidenceLabel): number {
  if (REBOOT_SCENARIO_LABELS.has(label)) return 125_000
  if (label === "unit-15c-1-no-callback-terminalization") return 365_000
  if (label === "unit-16h-acceptance-delivery-probe") return 1_025_000
  if (label === "unit-16f-cron-fingerprint") return 1_025_000
  if (label === "unit-16i-delayed-approval") return 185_000
  if (label === "unit-16k-timeout-stale") return TIMEOUT_STALE_SCENARIO_MS
  return SANCTUARY_SCENARIO_GATES[label] === "none" ? 35_000 : 305_000
}

function exactObjectKeys(value: JsonObject, expected: string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} fields are invalid`)
  }
}

function requiredTrue(value: JsonObject, key: string, label: string): void {
  if (boolean(value[key], `${label} ${key}`) !== true) throw new Error(`${label} ${key} must be true`)
}

function requiredFalse(value: JsonObject, key: string, label: string): void {
  if (boolean(value[key], `${label} ${key}`) !== false) throw new Error(`${label} ${key} must be false`)
}

function requiredInteger(value: JsonObject, key: string, expected: number, label: string): void {
  if (integer(value[key], `${label} ${key}`) !== expected) throw new Error(`${label} ${key} must equal ${expected}`)
}

export function validateSanctuaryUnit16EvidenceAssertions(label: SanctuaryUnit16EvidenceLabel, raw: unknown): JsonObject {
  const value = object(raw, `${label} assertions`)
  const exact = (keys: string[]): void => exactObjectKeys(value, keys, `${label} assertions`)
  const allTrue = (keys: string[]): void => keys.forEach((key) => requiredTrue(value, key, label))
  const allZero = (keys: string[]): void => keys.forEach((key) => requiredInteger(value, key, 0, label))
  switch (label) {
    case "unit-12c-1-opaque-identity":
    case "unit-14b-3-opaque-identity-live":
      exact(["identityBound", "opaqueSubject", "rawIdentityAbsent"])
      allTrue(["identityBound", "opaqueSubject", "rawIdentityAbsent"])
      break
    case "unit-15c-1-no-callback-terminalization":
      exact(["buttonsRemoved", "elapsedMs", "mutationCount", "noInboundUpdate", "replayMutationCount", "terminalExpired", "ttlMs"])
      allTrue(["buttonsRemoved", "noInboundUpdate", "terminalExpired"])
      allZero(["mutationCount", "replayMutationCount"])
      if (integer(value.ttlMs, `${label} ttlMs`, 1) > integer(value.elapsedMs, `${label} elapsedMs`, 1)) throw new Error(`${label} elapsedMs must reach ttlMs`)
      break
    case "unit-16a-pre-reboot-checkpoint":
      exact(["approvalDigest", "auditDigest", "containerDigest", "fingerprintDigest", "offsetDigest", "processBindingDigest", "ready", "unrelatedHostOperations"])
      for (const key of ["approvalDigest", "auditDigest", "containerDigest", "fingerprintDigest", "offsetDigest"]) opaqueDigest(value[key], `${label} ${key}`)
      opaqueDigest(value.processBindingDigest, `${label} processBindingDigest`)
      requiredTrue(value, "ready", label)
      requiredInteger(value, "unrelatedHostOperations", 0, label)
      break
    case "unit-16a-reboot-request":
      exact(["exactlyOnce", "processBindingDigest", "requestCheckpointPersisted", "requestDigest"])
      allTrue(["exactlyOnce", "requestCheckpointPersisted"])
      opaqueDigest(value.processBindingDigest, `${label} processBindingDigest`)
      opaqueDigest(value.requestDigest, `${label} requestDigest`)
      break
    case "unit-16a-boot-recovery-milestones":
      exact(["arrayReady", "bootIdentityChanged", "butlerReady", "dockerReady", "hostReady", "postbootIntegrityPreserved", "processBindingDigest", "sshReady", "tailscaleReady"])
      allTrue(["arrayReady", "bootIdentityChanged", "butlerReady", "dockerReady", "hostReady", "postbootIntegrityPreserved", "sshReady", "tailscaleReady"])
      opaqueDigest(value.processBindingDigest, `${label} processBindingDigest`)
      break
    case "unit-16b-runtime-vault-containment":
      exact(["autostartExact", "exactImage", "manualAuthRequired", "mountCount", "mountsExact", "nonRootUid", "publishedPortCount", "readOnlyRoot", "updaterDisabled", "vaultUnlocked"])
      allTrue(["autostartExact", "exactImage", "mountsExact", "readOnlyRoot", "updaterDisabled", "vaultUnlocked"])
      requiredFalse(value, "manualAuthRequired", label)
      requiredInteger(value, "mountCount", 4, label)
      requiredInteger(value, "nonRootUid", 10001, label)
      requiredInteger(value, "publishedPortCount", 0, label)
      break
    case "unit-16c-provider-readiness":
      exact(["innerReady", "laneSelectionExact", "outwardReady", "silentFallback", "singleCredentialExact", "vaultCoordinatesExact"])
      allTrue(["innerReady", "laneSelectionExact", "outwardReady", "singleCredentialExact", "vaultCoordinatesExact"])
      requiredFalse(value, "silentFallback", label)
      break
    case "unit-16d-whats-up":
      exact(["accurate", "authorized", "grounded", "liveFactsMatched", "responseCount", "responseWithinLimit", "telegramDelivered"])
      allTrue(["accurate", "authorized", "grounded", "liveFactsMatched", "responseWithinLimit", "telegramDelivered"])
      requiredInteger(value, "responseCount", 1, label)
      break
    case "unit-16d-1-space":
      exact(["accurate", "authorized", "grounded", "liveFactsMatched", "mutationCount", "responseCount", "responseWithinLimit", "telegramDelivered"])
      allTrue(["accurate", "authorized", "grounded", "liveFactsMatched", "responseWithinLimit", "telegramDelivered"])
      requiredInteger(value, "responseCount", 1, label)
      requiredInteger(value, "mutationCount", 0, label)
      break
    case "unit-16d-2-unknown-admission":
      exact(["acknowledgementSent", "agentTurnCount", "distinctAccount", "mutationCount", "ownerCardSent", "providerInvocationCount", "quarantined", "responseCount", "workItemCount"])
      allTrue(["acknowledgementSent", "distinctAccount", "ownerCardSent", "quarantined"])
      allZero(["agentTurnCount", "mutationCount", "providerInvocationCount", "responseCount", "workItemCount"])
      break
    case "unit-16e-containment-audit":
      exact([
        "schemaVersion", "keyCount", "keyInventoryDigest", "readScopeDigest", "writeScopeDigest", "keyRoleAssignmentCount",
        "telegramToolCount", "telegramProfileDigest", "telegramSchemaDigest", "privateToolCount", "privateProfileDigest", "privateSchemaDigest", "resolvedHandlerCount", "relationshipProfilesExact", "handlersExact",
        "excludedToolCount", "excludedSchemaIntersectionCount", "fabricatedHandlerInvocationCount", "excludedToolAttemptCount", "excludedToolRejectedCount", "excludedToolInvokedCount", "excludedToolSideEffectCount", "globallyResolvableExcludedToolCount",
        "auditPathDigest", "auditLedgerDigest", "auditRecordCount", "auditLifecyclePairCount",
        "containerUser", "liveProcessUser", "mountCount", "publishedPortCount", "networkMode", "readOnlyRoot", "mountsExact", "securityExact", "updaterDisabled", "writableKeyExposure",
        "rawWriteMaterialFieldCount", "typedWriteExecutorCount", "writeApprovalPolicyDigest", "writeApprovalPolicyExact", "sensitiveMaterialObserved", "mutationCount",
      ])
      if (text(value.schemaVersion, `${label} schemaVersion`) !== "sanctuary-containment-audit-v1") throw new Error(`${label} schemaVersion is invalid`)
      for (const key of ["keyInventoryDigest", "readScopeDigest", "writeScopeDigest", "telegramProfileDigest", "telegramSchemaDigest", "privateProfileDigest", "privateSchemaDigest", "auditPathDigest", "auditLedgerDigest", "writeApprovalPolicyDigest"]) opaqueDigest(value[key], `${label} ${key}`)
      for (const [key, expected] of Object.entries({
        readScopeDigest: "9914469afdcb574937d1020a03faa82e3c02d767169d3eccae4b81863dafa06e",
        writeScopeDigest: "1de873b2bc3c7769010c32c69fcc8ea55343a5647cfdb0294769e831142945ec",
        auditPathDigest: "1cb8f1a00c544a5d10b0577090dbf070a07a5b6a99de13ccd27c11a257f84b75",
      })) if (value[key] !== expected) throw new Error(`${label} ${key} does not match the canonical contract`)
      requiredInteger(value, "keyCount", 2, label)
      requiredInteger(value, "keyRoleAssignmentCount", 0, label)
      const telegramToolCount = integer(value.telegramToolCount, `${label} telegramToolCount`, 1)
      const privateToolCount = integer(value.privateToolCount, `${label} privateToolCount`, 1)
      if (integer(value.resolvedHandlerCount, `${label} resolvedHandlerCount`, 1) !== telegramToolCount + privateToolCount) throw new Error(`${label} handler count does not match the live relationship profiles`)
      requiredInteger(value, "excludedToolCount", 7, label)
      requiredInteger(value, "excludedToolAttemptCount", 7, label)
      requiredInteger(value, "excludedToolRejectedCount", 7, label)
      integer(value.globallyResolvableExcludedToolCount, `${label} globallyResolvableExcludedToolCount`, 1)
      allZero(["excludedSchemaIntersectionCount", "fabricatedHandlerInvocationCount", "excludedToolInvokedCount", "excludedToolSideEffectCount", "publishedPortCount", "rawWriteMaterialFieldCount", "mutationCount"])
      requiredFalse(value, "sensitiveMaterialObserved", label)
      requiredFalse(value, "writableKeyExposure", label)
      integer(value.auditRecordCount, `${label} auditRecordCount`, 2)
      integer(value.auditLifecyclePairCount, `${label} auditLifecyclePairCount`, 1)
      if (text(value.containerUser, `${label} containerUser`) !== "10001:10001" || text(value.liveProcessUser, `${label} liveProcessUser`) !== "10001:10001" || text(value.networkMode, `${label} networkMode`) !== "host") throw new Error(`${label} container identity or network is invalid`)
      requiredInteger(value, "mountCount", 4, label)
      requiredInteger(value, "typedWriteExecutorCount", 1, label)
      allTrue(["relationshipProfilesExact", "handlersExact", "writeApprovalPolicyExact", "readOnlyRoot", "mountsExact", "securityExact", "updaterDisabled"])
      break
    case "unit-16e-1-stop-denial":
    case "unit-16e-2-restart-denial":
      exact(["attemptCount", "cursorBoundaryCount", "denied", "mutationCount", "restartCountUnchanged", "resumed"])
      allTrue(["denied", "restartCountUnchanged", "resumed"])
      requiredInteger(value, "attemptCount", 1, label)
      requiredInteger(value, "cursorBoundaryCount", 7, label)
      requiredInteger(value, "mutationCount", 0, label)
      break
    case "unit-16f-cron-fingerprint":
      exact(["fingerprintUnchanged", "messageCount", "providerInvocationCount", "receiptUnchanged", "scheduleRegistered", "sweepObserved"])
      allTrue(["fingerprintUnchanged", "receiptUnchanged", "scheduleRegistered", "sweepObserved"])
      allZero(["messageCount", "providerInvocationCount"])
      break
    case "unit-16g-health-transition":
      exact(["alertCount", "productionRestored", "transitionObserved"])
      allTrue(["productionRestored", "transitionObserved"])
      requiredInteger(value, "alertCount", 3, label)
      break
    case "unit-16h-acceptance-delivery-probe":
      exact(["acceptanceOnly", "deliveryPathObserved", "firedWithinMs", "messageCount", "productionRestored", "productionScheduleChanged"])
      allTrue(["acceptanceOnly", "deliveryPathObserved", "productionRestored"])
      requiredFalse(value, "productionScheduleChanged", label)
      requiredInteger(value, "messageCount", 1, label)
      if (integer(value.firedWithinMs, `${label} firedWithinMs`, 0) > 960_000) throw new Error(`${label} fired outside the 16-minute bound`)
      break
    case "unit-16i-delayed-approval":
      exact(["elapsedMs", "mutationCount", "promptTerminal", "replayMutationCount", "resumed", "state"])
      if (integer(value.elapsedMs, `${label} elapsedMs`, 1) < 120_000) throw new Error(`${label} did not remain suspended for 120 seconds`)
      requiredInteger(value, "mutationCount", 1, label)
      requiredInteger(value, "replayMutationCount", 0, label)
      allTrue(["promptTerminal", "resumed"])
      if (value.state !== "succeeded") throw new Error(`${label} state must be succeeded`)
      break
    case "unit-16j-denial":
      exact(["mutationCount", "promptTerminal", "replayMutationCount", "resumed", "state"])
      allZero(["mutationCount", "replayMutationCount"])
      allTrue(["promptTerminal", "resumed"])
      if (value.state !== "denied") throw new Error(`${label} state must be denied`)
      break
    case "unit-16k-timeout-stale":
      exact(["buttonsRemoved", "mutationCount", "promptTerminal", "staleAcknowledged", "staleReplayMutationCount", "state"])
      allTrue(["buttonsRemoved", "promptTerminal", "staleAcknowledged"])
      allZero(["mutationCount", "staleReplayMutationCount"])
      if (value.state !== "expired") throw new Error(`${label} state must be expired`)
      break
    case "unit-16l-duplicate-callback":
      exact(["callbackCount", "claimCount", "mutationCount", "promptTerminal", "replayMutationCount", "settledCount", "staleReplaySettled", "writeCredentialAbsent"])
      requiredInteger(value, "callbackCount", 2, label)
      requiredInteger(value, "claimCount", 1, label)
      requiredInteger(value, "mutationCount", 1, label)
      requiredInteger(value, "settledCount", 2, label)
      requiredInteger(value, "replayMutationCount", 0, label)
      allTrue(["promptTerminal", "staleReplaySettled", "writeCredentialAbsent"])
      break
    case "unit-16m-restart-continuation":
      exact(["attemptedIndeterminateRetryCount", "butlerRestartObserved", "checkpointEpochPreserved", "continuationEpochAdvanced", "mutationCount", "preAttemptResumed", "restartObserved", "state"])
      allTrue(["butlerRestartObserved", "checkpointEpochPreserved", "continuationEpochAdvanced", "preAttemptResumed", "restartObserved"])
      requiredInteger(value, "attemptedIndeterminateRetryCount", 0, label)
      requiredInteger(value, "mutationCount", 1, label)
      if (value.state !== "succeeded") throw new Error(`${label} state must be succeeded`)
      break
  }
  return value
}

const RAW_LONG_DECIMAL = /^-?\d{5,16}$/u
const EPOCH_MILLISECONDS_MIN = 1_577_836_800_000
const EPOCH_MILLISECONDS_MAX = 4_102_444_800_000
const TYPED_TIMESTAMP_KEYS = new Set(["capturedAt", "completedAt", "requestedAt", "startedAt"])
const TYPED_SCENARIO_NUMERIC_KEYS = new Set([
  "activePollers", "alertCount", "attemptedIndeterminateRetryCount", "callbackCount", "claimCount",
  "elapsedMs", "firedWithinMs", "messageCount", "mountCount", "mutationCount", "nonRootUid",
  "providerInvocationCount", "publishedPortCount", "replayMutationCount", "responseCount",
  "settledCount", "staleReplayMutationCount", "ttlMs", "unrelatedHostOperations", "workItemCount",
])

function assertRedactedEvidence(value: unknown, label: string, key = ""): void {
  if (Array.isArray(value)) {
    for (const item of value) assertRedactedEvidence(item, label, key)
    return
  }
  if (value && typeof value === "object") {
    if (key === "evidenceCounters") {
      const counters = object(value, `${label} evidenceCounters`)
      for (const [counterName, counterValue] of Object.entries(counters)) {
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(counterName) || !Number.isSafeInteger(counterValue) || (counterValue as number) < 0) {
          throw new Error(`${label} evidenceCounters contain an invalid or raw Telegram identity-like counter`)
        }
      }
      return
    }
    for (const [key, item] of Object.entries(value as JsonObject)) {
      if (key === "writeCredentialAbsent" && item === true) continue
      if (key === "singleCredentialExact" && typeof item === "boolean") continue
      if (/(?:telegram)?(?:user|chat|update|message)[_-]?id|token|secret|password|credential|api[_-]?key/iu.test(key)) {
        throw new Error(`${label} contains a sensitive or raw Telegram identity field`)
      }
      assertRedactedEvidence(item, label, key)
    }
    return
  }
  if (typeof value === "string" && /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/u.test(value)) {
    throw new Error(`${label} contains sensitive material`)
  }
  if (((typeof value === "string" && RAW_LONG_DECIMAL.test(value))
    || (typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) >= 10_000))
    && !(typeof value === "number" && TYPED_TIMESTAMP_KEYS.has(key)
      && value >= EPOCH_MILLISECONDS_MIN && value <= EPOCH_MILLISECONDS_MAX)
    && !(typeof value === "number" && TYPED_SCENARIO_NUMERIC_KEYS.has(key) && value >= 0)) {
    throw new Error(`${label} contains a raw Telegram identity-like decimal value`)
  }
}

function normalizedEvidenceHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function exactEvidenceLabels(entries: Array<{ label: string }>): boolean {
  return JSON.stringify(entries.map((entry) => entry.label).sort())
    === JSON.stringify([...SANCTUARY_UNIT_16_EVIDENCE_LABELS].sort())
}

interface EvidenceProvenance {
  imageDigest: string
  containerDigest: string
  cursorDigest: string
  harnessSha256: string
}

type SanctuaryScenarioGate = "none" | "authorized-telegram-message" | "unknown-telegram-admission"
  | "telegram-delayed-approve" | "telegram-deny" | "telegram-stale-callback"
  | "telegram-concurrent-callback" | "telegram-restart-approve" | "authorized-telegram-restart-no-callback"

export const SANCTUARY_SCENARIO_GATES: Record<SanctuaryUnit16EvidenceLabel, SanctuaryScenarioGate> = {
  "unit-12c-1-opaque-identity": "none",
  "unit-14b-3-opaque-identity-live": "authorized-telegram-message",
  "unit-15c-1-no-callback-terminalization": "authorized-telegram-restart-no-callback",
  "unit-16a-pre-reboot-checkpoint": "none",
  "unit-16a-reboot-request": "none",
  "unit-16a-boot-recovery-milestones": "none",
  "unit-16b-runtime-vault-containment": "none",
  "unit-16c-provider-readiness": "none",
  "unit-16d-whats-up": "authorized-telegram-message",
  "unit-16d-1-space": "authorized-telegram-message",
  "unit-16d-2-unknown-admission": "unknown-telegram-admission",
  "unit-16e-containment-audit": "none",
  "unit-16e-1-stop-denial": "none",
  "unit-16e-2-restart-denial": "none",
  "unit-16f-cron-fingerprint": "none",
  "unit-16g-health-transition": "none",
  "unit-16h-acceptance-delivery-probe": "none",
  "unit-16i-delayed-approval": "telegram-delayed-approve",
  "unit-16j-denial": "telegram-deny",
  "unit-16k-timeout-stale": "telegram-stale-callback",
  "unit-16l-duplicate-callback": "telegram-concurrent-callback",
  "unit-16m-restart-continuation": "telegram-restart-approve",
}

type SanctuaryScenarioSource = "identity-key" | "telegram-audit" | "telegram-offset" | "approval-journal"
  | "approval-checkpoints" | "container-inspect" | "provider-live-check" | "cron-runtime"
  | "health-runtime" | "digest-runtime" | "health-probe-receipt" | "scheduler-liveness-receipt" | "reboot-checkpoint" | "restart-attempt-ledger" | "telegram-turn-receipts" | "read-only-denial-receipt" | "containment-audit" | "identity-surface-audit" | "interactive-driver-receipt"
  | "live-grounding-read"
  | "telegram-admission-evidence"

export const SANCTUARY_SCENARIO_SOURCES: Record<SanctuaryUnit16EvidenceLabel, SanctuaryScenarioSource[]> = {
  "unit-12c-1-opaque-identity": ["identity-key", "identity-surface-audit", "approval-journal"],
  "unit-14b-3-opaque-identity-live": ["identity-key", "identity-surface-audit", "telegram-audit", "approval-journal", "telegram-turn-receipts"],
  "unit-15c-1-no-callback-terminalization": ["identity-key", "telegram-audit", "telegram-offset", "approval-journal", "approval-checkpoints", "container-inspect"],
  "unit-16a-pre-reboot-checkpoint": ["telegram-audit", "telegram-offset", "approval-journal", "container-inspect", "cron-runtime", "reboot-checkpoint"],
  "unit-16a-reboot-request": ["reboot-checkpoint"],
  "unit-16a-boot-recovery-milestones": ["reboot-checkpoint", "container-inspect"],
  "unit-16b-runtime-vault-containment": ["container-inspect"],
  "unit-16c-provider-readiness": ["provider-live-check"],
  "unit-16d-whats-up": ["telegram-audit", "telegram-offset", "telegram-turn-receipts", "live-grounding-read"],
  "unit-16d-1-space": ["telegram-audit", "telegram-offset", "telegram-turn-receipts", "restart-attempt-ledger", "container-inspect", "live-grounding-read"],
  "unit-16d-2-unknown-admission": ["identity-key", "telegram-audit", "telegram-offset", "telegram-turn-receipts", "telegram-admission-evidence", "approval-journal", "restart-attempt-ledger", "container-inspect", "containment-audit"],
  "unit-16e-containment-audit": ["telegram-audit", "container-inspect", "containment-audit"],
  "unit-16e-1-stop-denial": ["read-only-denial-receipt", "container-inspect"],
  "unit-16e-2-restart-denial": ["read-only-denial-receipt", "container-inspect"],
  "unit-16f-cron-fingerprint": ["health-probe-receipt", "scheduler-liveness-receipt", "cron-runtime", "telegram-audit", "container-inspect"],
  "unit-16g-health-transition": ["health-probe-receipt", "telegram-audit", "container-inspect"],
  "unit-16h-acceptance-delivery-probe": ["health-probe-receipt", "cron-runtime", "telegram-audit", "container-inspect"],
  "unit-16i-delayed-approval": ["identity-key", "telegram-audit", "approval-journal", "approval-checkpoints", "restart-attempt-ledger", "container-inspect"],
  "unit-16j-denial": ["identity-key", "telegram-audit", "approval-journal", "approval-checkpoints", "restart-attempt-ledger", "container-inspect"],
  "unit-16k-timeout-stale": ["identity-key", "telegram-audit", "approval-journal", "approval-checkpoints", "restart-attempt-ledger", "container-inspect", "interactive-driver-receipt"],
  "unit-16l-duplicate-callback": ["identity-key", "telegram-audit", "approval-journal", "approval-checkpoints", "restart-attempt-ledger", "container-inspect", "interactive-driver-receipt"],
  "unit-16m-restart-continuation": ["identity-key", "telegram-audit", "approval-journal", "approval-checkpoints", "restart-attempt-ledger", "container-inspect", "interactive-driver-receipt"],
}

function packagedHarnessSha256(value: unknown, deps: AcceptanceHarnessDependencies): string {
  const configured = text(value, "harnessPath")
  if (!path.isAbsolute(configured)) throw new Error("harnessPath must be absolute")
  const resolved = path.resolve(configured)
  const handle = openSync(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const metadata = fstatSync(handle)
    if (!metadata.isFile()) throw new Error("packaged harness must be a regular file")
    if ((metadata.mode & 0o022) !== 0) throw new Error("packaged harness must not be group- or world-writable")
    if (deps.realpath(resolved) !== resolved) throw new Error("packaged harness path must be canonical")
    return createHash("sha256").update(readFileSync(handle)).digest("hex")
  } finally {
    closeSync(handle)
  }
}

function evidenceProvenance(value: unknown, label: string): EvidenceProvenance {
  const provenance = object(value, `${label} provenance`)
  const expectedKeys = ["containerDigest", "cursorDigest", "harnessSha256", "imageDigest"]
  if (JSON.stringify(Object.keys(provenance).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error(`${label} provenance must contain the exact continuity coordinates`)
  }
  return {
    imageDigest: opaqueDigest(provenance.imageDigest, `${label} imageDigest`),
    containerDigest: opaqueDigest(provenance.containerDigest, `${label} containerDigest`),
    cursorDigest: opaqueDigest(provenance.cursorDigest, `${label} cursorDigest`),
    harnessSha256: opaqueDigest(provenance.harnessSha256, `${label} harnessSha256`),
  }
}

function completeEvidenceContract(value: JsonObject, label: string): EvidenceProvenance {
  exactObjectKeys(value, ["assertions", "operation", "phase", "producer", "provenance", "schemaVersion"], `${label} evidence`)
  if (value.schemaVersion !== 1 || value.operation !== label || value.phase !== "complete") {
    throw new Error(`${label} evidence contract must use schemaVersion 1, its exact operation, and phase complete`)
  }
  const assertions = validateSanctuaryUnit16EvidenceAssertions(label as SanctuaryUnit16EvidenceLabel, value.assertions)
  const producer = object(value.producer, `${label} producer`)
  exactObjectKeys(producer, ["adapterOperation", "captureDigest", "checkpointDigest", "command", "sourceDigest"], `${label} producer`)
  if (producer.command !== SANCTUARY_SCENARIO_COMMAND || producer.adapterOperation !== SANCTUARY_SCENARIO_ADAPTER_OPERATION) {
    throw new Error(`${label} evidence was not produced by the fixed packaged scenario command`)
  }
  opaqueDigest(producer.checkpointDigest, `${label} checkpointDigest`)
  opaqueDigest(producer.sourceDigest, `${label} sourceDigest`)
  if (opaqueDigest(producer.captureDigest, `${label} captureDigest`) !== normalizedEvidenceHash(assertions)) {
    throw new Error(`${label} capture digest does not bind its typed assertions`)
  }
  return evidenceProvenance(value.provenance, label)
}

function sameStableProvenance(left: EvidenceProvenance, right: EvidenceProvenance): boolean {
  return left.imageDigest === right.imageDigest
    && left.containerDigest === right.containerDigest
    && left.harnessSha256 === right.harnessSha256
}

async function liveEvidenceProvenance(config: JsonObject, deps: AcceptanceHarnessDependencies, deadline?: number): Promise<Omit<EvidenceProvenance, "harnessSha256">> {
  const executable = adapter(config.provenanceAdapter, "provenanceAdapter")
  if (executable !== PACKAGED_PROVENANCE_ADAPTER) throw new Error("provenanceAdapter must be the packaged Sanctuary acceptance adapter")
  const remainingMs = deadline === undefined ? undefined : deadline - deps.now()
  if (remainingMs !== undefined && remainingMs <= 0) throw new Error("live evidence provenance exceeded its remaining deadline")
  const capture = object(await deps.runAdapter(executable, {
    operation: "capture_evidence_provenance",
    schema: "sanctuary-unit-16-provenance-v1",
  }, remainingMs), "live provenance")
  const expectedKeys = ["containerDigest", "cursorDigest", "imageDigest"]
  if (JSON.stringify(Object.keys(capture).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("live provenance must contain the exact image, container, and cursor coordinates")
  }
  return {
    imageDigest: opaqueDigest(capture.imageDigest, "live provenance imageDigest"),
    containerDigest: opaqueDigest(capture.containerDigest, "live provenance containerDigest"),
    cursorDigest: opaqueDigest(capture.cursorDigest, "live provenance cursorDigest"),
  }
}

function matchesLiveProvenance(provenance: EvidenceProvenance, live: Omit<EvidenceProvenance, "harnessSha256">): boolean {
  return provenance.imageDigest === live.imageDigest
    && provenance.containerDigest === live.containerDigest
    && provenance.cursorDigest === live.cursorDigest
}

async function evidenceBundleIndex(config: JsonObject, deps: AcceptanceHarnessDependencies): Promise<void> {
  const root = privateAllowedRoot(config)
  const evidencePath = confinedPath(root, config.evidencePath, "evidencePath")
  refuseExistingCheckpoint(root, evidencePath)
  if (!Array.isArray(config.entries)) throw new Error("evidence entries must be an array")
  const requested = config.entries.map((raw) => {
    const entry = object(raw, "evidence entry")
    return { label: text(entry.label, "evidence entry label"), path: entry.path }
  })
  if (!exactEvidenceLabels(requested) || new Set(requested.map((entry) => entry.label)).size !== requested.length) {
    throw new Error("evidence entries must equal the complete Unit 16 evidence matrix")
  }
  const harnessSha256 = packagedHarnessSha256(config.harnessPath, deps)
  const byLabel = new Map(requested.map((entry) => [entry.label, entry.path]))
  let continuity: EvidenceProvenance | undefined
  let latest: EvidenceProvenance | undefined
  const entries = SANCTUARY_UNIT_16_EVIDENCE_LABELS.map((label) => {
    const source = requirePrivateRegularFile(root, byLabel.get(label), `${label} evidence`)
    const value = object(JSON.parse(readFileSync(source, "utf8")) as unknown, `${label} evidence`)
    assertRedactedEvidence(value, label)
    const provenance = completeEvidenceContract(value, label)
    if (provenance.harnessSha256 !== harnessSha256) throw new Error(`${label} harness provenance does not match the packaged harness bytes`)
    continuity ??= provenance
    if (!sameStableProvenance(continuity, provenance)) throw new Error(`${label} provenance breaks image, container, or harness continuity`)
    latest = provenance
    return { label, sha256: normalizedEvidenceHash(value), evidence: value }
  })
  const live = await liveEvidenceProvenance(config, deps)
  const finalContinuity = latest as EvidenceProvenance
  if (!matchesLiveProvenance(finalContinuity, live)) {
    throw new Error("evidence coordinates do not match trusted live provenance")
  }
  const core = {
    schemaVersion: 1,
    operation: "sanctuary-unit-16-evidence-bundle",
    phase: "complete",
    imageDigest: finalContinuity.imageDigest,
    containerDigest: finalContinuity.containerDigest,
    cursorDigest: finalContinuity.cursorDigest,
    harnessSha256,
    entries,
  }
  initializeCheckpoint(root, evidencePath, { ...core, bundleDigest: normalizedEvidenceHash(core), completedAt: deps.now() })
}

async function verifyEvidenceBundle(config: JsonObject, deps: AcceptanceHarnessDependencies): Promise<void> {
  const root = privateAllowedRoot(config)
  const bundle = readCheckpoint(root, config.evidencePath)
  const harnessSha256 = packagedHarnessSha256(config.harnessPath, deps)
  if (bundle.schemaVersion !== 1 || bundle.operation !== "sanctuary-unit-16-evidence-bundle" || bundle.phase !== "complete") {
    throw new Error("evidence bundle header is invalid")
  }
  if (!Array.isArray(bundle.entries)) throw new Error("evidence bundle entries must be an array")
  let continuity: EvidenceProvenance | undefined
  let latest: EvidenceProvenance | undefined
  const entries = bundle.entries.map((raw) => {
    const entry = object(raw, "evidence bundle entry")
    const label = text(entry.label, "evidence bundle label")
    const evidence = object(entry.evidence, `${label} evidence`)
    assertRedactedEvidence(evidence, label)
    const provenance = completeEvidenceContract(evidence, label)
    if (provenance.harnessSha256 !== harnessSha256) throw new Error(`${label} harness provenance does not match the packaged harness bytes`)
    continuity ??= provenance
    if (!sameStableProvenance(continuity, provenance)) throw new Error(`${label} provenance breaks image, container, or harness continuity`)
    latest = provenance
    const sha256 = opaqueDigest(entry.sha256, `${label} entry hash`)
    if (sha256 !== normalizedEvidenceHash(evidence)) throw new Error("evidence bundle entry hash mismatch")
    return { label, sha256, evidence }
  })
  if (!exactEvidenceLabels(entries) || new Set(entries.map((entry) => entry.label)).size !== entries.length) {
    throw new Error("evidence bundle does not contain the complete Unit 16 evidence matrix")
  }
  const live = await liveEvidenceProvenance(config, deps)
  const finalContinuity = latest as EvidenceProvenance
  if (!matchesLiveProvenance(finalContinuity, live)) {
    throw new Error("evidence bundle coordinates do not match trusted live provenance")
  }
  const core = {
    schemaVersion: 1,
    operation: "sanctuary-unit-16-evidence-bundle",
    phase: "complete",
    imageDigest: opaqueDigest(bundle.imageDigest, "bundle imageDigest"),
    containerDigest: opaqueDigest(bundle.containerDigest, "bundle containerDigest"),
    cursorDigest: opaqueDigest(bundle.cursorDigest, "bundle cursorDigest"),
    harnessSha256: opaqueDigest(bundle.harnessSha256, "bundle harnessSha256"),
    entries,
  }
  if (core.imageDigest !== finalContinuity.imageDigest || core.containerDigest !== finalContinuity.containerDigest
    || core.cursorDigest !== finalContinuity.cursorDigest || core.harnessSha256 !== finalContinuity.harnessSha256) {
    throw new Error("evidence bundle continuity coordinates do not match its entries")
  }
  if (opaqueDigest(bundle.bundleDigest, "bundle digest") !== normalizedEvidenceHash(core)) throw new Error("evidence bundle digest mismatch")
}

async function telegramBootstrap(config: JsonObject, deps: AcceptanceHarnessDependencies): Promise<void> {
  const root = privateAllowedRoot(config)
  const evidencePath = confinedPath(root, config.evidencePath, "evidencePath")
  refuseExistingCheckpoint(root, evidencePath)
  const offsetPath = confinedPath(root, config.offsetPath, "offsetPath")
  const expectedBotId = text(config.expectedBotId, "expectedBotId")
  const expectedUsername = text(config.expectedUsername, "expectedUsername")
  const currentOffset = integer(config.currentOffset, "currentOffset")
  const noncePath = confinedPath(root, config.noncePath, "noncePath")
  refuseExistingCheckpoint(root, noncePath)
  const pollerAdapter = adapter(config.pollerAdapter, "pollerAdapter")
  const vaultAdapter = adapter(config.vaultAdapter, "vaultAdapter")
  if (pollerAdapter !== PACKAGED_PROVENANCE_ADAPTER || vaultAdapter !== PACKAGED_PROVENANCE_ADAPTER) {
    throw new Error("Telegram bootstrap requires the fixed packaged acceptance adapter")
  }
  const deadlineMs = integer(config.deadlineMs, "deadlineMs", 300_000)
  if (deadlineMs > 900_000) throw new Error("Telegram bootstrap deadline exceeds 15 minutes")
  const pollTimeoutSeconds = integer(config.pollTimeoutSeconds, "pollTimeoutSeconds", 1)
  if (pollTimeoutSeconds > 50) throw new Error("Telegram poll timeout exceeds 50 seconds")
  const token = deps.readSecret().trim()
  if (!token) throw new Error("Telegram token descriptor is empty")
  const bot = object(await telegramRequest(deps, token, "getMe"), "Telegram getMe result")
  if (String(bot.id) !== expectedBotId || bot.username !== expectedUsername) throw new Error("Telegram bot identity mismatch")

  const nonce = deps.randomBytes(16).toString("hex")
  const base: JsonObject = {
    schemaVersion: 1,
    operation: "telegram-bootstrap",
    phase: "preflight",
    botIdentityDigest: digest({ id: expectedBotId, username: expectedUsername }),
    startedAt: deps.now(),
  }
  initializeCheckpoint(root, evidencePath, base)
  try {
    const quiesced = object(await deps.runAdapter(pollerAdapter, {
      operation: "quiesce_telegram_poller",
      expectedState: "stopped",
    }), "Telegram poller precondition")
    exactObjectKeys(quiesced, ["activePollers", "quiesced"], "Telegram poller precondition")
    if (quiesced.quiesced !== true || quiesced.activePollers !== 0) throw new Error("Telegram competing poller is not quiescent")
    writeAtomicPrivateText(root, noncePath, nonce)

    const deadline = deps.now() + deadlineMs
    let nextOffset = currentOffset
    let match: JsonObject | undefined
    while (deps.now() < deadline && !match) {
      const updates = await telegramRequest(deps, token, "getUpdates", {
        offset: nextOffset,
        timeout: pollTimeoutSeconds,
        allowed_updates: ["message"],
      }, (pollTimeoutSeconds + 5) * 1_000)
      if (!Array.isArray(updates)) throw new Error("Telegram getUpdates result must be an array")
      const parsed = updates.map((entry) => object(entry, "Telegram update"))
      const updateIds = parsed.map((entry) => integer(entry.update_id, "Telegram update id"))
      if (updateIds.length > 0) nextOffset = Math.max(nextOffset, ...updateIds.map((id) => id + 1))
      const matches = parsed.filter((entry) => {
        const message = entry.message && typeof entry.message === "object" && !Array.isArray(entry.message) ? entry.message as JsonObject : null
        const chat = message?.chat && typeof message.chat === "object" && !Array.isArray(message.chat) ? message.chat as JsonObject : null
        return message?.text === nonce
          && chat?.type === "private"
          && typeof message?.from === "object"
          && message.from !== null
          && !Array.isArray(message.from)
          && !Object.keys(message).some((key) => key.startsWith("forward_"))
          && Number.isSafeInteger(message.date)
          && (message.date as number) >= Math.floor((base.startedAt as number) / 1000)
      })
      if (matches.length > 1) throw new Error("Telegram nonce update is ambiguous")
      match = matches[0]
    }
    if (!match) throw new Error("Telegram nonce confirmation timed out")
    const message = object(match.message, "Telegram nonce message")
    const from = object(message.from, "Telegram nonce sender")
    const chat = object(message.chat, "Telegram nonce chat")
    const userId = String(integer(from.id, "Telegram user id", 1))
    const chatId = String(integer(chat.id, "Telegram chat id", 1))
    const nextUpdateId = nextOffset
    const confirmed = {
      ...base,
      phase: "nonce_confirmed",
      updateDigest: digest(match),
      coordinateDigest: digest({ userId, chatId }),
      offsetDigest: digest(nextUpdateId),
    }
    replaceCheckpoint(root, evidencePath, confirmed)
    const stored = object(await deps.runAdapter(vaultAdapter, {
      operation: "store_telegram_bootstrap",
      botToken: token,
      authorizedUserId: userId,
      authorizedChatId: chatId,
    }), "vault adapter result")
    if (stored.stored !== true) throw new Error("Telegram vault adapter did not attest storage")
    replaceCheckpoint(root, evidencePath, { ...confirmed, phase: "vault_committed" })
    atomicPrivateJson(root, offsetPath, { nextUpdateId })
    replaceCheckpoint(root, evidencePath, { ...confirmed, phase: "complete", completedAt: deps.now() })
  } catch (error) {
    failedCheckpoint(root, evidencePath, base, error)
    throw error
  }
}

function atomicPrivateJson(root: string, filePath: string, value: unknown): void {
  writeAtomicPrivateJson(root, filePath, value, pathEntryExists(filePath))
}

function opaqueDigest(value: unknown, label: string): string {
  const result = text(value, label)
  if (!OPAQUE_DIGEST.test(result)) throw new Error(`${label} must be an opaque sha256 digest`)
  return result
}

function fixedEvidenceValues(schema: FixedEvidenceSchema, payload: unknown): Record<string, string | boolean> {
  const value = object(payload, `${schema} evidence`)
  switch (schema) {
    case "telegram-cursor-v1":
      return {
        offsetDigest: opaqueDigest(value.offsetDigest, "telegram cursor offsetDigest"),
        auditCursorDigest: opaqueDigest(value.auditCursorDigest, "telegram cursor auditCursorDigest"),
      }
    case "postboot-health-v1":
      return {
        healthy: boolean(value.healthy, "postboot healthy"),
        containerImageDigest: opaqueDigest(value.containerImageDigest, "postboot containerImageDigest"),
        telegramOffsetDigest: opaqueDigest(value.telegramOffsetDigest, "postboot telegramOffsetDigest"),
      }
  }
}

async function cursorSnapshot(config: JsonObject, deps: AcceptanceHarnessDependencies): Promise<void> {
  const root = privateAllowedRoot(config)
  const evidencePath = confinedPath(root, config.evidencePath, "evidencePath")
  refuseExistingCheckpoint(root, evidencePath)
  if (!Array.isArray(config.adapters) || config.adapters.length === 0) throw new Error("snapshot adapters must be nonempty")
  const values: Record<string, string | boolean> = {}
  const schemas = new Set<string>()
  for (const raw of config.adapters) {
    const spec = object(raw, "snapshot adapter")
    const schema = text(spec.schema, "snapshot adapter schema")
    if (schema !== "telegram-cursor-v1") throw new Error("unsupported cursor snapshot evidence schema")
    if (schemas.has(schema)) throw new Error("snapshot adapter schemas must be unique")
    schemas.add(schema)
    const executable = adapter(spec.executable, "snapshot adapter executable")
    const allowGenesis = spec.allowGenesis === undefined ? false : boolean(spec.allowGenesis, "snapshot adapter allowGenesis")
    if (allowGenesis && evidencePath !== path.join(root, "cursor-before.json")) throw new Error("snapshot adapter genesis authority is only valid for cursor-before evidence")
    const payload = await deps.runAdapter(executable, { operation: "snapshot", schema, allowGenesis })
    const selected = fixedEvidenceValues(schema, payload)
    for (const [name, value] of Object.entries(selected)) values[`${schema}.${name}`] = value
  }
  initializeCheckpoint(root, evidencePath, { schemaVersion: 1, operation: "cursor-snapshot", phase: "complete", schema: "telegram-cursor-v1", capturedAt: deps.now(), values })
}

function cursorSnapshotValues(checkpoint: JsonObject, label: string): Record<string, string> {
  if (checkpoint.schemaVersion !== 1 || checkpoint.operation !== "cursor-snapshot" || checkpoint.phase !== "complete"
    || checkpoint.schema !== "telegram-cursor-v1") {
    throw new Error(`${label} must be an exact complete cursor snapshot`)
  }
  const values = object(checkpoint.values, `${label} values`)
  const expectedKeys = ["telegram-cursor-v1.auditCursorDigest", "telegram-cursor-v1.offsetDigest"]
  if (JSON.stringify(Object.keys(values).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error(`${label} must contain the exact cursor snapshot values`)
  }
  return Object.fromEntries(expectedKeys.map((key) => [key, opaqueDigest(values[key], `${label} ${key}`)]))
}

async function cursorDelta(config: JsonObject, deps: AcceptanceHarnessDependencies): Promise<void> {
  const root = privateAllowedRoot(config)
  const evidencePath = confinedPath(root, config.evidencePath, "evidencePath")
  refuseExistingCheckpoint(root, evidencePath)
  const before = cursorSnapshotValues(readCheckpoint(root, config.beforePath), "before cursor snapshot")
  const after = cursorSnapshotValues(readCheckpoint(root, config.afterPath), "after cursor snapshot")
  const changes: Record<string, { before: string; after: string }> = {}
  for (const key of Object.keys(before).sort()) {
    if (before[key] !== after[key]) changes[key] = { before: before[key]!, after: after[key]! }
  }
  initializeCheckpoint(root, evidencePath, { schemaVersion: 1, operation: "cursor-delta", phase: "complete", capturedAt: deps.now(), changes })
}

async function callbackInject(config: JsonObject, deps: AcceptanceHarnessDependencies): Promise<void> {
  const root = privateAllowedRoot(config)
  const evidencePath = confinedPath(root, config.evidencePath, "evidencePath")
  refuseExistingCheckpoint(root, evidencePath)
  const executable = adapter(config.adapter, "callback adapter")
  const concurrency = integer(config.concurrency, "concurrency", 2)
  if (concurrency > 16) throw new Error("callback concurrency exceeds 16")
  let update: JsonObject
  try { update = object(JSON.parse(deps.readSecret()) as unknown, "saved callback update") }
  catch { throw new Error("saved callback update must be valid JSON") }
  object(update.callback_query, "saved callback update callback_query")
  const base = { schemaVersion: 1, operation: "callback-inject", phase: "preflight", updateDigest: digest(update), concurrency, replay: true }
  initializeCheckpoint(root, evidencePath, base)
  try {
    const preflight = async (): Promise<{ playbackCount: number; coordinateDigest: string; journalDigest: string }> => {
      const result = object(await deps.runAdapter(executable, { operation: "callback_playback_preflight", update }), "callback playback preflight")
      if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(["coordinateDigest", "journalDigest", "playbackCount"])) {
        throw new Error("callback playback preflight shape is invalid")
      }
      if (!Number.isSafeInteger(result.playbackCount) || Number(result.playbackCount) < 0) {
        throw new Error("callback playback preflight count is invalid")
      }
      if (typeof result.coordinateDigest !== "string" || !/^[0-9a-f]{64}$/u.test(result.coordinateDigest)) {
        throw new Error("callback playback preflight coordinate digest is invalid")
      }
      if (typeof result.journalDigest !== "string" || !/^[0-9a-f]{64}$/u.test(result.journalDigest)) {
        throw new Error("callback playback preflight journal digest is invalid")
      }
      return { playbackCount: Number(result.playbackCount), coordinateDigest: result.coordinateDigest, journalDigest: result.journalDigest }
    }
    const firstPreflight = await preflight()
    if (firstPreflight.playbackCount !== 0) throw new Error("callback injection requires zero prior playback")
    const secondPreflight = await preflight()
    if (secondPreflight.playbackCount !== 0) throw new Error("callback injection requires zero prior playback")
    if (secondPreflight.coordinateDigest !== firstPreflight.coordinateDigest) throw new Error("callback playback coordinate changed between preflights")
    if (secondPreflight.journalDigest !== firstPreflight.journalDigest) throw new Error("callback playback journal changed between preflights")
    const batch = object(await deps.runAdapter(executable, { operation: "inject_callbacks_concurrently", update, concurrency }), "callback batch result")
    if (!Array.isArray(batch.results) || batch.results.length !== concurrency) throw new Error("callback batch result count mismatch")
    const responses = batch.results
    let claims = 0
    let mutations = 0
    for (const response of responses) {
      const result = object(response, "callback adapter result")
      if (result.settled !== true) throw new Error("callback adapter did not settle")
      if (result.claimed === true) claims += 1
      else if (result.claimed !== false) throw new Error("callback adapter claim must be boolean")
      if (result.mutated === true) mutations += 1
      else if (result.mutated !== false) throw new Error("callback adapter mutation must be boolean")
    }
    if (claims !== 1) throw new Error("callback claim total must be exactly one")
    if (mutations !== 1) throw new Error("callback mutation total must be exactly one")
    const replayResult = object(await deps.runAdapter(executable, { operation: "inject_callback_replay", update }), "callback replay result")
    if (replayResult.settled !== true || typeof replayResult.claimed !== "boolean" || typeof replayResult.mutated !== "boolean") {
      throw new Error("callback replay did not settle canonically")
    }
    if (replayResult.claimed || replayResult.mutated) throw new Error("callback replay was claimed or mutated state")
    replaceCheckpoint(root, evidencePath, { ...base, phase: "complete", coordinateDigest: firstPreflight.coordinateDigest, zeroPlayback: true, claims, mutations, replayClaimed: false, replayMutated: false, completedAt: deps.now() })
  } catch (error) {
    failedCheckpoint(root, evidencePath, base, error)
    throw error
  }
}

interface InventoryKey { id: string; name: string; permissions: string[]; roles: string[] }
interface DesiredInventoryKey { name: string; vaultField: string; permissions: string[] }
interface OldInventoryKey { id: string; secretAdapter: string }

const SANCTUARY_ACCEPTANCE_ADAPTER = "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh"

function inventory(value: unknown): InventoryKey[] {
  const root = object(value, "Unraid inventory")
  if (!Array.isArray(root.keys)) throw new Error("Unraid inventory keys must be an array")
  const keys = root.keys.map((raw) => {
    const key = object(raw, "Unraid inventory key")
    return {
      id: text(key.id, "Unraid key id"),
      name: text(key.name, "Unraid key name"),
      permissions: stringArray(key.permissions, "Unraid key permissions").sort(),
      roles: Array.isArray(key.roles) ? stringArray(key.roles, "Unraid key roles").sort() : (() => { throw new Error("Unraid key roles must be an array") })(),
    }
  })
  if (new Set(keys.map((key) => key.id)).size !== keys.length) throw new Error("Unraid inventory key IDs must be unique")
  if (new Set(keys.map((key) => key.name)).size !== keys.length) throw new Error("Unraid inventory key names must be unique")
  return keys
}

function sameStrings(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

function sameInventoryKey(left: InventoryKey, right: InventoryKey): boolean {
  return left.id === right.id && left.name === right.name && sameStrings(left.permissions, right.permissions) && sameStrings(left.roles, right.roles)
}

function sameInventory(left: InventoryKey[], right: InventoryKey[]): boolean {
  const sorted = (keys: InventoryKey[]) => [...keys].sort((a, b) => a.id.localeCompare(b.id))
  const expected = sorted(left)
  const actual = sorted(right)
  return expected.length === actual.length && expected.every((key, index) => sameInventoryKey(key, actual[index]!))
}

async function rotateOccupiedCanonicalUnraidKeys(input: {
  root: string
  evidencePath: string
  targetServerId: string
  adapters: { inventory: string; create: string; store: string; revoke: string; probe: string }
  desired: DesiredInventoryKey[]
  oldKeys: OldInventoryKey[]
  initial: InventoryKey[]
  deps: AcceptanceHarnessDependencies
}): Promise<void> {
  const { root, evidencePath, targetServerId, adapters, desired, oldKeys, initial, deps } = input
  const prior = pathEntryExists(evidencePath) ? readCheckpoint(root, evidencePath) : null
  if (prior && (prior.schemaVersion !== 1 || prior.operation !== "unraid-key-rotate" || prior.targetServerId !== targetServerId)) {
    throw new Error("Unraid rotation checkpoint identity mismatch")
  }
  const suffix = prior ? text(prior.transactionSuffix, "Unraid rotation transaction suffix") : deps.randomBytes(8).subarray(0, 8).toString("hex")
  if (!/^[0-9a-f]{16}$/u.test(suffix)) throw new Error("Unraid rotation transaction suffix is invalid")
  const createdKeyIds = prior ? stringArray(prior.createdKeyIds, "createdKeyIds") : []
  const revokedKeyIds = prior ? stringArray(prior.revokedKeyIds, "revokedKeyIds") : []
  const transactionKeys = prior ? (() => {
    if (!Array.isArray(prior.transactionKeys)) throw new Error("Unraid rotation transaction keys are unavailable")
    return prior.transactionKeys.map((raw) => {
      const value = object(raw, "Unraid rotation transaction key")
      return {
        id: text(value.id, "transaction key id"), name: text(value.name, "transaction key name"),
        vaultField: text(value.vaultField, "transaction key vault field"),
        permissions: stringArray(value.permissions, "transaction key permissions").sort(),
        temporary: boolean(value.temporary, "transaction key temporary"),
        attested: boolean(value.attested, "transaction key attested"),
      }
    })
  })() : []
  if (new Set(createdKeyIds).size !== createdKeyIds.length || new Set(revokedKeyIds).size !== revokedKeyIds.length) {
    throw new Error("Unraid rotation checkpoint IDs are ambiguous")
  }
  if (new Set(transactionKeys.map((entry) => entry.id)).size !== transactionKeys.length
    || new Set(transactionKeys.map((entry) => entry.name)).size !== transactionKeys.length
    || !sameStrings(createdKeyIds, transactionKeys.map((entry) => entry.id))) {
    throw new Error("Unraid rotation transaction key metadata is ambiguous")
  }
  const slots = desired.flatMap((key) => [
    { ...key, name: `${key.name} Rotation ${suffix}`, temporary: true },
    { ...key, temporary: false },
  ])
  if (transactionKeys.some((entry) => {
    const slot = slots.find((candidate) => candidate.name === entry.name)
    return !slot || entry.temporary !== slot.temporary || entry.vaultField !== slot.vaultField
      || !sameStrings(entry.permissions, slot.permissions)
  })) throw new Error("Unraid rotation checkpoint transaction slots are invalid")
  const revocableKeyIds = new Set([
    ...oldKeys.map((entry) => entry.id),
    ...transactionKeys.filter((entry) => entry.temporary).map((entry) => entry.id),
  ])
  if (revokedKeyIds.some((id) => !revocableKeyIds.has(id))) {
    throw new Error("Unraid rotation checkpoint contains an unowned revoked key ID")
  }
  const temporary = transactionKeys.filter((entry) => entry.temporary)
  const canonical = transactionKeys.filter((entry) => !entry.temporary)
  const allOldRevoked = oldKeys.every((entry) => revokedKeyIds.includes(entry.id))
  const allTemporaryAttested = temporary.length === desired.length && temporary.every((entry) => entry.attested)
  const allCanonicalAttested = canonical.length === desired.length && canonical.every((entry) => entry.attested)
  const revokedTemporary = temporary.filter((entry) => revokedKeyIds.includes(entry.id))
  if (revokedTemporary.some((entry) => !entry.attested)
    || (oldKeys.some((entry) => revokedKeyIds.includes(entry.id)) && !allTemporaryAttested)
    || (revokedTemporary.length > 0 && !allCanonicalAttested)
    || (canonical.length > 0 && !allOldRevoked)) {
    throw new Error("Unraid rotation checkpoint revocation order is invalid")
  }
  const phase = prior ? text(prior.phase, "Unraid rotation phase") : "preflight"
  const knownPhases = new Set(["preflight", "temporary_key_created", "temporary_key_attested", "key_revoke_attempted", "key_revoked", "canonical_key_created", "canonical_key_attested", "complete"])
  const resumePhase = phase === "failed" ? text(prior?.resumePhase, "Unraid rotation resume phase") : phase
  if (!knownPhases.has(resumePhase) || (phase !== "failed" && prior?.resumePhase !== undefined)) {
    throw new Error("Unraid rotation checkpoint phase is invalid")
  }
  const stateMatchesPhase = resumePhase === "preflight" ? transactionKeys.length === 0 && revokedKeyIds.length === 0
    : resumePhase === "temporary_key_created" ? temporary.length > 0 && canonical.length === 0 && revokedKeyIds.length === 0 && temporary.filter((entry) => !entry.attested).length === 1
      : resumePhase === "temporary_key_attested" ? temporary.length > 0 && canonical.length === 0 && revokedKeyIds.length === 0 && temporary.every((entry) => entry.attested)
        : resumePhase === "key_revoke_attempted" ? allTemporaryAttested && (canonical.length === 0 || allCanonicalAttested)
          : resumePhase === "key_revoked" ? revokedKeyIds.length > 0 && allTemporaryAttested && (canonical.length === 0 || allCanonicalAttested)
            : resumePhase === "canonical_key_created" ? allTemporaryAttested && canonical.length > 0 && sameStrings(revokedKeyIds, oldKeys.map((entry) => entry.id)) && canonical.filter((entry) => !entry.attested).length === 1
              : resumePhase === "canonical_key_attested" ? allTemporaryAttested && canonical.length > 0 && sameStrings(revokedKeyIds, oldKeys.map((entry) => entry.id)) && canonical.every((entry) => entry.attested)
                : transactionKeys.length === slots.length && allTemporaryAttested && allCanonicalAttested
                  && sameStrings(revokedKeyIds, [...oldKeys.map((entry) => entry.id), ...temporary.map((entry) => entry.id)])
  if (!stateMatchesPhase) throw new Error("Unraid rotation checkpoint state does not match its phase")
  const base: JsonObject = {
    schemaVersion: 1, operation: "unraid-key-rotate", targetServerId,
    initialInventoryDigest: prior ? text(prior.initialInventoryDigest, "initialInventoryDigest") : digest(initial),
    transactionSuffix: suffix,
  }
  if (!prior) initializeCheckpoint(root, evidencePath, { ...base, phase: "preflight", createdKeyIds, revokedKeyIds, transactionKeys })
  if (phase === "complete") {
    const final = inventory(await deps.runAdapter(adapters.inventory, { operation: "inventory_keys", targetServerId }))
    const canonical = transactionKeys.filter((entry) => !entry.temporary)
      .map(({ id, name, permissions }) => ({ id, name, permissions, roles: [] as string[] }))
    if (canonical.length !== desired.length || !sameInventory(final, canonical)) {
      throw new Error("completed Unraid rotation inventory drifted")
    }
    return
  }
  const created: Array<InventoryKey & { handle: string; desired: DesiredInventoryKey; temporary: boolean }> = []
  let activePhase = resumePhase

  const checkpoint = (phase: string): void => {
    activePhase = phase
    replaceCheckpoint(root, evidencePath, { ...base, phase, createdKeyIds, revokedKeyIds, transactionKeys })
  }

  const createAndAttest = async (key: DesiredInventoryKey, name: string, temporary: boolean): Promise<void> => {
    const live = inventory(await deps.runAdapter(adapters.inventory, { operation: "inventory_keys", targetServerId }))
    const matches = live.filter((entry) => entry.name === name)
    const transaction = transactionKeys.find((entry) => entry.name === name)
    if (transaction && (transaction.temporary !== temporary || transaction.vaultField !== key.vaultField
      || !sameStrings(transaction.permissions, key.permissions))) throw new Error("resumable Unraid key metadata mismatch")
    if (transaction && revokedKeyIds.includes(transaction.id)) {
      if (matches.length !== 0) throw new Error("revoked Unraid transaction key inventory mismatch")
      return
    }
    if (transaction && temporary && matches.length === 0) return
    let id: string
    let handle: string
    if (matches.length === 1) {
      const existing = matches[0]!
      if (!sameStrings(existing.permissions, key.permissions) || existing.roles.length !== 0
        || oldKeys.some((old) => old.id === existing.id)
        || (transaction && transaction.id !== existing.id)) {
        throw new Error("resumable Unraid key scope or identity mismatch")
      }
      id = existing.id
      handle = `unraid-key:${id}:${key.vaultField}`
      if (!transaction) {
        const recovered = object(await deps.runAdapter(adapters.create, {
          operation: "create_key", targetServerId, name, permissions: key.permissions,
        }), "recovered Unraid key")
        if (recovered.id !== id || recovered.name !== name
          || !sameStrings(stringArray(recovered.permissions, "recovered permissions"), key.permissions)
          || !Array.isArray(recovered.roles) || recovered.roles.length !== 0) {
          throw new Error("recovered Unraid key scope or identity mismatch")
        }
        handle = text(recovered.key, "recovered key handle")
      }
    } else {
      const response = object(await deps.runAdapter(adapters.create, {
        operation: "create_key", targetServerId, name, permissions: key.permissions,
      }), "created Unraid key")
      id = text(response.id, "created key id")
      handle = text(response.key, "created key handle")
      if (response.name !== name || !sameStrings(stringArray(response.permissions, "created permissions"), key.permissions)
        || !Array.isArray(response.roles) || response.roles.length !== 0
        || oldKeys.some((old) => old.id === id) || created.some((entry) => entry.id === id)) {
        throw new Error("created Unraid key scope or identity mismatch")
      }
    }
    created.push({ id, name, permissions: key.permissions, roles: [], handle, desired: key, temporary })
    if (!createdKeyIds.includes(id)) createdKeyIds.push(id)
    const metadata = transaction ?? { id, name, vaultField: key.vaultField, permissions: key.permissions, temporary, attested: false }
    if (!transaction) transactionKeys.push(metadata)
    checkpoint(temporary ? "temporary_key_created" : "canonical_key_created")
    if (!metadata.attested) {
      const stored = object(await deps.runAdapter(adapters.store, {
        operation: "store_key", targetServerId, vaultField: key.vaultField, keyId: id, key: handle,
      }), "key store result")
      if (stored.stored !== true || stored.keyId !== id) throw new Error("vault did not attest exact key storage")
    }
    const probe = object(await deps.runAdapter(adapters.probe, {
      operation: "probe_new_key", targetServerId, id, key: handle,
    }), "new key probe")
    if (probe.valid !== true) throw new Error("new Unraid key readiness failed")
    metadata.attested = true
    checkpoint(temporary ? "temporary_key_attested" : "canonical_key_attested")
  }

  const revokeAndReject = async (id: string, handle: string): Promise<void> => {
    if (revokedKeyIds.includes(id)) return
    const live = inventory(await deps.runAdapter(adapters.inventory, { operation: "inventory_keys", targetServerId }))
    if (live.some((entry) => entry.id === id)) {
      const revoked = object(await deps.runAdapter(adapters.revoke, { operation: "revoke_key", targetServerId, id }), "key revoke result")
      if (revoked.revoked !== true || revoked.id !== id) throw new Error("Unraid revoke did not attest exact key id")
      checkpoint("key_revoke_attempted")
    }
    const probe = object(await deps.runAdapter(adapters.probe, { operation: "probe_revoked_key", targetServerId, id, key: handle }), "revoked key probe")
    if (probe.valid !== false || (probe.status !== 401 && probe.status !== 403)) throw new Error("revoked Unraid key still authenticates")
    revokedKeyIds.push(id)
    checkpoint("key_revoked")
  }

  try {
    for (const key of desired) await createAndAttest(key, `${key.name} Rotation ${suffix}`, true)
    const withTemporary = inventory(await deps.runAdapter(adapters.inventory, { operation: "inventory_keys", targetServerId }))
    const liveOld = withTemporary.filter((entry) => oldKeys.some((old) => old.id === entry.id))
    const inventoryAmbiguous = withTemporary.some((entry) => {
      if (oldKeys.some((old) => old.id === entry.id)) {
        const expected = desired.find((candidate) => candidate.name === entry.name)
        return !expected || !sameStrings(expected.permissions, entry.permissions) || entry.roles.length !== 0
      }
      const metadata = transactionKeys.find((candidate) => candidate.id === entry.id)
      return !metadata || metadata.name !== entry.name || !sameStrings(metadata.permissions, entry.permissions) || entry.roles.length !== 0
    })
    const missingBridge = liveOld.length > 0 && transactionKeys.filter((entry) => entry.temporary && !revokedKeyIds.includes(entry.id))
      .some((entry) => !withTemporary.some((candidate) => candidate.id === entry.id))
    if (inventoryAmbiguous || missingBridge) {
      throw new Error("temporary Unraid key inventory changed ambiguously")
    }
    for (const old of oldKeys) {
      const live = inventory(await deps.runAdapter(adapters.inventory, { operation: "inventory_keys", targetServerId }))
      if (live.some((entry) => entry.id === old.id)) {
        const secret = object(await deps.runAdapter(old.secretAdapter, { operation: "read_old_key", targetServerId, id: old.id }), "old key handle result")
        await revokeAndReject(old.id, text(secret.key, "old key handle"))
      } else {
        await revokeAndReject(old.id, `unraid-key:${old.id}:legacy`)
      }
    }
    let afterOldRevokes = inventory(await deps.runAdapter(adapters.inventory, { operation: "inventory_keys", targetServerId }))
    const existingCanonical = transactionKeys.filter((entry) => !entry.temporary)
    if (existingCanonical.length === desired.length) {
      for (const key of transactionKeys.filter((entry) => entry.temporary && !revokedKeyIds.includes(entry.id))) {
        if (!afterOldRevokes.some((entry) => entry.id === key.id)) {
          await revokeAndReject(key.id, `unraid-key:${key.id}:${key.vaultField}`)
        }
      }
      afterOldRevokes = inventory(await deps.runAdapter(adapters.inventory, { operation: "inventory_keys", targetServerId }))
    }
    const exactPhase = transactionKeys.filter((entry) => !revokedKeyIds.includes(entry.id))
      .map(({ id, name, permissions }) => ({ id, name, permissions, roles: [] as string[] }))
    if (existingCanonical.length > desired.length || !sameInventory(afterOldRevokes, exactPhase)) {
      throw new Error("old-key revoke inventory is not the exact temporary pair")
    }
    for (const key of desired) await createAndAttest(key, key.name, false)
    const withCanonical = inventory(await deps.runAdapter(adapters.inventory, { operation: "inventory_keys", targetServerId }))
    if (withCanonical.some((entry) => {
      const metadata = transactionKeys.find((candidate) => candidate.id === entry.id)
      return !metadata || metadata.name !== entry.name || !sameStrings(metadata.permissions, entry.permissions) || entry.roles.length !== 0
    }) || transactionKeys.filter((entry) => !entry.temporary).some((entry) => !withCanonical.some((candidate) => candidate.id === entry.id))) {
      throw new Error("canonical-key mint inventory changed ambiguously")
    }
    for (const key of transactionKeys.filter((entry) => entry.temporary)) {
      await revokeAndReject(key.id, `unraid-key:${key.id}:${key.vaultField}`)
    }
    const final = inventory(await deps.runAdapter(adapters.inventory, { operation: "inventory_keys", targetServerId }))
    const canonical = transactionKeys.filter((entry) => !entry.temporary)
      .map(({ id, name, permissions }) => ({ id, name, permissions, roles: [] as string[] }))
    if (!sameInventory(final, canonical)) throw new Error("final canonical Unraid key inventory mismatch")
    replaceCheckpoint(root, evidencePath, {
      ...base,
      phase: "complete",
      createdKeyIds,
      revokedKeyIds,
      transactionKeys,
      finalInventoryDigest: digest(final),
      completedAt: deps.now(),
    })
  } catch (error) {
    replaceCheckpoint(root, evidencePath, { ...base, phase: "failed", resumePhase: activePhase, createdKeyIds, revokedKeyIds, transactionKeys, errorCategory: safeErrorCategory(error) })
    throw error
  }
}

async function unraidKeyRotate(config: JsonObject, deps: AcceptanceHarnessDependencies): Promise<void> {
  const root = privateAllowedRoot(config)
  const evidencePath = confinedPath(root, config.evidencePath, "evidencePath")
  const targetServerId = text(config.targetServerId, "targetServerId")
  const inventoryAdapter = adapter(config.inventoryAdapter, "inventoryAdapter")
  const createAdapter = adapter(config.createAdapter, "createAdapter")
  const storeAdapter = adapter(config.storeAdapter, "storeAdapter")
  const revokeAdapter = adapter(config.revokeAdapter, "revokeAdapter")
  const probeAdapter = adapter(config.probeAdapter, "probeAdapter")
  if (!Array.isArray(config.keys) || config.keys.length === 0) throw new Error("Unraid desired keys must be nonempty")
  const desired = config.keys.map((raw) => {
    const key = object(raw, "desired Unraid key")
    const permissions = stringArray(key.permissions, "desired key permissions")
    if (new Set(permissions).size !== permissions.length) throw new Error("desired key permissions must be unique")
    return { name: text(key.name, "desired key name"), vaultField: text(key.vaultField, "desired vault field"), permissions: permissions.sort() }
  })
  if (new Set(desired.map((key) => key.name)).size !== desired.length) throw new Error("desired key names must be unique")
  if (new Set(desired.map((key) => key.vaultField)).size !== desired.length) throw new Error("desired key vault fields must be unique")
  if (!Array.isArray(config.oldKeys)) throw new Error("oldKeys must be an array")
  const oldKeys = config.oldKeys.map((raw) => {
    const old = object(raw, "old Unraid key")
    return { id: text(old.id, "old key id"), secretAdapter: adapter(old.secretAdapter, "old key secretAdapter") }
  })
  if (new Set(oldKeys.map((key) => key.id)).size !== oldKeys.length) throw new Error("old key IDs must be unique")
  const initial = inventory(await deps.runAdapter(inventoryAdapter, { operation: "inventory_keys", targetServerId }))
  const occupiedCanonicalContract = targetServerId === "sanctuary-unraid"
    && desired.length === 2 && oldKeys.length === 2
    && JSON.stringify(desired.map((key) => key.name).sort()) === JSON.stringify(["Butler RO", "Butler RW"])
    && (pathEntryExists(evidencePath) || (initial.length === 2 && desired.every((key) => {
      const existing = initial.find((entry) => entry.name === key.name)
      return existing !== undefined && oldKeys.some((old) => old.id === existing.id)
        && existing.roles.length === 0 && sameStrings(existing.permissions, key.permissions)
    })))
    && [inventoryAdapter, createAdapter, storeAdapter, revokeAdapter, probeAdapter, ...oldKeys.map((old) => old.secretAdapter)]
      .every((value) => value === SANCTUARY_ACCEPTANCE_ADAPTER)
  if (occupiedCanonicalContract) {
    await rotateOccupiedCanonicalUnraidKeys({
      root, evidencePath, targetServerId,
      adapters: { inventory: inventoryAdapter, create: createAdapter, store: storeAdapter, revoke: revokeAdapter, probe: probeAdapter },
      desired, oldKeys, initial, deps,
    })
    return
  }
  refuseExistingCheckpoint(root, evidencePath)
  for (const key of desired) if (initial.some((entry) => entry.name === key.name)) throw new Error(`Unraid key ${key.name} already exists`)
  for (const old of oldKeys) if (!initial.some((entry) => entry.id === old.id)) throw new Error(`old Unraid key ${old.id} is absent`)

  const base: JsonObject = { schemaVersion: 1, operation: "unraid-key-rotate", phase: "preflight", targetServerId, initialInventoryDigest: digest(initial), createdKeyIds: [], revokedKeyIds: [] }
  initializeCheckpoint(root, evidencePath, base)
  const createdKeyIds: string[] = []
  const revokedKeyIds: string[] = []
  try {
    for (const key of desired) {
      const created = object(await deps.runAdapter(createAdapter, { operation: "create_key", targetServerId, name: key.name, permissions: key.permissions }), "created Unraid key")
      const id = text(created.id, "created key id")
      const rawKey = text(created.key, "created raw key")
      if (created.name !== key.name || !sameStrings(stringArray(created.permissions, "created permissions"), key.permissions)
        || !Array.isArray(created.roles) || created.roles.length !== 0) throw new Error("created Unraid key scope mismatch")
      if (initial.some((entry) => entry.id === id) || oldKeys.some((entry) => entry.id === id) || createdKeyIds.includes(id)) {
        throw new Error("created Unraid key ID is preexisting or reused")
      }
      createdKeyIds.push(id)
      replaceCheckpoint(root, evidencePath, { ...base, phase: "key_created", createdKeyIds, revokedKeyIds })
      const stored = object(await deps.runAdapter(storeAdapter, { operation: "store_key", targetServerId, vaultField: key.vaultField, keyId: id, key: rawKey }), "key store result")
      if (stored.stored !== true || stored.keyId !== id) throw new Error("vault did not attest exact key storage")
      const probe = object(await deps.runAdapter(probeAdapter, { operation: "probe_new_key", targetServerId, id, key: rawKey }), "new key probe")
      if (probe.valid !== true) throw new Error("new Unraid key readiness failed")
      replaceCheckpoint(root, evidencePath, { ...base, phase: "key_attested", createdKeyIds, revokedKeyIds })
    }
    for (const old of oldKeys) {
      const reconciled = inventory(await deps.runAdapter(inventoryAdapter, { operation: "inventory_keys", targetServerId }))
      const expected = [
        ...initial.filter((entry) => !revokedKeyIds.includes(entry.id)),
        ...desired.map((key, index): InventoryKey => ({ id: createdKeyIds[index]!, name: key.name, permissions: key.permissions, roles: [] })),
      ]
      if (!sameInventory(reconciled, expected)) throw new Error("Unraid inventory changed ambiguously before exact revoke")
      const secretResult = object(await deps.runAdapter(old.secretAdapter, { operation: "read_old_key", targetServerId, id: old.id }), "old key secret result")
      const rawOldKey = text(secretResult.key, "old raw key")
      const revoked = object(await deps.runAdapter(revokeAdapter, { operation: "revoke_key", targetServerId, id: old.id }), "key revoke result")
      if (revoked.revoked !== true || revoked.id !== old.id) throw new Error("Unraid revoke did not attest exact key id")
      const probe = object(await deps.runAdapter(probeAdapter, { operation: "probe_revoked_key", targetServerId, id: old.id, key: rawOldKey }), "revoked key probe")
      if (probe.valid !== false || (probe.status !== 401 && probe.status !== 403)) throw new Error("revoked Unraid key still authenticates")
      revokedKeyIds.push(old.id)
      replaceCheckpoint(root, evidencePath, { ...base, phase: "old_key_revoked", createdKeyIds, revokedKeyIds })
    }
    const final = inventory(await deps.runAdapter(inventoryAdapter, { operation: "inventory_keys", targetServerId }))
    const expectedFinal = [
      ...initial.filter((entry) => !oldKeys.some((old) => old.id === entry.id)),
      ...desired.map((key, index): InventoryKey => ({ id: createdKeyIds[index]!, name: key.name, permissions: key.permissions, roles: [] })),
    ]
    if (!sameInventory(final, expectedFinal)) throw new Error("final Unraid key inventory mismatch")
    replaceCheckpoint(root, evidencePath, { ...base, phase: "complete", createdKeyIds, revokedKeyIds, finalInventoryDigest: digest(final), completedAt: deps.now() })
  } catch (error) {
    failedCheckpoint(root, evidencePath, { ...base, createdKeyIds, revokedKeyIds }, error)
    throw error
  }
}

async function captureScenarioEvidence(input: {
  config: JsonObject
  root: string
  executable: string
  harnessSha256: string
  label: SanctuaryUnit16EvidenceLabel
  deadline: number
  intervalMs: number
  deps: AcceptanceHarnessDependencies
}): Promise<void> {
  const { config, root, executable, harnessSha256, label, deadline, intervalMs, deps } = input
  const evidencePath = path.join(root, `${label}.json`)
  refuseExistingCheckpoint(root, evidencePath)
  const gate = SANCTUARY_SCENARIO_GATES[label]
  const sources = SANCTUARY_SCENARIO_SOURCES[label]
  const operationDeadline = deadline - SCENARIO_CLEANUP_RESERVE_MS
  const runBefore = async (payload: unknown, callLabel: string, callDeadline = operationDeadline): Promise<unknown> => {
    const remainingMs = callDeadline - deps.now()
    if (remainingMs <= 0) throw new Error(`${label} ${callLabel} timed out at its remaining deadline`)
    return deps.runAdapter(executable, payload, remainingMs)
  }
  let capture: { checkpointDigest: string; assertions: JsonObject; sourceDigest: string; provenance: Omit<EvidenceProvenance, "harnessSha256"> } | undefined
  let operationError: unknown
  try {
    let response = object(await runBefore({
      operation: SANCTUARY_SCENARIO_ADAPTER_OPERATION,
      phase: "begin",
      label,
      externalGate: gate,
      sources,
    }, "begin"), `${label} begin result`)
    exactObjectKeys(response, response.state === "complete" ? ["assertions", "checkpointDigest", "sourceDigests", "state"] : ["checkpointDigest", "state"], `${label} begin result`)
    const checkpointDigest = opaqueDigest(response.checkpointDigest, `${label} checkpointDigest`)
    while (response.state === "waiting") {
      const remainingBeforeSleep = operationDeadline - deps.now()
      if (remainingBeforeSleep <= 0) throw new Error(`${label} live scenario timed out while awaiting ${gate}`)
      await deps.sleep(Math.min(intervalMs, remainingBeforeSleep))
      response = object(await runBefore({
        operation: SANCTUARY_SCENARIO_ADAPTER_OPERATION,
        phase: "poll",
        label,
        externalGate: gate,
        sources,
        checkpointDigest,
      }, "poll"), `${label} poll result`)
      exactObjectKeys(response, response.state === "complete" ? ["assertions", "checkpointDigest", "sourceDigests", "state"] : ["checkpointDigest", "state"], `${label} poll result`)
      if (opaqueDigest(response.checkpointDigest, `${label} checkpointDigest`) !== checkpointDigest) throw new Error(`${label} checkpoint identity drifted`)
    }
    if (response.state !== "complete") throw new Error(`${label} scenario returned an invalid state`)
    const sourceDigests = object(response.sourceDigests, `${label} sourceDigests`)
    exactObjectKeys(sourceDigests, sources, `${label} sourceDigests`)
    for (const source of sources) opaqueDigest(sourceDigests[source], `${label} ${source} source digest`)
    capture = {
      checkpointDigest,
      assertions: validateSanctuaryUnit16EvidenceAssertions(label, response.assertions),
      sourceDigest: normalizedEvidenceHash(sourceDigests),
      provenance: await liveEvidenceProvenance(config, deps, operationDeadline),
    }
  } catch (error) {
    operationError = error
  }
  let cleanupError: unknown
  try {
    const cleanupRemainingMs = Math.max(1, deadline - deps.now())
    const finalized = object(await deps.runAdapter(executable, { operation: "finalize_acceptance_scenarios" }, cleanupRemainingMs), "scenario finalization result")
    exactObjectKeys(finalized, ["finalized"], "scenario finalization result")
    if (finalized.finalized !== true) throw new Error("scenario finalization failed")
  } catch (error) {
    cleanupError = error
  }
  if (operationError && cleanupError) {
    const operationMessage = operationError instanceof Error ? operationError.message : "unknown operation error"
    const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : "unknown cleanup error"
    throw new AggregateError([operationError, cleanupError], `${label} scenario operation failed: ${operationMessage}; cleanup failed: ${cleanupMessage}`)
  }
  if (operationError) throw operationError
  if (cleanupError) throw cleanupError
  if (!capture) throw new Error(`${label} scenario capture was not produced`)
  const value = {
    schemaVersion: 1,
    operation: label,
    phase: "complete",
    provenance: { ...capture.provenance, harnessSha256 },
    producer: {
      command: SANCTUARY_SCENARIO_COMMAND,
      adapterOperation: SANCTUARY_SCENARIO_ADAPTER_OPERATION,
      checkpointDigest: capture.checkpointDigest,
      sourceDigest: capture.sourceDigest,
      captureDigest: normalizedEvidenceHash(capture.assertions),
    },
    assertions: capture.assertions,
  }
  completeEvidenceContract(value, label)
  initializeCheckpoint(root, evidencePath, value)
}

async function scenarioMatrixSnapshot(config: JsonObject, deps: AcceptanceHarnessDependencies): Promise<void> {
  const root = privateAllowedRoot(config)
  const executable = adapter(config.adapter, "scenario adapter")
  if (executable !== PACKAGED_PROVENANCE_ADAPTER || config.provenanceAdapter !== PACKAGED_PROVENANCE_ADAPTER) {
    throw new Error("scenario matrix requires the fixed packaged acceptance adapter")
  }
  const timeoutMs = integer(config.timeoutMs, "scenario total timeoutMs", 1)
  const intervalMs = integer(config.intervalMs, "scenario intervalMs", 1)
  if (timeoutMs > MAX_MATRIX_TIMEOUT_MS || intervalMs > MAX_SCENARIO_INTERVAL_MS) throw new Error("scenario timing bound is invalid")
  const harnessSha256 = packagedHarnessSha256(config.harnessPath, deps)
  const totalDeadline = deps.now() + timeoutMs
  for (const label of REBOOT_SCENARIO_LABELS) {
    const value = object(JSON.parse(readFileSync(requirePrivateRegularFile(root, path.join(root, `${label}.json`), `${label} phase evidence`), "utf8")) as unknown, `${label} phase evidence`)
    const provenance = completeEvidenceContract(value, label)
    if (provenance.harnessSha256 !== harnessSha256) throw new Error(`${label} phase evidence does not match the packaged harness`)
  }
  for (const label of SANCTUARY_UNIT_16_EVIDENCE_LABELS.filter((candidate) => !REBOOT_SCENARIO_LABELS.has(candidate))) {
    const scenarioDeadline = Math.min(totalDeadline, deps.now() + sanctuaryScenarioTimeoutBudget(label))
    await captureScenarioEvidence({ config, root, executable, harnessSha256, label, deadline: scenarioDeadline, intervalMs, deps })
  }
}

async function evidenceSnapshot(config: JsonObject, deps: AcceptanceHarnessDependencies): Promise<void> {
  if (config.schema === "sanctuary-unit-16-matrix-v1") {
    await scenarioMatrixSnapshot(config, deps)
    return
  }
  const root = privateAllowedRoot(config)
  const evidencePath = confinedPath(root, config.evidencePath, "evidencePath")
  refuseExistingCheckpoint(root, evidencePath)
  const schema = text(config.schema, "snapshot schema")
  if (schema !== "postboot-health-v1") throw new Error("unsupported standalone evidence schema")
  const executable = adapter(config.adapter, "snapshot adapter")
  const payload = await deps.runAdapter(executable, { operation: "evidence_snapshot", schema })
  const values = fixedEvidenceValues(schema, payload)
  initializeCheckpoint(root, evidencePath, {
    schemaVersion: 1,
    operation: "evidence-snapshot",
    phase: "complete",
    schema,
    capturedAt: deps.now(),
    values,
  })
}

async function captureRebootScenario(
  config: JsonObject,
  root: string,
  label: SanctuaryUnit16EvidenceLabel,
  deps: AcceptanceHarnessDependencies,
): Promise<void> {
  const executable = adapter(config.scenarioAdapter, "reboot scenario adapter")
  if (executable !== PACKAGED_PROVENANCE_ADAPTER || config.provenanceAdapter !== PACKAGED_PROVENANCE_ADAPTER) {
    throw new Error("reboot scenario capture requires the fixed packaged acceptance adapter")
  }
  const harnessSha256 = packagedHarnessSha256(config.harnessPath, deps)
  const intervalMs = integer(config.scenarioIntervalMs, "reboot scenario intervalMs", 1)
  const timeoutMs = integer(config.scenarioTimeoutMs, "reboot scenario timeoutMs", 1)
  if (timeoutMs > sanctuaryScenarioTimeoutBudget(label) || intervalMs > MAX_SCENARIO_INTERVAL_MS) throw new Error("reboot scenario timing bound is invalid")
  await captureScenarioEvidence({
    config, root, executable, harnessSha256, label,
    deadline: deps.now() + timeoutMs,
    intervalMs,
    deps,
  })
}

async function rebootRequest(config: JsonObject, deps: AcceptanceHarnessDependencies): Promise<void> {
  const root = privateAllowedRoot(config)
  const evidencePath = confinedPath(root, config.evidencePath, "evidencePath")
  refuseExistingCheckpoint(root, evidencePath)
  const targetId = text(config.targetId, "targetId")
  const executable = adapter(config.adapter, "reboot adapter")
  const idempotencyKey = deps.randomBytes(16).toString("hex")
  const preflight = object(await deps.runAdapter(executable, { operation: "reboot_preflight_snapshot", targetId }), "reboot preflight adapter result")
  const preflightDigest = opaqueDigest(preflight.digest, "reboot preflight digest")
  const processBindingDigest = opaqueDigest(preflight.processBindingDigest, "reboot process binding digest")
  if (preflight.arrayReady !== true || typeof preflight.parityActive !== "boolean" || typeof preflight.moverActive !== "boolean" || typeof preflight.mutationActive !== "boolean") {
    throw new Error("reboot preflight is invalid")
  }
  const unrelatedHostOperations = [preflight.parityActive, preflight.moverActive, preflight.mutationActive].filter((value) => value === true).length
  if (preflight.safe !== true || unrelatedHostOperations !== 0) throw new Error("reboot preflight is unsafe")
  const prebootIntegrity = object(await deps.runAdapter(executable, { operation: "postboot_integrity_snapshot" }), "preboot integrity snapshot")
  const base = { schemaVersion: 1, operation: "reboot", phase: "preflight", targetId, idempotencyDigest: digest(idempotencyKey), preflightDigest, processBindingDigest, prebootIntegrity, unrelatedHostOperations, requestedAt: deps.now() }
  initializeCheckpoint(root, evidencePath, base)
  try {
    if (config.scenarioAdapter !== undefined) {
      await captureRebootScenario(config, root, "unit-16a-pre-reboot-checkpoint", deps)
    }
    const response = object(await deps.runAdapter(executable, { operation: "request_reboot", targetId, idempotencyKey, preflightDigest, processBindingDigest }), "reboot adapter result")
    if (response.accepted !== true || response.targetId !== targetId) throw new Error("reboot adapter did not accept the exact target")
    const requestId = text(response.requestId, "reboot requestId")
    const reservationId = opaqueDigest(response.reservationId, "reboot reservationId")
    const prebootDigest = digest(text(response.prebootId, "reboot prebootId"))
    replaceCheckpoint(root, evidencePath, { ...base, phase: "requested", requestId, reservationId, prebootDigest })
  } catch (error) {
    failedCheckpoint(root, evidencePath, base, error)
    throw error
  }
  if (config.scenarioAdapter !== undefined) {
    await captureRebootScenario(config, root, "unit-16a-reboot-request", deps)
  }
}

async function rebootResume(config: JsonObject, deps: AcceptanceHarnessDependencies): Promise<void> {
  const root = privateAllowedRoot(config)
  const evidencePath = confinedPath(root, config.evidencePath, "evidencePath")
  const checkpoint = readCheckpoint(root, evidencePath)
  if (checkpoint.operation !== "reboot" || (checkpoint.phase !== "requested" && checkpoint.phase !== "complete")) throw new Error("reboot checkpoint is not resumable")
  const targetId = text(checkpoint.targetId, "checkpoint targetId")
  const requestId = text(checkpoint.requestId, "checkpoint requestId")
  const prebootDigest = opaqueDigest(checkpoint.prebootDigest, "checkpoint prebootDigest")
  if (checkpoint.phase === "requested") {
    const executable = adapter(config.adapter, "reboot poll adapter")
    const timeoutMs = integer(config.timeoutMs, "timeoutMs", 1)
    const intervalMs = integer(config.intervalMs, "intervalMs", 1)
    const deadline = deps.now() + timeoutMs
    let complete = false
    while (deps.now() < deadline) {
      const response = object(await deps.runAdapter(executable, { operation: "poll_reboot", targetId, requestId }), "reboot poll result")
      if (response.targetId !== targetId || response.requestId !== requestId) throw new Error("reboot target drift")
      if (response.state === "ready") {
        const bootId = text(response.bootId, "reboot bootId")
        const postbootDigest = digest(bootId)
        if (postbootDigest === prebootDigest) throw new Error("reboot boot identity did not change")
        replaceCheckpoint(root, evidencePath, { ...checkpoint, phase: "complete", postbootDigest, completedAt: deps.now() })
        complete = true
        break
      }
      if (response.state !== "booting" && response.state !== "offline") throw new Error("reboot poll returned an invalid state")
      await deps.sleep(intervalMs)
    }
    if (!complete) throw new Error("reboot resume timed out")
  } else {
    opaqueDigest(checkpoint.postbootDigest, "checkpoint postbootDigest")
  }
  if (config.scenarioAdapter !== undefined && !pathEntryExists(path.join(root, "unit-16a-boot-recovery-milestones.json"))) {
    await captureRebootScenario(config, root, "unit-16a-boot-recovery-milestones", deps)
  }
}

export async function executeSanctuaryAcceptanceHarness(
  command: string,
  rawConfig: unknown,
  deps: AcceptanceHarnessDependencies = createSanctuaryAcceptanceHarnessDependencies(),
): Promise<void> {
  emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_acceptance_start", message: "Sanctuary acceptance operation started", meta: { command } })
  try {
    const config = object(rawConfig, "acceptance config")
    switch (command) {
      case "telegram-bootstrap": await telegramBootstrap(config, deps); break
      case "cursor-snapshot": await cursorSnapshot(config, deps); break
      case "cursor-delta": await cursorDelta(config, deps); break
      case "callback-inject": await callbackInject(config, deps); break
      case "unraid-key-rotate": await unraidKeyRotate(config, deps); break
      case "evidence-snapshot": await evidenceSnapshot(config, deps); break
      case "reboot-request": await rebootRequest(config, deps); break
      case "reboot-resume": await rebootResume(config, deps); break
      case "evidence-bundle-index": await evidenceBundleIndex(config, deps); break
      case "evidence-bundle-verify": await verifyEvidenceBundle(config, deps); break
      default: throw new Error("unknown Sanctuary acceptance command")
    }
    emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_acceptance_end", message: "Sanctuary acceptance operation completed", meta: { command } })
  } catch (error) {
    emitNervesEvent({ level: "error", component: "daemon", event: "daemon.sanctuary_acceptance_error", message: "Sanctuary acceptance operation failed", meta: { command, errorCategory: safeErrorCategory(error) } })
    throw error
  }
}
