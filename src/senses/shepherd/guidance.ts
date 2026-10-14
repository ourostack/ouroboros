import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { withFileLock } from "../../heart/file-lock"
import { redactSecrets } from "./redact"
import { readReturns, shepherdStateDir, type ReturnRecord } from "./returns"
import { emitNervesEvent } from "../../nerves/runtime"

export type ShepherdGuidanceScope = "session" | "project" | "global"
export type ShepherdGuidanceTarget = { host: string; session: string; cwd: string | null; task: string | null }
export interface ShepherdGuidanceProvenance {
  actorId: string
  requestId: string
  at: string
  kind: "operator correction" | "operator instruction"
  returnId: string | null
}
export interface ShepherdPrinciple {
  id: string
  text: string
  scope: ShepherdGuidanceScope
  target: ShepherdGuidanceTarget
  active: boolean
  provenance: ShepherdGuidanceProvenance
}
export interface ShepherdGuidanceReceipt {
  revision: number
  provenance: ShepherdGuidanceProvenance
  correctionId?: string
  principleId?: string
  paused?: boolean
}
export interface ShepherdGuidanceState {
  version: 1
  revision: number
  corrections: Array<{ id: string; feedback: string; target: ShepherdGuidanceTarget; returnRecord: ReturnRecord | null; provenance: ShepherdGuidanceProvenance }>
  principles: ShepherdPrinciple[]
  pauses: Array<{ host: string; session: string; paused: boolean; provenance: ShepherdGuidanceProvenance }>
  requests: Array<{ actorId: string; requestId: string; hash: string; requestFingerprint: string | null; receipt: ShepherdGuidanceReceipt }>
}
export interface ShepherdGuidanceView {
  revision: number
  paused: boolean
  principles: Array<Pick<ShepherdPrinciple, "id" | "text" | "scope" | "provenance">>
}
export interface ShepherdGuidanceRequest {
  actorId: string
  requestId: string
  /** Trusted tool adapter only: SHA-256 of tool name + canonical original arguments, before resolving live coordinates. */
  requestFingerprint?: string
}
export interface ShepherdCorrectionInput extends ShepherdGuidanceRequest {
  target: ShepherdGuidanceTarget
  feedback: string
  returnId?: string
  principle?: string
  scope?: ShepherdGuidanceScope
}
export interface ShepherdPrincipleUpdateInput extends ShepherdGuidanceRequest { principleId: string; text: string }
export interface ShepherdPrincipleForgetInput extends ShepherdGuidanceRequest { principleId: string }
export interface ShepherdPauseInput extends ShepherdGuidanceRequest { target: ShepherdGuidanceTarget; paused: boolean }

const MAX_BYTES = 2 * 1024 * 1024
const SCOPES = new Set(["session", "project", "global"])
const RETURN_KINDS = new Set(["premature", "gate", "done", "waiting", "working", "unclear", "error", "loop_guard"])
const empty = (): ShepherdGuidanceState => ({ version: 1, revision: 0, corrections: [], principles: [], pauses: [], requests: [] })
const hash = (value: string): string => createHash("sha256").update(value).digest("hex")
const filePath = (root: string): string => path.join(shepherdStateDir(root), "guidance.json")

