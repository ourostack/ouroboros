import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { vi } from "vitest"
import { createContinuityCoordinator } from "../../../senses/shepherd/continuity-coordinator"
import { parseContinuityConfig, continuityConfigFingerprint } from "../../../senses/shepherd/continuity-config"
import { reserveContinuityReceiptSlot, readContinuityReceipt, verifyContinuityCheckpoint } from "../../../senses/shepherd/continuity-evidence"
import { continuityStatePath, readContinuityState, transactContinuity } from "../../../senses/shepherd/continuity-store"
import type { ContinuityBinding, ContinuityReceipt } from "../../../senses/shepherd/continuity-types"
import type { HostSession, ShepherdHost } from "../../../senses/shepherd/host"
import type { ProcessProofDeps } from "../../../senses/shepherd/continuity-process"

export async function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "continuity-coordinator-")))
  const worktree = path.join(home, "code")
  fs.mkdirSync(worktree)
  const executable = path.join(home, "copilot")
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 })
  const config = parseContinuityConfig({ schemaVersion: 1,
    roots: [{ id: "desk", path: home, namespace: "track", receiptBase: ".receipts", launchRoots: [home], worktreeRoots: [worktree] }],
    profiles: [{ id: "worker", runner: "copilot", launcher: "direct", executable, argv: ["--allow-all"],
      rootIds: ["desk"], settingsPath: path.join(home, "hooks.json"), version: "1.0.97" }],
  })
  const file = continuityStatePath(home, "machine1")
  const actor = { pid: 10, birth: "darwin:100:10", uid: process.getuid!() }
  const binding: ContinuityBinding = {
    id: "binding1", agent: "ouro", host: "cmux", incarnation: "host1", surfaceId: "surface1", surfaceGeneration: "sg1",
    nativeSessionId: "native1", runner: "copilot", process: actor, wrapper: null, launchCwd: home, worktree,
    rootId: "desk", root: config.roots[0], taskRef: "track/task", taskKey: `${home}:track/task`,
    profileId: "worker", profileFingerprint: config.profiles[0].fingerprint,
    configFingerprint: continuityConfigFingerprint(config), enrollmentEpoch: "epoch1",
  }
  await transactContinuity(file, undefined, state => state.enrollments.push({
    id: "epoch1", agent: "ouro", runner: "copilot", nativeSessionId: "native1", process: actor, wrapper: null,
    profileId: "worker", profileFingerprint: config.profiles[0].fingerprint,
    configFingerprint: binding.configFingerprint, launchCwd: home, observedAt: "2026-10-15T04:00:00Z",
  }))
  let live = true
  let ownersComplete = true
  const processDeps: ProcessProofDeps = { platform: "darwin",
    inspect: async () => live ? { state: "present", generation: actor, parentPid: 1, processGroupId: 10,
      foregroundProcessGroupId: 10, ttyDevice: fs.statSync("/dev/null").rdev, executable, entryScript: null, cwd: home } : { state: "absent" },
    knownOwners: async () => ({ complete: ownersComplete, owners: [] }),
  }
  const sessions: HostSession[] = [{ id: "surface1", ref: "surface:1", workspace: "workspace:1", title: "fixture",
    agent: "Copilot", focused: false, tty: "/dev/null", cwd: home }]
  const bindings = [binding]
  const launches: unknown[] = []
  const host: ShepherdHost = { name: "cmux", list: async () => sessions, read: async () => "",
    prompt: async () => { throw new Error("continuity must not prompt") }, key: async () => { throw new Error("continuity must not press keys") },
    signal: async () => {}, watch: () => ({ close() {} }),
    launchContinuity: async request => { launches.push(request); return { workspaceId: "workspace-new", surfaceId: "surface-new" } },
  }
  const judge = vi.fn(async (_packet: unknown) => ({ ready: true, unfinished: true, reason: "Checkpoint and next action are consistent" }))
  const options = { agent: "ouro", storePath: file, host, config: async () => config, bindings: async () => bindings,
    processDeps, judge, ouroEntry: executable, authorize: async () => true }
  const coordinator = createContinuityCoordinator(options)
  const origin = (requestId: string) => ({ actorId: "operator", requestId })
  const prepare = (requestId = "prepare1") => coordinator.prepare({ requestId, selection: "all" }, origin(requestId))
  const finalEvidence = async (batchId: string, decisions = ["Preserve work"]) => {
    const state = readContinuityState(file)
    const target = state.batches.find(batch => batch.id === batchId)!.targets[0]
    const slot = reserveContinuityReceiptSlot(target.binding, batchId, 1, "followup", "followup1")
    const document = { goal: "Finish fixture", scope: "Fixture only", decisions, nextAction: "Run fixture test",
      knownJobs: [], uncertainMutations: [], references: ["task.md"] }
    const checkpointFile = path.join(home, "track/task/checkpoint.json")
    fs.mkdirSync(path.dirname(checkpointFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(checkpointFile, JSON.stringify(document), { mode: 0o600 })
    const receipt: ContinuityReceipt = { ...slot.correlation,
      checkpoint: { rootId: "desk", relativePath: "track/task/checkpoint.json", sha256: createHash("sha256").update(fs.readFileSync(checkpointFile)).digest("hex") },
      task: { ref: "track/task", rootId: "desk", launchCwd: home, worktree, branch: "fixture", head: "a".repeat(40), nextAction: document.nextAction },
      confirmation: true, knownJobs: [], uncertainMutations: [],
    }
    fs.mkdirSync(path.dirname(slot.path), { recursive: true, mode: 0o700 })
    fs.writeFileSync(slot.path, JSON.stringify(receipt), { mode: 0o600 })
    const projection = verifyContinuityCheckpoint(readContinuityReceipt(slot, slot.correlation), target.binding)
    await transactContinuity(file, state.revision, current => {
      const saved = current.batches.find(batch => batch.id === batchId)!.targets[0]
      saved.rounds = [{ batchId, kind: "followup", nonce: receipt.nonce, receiptSlot: slot.relativePath,
        phase: "acknowledged", attemptId: "followup1", expectedRevision: current.revision }]
      saved.receipt = receipt
      saved.projection = projection
      saved.state = "verifying"
      saved.assurance = { checkpoint: "verified", endReadiness: "agent-confirmed-as-of-native-boundary",
        backgroundCoverage: "unknown", jobInventory: "preserved-agent-reported", reopen: "unverified", observedAt: "now", qualifications: [] }
    })
  }
  return { home, worktree, file, config, binding, bindings, sessions, options, coordinator, origin, prepare, finalEvidence,
    launches, judge, end: () => { live = false }, incompleteOwners: () => { ownersComplete = false } }
}
