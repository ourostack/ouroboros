import { createHash, randomBytes as nodeRandomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import * as path from "node:path"

import { emitNervesEvent } from "../../nerves/runtime"

const SECRET_SELECTOR = /(?:token|secret|password|credential|authorization|api.?key)/iu
const MAX_ADAPTER_OUTPUT = 1_048_576

type JsonObject = Record<string, unknown>

export interface AcceptanceHarnessDependencies {
  readSecret(): string
  runAdapter(executable: string, payload: unknown): Promise<unknown>
  fetch: typeof fetch
  now(): number
  randomBytes(size: number): Buffer
  sleep(milliseconds: number): Promise<void>
}

export function createSanctuaryAcceptanceHarnessDependencies(secretFd = 3): AcceptanceHarnessDependencies {
  return {
    readSecret: () => readFileSync(secretFd, "utf8"),
    runAdapter: async (executable, payload) => {
      requireAbsoluteExecutable(executable)
      const result = spawnSync(executable, [], {
        input: `${JSON.stringify(payload)}\n`,
        encoding: "utf8",
        maxBuffer: MAX_ADAPTER_OUTPUT,
        cwd: "/",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        stdio: ["pipe", "pipe", "ignore"],
      })
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

function ensurePrivateParent(filePath: string): void {
  const parent = path.dirname(filePath)
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const mode = statSync(parent).mode & 0o777
  if ((mode & 0o077) !== 0) throw new Error("evidence parent directory must not be group/world accessible")
}

function syncDirectory(directory: string): void {
  const handle = openSync(directory, "r")
  try { fsyncSync(handle) } finally { closeSync(handle) }
}

function initializeCheckpoint(filePath: string, value: JsonObject): void {
  ensurePrivateParent(filePath)
  let handle: number
  try {
    handle = openSync(filePath, "wx", 0o600)
  } catch (error) {
    /* v8 ignore next 3 -- TOCTOU race after the explicit preflight existence check; preserves inspect-before-retry semantics @preserve */
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("acceptance checkpoint exists; inspect-before-retry is required")
    }
    throw error
  }
  try {
    writeFileSync(handle, `${JSON.stringify(value)}\n`)
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  chmodSync(filePath, 0o600)
  syncDirectory(path.dirname(filePath))
}

function refuseExistingCheckpoint(filePath: string): void {
  if (existsSync(filePath)) throw new Error("acceptance checkpoint exists; inspect-before-retry is required")
}

function replaceCheckpoint(filePath: string, value: JsonObject): void {
  const temporary = `${filePath}.tmp-${process.pid}-${nodeRandomBytes(8).toString("hex")}`
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 })
    const handle = openSync(temporary, "r")
    try { fsyncSync(handle) } finally { closeSync(handle) }
    renameSync(temporary, filePath)
    chmodSync(filePath, 0o600)
    syncDirectory(path.dirname(filePath))
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

function readCheckpoint(filePath: string): JsonObject {
  const mode = statSync(filePath).mode & 0o777
  if ((mode & 0o077) !== 0) throw new Error("acceptance checkpoint must be private")
  return object(JSON.parse(readFileSync(filePath, "utf8")) as unknown, "acceptance checkpoint")
}

function safeErrorCategory(error: unknown): string {
  if (!(error instanceof Error)) return "unknown"
  if (/timed out/iu.test(error.message)) return "timeout"
  if (/adapter/iu.test(error.message)) return "adapter"
  if (/checkpoint|inspect-before-retry/iu.test(error.message)) return "checkpoint"
  return "validation"
}

function failedCheckpoint(filePath: string, base: JsonObject, error: unknown): void {
  replaceCheckpoint(filePath, { ...base, phase: "failed", errorCategory: safeErrorCategory(error) })
}

async function telegramRequest(
  deps: AcceptanceHarnessDependencies,
  token: string,
  method: string,
  body?: JsonObject,
): Promise<unknown> {
  const response = await deps.fetch(`https://api.telegram.org/bot${token}/${method}`, body ? {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  } : undefined)
  let envelope: JsonObject
  try { envelope = object(await response.json(), "Telegram response") }
  catch { throw new Error("Telegram returned invalid JSON") }
  if (!response.ok || envelope.ok !== true) throw new Error("Telegram request failed")
  return envelope.result
}

async function telegramBootstrap(config: JsonObject, deps: AcceptanceHarnessDependencies): Promise<void> {
  const evidencePath = text(config.evidencePath, "evidencePath")
  refuseExistingCheckpoint(evidencePath)
  const offsetPath = text(config.offsetPath, "offsetPath")
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
    botId: expectedBotId,
    botUsername: expectedUsername,
    startedAt: deps.now(),
  }
  initializeCheckpoint(evidencePath, base)
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
      nextUpdateId,
    }
    replaceCheckpoint(evidencePath, confirmed)
    const stored = object(await deps.runAdapter(vaultAdapter, {
      operation: "store_telegram_bootstrap",
      botToken: token,
      authorizedUserId: userId,
      authorizedChatId: chatId,
    }), "vault adapter result")
    if (stored.stored !== true) throw new Error("Telegram vault adapter did not attest storage")
    replaceCheckpoint(evidencePath, { ...confirmed, phase: "vault_committed" })
    atomicPrivateJson(offsetPath, { nextUpdateId })
    replaceCheckpoint(evidencePath, { ...confirmed, phase: "complete", completedAt: deps.now() })
  } catch (error) {
    failedCheckpoint(evidencePath, base, error)
    throw error
  }
}

