import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { emitNervesEvent } from "../../nerves/runtime"
import { handleContinuityReplacementStop } from "./continuity-bootstrap"
import {
  continuityEvidenceAssurance, readContinuityReceipt, reserveContinuityReceiptSlot, verifyContinuityCheckpoint,
} from "./continuity-evidence"
import { resolveContinuityCaller, type ContinuityCallerProof, type ProcessProofDeps } from "./continuity-process"
import { readContinuityState, transactContinuity } from "./continuity-store"
import type {
  ContinuityCheckpointProjection, ContinuityProfile, ContinuityReceipt, ContinuityRound,
  ContinuityRunner, ContinuityTarget,
} from "./continuity-types"

export interface NativeContinuityStop {
  runner: ContinuityRunner
  nativeSessionId: string
  cwd: string
  normal: boolean
  stopHookActive: boolean
  eventId: string | null
}
export type NativeContinuityHookOutput = Record<string, never> | { decision: "block"; reason: string }
export interface ContinuityHookContext {
  agent: string
  storePath: string
  adapterPid: number
  profiles: ContinuityProfile[]
  configFingerprint: string
  processDeps: ProcessProofDeps
}
export const CONTINUITY_NATIVE_VERSIONS: Record<ContinuityRunner, string> = {
  copilot: "1.0.97", claude: "2.1.299", codex: "0.162.1",
}
const clean = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value)
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
function invalid(): never { throw new Error("Invalid native Shepherd continuity Stop") }
function diagnostic(code: string): void {
  emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_continuity_hook_refused",
    message: "native continuity progress refused", meta: { code } })
}
export function parseNativeContinuityStop(runner: ContinuityRunner, value: unknown): NativeContinuityStop {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid()
  const raw = value as Record<string, unknown>
  const nativeSessionId = runner === "copilot" ? raw.sessionId : raw.session_id
  if (!clean(nativeSessionId) || !clean(raw.cwd) || !path.isAbsolute(raw.cwd) || path.normalize(raw.cwd) !== raw.cwd) invalid()
  const active = raw.stop_hook_active
  if (active !== undefined && typeof active !== "boolean") invalid()
  if (runner !== "copilot" && typeof active !== "boolean") invalid()
  let eventId: string | null = null
  let normal: boolean
  if (runner === "copilot") {
    if (!clean(raw.timestamp) || !Number.isFinite(Date.parse(raw.timestamp)) || !clean(raw.stopReason)) invalid()
    eventId = hash([runner, nativeSessionId, raw.timestamp, raw.stopReason])
    normal = raw.stopReason === "end_turn"
  } else {
    if (!clean(raw.hook_event_name)) invalid()
    if (runner === "codex" && !clean(raw.turn_id)) invalid()
    if (clean(raw.turn_id)) eventId = hash([runner, nativeSessionId, raw.turn_id, raw.hook_event_name])
    normal = raw.hook_event_name === "Stop"
  }
  return { runner, nativeSessionId, cwd: raw.cwd, normal, stopHookActive: active === true, eventId }
}

export function renderContinuityRoundInstruction(target: ContinuityTarget, round: ContinuityRound): string {
  const binding = target.binding
  const correlation = {
    schemaVersion: 1, batchId: round.batchId, bindingId: binding.id, generation: target.generation,
    round: round.kind, nonce: round.nonce, launchAttemptId: null,
  }
  const instruction = [
    round.kind === "preparation" ? "Pause this task cooperatively at a safe point and prepare its durable handoff."
      : "Are you sure you are ready for this session to end? Recheck the saved checkpoint, unfinished work and background jobs.",
    round.kind === "correction" ? "This is the one final correction; resolve the listed evidence gaps or explicitly report why ending is unsafe." : "",
    "Do not execute the next task action. Preserve dirty work; do not commit, stash, discard, close or publish just to prepare.",
    "Save goal, scope, ownership, decisions, completed work, tests, failures, blockers, dependencies and the exact next action to your own durable context using its normal authorized mechanism.",
    "Record actual worktree/branch/HEAD, dirty-work inventory, known job owners/effects/status/disposition/references, and uncertain mutations with reconciliation steps. Do not replay unknown effects.",
    `Frozen binding: ${JSON.stringify({ taskRef: binding.taskRef, rootId: binding.rootId,
      durableRoot: binding.root.path, launchCwd: binding.launchCwd, worktree: binding.worktree })}`,
    "In this task namespace, write a bounded UTF-8 JSON handoff projection with exactly goal:string, scope:string, decisions:string[], nextAction:string, knownJobs:[{id,kind,owner,effects,status,disposition,reference}], uncertainMutations:[{id,operation,disposition,evidence}], references:string[]. References point to your original durable context. No credentials or raw logs. Maximum 64 KiB.",
    `Write a fresh UTF-8 JSON receipt ONLY to ${JSON.stringify(path.join(binding.root.path, round.receiptSlot))}. Maximum 16 KiB.`,
    `Copy these exact correlation fields: ${JSON.stringify(correlation)}.`,
    "Add checkpoint:{rootId,relativePath,sha256}, task:{ref,rootId,launchCwd,worktree,branch,head,nextAction}, confirmation:boolean, knownJobs and uncertainMutations. Use the SHA-256 of the exact projection bytes. The inventories and nextAction must match the projection.",
    "Use disposition independent only for independently owned jobs with durable references; stopped/completed require matching ended status. Unknown or unsafe work must remain explicit. This is your reported inventory, not native proof of zero background jobs.",
    "Previously reported unresolved items cannot disappear. Repeat each ID with its original job kind/owner/effects or mutation operation. Resolve a mutation only with disposition reconciled and explicit readback evidence; do not replay it.",
    "Inventory IDs and exact identity fields (job kind/owner/effects and mutation operation) must be stable nonsecret values; any value changed by credential redaction is refused.",
    `Outstanding reported inventory: ${JSON.stringify(target.unresolvedInventory)}`,
    `Evidence gaps: ${JSON.stringify(target.reasons)}`,
    "Finish this receipt and return to the native Stop boundary. Do not discover or substitute another receipt path.",
  ].filter(Boolean).join("\n")
  if (Buffer.byteLength(instruction) > 16384) throw new Error("Native continuity instruction exceeds byte limit")
  return instruction
}

