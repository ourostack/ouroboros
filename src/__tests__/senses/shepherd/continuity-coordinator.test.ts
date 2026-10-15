import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { continuityBindingProfile, createContinuityCoordinator, readFinalContinuityEvidence, summarizeContinuity } from "../../../senses/shepherd/continuity-coordinator"
import { createContinuityBatch, readContinuityState, transactContinuity } from "../../../senses/shepherd/continuity-store"
import { continuityConfigFingerprint } from "../../../senses/shepherd/continuity-config"
import { fixture } from "./continuity-coordinator-fixture"

describe("fleet continuity coordinator", () => {
  afterEach(() => vi.restoreAllMocks())
  it("does not reserve a later target after cancellation during an earlier host create", async () => {
    const f = await fixture()
    const second = structuredClone(f.binding)
    Object.assign(second, { id: "binding2", surfaceId: "surface2", nativeSessionId: "native2", enrollmentEpoch: "epoch2",
      taskRef: "track/task2", taskKey: `${f.home}:track/task2`, process: { ...f.binding.process, pid: 11, birth: "darwin:100:11" } })
    f.bindings.push(second)
    f.sessions.push({ ...f.sessions[0], id: "surface2" })
    await transactContinuity(f.file, undefined, state => {
      state.enrollments.push({ ...state.enrollments[0], id: "epoch2", nativeSessionId: "native2", process: second.process })
    })
    const inspect = f.options.processDeps.inspect!
    f.options.processDeps.inspect = async pid => {
      const observed = await inspect(pid)
      return observed.state === "present" && pid === 11 ? { ...observed, generation: second.process } : observed
    }
    const prepared = await f.prepare()
    expect(prepared.summary.counts.pending).toBe(2)
    await f.finalEvidence(prepared.batchId)
    await f.finalEvidence(prepared.batchId, undefined, 1)
    await f.coordinator.processPendingJudgments()
    f.end()
    let creates = 0
    const coordinator = createContinuityCoordinator({ ...f.options, host: { ...f.options.host, launchContinuity: async () => {
      creates++
      await f.coordinator.cancel(prepared.batchId, f.origin("cancel1"))
      return { workspaceId: "workspace-new", surfaceId: "surface-new" }
    } } })
    await expect(coordinator.reopen({ requestId: "reopen1", batchId: prepared.batchId, selection: "all" }, f.origin("reopen1"))).rejects.toThrow(/reservation changed/)
    expect(creates).toBe(1)
    const state = readContinuityState(f.file)
    expect(state.batches[0].targets[1].launch).toBeNull()
    expect(state.claims).toHaveLength(2)
  })
  it.each(["host", "surface", "changed-state"] as const)("does not judge another %s target from a stale fleet selection", async problem => {
    const f = await fixture()
    const prepared = await f.prepare()
    await f.finalEvidence(prepared.batchId)
    await transactContinuity(f.file, undefined, state => {
      const batch = structuredClone(state.batches[0])
      batch.id = "second-batch"
      batch.requestId = batch.origin.requestId = "second-request"
      const target = batch.targets[0]
      target.id = "second-target"
      target.binding.id = "second-binding"
      target.binding.taskRef = "track/task2"
      target.binding.taskKey = `${f.home}:track/task2`
      if (problem === "host") target.binding.host = "herdr"
      else target.binding.surfaceId = "surface2"
      createContinuityBatch(state, batch)
    })
    let judged = 0
    const coordinator = createContinuityCoordinator({ ...f.options,
      ...(problem === "changed-state" ? {} : { scope: { host: "cmux", id: "surface1" } }),
      judge: async () => {
        judged++
        if (problem === "changed-state") await transactContinuity(f.file, undefined, state => {
          state.batches[1].targets[0].state = "blocked"
        })
        return { ready: true, unfinished: true, reason: "Valid fixture" }
      },
    })
    await coordinator.processPendingJudgments()
    expect(judged).toBe(1)
    expect(readContinuityState(f.file).batches[1].targets[0].state).toBe(problem === "changed-state" ? "blocked" : "verifying")
  })
  it("rejects an untrusted bootstrap executable without a create attempt", async () => {
    const f = await fixture()
    const prepared = await f.prepare()
    await f.finalEvidence(prepared.batchId)
    await f.coordinator.processPendingJudgments()
    f.end()
    const coordinator = createContinuityCoordinator({ ...f.options, ouroEntry: f.worktree })
    await coordinator.reopen({ requestId: "reopen1", batchId: prepared.batchId, selection: "all" }, f.origin("reopen1"))
    expect(f.launches).toHaveLength(0)
    expect(readContinuityState(f.file).batches[0].targets[0].reopen).toBe("blocked")
  })
  it("does not replace an uncertain canonical claim even when the source is ready and ended", async () => {
    const f = await fixture()
    const prepared = await f.prepare()
    await f.finalEvidence(prepared.batchId)
    await f.coordinator.processPendingJudgments()
    f.end()
    await transactContinuity(f.file, undefined, state => { state.claims[0].phase = "uncertain" })
    await expect(f.coordinator.reopen({ requestId: "reopen1", batchId: prepared.batchId, selection: "all" }, f.origin("reopen1"))).rejects.toThrow(/canonical owner/)
    expect(f.launches).toHaveLength(0)
    expect(readContinuityState(f.file).claims[0].phase).toBe("uncertain")
  })
  it.each(["attempt-changed", "wrapper-blocked"] as const)("preserves ownership after %s during host creation", async problem => {
    const f = await fixture()
    const prepared = await f.prepare()
    await f.finalEvidence(prepared.batchId)
    await f.coordinator.processPendingJudgments()
    f.end()
    let creates = 0
    const coordinator = createContinuityCoordinator({ ...f.options, host: { ...f.options.host, launchContinuity: async () => {
      creates++
      await transactContinuity(f.file, undefined, state => {
        const launch = state.batches[0].targets[0].launch!
        if (problem === "attempt-changed") launch.attemptId = "different-attempt"
        else {
          launch.phase = "blocked"
          state.batches[0].targets[0].reopen = "blocked"
          launch.surfaceId = "surface-new"
          state.claims[0].phase = "uncertain"
          state.holds.push({ agent: "ouro", host: "cmux", surface: "surface-new", batchId: prepared.batchId, targetId: state.batches[0].targets[0].id })
        }
      })
      return { workspaceId: "workspace-new", surfaceId: "surface-new" }
    } } })
    const result = coordinator.reopen({ requestId: "reopen1", batchId: prepared.batchId, selection: "all" }, f.origin("reopen1"))
    if (problem === "attempt-changed") await expect(result).rejects.toThrow(/launch attempt changed/)
    else {
      await result
      const state = readContinuityState(f.file)
      expect(state.batches[0].targets[0]).toMatchObject({ reopen: "blocked", launch: { phase: "blocked" } })
      expect(state.holds.filter(hold => hold.surface === "surface-new")).toHaveLength(1)
    }
    expect(creates).toBe(1)
  })
  it.each(["final-round", "pending-round", "missing-receipt", "missing-projection", "job", "mutation", "slot", "receipt", "projection"] as const)(
    "rejects independently changed %s final handoff facts", async change => {
      const f = await fixture()
      const prepared = await f.prepare()
      await f.finalEvidence(prepared.batchId)
      const target = readContinuityState(f.file).batches[0].targets[0]
      if (change === "final-round") target.rounds[0].kind = "preparation"
      if (change === "pending-round") target.rounds[0].phase = "issued"
      if (change === "missing-receipt") target.receipt = null
      if (change === "missing-projection") target.projection = null
      if (change === "job") target.unresolvedInventory.knownJobs.push({ id: "j", kind: "test", owner: "fixture", status: "active",
        effects: "owned test", disposition: "unresolved", reference: "job.md" })
      if (change === "mutation") target.unresolvedInventory.uncertainMutations.push({ id: "m", operation: "owned test", disposition: "unresolved", evidence: "unknown" })
      if (change === "slot") target.rounds[0].receiptSlot = ".receipts/other.json"
      if (change === "receipt") target.receipt!.task.nextAction = "Changed"
      if (change === "projection") target.projection!.nextAction = "Changed"
      expect(() => readFinalContinuityEvidence(target, prepared.batchId)).toThrow()
    })
  it.each(["root-inode", "directory-owner", "executable-owner"] as const)("refuses %s policy drift before a native launch", async change => {
    const f = await fixture()
    const config = structuredClone(f.config)
    const binding = structuredClone(f.binding)
    if (change === "root-inode") {
      config.roots[0].identity.ino++
      binding.root = config.roots[0]
      binding.configFingerprint = continuityConfigFingerprint(config)
    } else {
      const lstat = fs.lstatSync
      vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
        const observed = lstat(...args)
        if (String(args[0]) === (change === "directory-owner" ? f.worktree : config.profiles[0].executable)) {
          observed.uid = process.getuid!() + 1
        }
        return observed
      })
    }
    expect(() => continuityBindingProfile(binding, config)).toThrow(/drift/)
  })
  it("keeps native-known background coverage distinct from unknown coverage in counts", async () => {
    const f = await fixture()
    await f.prepare()
    const state = readContinuityState(f.file)
    state.batches[0].targets[0].assurance.backgroundCoverage = "native-managed-snapshot"
    expect(summarizeContinuity("ouro", state.revision, state.batches).counts.backgroundUnknown).toBe(0)
  })
  it("filters unsupported source accounting to the fixed composer surface", async () => {
    const f = await fixture()
    f.sessions.push({ ...f.sessions[0], id: "unbound1" }, { ...f.sessions[0], id: "unbound2" })
    const prepared = await f.prepare()
    const fixed = createContinuityCoordinator({ ...f.options, scope: { host: "cmux", id: "unbound1" } })
    expect((await fixed.status(prepared.batchId)).counts).toMatchObject({ selected: 1, unsupported: 1 })
    expect((await fixed.status(prepared.batchId)).batches[0].unboundTargets[0].surfaceId).toBe("unbound1")
  })
  it("matches a source through the registered Agency native entry rather than the Agency launcher executable", async () => {
    const f = await fixture()
    f.config.profiles[0].launcher = "agency"
    f.config.profiles[0].argv = ["copilot", "--allow-all"]
    f.binding.configFingerprint = continuityConfigFingerprint(f.config)
    await transactContinuity(f.file, undefined, state => { state.enrollments[0].configFingerprint = f.binding.configFingerprint })
    expect((await f.coordinator.preview()).targets[0].state).toBe("unsupported")
    f.options.processDeps.nativeEntries = [{ runner: "claude", version: "2.1.299", executable: "/untracked", entryScript: null },
      { runner: "copilot", version: "wrong", executable: "/untracked", entryScript: null },
      { runner: "copilot", version: "1.0.97", executable: f.config.profiles[0].executable, entryScript: null }]
    f.sessions[0].tty = "null"
    expect((await f.coordinator.preview()).targets[0].state).toBe("eligible")
    const prepared = await f.prepare()
    await f.finalEvidence(prepared.batchId)
    f.end()
    f.sessions.splice(0)
    await f.coordinator.processPendingJudgments()
    expect((await f.coordinator.status()).counts.ready).toBe(1)
  })
  it.each([[], ["surface1", "surface1"], ["missing"], [""], ["bad\n"], ["token=x"], ["x".repeat(4097)], Array.from({ length: 257 }, (_, n) => `surface${n}`)].map(selection => ({ selection })))(
    "rejects invalid or unavailable explicit selections %# without reserving ownership", async ({ selection }) => {
      const f = await fixture()
      await expect(f.coordinator.prepare({ requestId: "invalid", selection }, f.origin("invalid"))).rejects.toThrow()
      expect(readContinuityState(f.file).batches).toHaveLength(0)
      expect(f.launches).toHaveLength(0)
    })
  it.each(["", "bad\n", "token=x", "x".repeat(4097)])("rejects invalid operator identity %s before persistence", async actorId => {
    const f = await fixture()
    await expect(f.coordinator.prepare({ requestId: "invalid", selection: "all" }, { actorId, requestId: "invalid" })).rejects.toThrow(/authority/)
    expect(readContinuityState(f.file).batches).toHaveLength(0)
  })
  it("rejects request replay with a different selector or actor and rejects another agent's batch", async () => {
    const f = await fixture()
    const prepared = await f.prepare()
    await expect(f.coordinator.prepare({ requestId: "prepare1", selection: ["surface1"] }, f.origin("prepare1"))).rejects.toThrow(/body/)
    await expect(f.coordinator.prepare({ requestId: "prepare1", selection: "all" }, { ...f.origin("prepare1"), actorId: "other" })).rejects.toThrow(/body/)
    await expect(f.coordinator.prepare({ requestId: "wrong-origin", selection: "all" }, f.origin("different"))).rejects.toThrow(/authority/)
    await expect(f.coordinator.status("missing")).rejects.toThrow(/authority/)
    await expect(f.coordinator.cancel("missing", f.origin("cancel1"))).rejects.toThrow(/authority/)
    await expect(f.coordinator.cancel(prepared.batchId, { ...f.origin("cancel1"), actorId: "other" })).rejects.toThrow(/authority/)
    expect(readContinuityState(f.file).batches[0].cancellation).toBe("none")
  })
  it.each(["none", "duplicate", "overflow"] as const)("refuses %s discovery without creating a batch", async problem => {
    const f = await fixture()
    if (problem === "none") f.sessions.splice(0)
    else if (problem === "duplicate") f.sessions.push({ ...f.sessions[0] })
    else f.sessions.push(...Array.from({ length: 256 }, (_, n) => ({ ...f.sessions[0], id: `extra${n}` })))
    await expect(f.prepare()).rejects.toThrow()
    expect(readContinuityState(f.file).batches).toHaveLength(0)
  })
  it.each(["config", "task", "namespace", "executable", "worktree-permission", "worktree-symlink", "host", "agent", "cwd"] as const)(
    "keeps %s policy drift visible as unsupported without an invented actor", async change => {
      const f = await fixture()
      if (change === "config") f.binding.configFingerprint = "d".repeat(64)
      else if (change === "task") f.binding.taskKey = "different scope"
      else if (change === "namespace") { f.binding.taskRef = "outside/task"; f.binding.taskKey = `${f.home}:outside/task` }
      else if (change === "executable") fs.chmodSync(f.config.profiles[0].executable, 0o600)
      else if (change === "worktree-permission") fs.chmodSync(f.worktree, 0o777)
      else if (change === "worktree-symlink") { fs.renameSync(f.worktree, `${f.worktree}-original`); fs.symlinkSync(`${f.worktree}-original`, f.worktree) }
      else if (change === "host") f.binding.host = "herdr"
      else if (change === "agent") f.binding.agent = "other"
      else f.sessions[0].cwd = "/different"
      const prepared = await f.prepare()
      expect(prepared.summary.counts.unsupported).toBe(1)
      expect(readContinuityState(f.file).claims).toHaveLength(0)
    })
  it.each(["agent", "runner", "session", "process", "wrapper", "cwd", "profile", "config"] as const)(
    "refuses a source whose %s enrollment field no longer matches", async change => {
      const f = await fixture()
      await transactContinuity(f.file, undefined, state => {
        const enrollment = state.enrollments[0]
        if (change === "agent") enrollment.agent = "other"
        else if (change === "runner") enrollment.runner = "claude"
        else if (change === "session") enrollment.nativeSessionId = "different"
        else if (change === "process") enrollment.process = { ...enrollment.process, birth: "darwin:300:10" }
        else if (change === "wrapper") enrollment.wrapper = { pid: 50, birth: "darwin:300:50", uid: process.getuid!() }
        else if (change === "cwd") enrollment.launchCwd = "/other"
        else if (change === "profile") enrollment.profileFingerprint = "d".repeat(64)
        else enrollment.configFingerprint = "d".repeat(64)
      })
      expect((await f.coordinator.preview()).targets[0].state).toBe("unsupported")
    })
  it.each(["missing", "generation", "cwd", "tty", "no-tty", "outside-device", "background"] as const)(
    "does not admit %s live process evidence", async change => {
      const f = await fixture()
      const inspect = f.options.processDeps.inspect!
      f.options.processDeps.inspect = async pid => {
        const value = await inspect(pid)
        if (change === "missing") return { state: "absent" }
        if (value.state !== "present") return value
        if (change === "generation") return { ...value, generation: { ...value.generation, birth: "darwin:300:10" } }
        if (change === "cwd") return { ...value, cwd: "/different" }
        if (change === "tty") return { ...value, ttyDevice: 999 }
        if (change === "background") return { ...value, foregroundProcessGroupId: null }
        return value
      }
      if (change === "no-tty") f.sessions[0].tty = null
      if (change === "outside-device") f.sessions[0].tty = f.home
      expect((await f.coordinator.preview()).targets[0].state).toBe("unsupported")
    })
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
  it("filters a fixed composer's status and refuses foreign batches without exposing their bindings", async () => {
    const f = await fixture()
    const prepared = await f.prepare()
    const fixed = createContinuityCoordinator({ ...f.options, scope: { host: "cmux", id: "different" } })
    expect((await fixed.status()).batches).toEqual([])
    await expect(fixed.status(prepared.batchId)).rejects.toThrow(/authority/)
    await expect(fixed.cancel(prepared.batchId, f.origin("cancel1"))).rejects.toThrow(/bound/)
    await expect(fixed.reopen({ requestId: "reopen1", batchId: prepared.batchId, selection: "all" }, f.origin("reopen1"))).rejects.toThrow(/bound/)
  })
  it.each(["false", "finished", "invalid", "throw"] as const)("keeps a %s judgment from granting unsupported work", async verdict => {
    const f = await fixture()
    const prepared = await f.prepare()
    await f.finalEvidence(prepared.batchId)
    const coordinator = createContinuityCoordinator({ ...f.options, judge: async () => {
      if (verdict === "throw") throw new Error("fixture model unavailable")
      return { ready: verdict !== "false", unfinished: verdict !== "finished", reason: verdict === "invalid" ? "" : "fixture judgment" }
    } })
    await coordinator.processPendingJudgments()
    const target = readContinuityState(f.file).batches[0].targets[0]
    expect(target.assurance.reopen).toBe("blocked")
    expect(target.state).toBe(verdict === "finished" ? "ready" : "blocked")
    expect(f.launches).toHaveLength(0)
  })
  it.each(["unknown", "missing-host", "host-cwd", "kernel-cwd", "exec", "oversized", "redaction-expansion"] as const)(
    "refuses %s current observation before model use", async problem => {
      const f = await fixture()
      const prepared = await f.prepare()
      await f.finalEvidence(prepared.batchId)
      const inspect = f.options.processDeps.inspect!
      f.options.processDeps.inspect = async pid => {
        const value = await inspect(pid)
        if (problem === "unknown") return { state: "unknown", reason: "fixture unavailable" }
        if (value.state !== "present") return value
        if (problem === "kernel-cwd") return { ...value, cwd: "/different" }
        if (problem === "exec") return { ...value, executable: "/bin/sh" }
        return value
      }
      if (problem === "missing-host") f.sessions.splice(0)
      if (problem === "host-cwd") f.sessions[0].cwd = "/different"
      if (problem === "oversized") f.options.host.read = async () => "x".repeat(16385)
      if (problem === "redaction-expansion") f.options.host.read = async () => "token=x ".repeat(2000)
      await f.coordinator.processPendingJudgments()
      expect(f.judge).not.toHaveBeenCalled()
      expect((await f.coordinator.status(prepared.batchId)).counts.blocked).toBe(1)
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
  it("detects raw viewport changes even when redaction makes both observations look identical", async () => {
    const f = await fixture()
    const prepared = await f.prepare()
    await f.finalEvidence(prepared.batchId)
    let changed = false
    f.options.host.read = async () => changed ? "token=after" : "token=before"
    const coordinator = createContinuityCoordinator({ ...f.options, judge: async packet => {
      expect(packet.screen).toBe("token=[redacted]")
      changed = true
      return { ready: true, unfinished: true, reason: "stale after lossy redaction" }
    } })
    await coordinator.processPendingJudgments()
    expect((await coordinator.status(prepared.batchId)).counts.blocked).toBe(1)
    expect((await coordinator.status(prepared.batchId)).counts.ready).toBe(0)
    expect(JSON.stringify(readContinuityState(f.file))).not.toContain("token=before")
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
  it("rejects unknown or cancelled reopen authority and does not rebind a launch request body", async () => {
    const f = await fixture()
    const prepared = await f.prepare()
    await expect(f.coordinator.reopen({ requestId: "r1", batchId: "missing", selection: "all" }, f.origin("r1"))).rejects.toThrow(/authority/)
    await f.finalEvidence(prepared.batchId)
    await f.coordinator.processPendingJudgments()
    f.end()
    await f.coordinator.reopen({ requestId: "r1", batchId: prepared.batchId, selection: "all" }, f.origin("r1"))
    const targetId = readContinuityState(f.file).batches[0].targets[0].id
    await expect(f.coordinator.reopen({ requestId: "r1", batchId: prepared.batchId, selection: [targetId] }, f.origin("r1"))).rejects.toThrow(/body/)
    await f.coordinator.cancel(prepared.batchId, f.origin("cancel1"))
    await expect(f.coordinator.reopen({ requestId: "r2", batchId: prepared.batchId, selection: "all" }, f.origin("r2"))).rejects.toThrow(/cancelled/)
    expect(f.launches).toHaveLength(1)
  })
  it.each(["unfinished", "host", "entry"] as const)("does not launch a target with %s preconditions missing", async missing => {
    const f = await fixture()
    const prepared = await f.prepare()
    if (missing !== "unfinished") {
      await f.finalEvidence(prepared.batchId)
      await f.coordinator.processPendingJudgments()
    }
    f.end()
    if (missing === "host") f.options.host.launchContinuity = undefined
    if (missing === "entry") fs.chmodSync(f.options.ouroEntry, 0o600)
    await f.coordinator.reopen({ requestId: "r1", batchId: prepared.batchId, selection: "all" }, f.origin("r1"))
    expect(f.launches).toHaveLength(0)
    expect(readContinuityState(f.file).batches[0].targets[0].reopen).toBe(missing === "host" ? "unsupported" : "blocked")
  })
  it("reports cancelled and unsupported unbound targets while reopening no unseen source", async () => {
    const f = await fixture()
    f.bindings.splice(0)
    const prepared = await f.prepare()
    await f.coordinator.reopen({ requestId: "r1", batchId: prepared.batchId, selection: "all" }, f.origin("r1"))
    expect(f.launches).toHaveLength(0)
    await f.coordinator.cancel(prepared.batchId, f.origin("c1"))
    expect((await f.coordinator.status(prepared.batchId)).counts).toMatchObject({ selected: 1, cancelled: 1, ready: 0 })
  })
})
