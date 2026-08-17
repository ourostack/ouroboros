import { randomBytes as cryptoRandomBytes } from "crypto"
import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import {
  BLUEBUBBLES_APP_PATH,
  BLUEBUBBLES_LAUNCH_AGENT_LABEL,
  type BlueBubblesHostAction,
} from "./bluebubbles-host"

export const BLUEBUBBLES_HOST_PROTOCOL_SCHEMA_VERSION = 1 as const
export const BLUEBUBBLES_HOST_HELPER_VERSION = 1 as const
export const BLUEBUBBLES_HOST_FRESHNESS_MS = 300_000
export const BLUEBUBBLES_HOST_SHARED_ROOT = "/Users/Shared/Ouro"
export const BLUEBUBBLES_HOST_SHARED_HELPER = `${BLUEBUBBLES_HOST_SHARED_ROOT}/bluebubbles-host`
export const BLUEBUBBLES_HOST_REQUESTS_DIRECTORY = `${BLUEBUBBLES_HOST_SHARED_ROOT}/bluebubbles-host-requests`
export const BLUEBUBBLES_HOST_RECEIPTS_DIRECTORY = `${BLUEBUBBLES_HOST_SHARED_ROOT}/bluebubbles-host-receipts`

export interface BlueBubblesHostRequest {
  schemaVersion: typeof BLUEBUBBLES_HOST_PROTOCOL_SCHEMA_VERSION
  helperVersion: typeof BLUEBUBBLES_HOST_HELPER_VERSION
  requestId: string
  nonce: string
  action: BlueBubblesHostAction
  username: string
  uid: number
  requestedAt: string
  expiresAt: string
}

export interface BlueBubblesHostReceipt extends BlueBubblesHostRequest {
  appPath: typeof BLUEBUBBLES_APP_PATH
  plistPath: string
  launchAgentLabel: typeof BLUEBUBBLES_LAUNCH_AGENT_LABEL
  launchdDomain: string
  result: "verified" | "failed"
  detail: string
  verifiedAt: string
}

export interface BlueBubblesHostCollection {
  requestId: string
  status: "collected"
  detail: string
  receipt: BlueBubblesHostReceipt
}

interface BlueBubblesHostAttempt {
  schemaVersion: typeof BLUEBUBBLES_HOST_PROTOCOL_SCHEMA_VERSION
  status: "pending" | "collected"
  request: BlueBubblesHostRequest
  targetHomeDir: string
  collection?: BlueBubblesHostCollection
}

interface ResolvedBlueBubblesHostProtocolDeps {
  now: () => number
  randomBytes: (size: number) => Buffer
  currentUid: () => number
  expectedHelperBytes: () => Buffer
  existsSync: (filePath: string) => boolean
  readFileSync: (filePath: string) => Buffer
  mkdirSync: (directoryPath: string, options: { recursive: true; mode?: number }) => void
  chmodSync: (filePath: string, mode: number) => void
  writeFileSync: (
    filePath: string,
    content: string | Buffer,
    options: { encoding?: BufferEncoding; mode: number; flag?: string },
  ) => void
  linkSync: (existingPath: string, newPath: string) => void
  unlinkSync: (filePath: string) => void
  renameSync: (oldPath: string, newPath: string) => void
  lstatSync: (filePath: string) => {
    uid: number
    mode: number
    isSymbolicLink?: () => boolean
    isDirectory?: () => boolean
    isFile?: () => boolean
  }
}

export type BlueBubblesHostProtocolDeps = Partial<ResolvedBlueBubblesHostProtocolDeps>

