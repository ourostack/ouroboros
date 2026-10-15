import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { createContinuityCoordinator } from "../../../senses/shepherd/continuity-coordinator"
import { readContinuityState } from "../../../senses/shepherd/continuity-store"
import { fixture } from "./continuity-coordinator-fixture"

describe("fleet continuity coordinator", () => {
  it("freezes all coding sources, excludes shells/composers and keeps unsupported targets in the summary", async () => {
    const f = await fixture()
    f.sessions.push({ id: "unsupported1", ref: "surface:2", workspace: null, title: "unseen", agent: "Claude", focused: false },
      { id: "shell1", ref: "surface:3", workspace: null, title: "shell", agent: null, focused: false },
      { id: "composer1", ref: "surface:4", workspace: null, title: "ouro", agent: "ouro", focused: false })
    const before = readContinuityState(f.file).revision
    expect((await f.coordinator.preview()).targets.map(target => target.id)).toEqual(["surface1", "unsupported1"])
    expect(readContinuityState(f.file).revision).toBe(before)
    const result = await f.prepare()
    expect(result.summary.counts).toMatchObject({ selected: 2, pending: 1, unsupported: 1, ready: 0 })
    f.sessions.push({ id: "later", ref: "surface:5", workspace: null, title: "later", agent: "Codex", focused: false })
    expect((await f.prepare()).batchId).toBe(result.batchId)
    expect((await f.coordinator.status(result.batchId)).counts.selected).toBe(2)
    expect(readContinuityState(f.file).batches).toHaveLength(1)
    expect(f.launches).toHaveLength(0)
  })
  it("refuses unauthorized or broadened fixed-session mutations without persisting intent", async () => {
    const f = await fixture()
    const denied = createContinuityCoordinator({ ...f.options, authorize: async () => false })
    await expect(denied.prepare({ requestId: "denied", selection: "all" }, f.origin("denied"))).rejects.toThrow(/authority/)
    const fixed = createContinuityCoordinator({ ...f.options, scope: { host: "cmux", id: "surface1" } })
    await expect(fixed.prepare({ requestId: "other", selection: ["surface2"] }, f.origin("other"))).rejects.toThrow(/bound/)
    expect(readContinuityState(f.file).batches).toHaveLength(0)
    expect((await fixed.prepare({ requestId: "fixed", selection: "all" }, f.origin("fixed"))).summary.counts.selected).toBe(1)
  })
  it("keeps stale enrollment and changed root/profile generations unsupported", async () => {
    for (const drift of ["epoch", "profile", "root"] as const) {
      const f = await fixture()
      if (drift === "epoch") f.binding.enrollmentEpoch = "unobserved"
      else if (drift === "profile") f.binding.profileFingerprint = "d".repeat(64)
      else f.binding.root = { ...f.binding.root, identity: { dev: 1, ino: 2 } }
      const result = await f.prepare()
      expect(result.summary.counts).toMatchObject({ selected: 1, unsupported: 1, pending: 0 })
    }
  })
  it("refuses a same-generation source that execed into a different program after enrollment", async () => {
    const f = await fixture()
    const inspect = f.options.processDeps.inspect!
    f.options.processDeps.inspect = async pid => {
      const value = await inspect(pid)
      return value.state === "present" ? { ...value, executable: "/bin/sh", entryScript: null } : value
    }
    expect((await f.coordinator.preview()).targets[0].state).toBe("unsupported")
  })
  it("can prepare an end-only source without claiming it has a fresh launch profile", async () => {
    const f = await fixture()
    f.binding.profileId = null
    f.binding.profileFingerprint = null
    const prepared = await f.prepare()
    expect(prepared.summary.counts.pending).toBe(1)
    await f.finalEvidence(prepared.batchId)
    await f.coordinator.processPendingJudgments()
    const target = readContinuityState(f.file).batches[0].targets[0]
    expect(target.state).toBe("ready")
    expect(target.assurance.reopen).toBe("blocked")
    expect(f.launches).toHaveLength(0)
  })
  it("lets the same proven live owner prepare again after cancelling an unissued intent", async () => {
    const f = await fixture()
    const original = await f.prepare()
    await f.coordinator.cancel(original.batchId, f.origin("cancel1"))
    const next = await f.prepare("prepare2")
    expect(next.batchId).not.toBe(original.batchId)
    expect(next.summary.counts.pending).toBe(1)
    const state = readContinuityState(f.file)
    expect(state.claims).toHaveLength(1)
    expect(state.claims[0]).toMatchObject({ phase: "source", actor: f.binding.process, batchId: next.batchId })
  })
  it("judges verified evidence read-only with unknown coverage and never issues a fourth source wake", async () => {
    const f = await fixture()
    const result = await f.prepare()
    await f.finalEvidence(result.batchId)
    await f.coordinator.processPendingJudgments()
    const state = readContinuityState(f.file)
    expect(state.batches[0].targets[0]).toMatchObject({ state: "ready",
      assurance: { endReadiness: "agent-confirmed-as-of-native-boundary", backgroundCoverage: "unknown", reopen: "eligible" } })
    expect(state.batches[0].targets[0].rounds).toHaveLength(1)
    expect(f.judge.mock.calls[0][0]).toMatchObject({ projection: { nextAction: "Run fixture test" } })
    expect(f.launches).toHaveLength(0)
  })
  it("rejects changed checkpoint bytes before a model can promote readiness", async () => {
    const f = await fixture()
    const result = await f.prepare()
    await f.finalEvidence(result.batchId)
    fs.appendFileSync(path.join(f.home, "track/task/checkpoint.json"), " ")
    await f.coordinator.processPendingJudgments()
    expect((await f.coordinator.status(result.batchId)).counts.blocked).toBe(1)
    expect(f.judge).not.toHaveBeenCalled()
  })
  it("cannot overwrite a cancellation with a late asynchronous judgment", async () => {
    const f = await fixture()
    const result = await f.prepare()
    await f.finalEvidence(result.batchId)
    const late = createContinuityCoordinator({ ...f.options, judge: async () => {
      await f.coordinator.cancel(result.batchId, f.origin("cancel1"))
      return { ready: true, unfinished: true, reason: "late" }
    } })
    await late.processPendingJudgments()
    expect(readContinuityState(f.file).batches[0].cancellation).toBe("cancelled")
    expect((await f.coordinator.status(result.batchId)).counts.ready).toBe(0)
  })
  it.each(["screen", "focus", "checkpoint"] as const)("does not promote readiness after %s changes during judgment", async change => {
    const f = await fixture()
    const prepared = await f.prepare()
    await f.finalEvidence(prepared.batchId)
    let changed = false
    f.options.host.read = async () => changed && change === "screen" ? "new human input" : "source stopped"
    const coordinator = createContinuityCoordinator({ ...f.options, judge: async () => {
      changed = true
      if (change === "focus") f.sessions[0].focused = true
      if (change === "checkpoint") fs.appendFileSync(path.join(f.home, "track/task/checkpoint.json"), " ")
      return { ready: true, unfinished: true, reason: "stale affirmative judgment" }
    } })
    await coordinator.processPendingJudgments()
    expect((await coordinator.status(prepared.batchId)).counts.ready).toBe(0)
    expect((await coordinator.status(prepared.batchId)).counts.blocked).toBe(1)
  })
  it("reports a native-observed ended source without inventing complete native background coverage", async () => {
    const f = await fixture()
    const prepared = await f.prepare()
    await f.finalEvidence(prepared.batchId)
    f.end()
    await f.coordinator.processPendingJudgments()
    expect(readContinuityState(f.file).batches[0].targets[0].assurance).toMatchObject({
      endReadiness: "native-observed", backgroundCoverage: "unknown",
    })
  })
  it("reserves exactly one fresh launch only after the source and known owners ended", async () => {
    const f = await fixture()
    const prepared = await f.prepare()
    await f.finalEvidence(prepared.batchId)
    await f.coordinator.processPendingJudgments()
    const request = { requestId: "reopen1", batchId: prepared.batchId, selection: "all" as const }
    await f.coordinator.reopen(request, f.origin("reopen1"))
    expect(f.launches).toHaveLength(0)
    f.end()
    await f.coordinator.reopen(request, f.origin("reopen1"))
    await f.coordinator.reopen(request, f.origin("reopen1"))
    expect(f.launches).toHaveLength(1)
    expect(f.launches[0]).toMatchObject({ launchCwd: f.home, title: "desk / track/task" })
    const target = readContinuityState(f.file).batches[0].targets[0]
    expect(target).toMatchObject({ reopen: "launching", launch: { phase: "created", workspaceId: "workspace-new", surfaceId: "surface-new" } })
    expect((await f.coordinator.status(prepared.batchId)).counts.launched).toBe(0)
    expect(readContinuityState(f.file).claims[0]).toMatchObject({ phase: "created", actor: null })
  })
  it("retains unknown creates and cancellation claims rather than retrying or closing a workspace", async () => {
    const f = await fixture()
    const prepared = await f.prepare()
    await f.finalEvidence(prepared.batchId)
    await f.coordinator.processPendingJudgments()
    f.end()
    const uncertain = createContinuityCoordinator({ ...f.options, host: { ...f.options.host,
      launchContinuity: async request => { f.launches.push(request); throw new Error("lost create reply") },
    } })
    await uncertain.reopen({ requestId: "reopen1", batchId: prepared.batchId, selection: "all" }, f.origin("reopen1"))
    await uncertain.reopen({ requestId: "reopen2", batchId: prepared.batchId, selection: "all" }, f.origin("reopen2"))
    expect(f.launches).toHaveLength(1)
    expect((await uncertain.cancel(prepared.batchId, f.origin("cancel1"))).state).toBe("cancelling")
    expect(readContinuityState(f.file).claims[0].phase).toBe("uncertain")
    expect((await f.coordinator.status(prepared.batchId)).counts.uncertain).toBe(1)
  })
  it("keeps incomplete surviving-owner coverage blocked even after source disappearance", async () => {
    const f = await fixture()
    const prepared = await f.prepare()
    await f.finalEvidence(prepared.batchId)
    await f.coordinator.processPendingJudgments()
    f.end()
    f.incompleteOwners()
    await f.coordinator.reopen({ requestId: "reopen1", batchId: prepared.batchId, selection: "all" }, f.origin("reopen1"))
    expect(f.launches).toHaveLength(0)
    expect(readContinuityState(f.file).batches[0].targets[0].reasons).toContain("surviving-owners-unknown")
  })
})
