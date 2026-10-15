import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import Ajv from "ajv"
import { emitNervesEvent } from "../../nerves/runtime"
import { redactSecrets } from "./redact"
import type {
  ContinuityAssurance, ContinuityBinding, ContinuityCheckpointProjection, ContinuityKnownJob, ContinuityReceipt,
  ContinuityReceiptCorrelation, ContinuityUncertainMutation,
} from "./continuity-types"

const RECEIPT_LIMIT = 16384
const CHECKPOINT_LIMIT = 65536
const text = { type: "string", minLength: 1, maxLength: 4096, pattern: "^[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]+$" }
const digest = { type: "string", pattern: "^[a-f0-9]{64}$" }
const object = (properties: Record<string, object>) => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
})
const array = (items: object) => ({ type: "array", items, maxItems: 64 })
const jobSchema = object({ id: text, kind: text, owner: text, effects: text, status: text, disposition: text, reference: text })
const mutationSchema = object({ id: text, operation: text, disposition: text, evidence: text })
const ajv = new Ajv({ strict: true })
const validateReceipt = ajv.compile<ContinuityReceipt>(object({
  schemaVersion: { const: 1 }, batchId: text, bindingId: text, generation: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  round: { enum: ["preparation", "followup", "correction", "bootstrap", "execute"] }, nonce: text,
  launchAttemptId: { anyOf: [text, { type: "null" }] },
  checkpoint: object({ rootId: text, relativePath: text, sha256: digest }),
  task: object({ ref: text, rootId: text, launchCwd: text, worktree: text, branch: text, head: text, nextAction: text }),
  confirmation: { type: "boolean" }, knownJobs: array(jobSchema), uncertainMutations: array(mutationSchema),
}))
interface CheckpointDocument {
  goal: string
  scope: string
  decisions: string[]
  nextAction: string
  knownJobs: ContinuityKnownJob[]
  uncertainMutations: ContinuityUncertainMutation[]
  references: string[]
}
const validateCheckpoint = ajv.compile<CheckpointDocument>(object({
  goal: text, scope: text, decisions: array(text), nextAction: text,
  knownJobs: array(jobSchema), uncertainMutations: array(mutationSchema), references: array(text),
}))

export interface ContinuityReceiptSlot {
  path: string
  relativePath: string
  binding: ContinuityBinding
  attemptId: string
  correlation: ContinuityReceiptCorrelation
}
export interface VerifiedContinuityReceipt {
  receipt: ContinuityReceipt
  slot: ContinuityReceiptSlot
}
export type { ContinuityCheckpointProjection } from "./continuity-types"
export interface ContinuityEvidenceDeps {
  filesystem?: typeof fs
}

function refuse(code: string): never {
  emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_continuity_evidence_refused",
    message: "continuity evidence refused", meta: { code } })
  throw new Error(`Shepherd continuity evidence: ${code}`)
}

