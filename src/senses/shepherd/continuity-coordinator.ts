import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { emitNervesEvent } from "../../nerves/runtime"
import { continuityConfigFingerprint } from "./continuity-config"
import { continuityEvidenceAssurance, readContinuityReceipt, reserveContinuityReceiptSlot, verifyContinuityCheckpoint } from "./continuity-evidence"
import { inspectContinuityProcess, matchesContinuityProcess, observeContinuityTermination, type ProcessProofDeps, type ProcessProofObservation } from "./continuity-process"
import { cancelContinuityBatch, createContinuityBatch, readContinuityState, transactContinuity } from "./continuity-store"
import { redactSecrets } from "./redact"
import type { HostSession, ShepherdHost } from "./host"
import type {
  ContinuityBatch, ContinuityBinding, ContinuityCheckpointProjection, ContinuityConfig, ContinuityEnrollment, ContinuityOrigin,
  ContinuityProfile, ContinuitySummary, ContinuityTarget,
} from "./continuity-types"

export interface ContinuityPreviewTarget {
  id: string
  label: string
  state: "eligible" | "unsupported"
  binding: ContinuityBinding | null
  reasons: string[]
}
export interface ContinuityPreview { agent: string; revision: number; targets: ContinuityPreviewTarget[] }
export interface ContinuityPrepareRequest { requestId: string; selection: "all" | string[] }
export interface ContinuityReopenRequest extends ContinuityPrepareRequest { batchId: string }
export interface ContinuityOperationReceipt {
  agent: string
  operation: "prepare" | "cancel" | "reopen"
  batchId: string
  state: "accepted" | "cancelled" | "cancelling"
  summary: ContinuitySummary
}
export interface ContinuityJudgmentPacket {
  projection: ContinuityCheckpointProjection
  endReadiness: ContinuityTarget["assurance"]["endReadiness"]
  backgroundCoverage: ContinuityTarget["assurance"]["backgroundCoverage"]
  source: "present" | "ended"
  focused: boolean | null
  screen: string | null
}
export interface ContinuityJudgment { ready: boolean; unfinished: boolean; reason: string }
export interface ContinuityCoordinatorOptions {
  agent: string
  storePath: string
  host: ShepherdHost
  config: () => Promise<ContinuityConfig>
  /** Task associations from the authorized request; local enrollment/process/TTY evidence still corroborates them. */
  bindings: () => Promise<ContinuityBinding[]>
  processDeps: ProcessProofDeps
  judge: (packet: ContinuityJudgmentPacket) => Promise<ContinuityJudgment>
  ouroEntry: string
  authorize: (origin: ContinuityOrigin, operation: "prepare" | "cancel" | "reopen") => Promise<boolean>
  scope?: { host: string; id: string }
}
export interface ContinuityCoordinator {
  preview(): Promise<ContinuityPreview>
  prepare(request: ContinuityPrepareRequest, origin: ContinuityOrigin): Promise<ContinuityOperationReceipt>
  status(batchId?: string): Promise<ContinuitySummary>
  cancel(batchId: string, origin: ContinuityOrigin): Promise<ContinuityOperationReceipt>
  reopen(request: ContinuityReopenRequest, origin: ContinuityOrigin): Promise<ContinuityOperationReceipt>
  processPendingJudgments(): Promise<void>
}
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const clean = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value) && redactSecrets(value) === value
function diagnostic(code: string): void {
  emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_continuity_coordinator_refused",
    message: "continuity coordinator refused progress", meta: { code } })
}
function refuse(code: string): never { diagnostic(code); throw new Error(`Shepherd continuity ${code}`) }
function select<T extends { id: string }>(targets: T[], selection: "all" | string[]): T[] {
  if (selection === "all") return targets
  if (!Array.isArray(selection) || !selection.length || selection.length > 256 ||
    selection.some(id => !clean(id)) || new Set(selection).size !== selection.length) refuse("selection")
  return selection.map(id => targets.find(target => target.id === id) ?? refuse("unknown target"))
}
function privateDirectory(directory: string): void {
  const stat = fs.lstatSync(directory)
  if (!path.isAbsolute(directory) || fs.realpathSync(directory) !== directory || !stat.isDirectory() ||
    stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || (stat.uid !== process.getuid!() && stat.uid !== 0)) refuse("directory drift")
}
export function continuityBindingProfile(
  binding: ContinuityBinding, config: ContinuityConfig, enrollment?: ContinuityEnrollment,
): ContinuityProfile {
  if (binding.configFingerprint !== continuityConfigFingerprint(config)) refuse("configuration drift")
  const root = config.roots.find(root => root.id === binding.rootId)
  if (!root || !isDeepStrictEqual(root, binding.root)) refuse("root drift")
  const observed = fs.lstatSync(root.path)
  if (observed.dev !== root.identity.dev || observed.ino !== root.identity.ino) refuse("root drift")
  privateDirectory(root.path)
  privateDirectory(binding.launchCwd)
  privateDirectory(binding.worktree)
  const profile = config.profiles.find(profile => profile.id === (binding.profileId ?? enrollment?.profileId))
  if (!profile || profile.fingerprint !== (binding.profileFingerprint ?? enrollment?.profileFingerprint) || profile.runner !== binding.runner ||
    !profile.rootIds.includes(root.id)) refuse("profile drift")
  const executable = fs.lstatSync(profile.executable)
  if (!executable.isFile() || executable.isSymbolicLink() || executable.dev !== profile.executableIdentity.dev ||
    executable.ino !== profile.executableIdentity.ino || (executable.mode & 0o111) === 0 ||
    (executable.mode & 0o022) !== 0 || (executable.uid !== process.getuid!() && executable.uid !== 0)) refuse("executable drift")
  if (binding.taskKey !== `${root.path}:${binding.taskRef}`) refuse("canonical task scope")
  reserveContinuityReceiptSlot(binding, "policy-check", 1, "preparation", "policy-check")
  return profile
}
function matchesProfile(profile: ContinuityProfile, observed: Extract<ProcessProofObservation, { state: "present" }>, deps: ProcessProofDeps): boolean {
  return profile.launcher === "direct" ? matchesContinuityProcess(observed, profile.executable) :
    deps.nativeEntries?.some(entry => entry.runner === profile.runner && entry.version === profile.version &&
      matchesContinuityProcess(observed, entry.executable, entry.entryScript)) === true
}
export function readFinalContinuityEvidence(target: ContinuityTarget, batchId: string): ContinuityCheckpointProjection {
  const final = target.rounds.at(-1)
  if (!final || !["followup", "correction"].includes(final.kind) ||
    target.rounds.some(round => round.phase !== "acknowledged") || !target.receipt || !target.projection ||
    target.unresolvedInventory.knownJobs.length || target.unresolvedInventory.uncertainMutations.length) refuse("final evidence unresolved")
  const slot = reserveContinuityReceiptSlot(target.binding, batchId, target.generation, final.kind, final.attemptId)
  slot.correlation.nonce = final.nonce
  if (slot.relativePath !== final.receiptSlot) refuse("final slot changed")
  const verified = readContinuityReceipt(slot, slot.correlation)
  const projection = verifyContinuityCheckpoint(verified, target.binding)
  if (!isDeepStrictEqual(verified.receipt, target.receipt) || !isDeepStrictEqual(projection, target.projection) ||
    continuityEvidenceAssurance(verified.receipt, projection, { round: final.kind, observedAt: "now" }).endReadiness === "unconfirmed") {
    refuse("final evidence changed")
  }
  return projection
}
export function summarizeContinuity(agent: string, revision: number, batches: ContinuityBatch[]): ContinuitySummary {
  const counts = { selected: 0, ready: 0, blocked: 0, unsupported: 0, uncertain: 0, cancelled: 0, pending: 0, launched: 0, backgroundUnknown: 0 }
  for (const batch of batches) {
    for (const target of batch.unboundTargets) {
      counts.selected++
      counts.backgroundUnknown++
      counts[batch.cancellation === "cancelled" ? "cancelled" : target.state]++
    }
    for (const target of batch.targets) {
      counts.selected++
      if (target.assurance.backgroundCoverage === "unknown") counts.backgroundUnknown++
      if (target.launch?.phase === "working") counts.launched++
      const kind = batch.cancellation === "cancelled" || target.state === "cancelled" ? "cancelled" :
        target.state === "uncertain" || target.reopen === "uncertain" ? "uncertain" :
        target.state === "unsupported" || target.reopen === "unsupported" ? "unsupported" :
        target.state === "blocked" || target.reopen === "blocked" ? "blocked" :
        target.state === "ready" && target.reopen !== "launching" ? "ready" : "pending"
      counts[kind]++
    }
  }
  return { agent, revision, batches, counts }
}
export function createContinuityCoordinator(options: ContinuityCoordinatorOptions): ContinuityCoordinator {
  const status = async (batchId?: string): Promise<ContinuitySummary> => {
    const snapshot = readContinuityState(options.storePath)
    let batches = snapshot.batches.filter(batch => batch.agent === options.agent && (batchId === undefined || batch.id === batchId))
    if (options.scope) {
      batches = batches.map(batch => ({ ...batch,
        targets: batch.targets.filter(target => target.binding.host === options.scope!.host && target.binding.surfaceId === options.scope!.id),
        unboundTargets: batch.unboundTargets.filter(target => target.host === options.scope!.host && target.surfaceId === options.scope!.id),
      })).filter(batch => batch.targets.length + batch.unboundTargets.length > 0)
    }
    if (batchId !== undefined && !batches.length) refuse("batch authority")
    return summarizeContinuity(options.agent, snapshot.revision, batches)
  }
  const authority = async (origin: ContinuityOrigin, operation: "prepare" | "cancel" | "reopen", requestId?: string) => {
    if (!clean(origin.actorId) || !clean(origin.requestId) || requestId !== undefined && origin.requestId !== requestId ||
      !await options.authorize(origin, operation)) refuse("operator authority")
  }
  const assertScope = (surfaces: string[]) => {
    if (options.scope && (options.scope.host !== options.host.name || surfaces.some(id => id !== options.scope!.id))) refuse("bound composer scope")
  }
  const preview = async (): Promise<ContinuityPreview> => {
    const snapshot = readContinuityState(options.storePath)
    const [config, bindings, sessions] = await Promise.all([options.config(), options.bindings(), options.host.list()])
    const selected = sessions.filter(session => session.agent !== null && !/^ouro(?:boros)?$/i.test(session.agent) &&
      (!options.scope || session.id === options.scope.id))
    if (selected.length > 256 || new Set(selected.map(session => session.id)).size !== selected.length) refuse("discovery capacity")
    const targets = await Promise.all(selected.map(async (session: HostSession): Promise<ContinuityPreviewTarget> => {
      const candidates = bindings.filter(binding => binding.surfaceId === session.id)
      const label = redactSecrets(`${session.workspaceTitle ?? session.title} / ${session.ref}`).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 4096)
      const unsupported = (reason: string): ContinuityPreviewTarget => ({ id: session.id, label, state: "unsupported", binding: null, reasons: [reason] })
      if (candidates.length !== 1) return unsupported("unbound-or-ambiguous-source")
      const binding = structuredClone(candidates[0])
      try {
        const enrollment = snapshot.enrollments.find(enrollment => enrollment.id === binding.enrollmentEpoch)
        const profile = continuityBindingProfile(binding, config, enrollment)
        if (binding.agent !== options.agent || binding.host !== options.host.name || session.cwd !== binding.launchCwd) refuse("host binding")
        if (!enrollment || enrollment.agent !== options.agent || enrollment.runner !== binding.runner ||
          enrollment.nativeSessionId !== binding.nativeSessionId || !isDeepStrictEqual(enrollment.process, binding.process) ||
          !isDeepStrictEqual(enrollment.wrapper, binding.wrapper) || enrollment.launchCwd !== binding.launchCwd ||
          enrollment.profileFingerprint !== profile.fingerprint || enrollment.configFingerprint !== binding.configFingerprint) refuse("enrollment unobserved")
        const observed = await inspectContinuityProcess(binding.process.pid, options.processDeps)
        const tty = session.tty ? path.isAbsolute(session.tty) ? session.tty : path.join("/dev", session.tty) : null
        if (observed.state !== "present" || !isDeepStrictEqual(observed.generation, binding.process) ||
          observed.cwd !== null && observed.cwd !== binding.launchCwd || !tty || !tty.startsWith("/dev/") ||
          observed.ttyDevice !== fs.statSync(tty).rdev || observed.foregroundProcessGroupId !== observed.processGroupId) refuse("source observation")
        if (!matchesProfile(profile, observed, options.processDeps)) refuse("source executable changed")
        return { id: session.id, label, state: "eligible", binding, reasons: [] }
      } catch { diagnostic("discovery-unsupported"); return unsupported("binding-or-policy-unverified") }
    }))
    return { agent: options.agent, revision: snapshot.revision, targets }
  }
  const sourceObservation = async (target: ContinuityTarget, profile: ContinuityProfile) => {
    const observed = await inspectContinuityProcess(target.binding.process.pid, options.processDeps)
    if (observed.state === "unknown") refuse("source observation unknown")
    const session = (await options.host.list()).find(session => session.id === target.binding.surfaceId)
    const ended = observed.state === "absent" || !isDeepStrictEqual(observed.generation, target.binding.process)
    const termination = ended ? await observeContinuityTermination(target.binding, options.processDeps) : null
    let screen: string | null = null
    let viewportSha256: string | null = null
    if (!ended) {
      if (!session || !matchesProfile(profile, observed, options.processDeps) ||
        session.cwd !== target.binding.launchCwd || observed.cwd !== null && observed.cwd !== target.binding.launchCwd) refuse("source host changed")
      const raw = await options.host.read(session.id, 40)
      if (Buffer.byteLength(raw) > 16384) refuse("source viewport byte limit")
      viewportSha256 = createHash("sha256").update(raw).digest("hex")
      screen = redactSecrets(raw).replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
      if (Buffer.byteLength(screen) > 16384) refuse("redacted viewport byte limit")
    }
    return { source: ended ? "ended" as const : "present" as const, focused: session?.focused ?? null,
      workspace: session?.workspace ?? null, cwd: session?.cwd ?? null, screen, viewportSha256, termination }
  }
  return {
    preview, status,
    async prepare(request, origin) {
      await authority(origin, "prepare", request.requestId)
      if (request.selection !== "all") assertScope(request.selection)
      const bodyHash = hash(request)
      const snapshot = readContinuityState(options.storePath)
      const existing = snapshot.batches.find(batch => batch.agent === options.agent && batch.requestId === request.requestId)
      if (existing) {
        if (existing.bodyHash !== bodyHash || existing.origin.actorId !== origin.actorId) refuse("request body changed")
        assertScope([...existing.targets.map(target => target.binding.surfaceId), ...existing.unboundTargets.map(target => target.surfaceId)])
        return { agent: options.agent, operation: "prepare", batchId: existing.id, state: "accepted", summary: await status(existing.id) }
      }
      const view = await preview()
      const selected = select(view.targets, request.selection)
      if (!selected.length) refuse("empty selection")
      assertScope(selected.map(target => target.id))
      const batch: ContinuityBatch = { id: randomUUID(), agent: options.agent, requestId: request.requestId, bodyHash,
        origin: structuredClone(origin), createdAt: new Date().toISOString(), cancellation: "none", targets: [], unboundTargets: [] }
      for (const entry of selected) {
        if (!entry.binding) {
          batch.unboundTargets.push({ id: randomUUID(), host: options.host.name, surfaceId: entry.id,
            label: entry.label, state: "unsupported", reasons: entry.reasons })
        } else batch.targets.push({ id: randomUUID(), binding: entry.binding, generation: 1, unfinished: null,
          state: "pending-boundary", reopen: "not-requested", rounds: [], reasons: [],
          assurance: { checkpoint: "unverified", endReadiness: "unconfirmed", backgroundCoverage: "unknown",
            jobInventory: "unverified", reopen: "unverified", observedAt: null, qualifications: [] },
          receipt: null, projection: null, unresolvedInventory: { knownJobs: [], uncertainMutations: [] }, observedTransitions: [], launch: null })
      }
      await transactContinuity(options.storePath, view.revision, state => {
        // A cancelled unissued intent can move only the same proven live actor's existing ownership.
        state.claims = state.claims.filter(claim => {
          const next = batch.targets.find(target => target.binding.taskKey === claim.taskKey)
          const previous = state.batches.find(batch => batch.id === claim.batchId)
          const old = previous?.targets.find(target => target.id === claim.targetId)
          return !(next && previous?.cancellation === "cancelled" && old?.launch === null && claim.phase === "source" &&
            claim.agent === options.agent && isDeepStrictEqual(claim.actor, next.binding.process) &&
            old.binding.nativeSessionId === next.binding.nativeSessionId && isDeepStrictEqual(old.binding.wrapper, next.binding.wrapper))
        })
        createContinuityBatch(state, batch)
      })
      return { agent: options.agent, operation: "prepare", batchId: batch.id, state: "accepted", summary: await status(batch.id) }
    },
    async cancel(batchId, origin) {
      await authority(origin, "cancel")
      const snapshot = readContinuityState(options.storePath)
      const batch = snapshot.batches.find(batch => batch.id === batchId && batch.agent === options.agent)
      if (!batch || batch.origin.actorId !== origin.actorId) refuse("batch authority")
      assertScope([...batch.targets.map(target => target.binding.surfaceId), ...batch.unboundTargets.map(target => target.surfaceId)])
      const cancelled = await transactContinuity(options.storePath, snapshot.revision, state => cancelContinuityBatch(state, batchId, options.agent))
      return { agent: options.agent, operation: "cancel", batchId, state: cancelled.result, summary: await status(batchId) }
    },
    async processPendingJudgments() {
      const initial = readContinuityState(options.storePath)
      for (const batch of initial.batches.filter(batch => batch.agent === options.agent && batch.cancellation === "none")) {
        for (const selected of batch.targets.filter(target => target.state === "verifying" &&
          (!options.scope || target.binding.host === options.scope.host && target.binding.surfaceId === options.scope.id))) {
          const snapshot = readContinuityState(options.storePath)
          const target = snapshot.batches.find(value => value.id === batch.id)!.targets.find(value => value.id === selected.id)!
          if (target.state !== "verifying") continue
          let verdict: ContinuityJudgment | null = null
          let reason = "readiness-evidence-unverified"
          let nativeEnded = false
          try {
            const enrollment = snapshot.enrollments.find(enrollment => enrollment.id === target.binding.enrollmentEpoch)
            const profile = continuityBindingProfile(target.binding, await options.config(), enrollment)
            const projection = readFinalContinuityEvidence(target, batch.id)
            const observation = await sourceObservation(target, profile)
            verdict = await options.judge({ projection, endReadiness: target.assurance.endReadiness,
              backgroundCoverage: target.assurance.backgroundCoverage, source: observation.source, focused: observation.focused, screen: observation.screen })
            if (typeof verdict?.ready !== "boolean" || typeof verdict.unfinished !== "boolean" || !clean(verdict.reason)) refuse("readiness verdict")
            continuityBindingProfile(target.binding, await options.config(), enrollment)
            readFinalContinuityEvidence(target, batch.id)
            const after = await sourceObservation(target, profile)
            if (!isDeepStrictEqual(observation, after)) refuse("readiness observation changed")
            nativeEnded = after.termination?.eligible === true
            reason = verdict.ready ? "" : "readiness-judgment-unconfirmed"
          } catch { diagnostic("readiness-evidence-or-judge"); verdict = null }
          const latest = readContinuityState(options.storePath)
          if (latest.revision !== snapshot.revision) { diagnostic("stale-readiness-judgment"); continue }
          await transactContinuity(options.storePath, snapshot.revision, state => {
            const current = state.batches.find(value => value.id === batch.id)!.targets.find(value => value.id === target.id)!
            current.state = verdict?.ready ? "ready" : "blocked"
            current.unfinished = verdict?.ready ? verdict.unfinished : null
            current.reasons = reason ? [reason] : []
            current.assurance.reopen = verdict?.ready && verdict.unfinished &&
              current.binding.profileId !== null && current.binding.profileFingerprint !== null ? "eligible" : "blocked"
            if (verdict?.ready && nativeEnded) {
              current.assurance.endReadiness = "native-observed"
              current.assurance.observedAt = new Date().toISOString()
              current.assurance.qualifications.push("Exact source and known owners are observed ended; native background coverage remains unknown.")
            }
          })
        }
      }
    },
    async reopen(request, origin) {
      await authority(origin, "reopen", request.requestId)
      const initial = readContinuityState(options.storePath)
      const batch = initial.batches.find(batch => batch.id === request.batchId && batch.agent === options.agent)
      if (!batch || batch.origin.actorId !== origin.actorId) refuse("batch authority")
      const selected = select([...batch.targets.map(target => ({ id: target.id, surfaceId: target.binding.surfaceId })),
        ...batch.unboundTargets.map(target => ({ id: target.id, surfaceId: target.surfaceId }))], request.selection)
      assertScope(selected.map(target => target.surfaceId))
      const bodyHash = hash(request)
      const duplicate = initial.batches.flatMap(batch => batch.targets).find(target => target.launch?.requestId === request.requestId)
      if (duplicate?.launch && (duplicate.launch.bodyHash !== bodyHash || duplicate.launch.originActorId !== origin.actorId)) refuse("reopen request body changed")
      if (batch.cancellation !== "none") refuse("batch cancelled")
      for (const selection of selected) {
        const snapshot = readContinuityState(options.storePath)
        const target = snapshot.batches.find(value => value.id === batch.id)!.targets.find(value => value.id === selection.id)
        if (!target || target.launch !== null) continue
        let reason = ""
        let eligible = false
        try {
          if (target.state !== "ready" || target.unfinished !== true || target.assurance.reopen !== "eligible") refuse("target not reopenable")
          continuityBindingProfile(target.binding, await options.config())
          readFinalContinuityEvidence(target, batch.id)
          const proof = await observeContinuityTermination(target.binding, options.processDeps)
          reason = proof.reasons[0] ?? ""
          eligible = proof.eligible
          if (eligible && !options.host.launchContinuity) { eligible = false; reason = "host-launch-unsupported" }
          if (eligible) {
            const entry = fs.lstatSync(options.ouroEntry)
            if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o111) === 0 || (entry.mode & 0o022) !== 0) refuse("bootstrap entry trust")
          }
        } catch { diagnostic("reopen-preconditions"); eligible = false; reason = "reopen-preconditions-unverified" }
        const reservation = await transactContinuity(options.storePath, snapshot.revision, state => {
          const currentBatch = state.batches.find(value => value.id === batch.id)!
          const current = currentBatch.targets.find(value => value.id === target.id)!
          if (currentBatch.cancellation !== "none" || current.launch !== null) refuse("reopen reservation changed")
          if (!eligible) {
            current.reopen = reason === "host-launch-unsupported" ? "unsupported" : "blocked"
            current.reasons = [reason]
            return null
          }
          const claim = state.claims.find(claim => claim.taskKey === current.binding.taskKey)
          if (!claim || claim.phase !== "source" || claim.bindingId !== current.binding.id ||
            claim.batchId !== batch.id || claim.targetId !== target.id || claim.agent !== options.agent) refuse("canonical owner changed")
          const attemptId = randomUUID()
          const slot = reserveContinuityReceiptSlot(current.binding, batch.id, current.generation + 1, "bootstrap", attemptId)
          current.launch = { requestId: request.requestId, bodyHash, originActorId: origin.actorId, attemptId,
            bootstrapNonce: slot.correlation.nonce, bootstrapSlot: slot.relativePath, phase: "reserved", nativeSessionId: randomUUID(),
            wrapper: null, bootstrapProcess: null, actor: null, workspaceId: null, surfaceId: null,
            executeNonce: null, executeSlot: null, bootstrapReceipt: null, executeReceipt: null, milestones: ["launch-reserved"] }
          current.reopen = "launching"
          current.reasons = []
          claim.phase = "launch-reserved"
          claim.actor = null
          claim.attemptId = attemptId
          return { attemptId, title: `${current.binding.rootId} / ${current.binding.taskRef}`, launchCwd: current.binding.launchCwd,
            ouroEntry: options.ouroEntry, agent: options.agent, batchId: batch.id, targetId: current.id }
        })
        if (!reservation.result) continue
        let created: { workspaceId: string; surfaceId: string } | null = null
        try { created = await options.host.launchContinuity!(reservation.result) } catch { diagnostic("launch-create-uncertain") }
        const observed = readContinuityState(options.storePath)
        await transactContinuity(options.storePath, observed.revision, state => {
          const current = state.batches.find(value => value.id === batch.id)!.targets.find(value => value.id === target.id)!
          const launch = current.launch!
          if (launch.attemptId !== reservation.result!.attemptId) refuse("launch attempt changed")
          const claim = state.claims.find(claim => claim.taskKey === current.binding.taskKey)!
          if (!created) { launch.phase = "uncertain"; current.reopen = "uncertain"; claim.phase = "uncertain" }
          else {
            launch.workspaceId = created.workspaceId
            launch.surfaceId = created.surfaceId
            if (launch.phase === "reserved") launch.phase = "created"
            if (claim.phase === "launch-reserved") claim.phase = "created"
            launch.milestones.push("workspace-readback")
            if (!state.holds.some(hold => hold.agent === options.agent && hold.host === current.binding.host && hold.surface === created.surfaceId)) {
              state.holds.push({ agent: options.agent, host: current.binding.host, surface: created.surfaceId, batchId: batch.id, targetId: current.id })
            }
          }
        })
      }
      return { agent: options.agent, operation: "reopen", batchId: batch.id, state: "accepted", summary: await status(batch.id) }
    },
  }
}