function accumulateContinuityInventory(target: ContinuityTarget, receipt: ContinuityReceipt, verified: boolean): void {
  const jobs = new Map(target.unresolvedInventory.knownJobs.map(job => [job.id, job]))
  const mutations = new Map(target.unresolvedInventory.uncertainMutations.map(mutation => [mutation.id, mutation]))
  for (const job of receipt.knownJobs) {
    const prior = jobs.get(job.id)
    if (prior && (prior.kind !== job.kind || prior.owner !== job.owner || prior.effects !== job.effects)) {
      throw new Error("reported job identity changed")
    }
    const safe = job.disposition === "independent" ||
      (["stopped", "completed"].includes(job.disposition) && ["stopped", "completed", "ended"].includes(job.status))
    if (verified && safe) jobs.delete(job.id)
    else jobs.set(job.id, job)
  }
  for (const mutation of receipt.uncertainMutations) {
    const prior = mutations.get(mutation.id)
    if (prior && prior.operation !== mutation.operation) throw new Error("reported mutation identity changed")
    if (verified && mutation.disposition === "reconciled") mutations.delete(mutation.id)
    else mutations.set(mutation.id, mutation)
  }
  target.unresolvedInventory = { knownJobs: [...jobs.values()], uncertainMutations: [...mutations.values()] }
}