function protocolDeps(overrides: BlueBubblesHostProtocolDeps = {}): ResolvedBlueBubblesHostProtocolDeps {
  return {
    now: Date.now,
    randomBytes: cryptoRandomBytes,
    currentUid: () => process.getuid?.() ?? 0,
    expectedHelperBytes: () => fs.readFileSync(path.resolve(__dirname, "../../../assets/bluebubbles-host")),
    existsSync: fs.existsSync,
    readFileSync: fs.readFileSync,
    mkdirSync: fs.mkdirSync,
    chmodSync: fs.chmodSync,
    writeFileSync: fs.writeFileSync,
    linkSync: fs.linkSync,
    unlinkSync: fs.unlinkSync,
    renameSync: fs.renameSync,
    lstatSync: fs.lstatSync,
    ...overrides,
  }
}

function sharedPaths(sharedRoot: string) {
  return {
    helper: path.join(sharedRoot, "bluebubbles-host"),
    requests: path.join(sharedRoot, "bluebubbles-host-requests"),
    receipts: path.join(sharedRoot, "bluebubbles-host-receipts"),
  }
}

function fileMode(deps: ResolvedBlueBubblesHostProtocolDeps, filePath: string): number | null {
  return deps.existsSync(filePath) ? deps.lstatSync(filePath).mode & 0o7777 : null
}

function validateManagedPath(
  deps: ResolvedBlueBubblesHostProtocolDeps,
  filePath: string,
  label: string,
  kind: "directory" | "file",
  expectedUid: number,
): void {
  const stat = deps.lstatSync(filePath)
  if (stat.isSymbolicLink?.()) throw new Error(`${label} must not be a symbolic link`)
  if (kind === "directory" && stat.isDirectory?.() !== true) throw new Error(`${label} must be a directory`)
  if (kind === "file" && stat.isFile?.() !== true) throw new Error(`${label} must be a regular file`)
  if (stat.uid !== expectedUid) throw new Error(`${label} must be owned by uid ${expectedUid}`)
}

function ensureDirectory(
  deps: ResolvedBlueBubblesHostProtocolDeps,
  directoryPath: string,
  mode: number,
  label: string,
  expectedUid: number,
): boolean {
  const priorMode = fileMode(deps, directoryPath)
  if (priorMode !== null) validateManagedPath(deps, directoryPath, label, "directory", expectedUid)
  if (priorMode === null) deps.mkdirSync(directoryPath, { recursive: true, mode })
  validateManagedPath(deps, directoryPath, label, "directory", expectedUid)
  deps.chmodSync(directoryPath, mode)
  return priorMode !== mode
}

function writeAtomicReplacement(
  deps: ResolvedBlueBubblesHostProtocolDeps,
  filePath: string,
  content: string | Buffer,
  mode: number,
): void {
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  try {
    deps.writeFileSync(temporaryPath, content, { mode, flag: "wx" })
    deps.chmodSync(temporaryPath, mode)
    deps.renameSync(temporaryPath, filePath)
    deps.chmodSync(filePath, mode)
  } catch (error) {
    if (deps.existsSync(temporaryPath)) deps.unlinkSync(temporaryPath)
    throw error
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"
}

function publishNoClobberJson(
  deps: ResolvedBlueBubblesHostProtocolDeps,
  filePath: string,
  value: unknown,
  mode: number,
  token: string,
  label: "request" | "receipt" | "attempt",
): void {
  const temporaryPath = `${filePath}.${token}.tmp`
  try {
    deps.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode,
      flag: "wx",
    })
    deps.chmodSync(temporaryPath, mode)
    deps.linkSync(temporaryPath, filePath)
    deps.chmodSync(filePath, mode)
  } catch (error) {
    if (isAlreadyExists(error)) throw new Error(`${label} already exists`)
    throw error
  } finally {
    if (deps.existsSync(temporaryPath)) deps.unlinkSync(temporaryPath)
  }
}

function readJson<T>(deps: ResolvedBlueBubblesHostProtocolDeps, filePath: string, label: string): T {
  try {
    return JSON.parse(deps.readFileSync(filePath).toString("utf8")) as T
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${label} is invalid: ${detail}`)
  }
}

function parseTime(value: string, label: string): number {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} is invalid`)
  return parsed
}