function atomicPrivateJson(filePath: string, value: unknown): void {
  ensurePrivateParent(filePath)
  const temporary = `${filePath}.tmp-${process.pid}-${nodeRandomBytes(8).toString("hex")}`
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 })
    const handle = openSync(temporary, "r")
    try { fsyncSync(handle) } finally { closeSync(handle) }
    renameSync(temporary, filePath)
    chmodSync(filePath, 0o600)
    syncDirectory(path.dirname(filePath))
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}

function selectedValues(payload: unknown, selectors: string[], prefix = ""): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {}
  for (const selector of selectors) {
    if (!selector || SECRET_SELECTOR.test(selector)) throw new Error("secret-bearing selector is forbidden")
    let value: unknown = payload
    for (const segment of selector.split(".")) value = object(value, `selector ${selector}`)[segment]
    if (!(value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
      throw new Error(`selector ${selector} must resolve to a scalar`)
    }
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`selector ${selector} must resolve to a finite scalar`)
    result[prefix ? `${prefix}.${selector}` : selector] = value
  }
  return result
}

async function cursorSnapshot(config: JsonObject, deps: AcceptanceHarnessDependencies): Promise<void> {
  const evidencePath = text(config.evidencePath, "evidencePath")
  refuseExistingCheckpoint(evidencePath)
  if (!Array.isArray(config.adapters) || config.adapters.length === 0) throw new Error("snapshot adapters must be nonempty")
  const values: Record<string, string | number | boolean | null> = {}
  for (const raw of config.adapters) {
    const spec = object(raw, "snapshot adapter")
    const name = text(spec.name, "snapshot adapter name")
    if (SECRET_SELECTOR.test(name)) throw new Error("secret-bearing snapshot name is forbidden")
    const executable = adapter(spec.executable, "snapshot adapter executable")
    const select = stringArray(spec.select, "snapshot selectors")
    const payload = await deps.runAdapter(executable, { operation: "snapshot", name })
    Object.assign(values, selectedValues(payload, select, name))
  }
  initializeCheckpoint(evidencePath, { schemaVersion: 1, operation: "cursor-snapshot", phase: "complete", capturedAt: deps.now(), values })
}