async function boundedProof(input: NativeContinuityStop, context: ContinuityHookContext, deadline: number): Promise<ContinuityCallerProof> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      resolveContinuityCaller({ adapterPid: context.adapterPid, nativeSessionId: input.nativeSessionId,
        runner: input.runner, profiles: context.profiles }, { ...context.processDeps, deadline }),
      new Promise<ContinuityCallerProof>(resolve => {
        timer = setTimeout(() => resolve({ state: "unsupported", reason: "native-budget" }), Math.max(0, deadline - Date.now()))
      }),
    ])
  } finally { clearTimeout(timer) }
}
export async function handleContinuityStop(input: NativeContinuityStop, context: ContinuityHookContext): Promise<NativeContinuityHookOutput> {
  if (!input.normal) return {}
  const deadline = Date.now() + 1900
  let failureTargets: Array<{ batchId: string; targetId: string; replacement?: boolean }> = []
  try {
    let snapshot = readContinuityState(context.storePath)
    const selected = snapshot.batches.flatMap(batch => batch.agent === context.agent && batch.cancellation === "none"
      ? batch.targets.filter(target => target.binding.runner === input.runner && target.binding.nativeSessionId === input.nativeSessionId)
        .map(target => ({ batch, target })) : [])
    const provisionalReplacements = snapshot.batches.flatMap(batch => batch.agent === context.agent
      ? batch.targets.filter(target => target.binding.runner === input.runner && target.launch?.nativeSessionId === input.nativeSessionId &&
        !["working", "blocked", "uncertain"].includes(target.launch.phase)).map(target => ({ batch, target })) : [])
    failureTargets = [...selected.map(entry => ({ batchId: entry.batch.id, targetId: entry.target.id })),
      ...provisionalReplacements.map(entry => ({ batchId: entry.batch.id, targetId: entry.target.id, replacement: true }))]
    if (selected.length > 1 || provisionalReplacements.length > 1) throw new Error("ambiguous native target")
    const entry = selected[0]
    const target = entry?.target
    if (target && (["blocked", "unsupported", "uncertain", "cancelled", "ready"].includes(target.state) ||
      target.rounds.length > 0 && target.rounds.every(round => round.phase === "acknowledged") ||
      input.eventId !== null && target.observedTransitions.includes(input.eventId))) return {}
    const proof = await boundedProof(input, context, deadline - 400)
    const profile = proof.state === "verified" ? context.profiles.find(profile => profile.id === proof.profileId) : undefined
    const recordRefusal = async (refusal: "blocked" | "unsupported", reason: string) => {
      diagnostic(reason)
      if (target) await transactContinuity(context.storePath, snapshot.revision, state => {
        const current = state.batches.find(batch => batch.id === entry.batch.id)!.targets.find(value => value.id === target.id)!
        current.state = refusal
        current.reasons = [reason]
      }, { busyTimeoutMs: 100 })
      else if (provisionalReplacements.length === 1) await transactContinuity(context.storePath, snapshot.revision, state => {
        const entry = provisionalReplacements[0]
        const current = state.batches.find(batch => batch.id === entry.batch.id)!.targets.find(value => value.id === entry.target.id)!
        current.launch!.phase = "blocked"
        current.reopen = refusal
        current.reasons = [reason]
        state.claims.find(claim => claim.taskKey === current.binding.taskKey)!.phase = "uncertain"
      }, { busyTimeoutMs: 100 })
    }
    if (proof.state !== "verified" || !profile || profile.version !== CONTINUITY_NATIVE_VERSIONS[input.runner]) {
      await recordRefusal(proof.state === "verified" ? "unsupported" : proof.state,
        proof.state === "verified" ? "native-version" : proof.reason)
      return {}
    }
    const replacements = snapshot.batches.flatMap(batch => batch.agent === context.agent
      ? batch.targets.filter(target => target.launch && target.binding.runner === input.runner &&
        (target.launch.nativeSessionId === input.nativeSessionId ||
          input.runner === "codex" && target.launch.bootstrapProcess !== null &&
          proof.lineage.some(generation => isDeepStrictEqual(generation, target.launch!.bootstrapProcess))))
        .map(target => ({ batch, target })) : [])
    if (replacements.length > 1) throw new Error("ambiguous replacement target")
    if (replacements.length) {
      const replacement = replacements[0]
      failureTargets = [{ batchId: replacement.batch.id, targetId: replacement.target.id, replacement: true }]
      return await handleContinuityReplacementStop(input, context, proof, profile, snapshot,
        replacement.batch.id, replacement.target.id, deadline)
    }
    let refusal: "blocked" | "unsupported" | undefined
    let reason = ""
    if (proof.cwd !== null && proof.cwd !== input.cwd) { refusal = "blocked"; reason = "native-cwd" }
    else if (target && (!isDeepStrictEqual(proof.generation, target.binding.process) ||
      !isDeepStrictEqual(proof.wrapper, target.binding.wrapper) || input.cwd !== target.binding.launchCwd ||
      target.binding.configFingerprint !== context.configFingerprint ||
      target.binding.profileFingerprint !== null && target.binding.profileFingerprint !== profile.fingerprint)) {
      refusal = "blocked"; reason = "native-binding"
    }
    if (refusal) {
      await recordRefusal(refusal, reason)
      return {}
    }
    const enrolled = await transactContinuity(context.storePath, snapshot.revision, state => {
      let enrollment = state.enrollments.find(value => value.agent === context.agent && value.runner === input.runner &&
        value.nativeSessionId === input.nativeSessionId && isDeepStrictEqual(value.process, proof.generation) &&
        isDeepStrictEqual(value.wrapper, proof.wrapper) && value.profileFingerprint === profile.fingerprint &&
        value.configFingerprint === context.configFingerprint && value.launchCwd === input.cwd)
      if (!enrollment) {
        enrollment = { id: randomUUID(), agent: context.agent, runner: input.runner, nativeSessionId: input.nativeSessionId,
          process: proof.generation, wrapper: proof.wrapper, profileId: profile.id, profileFingerprint: profile.fingerprint,
          configFingerprint: context.configFingerprint, launchCwd: input.cwd, observedAt: new Date().toISOString() }
        state.enrollments.push(enrollment)
      } else enrollment.observedAt = new Date().toISOString()
      return enrollment.id
    }, { busyTimeoutMs: 100 })
    if (!target) return {}
    snapshot = readContinuityState(context.storePath)
    if (snapshot.revision !== enrolled.revision || target.binding.enrollmentEpoch !== enrolled.result) throw new Error("native enrollment changed")
    const previous = target.rounds[target.rounds.length - 1]
    let receipt: ContinuityReceipt | null = null
    let projection: ContinuityCheckpointProjection | null = null
    let evidenceReason = ""
    if (previous) {
      if (previous.phase !== "issued") evidenceReason = "round-not-issued"
      else {
        try {
          const slot = reserveContinuityReceiptSlot(target.binding, entry.batch.id, target.generation, previous.kind, previous.attemptId)
          slot.correlation.nonce = previous.nonce
          if (slot.relativePath !== previous.receiptSlot || previous.batchId !== entry.batch.id) throw new Error("reserved slot changed")
          receipt = readContinuityReceipt(slot, slot.correlation).receipt
          try { projection = verifyContinuityCheckpoint({ receipt, slot }, target.binding) } catch { evidenceReason = "checkpoint-unverified" }
        } catch { evidenceReason = "receipt-unacknowledged" }
      }
    }
    if (Date.now() > deadline) throw new Error("native budget exhausted")
    const result = await transactContinuity(context.storePath, snapshot.revision, state => {
      const batch = state.batches.find(batch => batch.id === entry.batch.id)!
      const current = batch.targets.find(value => value.id === target.id)!
      if (input.eventId !== null) current.observedTransitions = [...current.observedTransitions, input.eventId].slice(-64)
      if (previous && !receipt) {
        current.rounds[current.rounds.length - 1].phase = "uncertain"
        current.state = "uncertain"
        current.reasons = [evidenceReason]
        return null
      }
      if (previous && receipt) {
        accumulateContinuityInventory(current, receipt, projection !== null)
        current.rounds[current.rounds.length - 1].phase = "acknowledged"
        current.receipt = receipt
        current.projection = projection
      }
      const final = previous && previous.kind !== "preparation"
      if (final && projection && receipt) {
        const unresolved = current.unresolvedInventory.knownJobs.length > 0 || current.unresolvedInventory.uncertainMutations.length > 0
        current.assurance = continuityEvidenceAssurance(receipt, projection, {
          round: previous.kind, observedAt: new Date().toISOString(), unresolvedInventory: unresolved,
        })
        if (current.assurance.endReadiness !== "unconfirmed") {
          current.state = "verifying"
          current.reasons = []
          return null
        }
        evidenceReason = unresolved ? "prior-inventory-unresolved" : "final-confirmation-unresolved"
      }
      current.reasons = evidenceReason ? [evidenceReason] : []
      if (final && current.rounds.length >= 3) {
        current.state = "blocked"
        current.reasons = [evidenceReason]
        return null
      }
      const kind = !previous ? "preparation" : previous.kind === "preparation" ? "followup" : "correction"
      const slot = reserveContinuityReceiptSlot(current.binding, batch.id, current.generation, kind, randomUUID())
      const round: ContinuityRound = {
        batchId: batch.id, kind, nonce: slot.correlation.nonce, receiptSlot: slot.relativePath, phase: "reserved",
        attemptId: slot.attemptId, expectedRevision: state.revision,
      }
      const instruction = renderContinuityRoundInstruction(current, round)
      current.rounds.push(round)
      current.state = "checkpoint-requested"
      return { instruction, attemptId: round.attemptId }
    }, { busyTimeoutMs: 100 })
    if (!result.result) return {}
    if (Date.now() > deadline) throw new Error("native budget exhausted after reservation")
    const reserved = result.result
    await transactContinuity(context.storePath, result.revision, state => {
      const current = state.batches.find(batch => batch.id === entry.batch.id)!.targets.find(value => value.id === target.id)!
      // Expected-revision CAS excludes cancellation/round changes since reservation.
      const round = current.rounds.find(round => round.attemptId === reserved.attemptId)!
      round.phase = "issued"
    }, { busyTimeoutMs: 100 })
    // Issued is not agent-acknowledged. Lost stdout leaves this exact round unreissued.
    return { decision: "block", reason: reserved.instruction }
  } catch {
    diagnostic("native-state-or-budget")
    if (failureTargets.length && Date.now() < deadline - 200) {
      try {
        const state = readContinuityState(context.storePath)
        await transactContinuity(context.storePath, state.revision, current => {
          for (const failed of failureTargets) {
            const batch = current.batches.find(batch => batch.id === failed.batchId)!
            const target = batch.targets.find(target => target.id === failed.targetId)!
            if (batch.cancellation !== "none") continue
            if (failed.replacement && target.launch) {
              target.launch.phase = "uncertain"
              target.reopen = "uncertain"
              current.claims.find(claim => claim.taskKey === target.binding.taskKey)!.phase = "uncertain"
              target.reasons = ["native-state-or-budget"]
              continue
            }
            target.state = target.rounds.some(round => round.phase === "reserved" || round.phase === "issued") ? "uncertain" : "blocked"
            target.reasons = ["native-state-or-budget"]
          }
        }, { busyTimeoutMs: 100 })
      } catch { diagnostic("native-refusal-state-unavailable") }
    }
    return {}
  }
}