function validateUsername(username: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9._-]*$/.test(username)) {
    throw new Error("invalid BlueBubbles host username")
  }
}

function validateUid(uid: number): void {
  if (!Number.isInteger(uid) || uid < 500) throw new Error("BlueBubbles host uid must be at least 500")
}

function validateAction(action: string): asserts action is BlueBubblesHostAction {
  if (!(["install", "status", "repair", "remove"] as string[]).includes(action)) {
    throw new Error("unsupported host action")
  }
}

function validateRequestShape(request: BlueBubblesHostRequest): { requestedAtMs: number; expiresAtMs: number } {
  if (request.schemaVersion !== BLUEBUBBLES_HOST_PROTOCOL_SCHEMA_VERSION) {
    throw new Error("unsupported request schema")
  }
  if (request.helperVersion !== BLUEBUBBLES_HOST_HELPER_VERSION) {
    throw new Error("unsupported helper version")
  }
  validateUsername(request.username)
  validateUid(request.uid)
  validateAction(request.action)
  if (!/^[0-9a-f]{64}$/.test(request.nonce)) throw new Error("invalid request nonce")
  if (request.requestId !== `${request.uid}-${request.nonce}`) throw new Error("request id does not match uid and nonce")
  const requestedAtMs = parseTime(request.requestedAt, "request timestamp")
  const expiresAtMs = parseTime(request.expiresAt, "request expiry")
  if (expiresAtMs - requestedAtMs > BLUEBUBBLES_HOST_FRESHNESS_MS) {
    throw new Error("request freshness window exceeds 300000 ms")
  }
  return { requestedAtMs, expiresAtMs }
}

export function installBlueBubblesHostSharedHelper(
  input: { assetPath: string; sharedRoot?: string },
  overrides: BlueBubblesHostProtocolDeps = {},
): { changed: boolean; helperPath: string } {
  const deps = protocolDeps(overrides)
  const root = input.sharedRoot ?? BLUEBUBBLES_HOST_SHARED_ROOT
  const paths = sharedPaths(root)
  const asset = deps.readFileSync(input.assetPath)
  const expectedUid = deps.currentUid()
  let changed = false
  changed = ensureDirectory(deps, root, 0o755, "shared root", expectedUid) || changed
  changed = ensureDirectory(deps, paths.requests, 0o755, "shared request directory", expectedUid) || changed
  changed = ensureDirectory(deps, paths.receipts, 0o1777, "shared receipt directory", expectedUid) || changed

  if (deps.existsSync(paths.helper)) validateManagedPath(deps, paths.helper, "shared helper", "file", expectedUid)
  const helperCurrent = deps.existsSync(paths.helper) && deps.readFileSync(paths.helper).equals(asset)
  const helperModeCurrent = fileMode(deps, paths.helper) === 0o755
  if (!helperCurrent) {
    writeAtomicReplacement(deps, paths.helper, asset, 0o755)
    changed = true
  } else {
    deps.chmodSync(paths.helper, 0o755)
    changed = !helperModeCurrent || changed
  }
  validateManagedPath(deps, paths.helper, "shared helper", "file", expectedUid)

  emitNervesEvent({
    component: "daemon",
    event: "daemon.bluebubbles_host_helper_installed",
    message: "installed shared BlueBubbles host helper state",
    meta: { changed, helperPath: paths.helper },
  })
  return { changed, helperPath: paths.helper }
}

export function blueBubblesHostAttemptPath(originHomeDir: string, requestId: string): string {
  return path.join(originHomeDir, ".ouro-cli", "bluebubbles-host", "attempts", `${requestId}.json`)
}

