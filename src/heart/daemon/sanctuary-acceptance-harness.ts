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
const DEFAULT_ADAPTER_TIMEOUT_MS = 15_000
const DEFAULT_TELEGRAM_TIMEOUT_MS = 10_000
const OPAQUE_DIGEST = /^[0-9a-f]{64}$/u
type FixedEvidenceSchema = "telegram-cursor-v1" | "postboot-health-v1"

type JsonObject = Record<string, unknown>

export interface AcceptanceHarnessDependencies {
  readSecret(): string
  runAdapter(executable: string, payload: unknown): Promise<unknown>
  fetch: typeof fetch
  now(): number
  randomBytes(size: number): Buffer
  sleep(milliseconds: number): Promise<void>
  telegramTimeoutMs?: number
}

export function createSanctuaryAcceptanceHarnessDependencies(
  secretFd = 3,
  options: { adapterTimeoutMs?: number; telegramTimeoutMs?: number } = {},
): AcceptanceHarnessDependencies {
  const adapterTimeoutMs = options.adapterTimeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS
  const telegramTimeoutMs = options.telegramTimeoutMs ?? DEFAULT_TELEGRAM_TIMEOUT_MS
  return {
    readSecret: () => readFileSync(secretFd, "utf8"),
    runAdapter: async (executable, payload) => {
      requireAbsoluteExecutable(executable)
      const result = spawnSync(executable, [], {
        input: `${JSON.stringify(payload)}\n`,
        encoding: "utf8",
        maxBuffer: MAX_ADAPTER_OUTPUT,
        timeout: adapterTimeoutMs,
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
): Promise<unknown> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), deps.telegramTimeoutMs ?? DEFAULT_TELEGRAM_TIMEOUT_MS)
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
  "unit-16d-2-unauthorized",
  "unit-16e-containment-audit",
  "unit-16e-1-stop-denial",
  "unit-16e-2-restart-denial",
  "unit-16f-cron-fingerprint",
  "unit-16g-health-transition",
  "unit-16h-daily-digest",
  "unit-16i-delayed-approval",
  "unit-16j-denial",
  "unit-16k-timeout-stale",
  "unit-16l-duplicate-callback",
  "unit-16m-restart-continuation",
] as const

const SAFE_OPERATIONAL_NUMBER_KEY = /(?:at|time|timestamp|duration|latency|counter|count|total|units|bytes|percent|status|code|port|ttl|interval|timeout|attempts|claims|mutations|generation|version|concurrency|index)$/iu
const RAW_LONG_DECIMAL = /^-?\d{5,16}$/u

function assertRedactedEvidence(value: unknown, label: string, key = ""): void {
  if (Array.isArray(value)) {
    for (const item of value) assertRedactedEvidence(item, label, key)
    return
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as JsonObject)) {
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
    && !SAFE_OPERATIONAL_NUMBER_KEY.test(key)) {
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

function packagedHarnessSha256(value: unknown): string {
  const configured = text(value, "harnessPath")
  if (!path.isAbsolute(configured)) throw new Error("harnessPath must be absolute")
  const resolved = path.resolve(configured)
  const handle = openSync(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const metadata = fstatSync(handle)
    if (!metadata.isFile()) throw new Error("packaged harness must be a regular file")
    if ((metadata.mode & 0o022) !== 0) throw new Error("packaged harness must not be group- or world-writable")
    if (realpathSync(resolved) !== resolved) throw new Error("packaged harness path must be canonical")
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
  if (value.schemaVersion !== 1 || value.operation !== label || value.phase !== "complete") {
    throw new Error(`${label} evidence contract must use schemaVersion 1, its exact operation, and phase complete`)
  }
  return evidenceProvenance(value.provenance, label)
}

function sameProvenance(left: EvidenceProvenance, right: EvidenceProvenance): boolean {
  return left.imageDigest === right.imageDigest
    && left.containerDigest === right.containerDigest
    && left.cursorDigest === right.cursorDigest
    && left.harnessSha256 === right.harnessSha256
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
  const harnessSha256 = packagedHarnessSha256(config.harnessPath)
  const byLabel = new Map(requested.map((entry) => [entry.label, entry.path]))
  let continuity: EvidenceProvenance | undefined
  const entries = SANCTUARY_UNIT_16_EVIDENCE_LABELS.map((label) => {
    const source = requirePrivateRegularFile(root, byLabel.get(label), `${label} evidence`)
    const value = object(JSON.parse(readFileSync(source, "utf8")) as unknown, `${label} evidence`)
    assertRedactedEvidence(value, label)
    const provenance = completeEvidenceContract(value, label)
    if (provenance.harnessSha256 !== harnessSha256) throw new Error(`${label} harness provenance does not match the packaged harness bytes`)
    continuity ??= provenance
    if (!sameProvenance(continuity, provenance)) throw new Error(`${label} provenance breaks image, container, cursor, or harness continuity`)
    return { label, sha256: normalizedEvidenceHash(value), evidence: value }
  })
  if (!continuity) throw new Error("evidence provenance is missing")
  const core = {
    schemaVersion: 1,
    operation: "sanctuary-unit-16-evidence-bundle",
    phase: "complete",
    imageDigest: continuity.imageDigest,
    containerDigest: continuity.containerDigest,
    cursorDigest: continuity.cursorDigest,
    harnessSha256,
    entries,
  }
  initializeCheckpoint(root, evidencePath, { ...core, bundleDigest: normalizedEvidenceHash(core), completedAt: deps.now() })
}

function verifyEvidenceBundle(config: JsonObject): void {
  const root = privateAllowedRoot(config)
  const bundle = readCheckpoint(root, config.evidencePath)
  const harnessSha256 = packagedHarnessSha256(config.harnessPath)
  if (bundle.schemaVersion !== 1 || bundle.operation !== "sanctuary-unit-16-evidence-bundle" || bundle.phase !== "complete") {
    throw new Error("evidence bundle header is invalid")
  }
  if (!Array.isArray(bundle.entries)) throw new Error("evidence bundle entries must be an array")
  let continuity: EvidenceProvenance | undefined
  const entries = bundle.entries.map((raw) => {
    const entry = object(raw, "evidence bundle entry")
    const label = text(entry.label, "evidence bundle label")
    const evidence = object(entry.evidence, `${label} evidence`)
    assertRedactedEvidence(evidence, label)
    const provenance = completeEvidenceContract(evidence, label)
    if (provenance.harnessSha256 !== harnessSha256) throw new Error(`${label} harness provenance does not match the packaged harness bytes`)
    continuity ??= provenance
    if (!sameProvenance(continuity, provenance)) throw new Error(`${label} provenance breaks image, container, cursor, or harness continuity`)
    const sha256 = opaqueDigest(entry.sha256, `${label} entry hash`)
    if (sha256 !== normalizedEvidenceHash(evidence)) throw new Error("evidence bundle entry hash mismatch")
    return { label, sha256, evidence }
  })
  if (!exactEvidenceLabels(entries) || new Set(entries.map((entry) => entry.label)).size !== entries.length) {
    throw new Error("evidence bundle does not contain the complete Unit 16 evidence matrix")
  }
  if (!continuity) throw new Error("evidence bundle provenance is missing")
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
  if (core.imageDigest !== continuity.imageDigest || core.containerDigest !== continuity.containerDigest
    || core.cursorDigest !== continuity.cursorDigest || core.harnessSha256 !== continuity.harnessSha256) {
    throw new Error("evidence bundle continuity coordinates do not match its entries")
  }
  if (core.harnessSha256 !== harnessSha256) throw new Error("evidence bundle does not match the packaged harness bytes")
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
  const nonceAdapter = adapter(config.nonceAdapter, "nonceAdapter")
  const vaultAdapter = adapter(config.vaultAdapter, "vaultAdapter")
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
    const sent = object(await deps.runAdapter(nonceAdapter, { operation: "send_telegram_nonce", nonce }), "nonce adapter result")
    if (sent.sent !== true) throw new Error("Telegram nonce adapter did not confirm delivery")
    const updates = await telegramRequest(deps, token, "getUpdates", { offset: currentOffset, timeout: 0, allowed_updates: ["message"] })
    if (!Array.isArray(updates)) throw new Error("Telegram getUpdates result must be an array")
    const parsed = updates.map((entry) => object(entry, "Telegram update"))
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
    if (matches.length !== 1) throw new Error("Telegram nonce update is missing or ambiguous")
    const match = matches[0]!
    const message = object(match.message, "Telegram nonce message")
    const from = object(message.from, "Telegram nonce sender")
    const chat = object(message.chat, "Telegram nonce chat")
    const userId = String(integer(from.id, "Telegram user id", 1))
    const chatId = String(integer(chat.id, "Telegram chat id", 1))
    const updateIds = parsed.map((entry) => integer(entry.update_id, "Telegram update id"))
    const nextUpdateId = Math.max(currentOffset, ...updateIds.map((id) => id + 1))
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
    const payload = await deps.runAdapter(executable, { operation: "snapshot", schema })
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
    replaceCheckpoint(root, evidencePath, { ...base, phase: "complete", claims, mutations, replayClaimed: false, replayMutated: false, completedAt: deps.now() })
  } catch (error) {
    failedCheckpoint(root, evidencePath, base, error)
    throw error
  }
}

interface InventoryKey { id: string; name: string; permissions: string[]; roles: string[] }

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

async function unraidKeyRotate(config: JsonObject, deps: AcceptanceHarnessDependencies): Promise<void> {
  const root = privateAllowedRoot(config)
  const evidencePath = confinedPath(root, config.evidencePath, "evidencePath")
  refuseExistingCheckpoint(root, evidencePath)
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

async function evidenceSnapshot(config: JsonObject, deps: AcceptanceHarnessDependencies): Promise<void> {
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

async function rebootRequest(config: JsonObject, deps: AcceptanceHarnessDependencies): Promise<void> {
  const root = privateAllowedRoot(config)
  const evidencePath = confinedPath(root, config.evidencePath, "evidencePath")
  refuseExistingCheckpoint(root, evidencePath)
  const targetId = text(config.targetId, "targetId")
  const executable = adapter(config.adapter, "reboot adapter")
  const idempotencyKey = deps.randomBytes(16).toString("hex")
  const base = { schemaVersion: 1, operation: "reboot", phase: "preflight", targetId, idempotencyDigest: digest(idempotencyKey), requestedAt: deps.now() }
  initializeCheckpoint(root, evidencePath, base)
  try {
    const response = object(await deps.runAdapter(executable, { operation: "request_reboot", targetId, idempotencyKey }), "reboot adapter result")
    if (response.accepted !== true || response.targetId !== targetId) throw new Error("reboot adapter did not accept the exact target")
    const requestId = text(response.requestId, "reboot requestId")
    const prebootDigest = digest(text(response.prebootId, "reboot prebootId"))
    replaceCheckpoint(root, evidencePath, { ...base, phase: "requested", requestId, prebootDigest })
  } catch (error) {
    failedCheckpoint(root, evidencePath, base, error)
    throw error
  }
}

async function rebootResume(config: JsonObject, deps: AcceptanceHarnessDependencies): Promise<void> {
  const root = privateAllowedRoot(config)
  const evidencePath = confinedPath(root, config.evidencePath, "evidencePath")
  const checkpoint = readCheckpoint(root, evidencePath)
  if (checkpoint.operation !== "reboot" || checkpoint.phase !== "requested") throw new Error("reboot checkpoint is not resumable")
  const targetId = text(checkpoint.targetId, "checkpoint targetId")
  const requestId = text(checkpoint.requestId, "checkpoint requestId")
  const prebootDigest = opaqueDigest(checkpoint.prebootDigest, "checkpoint prebootDigest")
  const executable = adapter(config.adapter, "reboot poll adapter")
  const timeoutMs = integer(config.timeoutMs, "timeoutMs", 1)
  const intervalMs = integer(config.intervalMs, "intervalMs", 1)
  const deadline = deps.now() + timeoutMs
  while (deps.now() < deadline) {
    const response = object(await deps.runAdapter(executable, { operation: "poll_reboot", targetId, requestId }), "reboot poll result")
    if (response.targetId !== targetId || response.requestId !== requestId) throw new Error("reboot target drift")
    if (response.state === "ready") {
      const bootId = text(response.bootId, "reboot bootId")
      const postbootDigest = digest(bootId)
      if (postbootDigest === prebootDigest) throw new Error("reboot boot identity did not change")
      replaceCheckpoint(root, evidencePath, { ...checkpoint, phase: "complete", postbootDigest, completedAt: deps.now() })
      return
    }
    if (response.state !== "booting" && response.state !== "offline") throw new Error("reboot poll returned an invalid state")
    await deps.sleep(intervalMs)
  }
  throw new Error("reboot resume timed out")
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
      case "evidence-bundle-verify": verifyEvidenceBundle(config); break
      default: throw new Error("unknown Sanctuary acceptance command")
    }
    emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_acceptance_end", message: "Sanctuary acceptance operation completed", meta: { command } })
  } catch (error) {
    emitNervesEvent({ level: "error", component: "daemon", event: "daemon.sanctuary_acceptance_error", message: "Sanctuary acceptance operation failed", meta: { command, errorCategory: safeErrorCategory(error) } })
    throw error
  }
}