function relative(value: string): string {
  if (typeof value !== "string" || !value || value.length > 4096 || path.isAbsolute(value) ||
    /[\\\x00-\x1f\x7f]/.test(value) || value.split("/").some(part => !part || part === "." || part === "..")) refuse("relative path")
  return value
}
function segment(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) refuse("slot component")
  return value
}
function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`)
}
function authority(value: string): void {
  if (typeof value !== "string" || redact(value) !== value || /[\x00-\x1f\x7f]/.test(value)) refuse("credential-bearing binding")
}
function redact(value: string): string {
  return redactSecrets(value).replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/(\bauthorization\s*[=:]\s*)[^\r\n]+/gi, "$1[redacted]")
}
function redactDocument<T>(value: T): T {
  // Schema validation bounds the tree before recursion; keys cannot contain arbitrary private data.
  if (typeof value === "string") return redact(value) as T
  if (Array.isArray(value)) return value.map(item => redactDocument(item)) as T
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDocument(item)])) as T
  return value
}
function rootBinding(binding: ContinuityBinding): void {
  const root = binding.root
  if (!root || root.id !== binding.rootId || !path.isAbsolute(root.path) ||
    path.normalize(root.path) !== root.path || root.path === "/") refuse("frozen root binding")
  relative(root.namespace)
  relative(root.receiptBase)
  relative(binding.taskRef)
  if (!within(root.namespace, binding.taskRef)) refuse("task namespace binding")
  for (const value of [root.path, root.receiptBase, binding.taskRef, binding.launchCwd, binding.worktree]) authority(value)
  for (const value of [binding.launchCwd, binding.worktree, ...root.launchRoots, ...root.worktreeRoots]) {
    if (!path.isAbsolute(value) || path.normalize(value) !== value) refuse("noncanonical path binding")
  }
  if (!root.launchRoots.some(parent => within(parent, binding.launchCwd)) ||
    !root.worktreeRoots.some(parent => within(parent, binding.worktree))) refuse("launch/worktree binding")
}
function slotRelative(binding: ContinuityBinding, correlation: ContinuityReceiptCorrelation, attemptId: string): string {
  rootBinding(binding)
  for (const value of [correlation.batchId, correlation.bindingId, attemptId]) segment(value)
  if (correlation.bindingId !== binding.id || !Number.isSafeInteger(correlation.generation) || correlation.generation < 1 ||
    !["preparation", "followup", "correction", "bootstrap", "execute"].includes(correlation.round)) refuse("slot binding")
  return `${binding.root.receiptBase}/${correlation.batchId}/${binding.id}/${correlation.generation}-${correlation.round}-${attemptId}.json`
}
export function reserveContinuityReceiptSlot(
  binding: ContinuityBinding, batchId: string, generation: number, kind: string, attemptId: string,
): ContinuityReceiptSlot {
  if (!["preparation", "followup", "correction", "bootstrap", "execute"].includes(kind)) refuse("slot kind")
  const correlation: ContinuityReceiptCorrelation = {
    schemaVersion: 1, batchId, bindingId: binding.id, generation,
    round: kind as ContinuityReceiptCorrelation["round"], nonce: randomUUID(),
    launchAttemptId: kind === "bootstrap" || kind === "execute" ? attemptId : null,
  }
  const relativePath = slotRelative(binding, correlation, attemptId)
  return { path: path.join(binding.root.path, relativePath), relativePath, binding: structuredClone(binding), attemptId, correlation }
}

interface Pin { path: string; stat: fs.BigIntStats }
function same(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink &&
    a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}
function identity(stat: fs.BigIntStats): void {
  if (typeof stat.dev !== "bigint" || typeof stat.ino !== "bigint" ||
    !Number.isSafeInteger(Number(stat.dev)) || !Number.isSafeInteger(Number(stat.ino))) refuse("inexact filesystem identity")
}
function pins(binding: ContinuityBinding, file: string, io: typeof fs): Pin[] {
  const root = binding.root
  const result: Pin[] = []
  const parts = file.split("/").filter(Boolean)
  let current = ""
  for (let index = 0; index < parts.length; index++) {
    current += `/${parts[index]}`
    const stat = io.lstatSync(current, { bigint: true })
    identity(stat)
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) refuse("symlink or non-directory ancestor")
    if (within(root.path, current) && ((stat.mode & 0o022n) !== 0n || (stat.uid !== BigInt(process.getuid!()) && stat.uid !== 0n))) refuse("untrusted evidence path")
    if (current === root.path && (stat.dev !== BigInt(root.identity.dev) || stat.ino !== BigInt(root.identity.ino))) refuse("root identity changed")
    if (index === parts.length - 1 && (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid!()))) refuse("nonregular or ambiguous evidence file")
    result.push({ path: current, stat })
  }
  return result
}
function readBounded(binding: ContinuityBinding, relativePath: string, limit: number, deps: ContinuityEvidenceDeps): Buffer {
  const io = deps.filesystem ?? fs
  rootBinding(binding)
  const file = path.join(binding.root.path, relative(relativePath))
  const before = pins(binding, file, io)
  const expected = before[before.length - 1].stat
  if (expected.size > BigInt(limit)) refuse("byte limit")
  const fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    if (!same(expected, io.fstatSync(fd, { bigint: true }))) refuse("opened descriptor identity changed")
    const buffer = Buffer.alloc(limit + 1)
    let count = 0
    while (count < buffer.length) {
      const read = io.readSync(fd, buffer, count, buffer.length - count, count)
      if (!read) break
      count += read
    }
    if (count > limit) refuse("byte limit")
    if (BigInt(count) !== expected.size || !same(expected, io.fstatSync(fd, { bigint: true }))) refuse("descriptor content changed")
    const after = pins(binding, file, io)
    if (before.some((pin, index) => {
      const current = after[index].stat
      return pin.stat.isFile() ? !same(pin.stat, current)
        : pin.stat.dev !== current.dev || pin.stat.ino !== current.ino || pin.stat.mode !== current.mode || pin.stat.uid !== current.uid
    })) refuse("evidence path identity changed")
    return buffer.subarray(0, count)
  } finally { io.closeSync(fd) }
}
function parse(buffer: Buffer): unknown {
  const value = buffer.toString("utf8")
  if (!Buffer.from(value, "utf8").equals(buffer)) refuse("invalid UTF-8")
  try { return JSON.parse(value) } catch { return refuse("invalid evidence JSON") }
}
function correlation(receipt: ContinuityReceiptCorrelation, expected: ContinuityReceiptCorrelation): void {
  for (const key of ["schemaVersion", "batchId", "bindingId", "generation", "round", "nonce", "launchAttemptId"] as const) {
    if (receipt[key] !== expected[key]) refuse("receipt correlation")
  }
}
function checkTask(receipt: ContinuityReceipt, binding: ContinuityBinding): void {
  for (const value of [receipt.checkpoint.rootId, receipt.checkpoint.relativePath, receipt.task.ref,
    receipt.task.rootId, receipt.task.launchCwd, receipt.task.worktree, receipt.task.branch, receipt.task.head]) authority(value)
  if (receipt.checkpoint.rootId !== binding.rootId || receipt.task.rootId !== binding.rootId ||
    receipt.task.ref !== binding.taskRef || receipt.task.launchCwd !== binding.launchCwd || receipt.task.worktree !== binding.worktree ||
    !within(binding.taskRef, relative(receipt.checkpoint.relativePath))) refuse("receipt task binding")
  for (const list of [receipt.knownJobs, receipt.uncertainMutations]) {
    if (new Set(list.map(item => item.id)).size !== list.length) refuse("duplicate inventory")
  }
}
export function readContinuityReceipt(
  slot: ContinuityReceiptSlot, expected: ContinuityReceiptCorrelation, deps: ContinuityEvidenceDeps = {},
): VerifiedContinuityReceipt {
  correlation(slot.correlation, expected)
  const relativePath = slotRelative(slot.binding, expected, slot.attemptId)
  if (relativePath !== slot.relativePath || path.join(slot.binding.root.path, relativePath) !== slot.path) refuse("receipt slot substitution")
  const receipt = parse(readBounded(slot.binding, relativePath, RECEIPT_LIMIT, deps))
  if (!validateReceipt(receipt)) refuse("receipt schema")
  correlation(receipt, expected)
  checkTask(receipt, slot.binding)
  const redacted = redactDocument(receipt)
  if (!validateReceipt(redacted) || Buffer.byteLength(JSON.stringify(redacted)) > RECEIPT_LIMIT) refuse("redacted receipt bounds")
  return { receipt: redacted, slot: structuredClone(slot) }
}
export function verifyContinuityCheckpoint(
  verified: VerifiedContinuityReceipt, binding: ContinuityBinding, deps: ContinuityEvidenceDeps = {},
): ContinuityCheckpointProjection {
  if (!isDeepStrictEqual(binding, verified.slot.binding)) refuse("checkpoint frozen binding")
  const receipt = verified.receipt
  checkTask(receipt, binding)
  const buffer = readBounded(binding, receipt.checkpoint.relativePath, CHECKPOINT_LIMIT, deps)
  const checkpointSha256 = createHash("sha256").update(buffer).digest("hex")
  if (checkpointSha256 !== receipt.checkpoint.sha256) refuse("checkpoint hash")
  const document = parse(buffer)
  if (!validateCheckpoint(document)) refuse("checkpoint projection schema")
  const projection = redactDocument(document)
  if (projection.nextAction !== receipt.task.nextAction ||
    !isDeepStrictEqual(projection.knownJobs, receipt.knownJobs) ||
    !isDeepStrictEqual(projection.uncertainMutations, receipt.uncertainMutations)) refuse("checkpoint inventory or action mismatch")
  const result = { ...projection, checkpointSha256 }
  if (Buffer.byteLength(JSON.stringify(result)) > CHECKPOINT_LIMIT) refuse("projection byte limit")
  return result
}
export function continuityEvidenceAssurance(
  receipt: ContinuityReceipt, projection: ContinuityCheckpointProjection,
  facts: { round: string; observedAt: string; knownUnsafeJobIds?: string[]; unresolvedInventory?: boolean },
): ContinuityAssurance {
  const safe = receipt.confirmation && receipt.round === facts.round && ["followup", "correction"].includes(facts.round) &&
    projection.checkpointSha256 === receipt.checkpoint.sha256 &&
    isDeepStrictEqual(projection.knownJobs, receipt.knownJobs) &&
    isDeepStrictEqual(projection.uncertainMutations, receipt.uncertainMutations) &&
    receipt.uncertainMutations.every(mutation => mutation.disposition === "reconciled") &&
    !(facts.knownUnsafeJobIds?.length) && !facts.unresolvedInventory &&
    receipt.knownJobs.every(job => job.disposition === "independent" ||
      (["stopped", "completed"].includes(job.disposition) && ["stopped", "completed", "ended"].includes(job.status)))
  return {
    checkpoint: "verified", endReadiness: safe ? "agent-confirmed-as-of-native-boundary" : "unconfirmed",
    backgroundCoverage: "unknown", jobInventory: "preserved-agent-reported", reopen: "unverified",
    observedAt: facts.observedAt, qualifications: ["Native background coverage is unknown; agent inventory is not proof of zero jobs.",
      ...(safe ? [] : ["Final confirmation or known-job/mutation disposition remains unresolved."])],
  }
}