export function requestCrossUserBlueBubblesHostAction(
  input: {
    action: BlueBubblesHostAction
    username: string
    uid: number
    targetHomeDir: string
    originHomeDir: string
    sharedRoot?: string
  },
  overrides: BlueBubblesHostProtocolDeps = {},
): {
  classification: "human-required"
  requestId: string
  requestPath: string
  helperCommand: string
  collectCommand: string
} {
  const deps = protocolDeps(overrides)
  validateUsername(input.username)
  validateUid(input.uid)
  validateAction(input.action)
  if (!path.isAbsolute(input.targetHomeDir)) throw new Error("target home must be absolute")
  if (!deps.existsSync(input.targetHomeDir)) throw new Error(`target home does not exist: ${input.targetHomeDir}`)
  validateManagedPath(deps, input.targetHomeDir, "target home", "directory", input.uid)
  const nonceBytes = deps.randomBytes(32)
  if (nonceBytes.length !== 32) throw new Error("BlueBubbles host nonce source must return 32 bytes")
  const nonce = nonceBytes.toString("hex")
  const requestId = `${input.uid}-${nonce}`
  const requestedAtMs = deps.now()
  const request: BlueBubblesHostRequest = {
    schemaVersion: BLUEBUBBLES_HOST_PROTOCOL_SCHEMA_VERSION,
    helperVersion: BLUEBUBBLES_HOST_HELPER_VERSION,
    requestId,
    nonce,
    action: input.action,
    username: input.username,
    uid: input.uid,
    requestedAt: new Date(requestedAtMs).toISOString(),
    expiresAt: new Date(requestedAtMs + BLUEBUBBLES_HOST_FRESHNESS_MS).toISOString(),
  }
  const root = input.sharedRoot ?? BLUEBUBBLES_HOST_SHARED_ROOT
  const paths = sharedPaths(root)
  const expectedUid = deps.currentUid()
  validateManagedPath(deps, root, "shared root", "directory", expectedUid)
  validateManagedPath(deps, paths.requests, "shared request directory", "directory", expectedUid)
  validateManagedPath(deps, paths.helper, "shared helper", "file", expectedUid)
  if (fileMode(deps, root) !== 0o755) throw new Error("shared root mode must be 0755")
  if (fileMode(deps, paths.requests) !== 0o755) throw new Error("shared request directory mode must be 0755")
  if (fileMode(deps, paths.helper) !== 0o755) throw new Error("shared helper mode must be 0755")
  if (!deps.readFileSync(paths.helper).equals(deps.expectedHelperBytes())) {
    throw new Error("shared helper bytes do not match the packaged helper")
  }
  const requestPath = path.join(paths.requests, `${requestId}.json`)
  const attemptPath = blueBubblesHostAttemptPath(input.originHomeDir, requestId)
  const attempt: BlueBubblesHostAttempt = {
    schemaVersion: BLUEBUBBLES_HOST_PROTOCOL_SCHEMA_VERSION,
    status: "pending",
    request,
    targetHomeDir: input.targetHomeDir,
  }
  deps.mkdirSync(path.dirname(attemptPath), { recursive: true, mode: 0o700 })
  deps.chmodSync(path.dirname(attemptPath), 0o700)
  publishNoClobberJson(deps, attemptPath, attempt, 0o600, nonce, "attempt")
  try {
    publishNoClobberJson(deps, requestPath, request, 0o444, nonce, "request")
  } catch (error) {
    deps.unlinkSync(attemptPath)
    throw error
  }
  const result = {
    classification: "human-required" as const,
    requestId,
    requestPath,
    helperCommand: `${paths.helper} --request ${requestPath}`,
    collectCommand: `ouro bluebubbles host collect --request-id ${requestId}`,
  }
  emitNervesEvent({
    component: "daemon",
    event: "daemon.bluebubbles_host_handoff_created",
    message: "created nonce-bound cross-user BlueBubbles host handoff",
    meta: { requestId, uid: input.uid, action: input.action },
  })
  return result
}