async function cursorDelta(config: JsonObject, deps: AcceptanceHarnessDependencies): Promise<void> {
  const evidencePath = text(config.evidencePath, "evidencePath")
  refuseExistingCheckpoint(evidencePath)
  const before = object(readCheckpoint(text(config.beforePath, "beforePath")).values, "before values")
  const after = object(readCheckpoint(text(config.afterPath, "afterPath")).values, "after values")
  const changes: Record<string, { before: unknown; after: unknown }> = {}
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes[key] = { before: before[key] ?? null, after: after[key] ?? null }
  }
  initializeCheckpoint(evidencePath, { schemaVersion: 1, operation: "cursor-delta", phase: "complete", capturedAt: deps.now(), changes })
}

async function callbackInject(config: JsonObject, deps: AcceptanceHarnessDependencies): Promise<void> {
  const evidencePath = text(config.evidencePath, "evidencePath")
  refuseExistingCheckpoint(evidencePath)
  const executable = adapter(config.adapter, "callback adapter")
  const concurrency = integer(config.concurrency, "concurrency", 1)
  if (concurrency > 16) throw new Error("callback concurrency exceeds 16")
  const replay = boolean(config.replay, "replay")
  const expectedClaims = integer(config.expectedClaims, "expectedClaims")
  const expectedMutations = integer(config.expectedMutations, "expectedMutations")
  let update: JsonObject
  try { update = object(JSON.parse(deps.readSecret()) as unknown, "saved callback update") }
  catch { throw new Error("saved callback update must be valid JSON") }
  object(update.callback_query, "saved callback update callback_query")
  const base = { schemaVersion: 1, operation: "callback-inject", phase: "preflight", updateDigest: digest(update), concurrency, replay }
  initializeCheckpoint(evidencePath, base)
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
    if (claims !== expectedClaims) throw new Error("callback claim total mismatch")
    if (mutations !== expectedMutations) throw new Error("callback mutation total mismatch")
    let replayMutated = false
    if (replay) {
      const replayResult = object(await deps.runAdapter(executable, { operation: "inject_callback_replay", update }), "callback replay result")
      if (replayResult.settled !== true || typeof replayResult.mutated !== "boolean") throw new Error("callback replay did not settle canonically")
      replayMutated = replayResult.mutated
      if (replayMutated) throw new Error("callback replay mutated state")
    }
    replaceCheckpoint(evidencePath, { ...base, phase: "complete", claims, mutations, replayMutated, completedAt: deps.now() })
  } catch (error) {
    failedCheckpoint(evidencePath, base, error)
    throw error
  }
}

interface InventoryKey { id: string; name: string; permissions: string[]; roles: string[] }

function inventory(value: unknown): InventoryKey[] {
  const root = object(value, "Unraid inventory")
  if (!Array.isArray(root.keys)) throw new Error("Unraid inventory keys must be an array")
  return root.keys.map((raw) => {
    const key = object(raw, "Unraid inventory key")
    return {
      id: text(key.id, "Unraid key id"),
      name: text(key.name, "Unraid key name"),
      permissions: stringArray(key.permissions, "Unraid key permissions").sort(),
      roles: Array.isArray(key.roles) ? stringArray(key.roles, "Unraid key roles").sort() : (() => { throw new Error("Unraid key roles must be an array") })(),
    }
  })
}

function sameStrings(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
}