/** Full immutable host/session/transition/time tuple; no host's recyclable short surface ref. */
export function shepherdReturnId(record: ReturnRecord): string {
  return `return:${hash(JSON.stringify([record.host, record.session, record.transition, record.at]))}`
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
const string = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0
const nullableString = (value: unknown): boolean => value === null || string(value)
const integer = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0
const coordinate = (value: unknown): boolean => value === null || (string(value) && redactSecrets(value) === value)
function validTarget(value: unknown): boolean {
  return object(value) && string(value.host) && string(value.session) && [value.host, value.session, value.cwd, value.task].every(coordinate)
}
function validProvenance(value: unknown): boolean {
  return object(value) && string(value.actorId) && string(value.requestId) && string(value.at)
    && (value.kind === "operator correction" || value.kind === "operator instruction") && nullableString(value.returnId)
    && (value.kind === "operator correction" ? value.returnId !== null : value.returnId === null)
}
function validReturn(value: unknown): value is ReturnRecord {
  return object(value) && validTarget(value) && string(value.at) && string(value.transition) && nullableString(value.agent)
    && RETURN_KINDS.has(value.kind as string) && (value.action === "respond" || value.action === "let_through")
    && typeof value.reason === "string" && nullableString(value.reply)
    && (value.latencyMs === null || integer(value.latencyMs)) && (value.inputTokens === null || integer(value.inputTokens))
}
function validState(value: unknown): value is ShepherdGuidanceState {
  if (!object(value) || value.version !== 1 || !integer(value.revision)) return false
  if (![value.corrections, value.principles, value.pauses, value.requests].every(Array.isArray)) return false
  const s = value as unknown as ShepherdGuidanceState
  return s.corrections.every(c => object(c) && string(c.id) && string(c.feedback) && c.feedback.length <= 2000 && validTarget(c.target) && validProvenance(c.provenance)
    && (c.returnRecord === null ? c.provenance.kind === "operator instruction" : validReturn(c.returnRecord) && shepherdReturnId(c.returnRecord) === c.provenance.returnId))
    && s.principles.every(p => object(p) && string(p.id) && string(p.text) && p.text.length <= 1000 && SCOPES.has(p.scope) && validTarget(p.target) && typeof p.active === "boolean" && validProvenance(p.provenance)
      && (p.scope !== "project" || (p.target.cwd !== null && path.isAbsolute(p.target.cwd) && path.normalize(p.target.cwd) === p.target.cwd)))
    && s.principles.filter(p => p.active).length <= 20
    && new Set(s.principles.map(p => p.id)).size === s.principles.length
    && s.pauses.every(p => object(p) && string(p.host) && string(p.session) && typeof p.paused === "boolean" && validProvenance(p.provenance))
    && s.requests.every(r => object(r) && string(r.actorId) && string(r.requestId) && string(r.hash) && nullableString(r.requestFingerprint) && object(r.receipt) && integer(r.receipt.revision) && r.receipt.revision <= s.revision && validProvenance(r.receipt.provenance))
}

/** Missing only is empty. Corruption, permission errors, unsupported schema and oversized state are never ignored. */
export function readGuidance(agentRoot: string): ShepherdGuidanceState {
  let raw: string
  let located = false
  try {
    const metadata = fs.lstatSync(filePath(agentRoot))
    located = true
    if (!metadata.isFile()) throw new Error("state must be a regular file, not a directory or symlink")
    if (metadata.size > MAX_BYTES) throw new Error("state exceeds 2 MiB")
    raw = fs.readFileSync(filePath(agentRoot), "utf8")
  } catch (error) {
    if (!located && (error as NodeJS.ErrnoException).code === "ENOENT") return empty()
    throw new Error(`Shepherd guidance could not be read: ${redactSecrets((error as Error).message)}`)
  }
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error("Shepherd guidance exceeds 2 MiB")
  let state: unknown
  try { state = JSON.parse(raw) } catch { throw new Error("Shepherd guidance is malformed JSON") }
  if (!validState(state)) throw new Error("Shepherd guidance is malformed or uses an unsupported state schema")
  return state
}

export function applicableGuidance(state: ShepherdGuidanceState, target: ShepherdGuidanceTarget): ShepherdGuidanceView {
  return {
    revision: state.revision,
    paused: state.pauses.some(p => p.host === target.host && p.session === target.session && p.paused),
    principles: state.principles.filter(p => p.active && (p.scope === "global"
      || (p.scope === "session" ? p.target.host === target.host && p.target.session === target.session
        : p.target.cwd === target.cwd && (p.target.task === null || p.target.task === target.task))))
      .map(({ id, text, scope, provenance }) => ({ id, text, scope, provenance })),
  }
}

function bounded(value: string, name: string, max: number): string {
  if (!string(value) || value.length > max) throw new Error(`${name} must be nonempty and at most ${max} characters`)
  const redacted = redactSecrets(value)
  if (redacted.length > max) throw new Error(`${name} exceeds ${max} characters after redaction`)
  return redacted
}
function knownTarget(root: string, target: ShepherdGuidanceTarget, live: readonly ShepherdGuidanceTarget[], record?: ReturnRecord): ShepherdGuidanceTarget {
  if (!validTarget(target)) throw new Error("invalid Shepherd session target")
  const known = record ?? [...readReturns(root).filter(validReturn)].reverse().find(r => r.host === target.host && r.session === target.session)
    ?? live.find(t => t.host === target.host && t.session === target.session)
  if (!known) throw new Error("unknown session; no recorded or verified live Shepherd target")
  if (known.host !== target.host || known.session !== target.session || known.cwd !== target.cwd || known.task !== target.task) throw new Error("target does not match the recorded or live session")
  return { host: known.host, session: known.session, cwd: known.cwd, task: known.task }
}

/** Canonical JSON for request equality, independent of object-property insertion order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
}
/** Redact string values, not the serialized JSON syntax; includes copied terminal judgment/provenance. */
function redactedSnapshot(state: ShepherdGuidanceState): string {
  return JSON.stringify(state, (_key, value: unknown) => typeof value === "string" ? redactSecrets(value) : value)
}
function persist(root: string, state: ShepherdGuidanceState): void {
  const snapshot = redactedSnapshot(state)
  if (Buffer.byteLength(snapshot) > MAX_BYTES) throw new Error("Shepherd guidance exceeds 2 MiB; no change was written")
  const file = filePath(root)
  // One fixed temp name is safe because every writer holds the same cross-process lock.
  const temp = `${file}.tmp`
  fs.writeFileSync(temp, snapshot, { mode: 0o600 })
  fs.chmodSync(temp, 0o600)
  fs.renameSync(temp, file)
}
async function mutate(root: string, op: string, input: ShepherdGuidanceRequest, apply: (state: ShepherdGuidanceState, provenance: ShepherdGuidanceProvenance) => Partial<ShepherdGuidanceReceipt>): Promise<ShepherdGuidanceReceipt> {
  if (bounded(input.actorId, "actor ID", 200) !== input.actorId || bounded(input.requestId, "request ID", 200) !== input.requestId) throw new Error("secret-shaped identity is not a valid actor or request ID")
  if (input.requestFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(input.requestFingerprint)) throw new Error("invalid trusted-adapter request fingerprint")
  const dir = shepherdStateDir(root)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  return withFileLock(dir, "guidance", () => {
    const state = readGuidance(root)
    // Tool targets include discovered cwd/task, not supplied arguments. The trusted adapter fingerprints its original
    // body so a retry still means the same instruction after a live ref moves, cwd changes, or return history rotates.
    const bodyHash = input.requestFingerprint ?? hash(canonical({ op, input }))
    const prior = state.requests.find(r => r.actorId === input.actorId && r.requestId === input.requestId)
    if (prior) {
      if (prior.hash !== bodyHash) throw new Error("request ID was already used with a different body")
      return prior.receipt
    }
    const clean: ShepherdGuidanceProvenance = { actorId: input.actorId, requestId: input.requestId, at: new Date().toISOString(), kind: "operator instruction", returnId: null }
    const result = apply(state, clean)
    state.revision++
    const receipt = { revision: state.revision, provenance: clean, ...result }
    state.requests.push({ actorId: input.actorId, requestId: input.requestId, hash: bodyHash, requestFingerprint: input.requestFingerprint ?? null, receipt })
    persist(root, state)
    emitNervesEvent({ component: "senses", event: "senses.shepherd_guidance_mutated", message: "committed a private Shepherd guidance revision", meta: { operation: op, revision: state.revision } })
    return receipt
  })
}

/** liveTargets are verified canonical host.list() identities, never caller-supplied tool arguments. */
export function recordShepherdCorrection(agentRoot: string, input: ShepherdCorrectionInput, liveTargets: readonly ShepherdGuidanceTarget[] = []): Promise<ShepherdGuidanceReceipt> {
  return mutate(agentRoot, "correct", input, (state, provenance) => {
    const feedback = bounded(input.feedback, "feedback", 2000)
    const scope = input.scope === undefined ? "session" : input.scope
    if (!SCOPES.has(scope)) throw new Error("unsupported guidance scope")
    let record: ReturnRecord | undefined
    if (input.returnId !== undefined) {
      record = readReturns(agentRoot).filter(validReturn).find(r => shepherdReturnId(r) === input.returnId)
      if (!record) throw new Error("Shepherd return ID not found")
      provenance.kind = "operator correction"
      provenance.returnId = input.returnId
    }
    const target = knownTarget(agentRoot, input.target, liveTargets, record)
    if (scope === "project" && (!target.cwd || !path.isAbsolute(target.cwd) || path.normalize(target.cwd) !== target.cwd)) throw new Error("project scope requires an exact canonical recorded cwd")
    const id = hash(canonical(provenance))
    const result: Partial<ShepherdGuidanceReceipt> = { correctionId: `correction:${id}` }
    if (input.principle !== undefined) {
      const text = bounded(input.principle, "principle", 1000)
      if (state.principles.filter(p => p.active).length >= 20) throw new Error("Shepherd guidance already has 20 active principles; forget one explicitly")
      result.principleId = `principle:${id}`
      state.principles.push({ id: result.principleId, text, scope, target, active: true, provenance })
    }
    state.corrections.push({ id: result.correctionId!, feedback, target, returnRecord: record ?? null, provenance })
    return result
  })
}

function activePrinciple(state: ShepherdGuidanceState, id: string): ShepherdPrinciple {
  const principle = state.principles.find(p => p.id === id && p.active)
  if (!principle) throw new Error("active principle not found")
  return principle
}
export function updateShepherdPrinciple(agentRoot: string, input: ShepherdPrincipleUpdateInput): Promise<ShepherdGuidanceReceipt> {
  return mutate(agentRoot, "update", input, (state, provenance) => {
    const principle = activePrinciple(state, input.principleId)
    principle.text = bounded(input.text, "principle", 1000)
    principle.provenance = provenance
    return { principleId: principle.id }
  })
}
export function forgetShepherdPrinciple(agentRoot: string, input: ShepherdPrincipleForgetInput): Promise<ShepherdGuidanceReceipt> {
  return mutate(agentRoot, "forget", input, (state, provenance) => {
    const principle = activePrinciple(state, input.principleId)
    principle.active = false
    principle.provenance = provenance
    return { principleId: principle.id }
  })
}
export function setShepherdSessionPause(agentRoot: string, input: ShepherdPauseInput, liveTargets: readonly ShepherdGuidanceTarget[] = []): Promise<ShepherdGuidanceReceipt> {
  return mutate(agentRoot, "pause", input, (state, provenance) => {
    if (typeof input.paused !== "boolean") throw new Error("paused must be a boolean")
    const target = knownTarget(agentRoot, input.target, liveTargets)
    const prior = state.pauses.find(p => p.host === target.host && p.session === target.session)
    const pause = { host: target.host, session: target.session, paused: input.paused, provenance }
    if (prior) Object.assign(prior, pause)
    else state.pauses.push(pause)
    return { paused: input.paused }
  })
}