export function validateBlueBubblesHostHelperRequest(input: {
  request: BlueBubblesHostRequest
  currentUsername: string
  currentUid: number
  launchdDomainAvailable: boolean
  nowMs: number
}): { request: BlueBubblesHostRequest; launchdDomain: string } {
  const { requestedAtMs, expiresAtMs } = validateRequestShape(input.request)
  if (input.currentUsername !== input.request.username) throw new Error("target username mismatch")
  if (input.currentUid !== input.request.uid) throw new Error("target uid mismatch")
  if (!input.launchdDomainAvailable) {
    throw new Error(`logged-in gui/${input.request.uid} session is unavailable`)
  }
  if (requestedAtMs > input.nowMs) throw new Error("request timestamp is in the future")
  if (input.nowMs > expiresAtMs) throw new Error("request expired")
  return { request: input.request, launchdDomain: `gui/${input.request.uid}` }
}

export function publishBlueBubblesHostReceipt(
  receipt: BlueBubblesHostReceipt,
  input: { sharedRoot?: string } = {},
  overrides: BlueBubblesHostProtocolDeps = {},
): string {
  const deps = protocolDeps(overrides)
  if (!/^\d+-[0-9a-f]{64}$/.test(receipt.requestId)) throw new Error("invalid BlueBubbles host receipt request id")
  const root = input.sharedRoot ?? BLUEBUBBLES_HOST_SHARED_ROOT
  const receiptPath = path.join(sharedPaths(root).receipts, `${receipt.requestId}.json`)
  publishNoClobberJson(deps, receiptPath, receipt, 0o444, receipt.nonce, "receipt")
  return receiptPath
}

function expectedPlistPath(targetHomeDir: string): string {
  return path.join(targetHomeDir, "Library", "LaunchAgents", `${BLUEBUBBLES_LAUNCH_AGENT_LABEL}.plist`)
}

function requireReceiptMatch(
  request: BlueBubblesHostRequest,
  targetHomeDir: string,
  receipt: BlueBubblesHostReceipt,
): void {
  const exactFields: Array<keyof BlueBubblesHostRequest> = [
    "schemaVersion",
    "helperVersion",
    "requestId",
    "nonce",
    "action",
    "username",
    "uid",
    "requestedAt",
    "expiresAt",
  ]
  for (const field of exactFields) {
    if (receipt[field] !== request[field]) throw new Error(`receipt ${field} does not match request`)
  }
  if (receipt.appPath !== BLUEBUBBLES_APP_PATH) throw new Error("receipt app path does not match")
  if (receipt.plistPath !== expectedPlistPath(targetHomeDir)) throw new Error("receipt plist path does not match")
  if (receipt.launchAgentLabel !== BLUEBUBBLES_LAUNCH_AGENT_LABEL) {
    throw new Error("receipt launch agent label does not match")
  }
  if (receipt.launchdDomain !== `gui/${request.uid}`) throw new Error("receipt launchd domain does not match")
  if (receipt.result !== "verified" && receipt.result !== "failed") throw new Error("receipt result is invalid")
  if (typeof receipt.detail !== "string" || receipt.detail.length === 0) throw new Error("receipt detail is invalid")
  const verifiedAtMs = parseTime(receipt.verifiedAt, "receipt verification timestamp")
  const requestedAtMs = parseTime(request.requestedAt, "request timestamp")
  const expiresAtMs = parseTime(request.expiresAt, "request expiry")
  if (verifiedAtMs < requestedAtMs || verifiedAtMs > expiresAtMs) {
    throw new Error("receipt verification is outside request freshness")
  }
}