async function unraidKeyRotate(config: JsonObject, deps: AcceptanceHarnessDependencies): Promise<void> {
  const evidencePath = text(config.evidencePath, "evidencePath")
  refuseExistingCheckpoint(evidencePath)
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
  if (!Array.isArray(config.oldKeys)) throw new Error("oldKeys must be an array")
  const oldKeys = config.oldKeys.map((raw) => {
    const old = object(raw, "old Unraid key")
    return { id: text(old.id, "old key id"), secretAdapter: adapter(old.secretAdapter, "old key secretAdapter") }
  })
  const initial = inventory(await deps.runAdapter(inventoryAdapter, { operation: "inventory_keys", targetServerId }))
  for (const key of desired) if (initial.some((entry) => entry.name === key.name)) throw new Error(`Unraid key ${key.name} already exists`)
  for (const old of oldKeys) if (!initial.some((entry) => entry.id === old.id)) throw new Error(`old Unraid key ${old.id} is absent`)

  const base: JsonObject = { schemaVersion: 1, operation: "unraid-key-rotate", phase: "preflight", targetServerId, initialInventoryDigest: digest(initial), createdKeyIds: [], revokedKeyIds: [] }
  initializeCheckpoint(evidencePath, base)
  const createdKeyIds: string[] = []
  const revokedKeyIds: string[] = []
  try {
    for (const key of desired) {
      const created = object(await deps.runAdapter(createAdapter, { operation: "create_key", targetServerId, name: key.name, permissions: key.permissions }), "created Unraid key")
      const id = text(created.id, "created key id")
      const rawKey = text(created.key, "created raw key")
      if (created.name !== key.name || !sameStrings(stringArray(created.permissions, "created permissions"), key.permissions)
        || !Array.isArray(created.roles) || created.roles.length !== 0) throw new Error("created Unraid key scope mismatch")
      createdKeyIds.push(id)
      replaceCheckpoint(evidencePath, { ...base, phase: "key_created", createdKeyIds, revokedKeyIds })
      const stored = object(await deps.runAdapter(storeAdapter, { operation: "store_key", targetServerId, vaultField: key.vaultField, keyId: id, key: rawKey }), "key store result")
      if (stored.stored !== true || stored.keyId !== id) throw new Error("vault did not attest exact key storage")
      const probe = object(await deps.runAdapter(probeAdapter, { operation: "probe_new_key", targetServerId, id, key: rawKey }), "new key probe")
      if (probe.valid !== true) throw new Error("new Unraid key readiness failed")
      replaceCheckpoint(evidencePath, { ...base, phase: "key_attested", createdKeyIds, revokedKeyIds })
    }
    for (const old of oldKeys) {
      const secretResult = object(await deps.runAdapter(old.secretAdapter, { operation: "read_old_key", targetServerId, id: old.id }), "old key secret result")
      const rawOldKey = text(secretResult.key, "old raw key")
      const revoked = object(await deps.runAdapter(revokeAdapter, { operation: "revoke_key", targetServerId, id: old.id }), "key revoke result")
      if (revoked.revoked !== true || revoked.id !== old.id) throw new Error("Unraid revoke did not attest exact key id")
      const probe = object(await deps.runAdapter(probeAdapter, { operation: "probe_revoked_key", targetServerId, id: old.id, key: rawOldKey }), "revoked key probe")
      if (probe.valid !== false || (probe.status !== 401 && probe.status !== 403)) throw new Error("revoked Unraid key still authenticates")
      revokedKeyIds.push(old.id)
      replaceCheckpoint(evidencePath, { ...base, phase: "old_key_revoked", createdKeyIds, revokedKeyIds })
    }
    const final = inventory(await deps.runAdapter(inventoryAdapter, { operation: "inventory_keys", targetServerId }))
    for (let index = 0; index < desired.length; index++) {
      const key = desired[index]!
      const id = createdKeyIds[index]!
      const found = final.find((entry) => entry.id === id && entry.name === key.name)
      if (!found || found.roles.length !== 0 || !sameStrings(found.permissions, key.permissions)) throw new Error("final Unraid key inventory mismatch")
    }
    if (oldKeys.some((old) => final.some((entry) => entry.id === old.id))) throw new Error("revoked Unraid key remains in inventory")
    replaceCheckpoint(evidencePath, { ...base, phase: "complete", createdKeyIds, revokedKeyIds, finalInventoryDigest: digest(final), completedAt: deps.now() })
  } catch (error) {
    failedCheckpoint(evidencePath, { ...base, createdKeyIds, revokedKeyIds }, error)
    throw error
  }
}