export function collectCrossUserBlueBubblesHostAction(
  input: { requestId: string; originHomeDir: string; sharedRoot?: string },
  overrides: BlueBubblesHostProtocolDeps = {},
): BlueBubblesHostCollection {
  const deps = protocolDeps(overrides)
  if (!/^\d+-[0-9a-f]{64}$/.test(input.requestId)) throw new Error("invalid BlueBubbles host request id")
  const attemptPath = blueBubblesHostAttemptPath(input.originHomeDir, input.requestId)
  if (!deps.existsSync(attemptPath)) throw new Error("BlueBubbles host attempt is missing")
  const attempt = readJson<BlueBubblesHostAttempt>(deps, attemptPath, "BlueBubbles host attempt")
  if (attempt.schemaVersion !== BLUEBUBBLES_HOST_PROTOCOL_SCHEMA_VERSION) {
    throw new Error("BlueBubbles host attempt state is invalid")
  }
  const request = attempt.request
  validateRequestShape(request)
  if (request.requestId !== input.requestId) throw new Error("attempt request id does not match collection request")
  if (typeof attempt.targetHomeDir !== "string" || !path.isAbsolute(attempt.targetHomeDir)) {
    throw new Error("BlueBubbles host attempt target home is invalid")
  }
  if (attempt.status === "collected" && attempt.collection) {
    if (attempt.collection.requestId !== request.requestId || attempt.collection.status !== "collected") {
      throw new Error("stored collection request id does not match")
    }
    requireReceiptMatch(request, attempt.targetHomeDir, attempt.collection.receipt)
    const expectedDetail = attempt.collection.receipt.result === "verified"
      ? `launchd verified at ${attempt.collection.receipt.verifiedAt}; current service state requires a fresh helper run`
      : `launchd helper reported failure at ${attempt.collection.receipt.verifiedAt}; current service state requires a fresh helper run`
    if (attempt.collection.detail !== expectedDetail) throw new Error("stored collection detail does not match receipt")
    return attempt.collection
  }
  if (attempt.status !== "pending") throw new Error("BlueBubbles host attempt state is invalid")
  const root = input.sharedRoot ?? BLUEBUBBLES_HOST_SHARED_ROOT
  const paths = sharedPaths(root)
  const expectedUid = deps.currentUid()
  validateManagedPath(deps, root, "shared root", "directory", expectedUid)
  validateManagedPath(deps, paths.receipts, "shared receipt directory", "directory", expectedUid)
  const receiptPath = path.join(paths.receipts, `${input.requestId}.json`)
  if (!deps.existsSync(receiptPath)) throw new Error("BlueBubbles host receipt is missing")
  const receiptStat = deps.lstatSync(receiptPath)
  if (receiptStat.isSymbolicLink?.()) throw new Error("BlueBubbles host receipt must not be a symbolic link")
  if (receiptStat.isFile?.() !== true) throw new Error("BlueBubbles host receipt must be a regular file")
  if (receiptStat.uid !== request.uid) throw new Error(`receipt owner uid ${receiptStat.uid} does not match target uid ${request.uid}`)
  if ((receiptStat.mode & 0o7777) !== 0o444) throw new Error("BlueBubbles host receipt mode must be 0444")
  const receipt = readJson<BlueBubblesHostReceipt>(deps, receiptPath, "BlueBubbles host receipt")
  requireReceiptMatch(request, attempt.targetHomeDir, receipt)
  const detail = receipt.result === "verified"
    ? `launchd verified at ${receipt.verifiedAt}; current service state requires a fresh helper run`
    : `launchd helper reported failure at ${receipt.verifiedAt}; current service state requires a fresh helper run`
  const collection: BlueBubblesHostCollection = {
    requestId: request.requestId,
    status: "collected",
    detail,
    receipt,
  }
  writeAtomicReplacement(deps, attemptPath, `${JSON.stringify({ ...attempt, status: "collected", collection }, null, 2)}\n`, 0o600)
  emitNervesEvent({
    component: "daemon",
    event: "daemon.bluebubbles_host_receipt_collected",
    message: "collected ownership-bound BlueBubbles host receipt",
    meta: { requestId: request.requestId, uid: request.uid, result: receipt.result },
  })
  return collection
}