async function evidenceSnapshot(config: JsonObject, deps: AcceptanceHarnessDependencies): Promise<void> {
  const evidencePath = text(config.evidencePath, "evidencePath")
  refuseExistingCheckpoint(evidencePath)
  const name = text(config.name, "snapshot name")
  if (SECRET_SELECTOR.test(name)) throw new Error("secret-bearing snapshot name is forbidden")
  const executable = adapter(config.adapter, "snapshot adapter")
  const selectors = stringArray(config.select, "snapshot selectors")
  const payload = await deps.runAdapter(executable, { operation: "evidence_snapshot", name })
  initializeCheckpoint(evidencePath, {
    schemaVersion: 1,
    operation: "evidence-snapshot",
    phase: "complete",
    name,
    capturedAt: deps.now(),
    payloadDigest: digest(payload),
    values: selectedValues(payload, selectors),
  })
}

async function rebootRequest(config: JsonObject, deps: AcceptanceHarnessDependencies): Promise<void> {
  const evidencePath = text(config.evidencePath, "evidencePath")
  refuseExistingCheckpoint(evidencePath)
  const targetId = text(config.targetId, "targetId")
  const executable = adapter(config.adapter, "reboot adapter")
  const idempotencyKey = deps.randomBytes(16).toString("hex")
  const base = { schemaVersion: 1, operation: "reboot", phase: "preflight", targetId, idempotencyDigest: digest(idempotencyKey), requestedAt: deps.now() }
  initializeCheckpoint(evidencePath, base)
  try {
    const response = object(await deps.runAdapter(executable, { operation: "request_reboot", targetId, idempotencyKey }), "reboot adapter result")
    if (response.accepted !== true || response.targetId !== targetId) throw new Error("reboot adapter did not accept the exact target")
    const requestId = text(response.requestId, "reboot requestId")
    replaceCheckpoint(evidencePath, { ...base, phase: "requested", requestId })
  } catch (error) {
    failedCheckpoint(evidencePath, base, error)
    throw error
  }
}

async function rebootResume(config: JsonObject, deps: AcceptanceHarnessDependencies): Promise<void> {
  const evidencePath = text(config.evidencePath, "evidencePath")
  const checkpoint = readCheckpoint(evidencePath)
  if (checkpoint.operation !== "reboot" || checkpoint.phase !== "requested") throw new Error("reboot checkpoint is not resumable")
  const targetId = text(checkpoint.targetId, "checkpoint targetId")
  const requestId = text(checkpoint.requestId, "checkpoint requestId")
  const executable = adapter(config.adapter, "reboot poll adapter")
  const timeoutMs = integer(config.timeoutMs, "timeoutMs", 1)
  const intervalMs = integer(config.intervalMs, "intervalMs", 1)
  const deadline = deps.now() + timeoutMs
  while (deps.now() < deadline) {
    const response = object(await deps.runAdapter(executable, { operation: "poll_reboot", targetId, requestId }), "reboot poll result")
    if (response.targetId !== targetId || response.requestId !== requestId) throw new Error("reboot target drift")
    if (response.state === "ready") {
      const bootId = text(response.bootId, "reboot bootId")
      replaceCheckpoint(evidencePath, { ...checkpoint, phase: "complete", bootId, completedAt: deps.now() })
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
      default: throw new Error("unknown Sanctuary acceptance command")
    }
    emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_acceptance_end", message: "Sanctuary acceptance operation completed", meta: { command } })
  } catch (error) {
    emitNervesEvent({ level: "error", component: "daemon", event: "daemon.sanctuary_acceptance_error", message: "Sanctuary acceptance operation failed", meta: { command, errorCategory: safeErrorCategory(error) } })
    throw error
  }
}
