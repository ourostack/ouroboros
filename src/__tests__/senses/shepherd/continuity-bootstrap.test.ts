import fs from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { handleContinuityReplacementStop, renderContinuityRestoreBrief, runContinuityBootstrap } from "../../../senses/shepherd/continuity-bootstrap"
import { handleContinuityStop, parseNativeContinuityStop } from "../../../senses/shepherd/continuity-hook"
import { reserveContinuityReceiptSlot } from "../../../senses/shepherd/continuity-evidence"
import { createContinuityBatch, readContinuityState, transactContinuity } from "../../../senses/shepherd/continuity-store"
import type { ContinuityCallerProof, ProcessProofDeps, ProcessProofObservation } from "../../../senses/shepherd/continuity-process"
import { fixture } from "./continuity-coordinator-fixture"
import { createContinuityCoordinator } from "../../../senses/shepherd/continuity-coordinator"
import * as continuityStore from "../../../senses/shepherd/continuity-store"
import { continuityConfigFingerprint, parseContinuityConfig } from "../../../senses/shepherd/continuity-config"
import type { ContinuityRunner } from "../../../senses/shepherd/continuity-types"

async function replacement(large = false, runner: ContinuityRunner = "copilot", launcher: "direct" | "agency" = "direct") {
  const f = await fixture()
  const nativeExecutable = path.join(f.home, runner)
  if (runner !== "copilot") fs.writeFileSync(nativeExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 })
  if (runner !== "copilot" || launcher !== "direct") {
    const executable = launcher === "agency" ? path.join(f.home, "agency") : nativeExecutable
    if (launcher === "agency") fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 })
    const parsed = parseContinuityConfig({ schemaVersion: 1, roots: [{
      id: "desk", path: f.home, namespace: "track", receiptBase: ".receipts", launchRoots: [f.home], worktreeRoots: [f.worktree],
    }], profiles: [{ id: "worker", runner, launcher, executable,
      argv: [...(launcher === "agency" ? [runner] : []), ...(runner === "copilot" ? ["--allow-all"] : [])],
      rootIds: ["desk"], settingsPath: path.join(f.home, "hooks.json"),
      version: runner === "claude" ? "2.1.299" : runner === "codex" ? "0.162.1" : "1.0.97",
    }] })
    f.config.profiles = parsed.profiles
    f.binding.runner = runner
    f.binding.profileFingerprint = f.config.profiles[0].fingerprint
    f.binding.configFingerprint = continuityConfigFingerprint(f.config)
    await transactContinuity(f.file, undefined, state => {
      Object.assign(state.enrollments[0], { runner, profileFingerprint: f.binding.profileFingerprint, configFingerprint: f.binding.configFingerprint })
    })
    const inspect = f.options.processDeps.inspect!
    f.options.processDeps.inspect = async pid => {
      const observed = await inspect(pid)
      return observed.state === "present" ? { ...observed, executable: nativeExecutable } : observed
    }
    if (launcher === "agency") f.options.processDeps.nativeEntries = [{ runner, executable: nativeExecutable, entryScript: null, version: f.config.profiles[0].version }]
  }
  const prepared = await f.prepare()
  await f.finalEvidence(prepared.batchId, large ? Array.from({ length: 12 }, () => "x".repeat(4096)) : undefined)
  await f.coordinator.processPendingJudgments()
  f.end()
  await f.coordinator.reopen({ requestId: "reopen1", batchId: prepared.batchId, selection: "all" }, f.origin("reopen1"))
  const target = () => readContinuityState(f.file).batches[0].targets[0]
  const wrapper = { pid: process.pid, birth: `darwin:200:${process.pid}`, uid: process.getuid!() }
  const actor = { pid: 20, birth: "darwin:200:20", uid: process.getuid!() }
  const processDeps: ProcessProofDeps = { ...f.options.processDeps,
    inspect: async (pid): Promise<ProcessProofObservation> => {
      if (pid === 10) return { state: "absent" }
      if (![process.pid, 20, 30, 40].includes(pid)) return { state: "unknown", reason: "untracked" }
      const generation = pid === process.pid ? wrapper : pid === 20 ? actor : { ...actor, pid: 30, birth: "darwin:200:30" }
      return { state: "present", generation: pid === 40 ? { ...actor, pid: 40, birth: "darwin:200:40" } : generation,
        parentPid: pid === 30 ? 20 : pid === 20 ? launcher === "agency" ? 40 : process.pid : pid === 40 ? process.pid : 1,
        processGroupId: 20, foregroundProcessGroupId: pid === 30 ? null : 20,
        ttyDevice: pid === 30 ? null : fs.statSync("/dev/null").rdev,
        executable: pid === 20 ? nativeExecutable : pid === 40 ? f.config.profiles[0].executable : "/trusted/ouro", entryScript: null, cwd: f.home }
    },
  }
  const request = { agent: "ouro", storePath: f.file, batchId: prepared.batchId, targetId: target().id, attemptId: target().launch!.attemptId }
  const context = { agent: "ouro", storePath: f.file, adapterPid: 30, profiles: f.config.profiles,
    configFingerprint: f.binding.configFingerprint, processDeps }
  const stop = (n: number) => parseNativeContinuityStop(runner, runner === "copilot" ? { sessionId: target().launch!.nativeSessionId,
    cwd: f.home, timestamp: `2026-10-15T04:00:${String(n).padStart(2, "0")}Z`, stopReason: "end_turn", stop_hook_active: true } :
    { session_id: runner === "codex" ? "codex-fresh-native" : target().launch!.nativeSessionId, cwd: f.home,
      hook_event_name: "Stop", stop_hook_active: true, ...(runner === "codex" ? { turn_id: `turn${n}` } : {}) })
  const writeAck = (kind: "bootstrap" | "execute", nonce?: string) => {
    const current = target()
    const launch = current.launch!
    const slot = reserveContinuityReceiptSlot(current.binding, prepared.batchId, 2, kind, launch.attemptId)
    const receipt = { ...current.receipt!, ...slot.correlation, nonce: nonce ?? (kind === "bootstrap" ? launch.bootstrapNonce : launch.executeNonce) }
    fs.mkdirSync(path.dirname(slot.path), { recursive: true, mode: 0o700 })
    fs.writeFileSync(slot.path, JSON.stringify(receipt), { mode: 0o600 })
  }
  const registerWrapper = () => transactContinuity(f.file, undefined, state => {
    state.batches[0].targets[0].launch!.bootstrapProcess = wrapper
  })
  return { ...f, request, target, wrapper, actor, processDeps, context, stop, writeAck, registerWrapper }
}

describe("fresh restore-only continuity bootstrap", () => {
  afterEach(() => vi.restoreAllMocks())
  it("refuses two Codex replacement attempts with the same observed bootstrap lineage", async () => {
    const f = await replacement(false, "codex")
    await f.registerWrapper()
    f.writeAck("bootstrap")
    await transactContinuity(f.file, undefined, state => {
      const batch = structuredClone(state.batches[0])
      batch.id = "second-batch"
      batch.requestId = batch.origin.requestId = "second-request"
      const target = batch.targets[0]
      target.id = "second-target"
      target.binding.id = "second-binding"
      target.binding.surfaceId = "second-surface"
      target.binding.taskRef = "track/task2"
      target.binding.taskKey = `${f.home}:track/task2`
      target.launch!.nativeSessionId = "another-native-session"
      createContinuityBatch(state, batch)
      state.claims[1].phase = "created"
      state.claims[1].attemptId = target.launch!.attemptId
    })
    expect(await handleContinuityStop(f.stop(1), f.context)).toEqual({})
    expect(f.target().launch!.phase).toBe("created")
    expect(readContinuityState(f.file).claims.every(claim => claim.phase !== "transferred")).toBe(true)
  })
  it("blocks its registered wrapper when cancellation arrives before the first creation readback", async () => {
    const f = await replacement()
    const transact = continuityStore.transactContinuity
    vi.spyOn(continuityStore, "transactContinuity").mockImplementationOnce(async (...args) => {
      const result = await transact(...args)
      await transact(f.file, undefined, state => { state.batches[0].cancellation = "cancelling" })
      return result
    })
    await expect(runContinuityBootstrap(f.request, {
      config: async () => f.config, processDeps: f.processDeps,
    })).rejects.toThrow(/creation readback cancelled/)
    expect(f.target().launch!.phase).toBe("blocked")
    expect(f.target().launch!.milestones).not.toContain("runner-start-issued")
  })
  it.each([{ runner: "claude", launcher: "direct" }, { runner: "codex", launcher: "direct" },
    { runner: "copilot", launcher: "agency" }, { runner: "claude", launcher: "agency" }] as const)(
    "restores and acknowledges only the exclusive $launcher/$runner fresh actor", async ({ runner, launcher }) => {
      const f = await replacement(false, runner, launcher)
      await runContinuityBootstrap(f.request, { config: async () => f.config, processDeps: f.processDeps,
        run: async (_executable, args) => {
          expect(args).not.toContain("--resume")
          expect(args).not.toContain("--continue")
          expect(args.at(-1)).toContain("Restore only")
          f.writeAck("bootstrap")
          expect(await handleContinuityStop(f.stop(1), f.context)).toMatchObject({ decision: "block" })
          f.writeAck("execute")
          expect(await handleContinuityStop(f.stop(2), f.context)).toEqual({})
          return 0
        },
      })
      expect(f.target()).toMatchObject({ reopen: "launched", launch: { phase: "working", actor: f.actor } })
      expect(f.target().launch!.nativeSessionId).toBe(f.stop(3).nativeSessionId)
      expect(readContinuityState(f.file).claims[0]).toMatchObject({ phase: "transferred", actor: f.actor })
    })
  it.each(["confirmation", "projection", "checkpoint", "slot", "nonce", "phase", "wrapper", "claim"] as const)(
    "never returns an execution grant after the restored %s changes", async problem => {
      const f = await replacement()
      await f.registerWrapper()
      f.writeAck("bootstrap")
      await transactContinuity(f.file, undefined, state => {
        const target = state.batches[0].targets[0]
        if (problem === "projection") target.projection!.nextAction = "Changed action"
        if (problem === "checkpoint") target.receipt!.checkpoint.sha256 = "f".repeat(64)
        if (problem === "slot") target.launch!.bootstrapSlot = ".receipts/other.json"
        if (problem === "nonce") { target.launch!.phase = "grant-issued"; target.launch!.executeNonce = null }
        if (problem === "phase") target.launch!.phase = "bootstrapped"
        if (problem === "wrapper") { target.launch!.actor = f.actor; target.launch!.wrapper = f.wrapper }
        if (problem === "claim") state.claims[0].attemptId = "different-attempt"
      })
      if (problem === "confirmation") {
        const file = path.join(f.home, f.target().launch!.bootstrapSlot)
        const receipt = JSON.parse(fs.readFileSync(file, "utf8"))
        receipt.confirmation = false
        fs.writeFileSync(file, JSON.stringify(receipt), { mode: 0o600 })
      }
      expect(await handleContinuityStop(f.stop(1), f.context)).toEqual({})
      expect(f.target().launch!.phase).not.toBe("grant-issued")
      expect(f.target().reopen).not.toBe("launched")
    })
  it.each(["before-restore", "after-transfer"] as const)("does not return a grant beyond the %s native deadline", async boundary => {
    const f = await replacement()
    await f.registerWrapper()
    f.writeAck("bootstrap")
    const input = { ...f.stop(1), eventId: null }
    const proof: Extract<ContinuityCallerProof, { state: "verified" }> = {
      state: "verified", profileId: "worker", generation: f.actor, wrapper: null,
      nativeSessionId: input.nativeSessionId, cwd: f.home, lineage: [f.actor, f.wrapper],
    }
    const deadline = Date.now() + 1000
    if (boundary === "before-restore") vi.spyOn(Date, "now").mockReturnValue(deadline + 1)
    else {
      const transact = continuityStore.transactContinuity
      vi.spyOn(continuityStore, "transactContinuity").mockImplementationOnce(async (...args) => {
        const result = await transact(...args)
        vi.spyOn(Date, "now").mockReturnValue(deadline + 1)
        return result
      })
    }
    await expect(handleContinuityReplacementStop(input, f.context, proof, f.config.profiles[0],
      readContinuityState(f.file), f.request.batchId, f.request.targetId, deadline)).rejects.toThrow(/budget/)
    expect(f.target().launch!.phase).not.toBe("grant-issued")
    if (boundary === "after-transfer") expect(readContinuityState(f.file).claims[0].phase).toBe("transferred")
  })
  it("does not hide a bootstrap refusal if its owned failure-state write is unavailable", async () => {
    const f = await replacement()
    vi.spyOn(continuityStore, "transactContinuity").mockRejectedValueOnce(new Error("owned store unavailable"))
    await expect(runContinuityBootstrap(f.request, {
      config: async () => { throw new Error("policy unavailable") }, processDeps: f.processDeps,
    })).rejects.toThrow("policy unavailable")
    expect(f.target().launch!.phase).toBe("created")
  })
  it("persists the replacement claim as uncertain when its native transaction fails", async () => {
    const f = await replacement()
    await f.registerWrapper()
    f.writeAck("bootstrap")
    vi.spyOn(continuityStore, "transactContinuity").mockRejectedValueOnce(new Error("owned transaction failure"))
    expect(await handleContinuityStop(f.stop(1), f.context)).toEqual({})
    expect(f.target()).toMatchObject({ reopen: "uncertain", launch: { phase: "uncertain" } })
    expect(readContinuityState(f.file).claims[0].phase).toBe("uncertain")
  })
  it.each(["exit-zero", "exit-error", "spawn-error"] as const)("runs only an owned local executable for default %s handling", async problem => {
    const f = await replacement()
    const marker = path.join(f.home, "spawned")
    fs.writeFileSync(f.config.profiles[0].executable, problem === "spawn-error" ? "#!/no-such-owned-interpreter\n" :
      `#!/bin/sh\nprintf 'restore-only' > '${marker}'\nexit ${problem === "exit-zero" ? 0 : 7}\n`, { mode: 0o700 })
    const execution = runContinuityBootstrap(f.request, { config: async () => f.config, processDeps: f.processDeps })
    if (problem === "exit-zero") await execution
    else await expect(execution).rejects.toThrow(/fresh runner exit/)
    if (problem !== "spawn-error") expect(fs.readFileSync(marker, "utf8")).toBe("restore-only")
    expect(f.target()).toMatchObject({ reopen: "uncertain", launch: { phase: "uncertain" } })
    expect(f.target().launch!.milestones.filter(value => value === "runner-start-issued")).toHaveLength(1)
  })
  it("leaves an acknowledged working actor intact after the wrapper exits successfully", async () => {
    const f = await replacement()
    await runContinuityBootstrap(f.request, { config: async () => f.config, processDeps: f.processDeps,
      run: async () => {
        f.writeAck("bootstrap")
        expect(await handleContinuityStop(f.stop(1), f.context)).toMatchObject({ decision: "block" })
        f.writeAck("execute")
        expect(await handleContinuityStop(f.stop(2), f.context)).toEqual({})
        return 0
      },
    })
    expect(f.target()).toMatchObject({ reopen: "launched", launch: { phase: "working" } })
    expect(readContinuityState(f.file).holds).toHaveLength(0)
  })
  it.each(["batch", "target", "attempt"] as const)("rejects a mismatched %s wrapper request without changing its actual actor", async field => {
    const f = await replacement()
    const request = { ...f.request, [field === "batch" ? "batchId" : field === "target" ? "targetId" : "attemptId"]: "missing" }
    await expect(runContinuityBootstrap(request, { config: async () => f.config, processDeps: f.processDeps })).rejects.toThrow(/authority/)
    expect(f.target().launch!.phase).toBe("created")
  })
  it.each(["launch", "handoff", "size"] as const)("refuses a restore brief with missing or oversized %s authority", async problem => {
    const f = await replacement()
    const target = f.target()
    if (problem === "launch") target.launch = null
    else if (problem === "handoff") target.receipt = null
    else target.binding.taskRef = "x".repeat(20000)
    expect(() => renderContinuityRestoreBrief(target, f.request.batchId)).toThrow()
  })
  it.each(["wrapper-race", "claim-race", "readback-cancel", "source-reappears", "runner-race"] as const)(
    "never starts a runner after %s invalidates the reservation", async problem => {
      const f = await replacement()
      let configurationReads = 0
      let sourceReads = 0
      const processDeps: ProcessProofDeps = { ...f.processDeps, inspect: async pid => {
        if (pid === 10 && ++sourceReads === 2 && problem === "source-reappears") return {
          state: "present", generation: f.binding.process, parentPid: 1, processGroupId: 10,
          foregroundProcessGroupId: 10, ttyDevice: fs.statSync("/dev/null").rdev,
          executable: f.config.profiles[0].executable, entryScript: null, cwd: f.home,
        }
        return f.processDeps.inspect!(pid)
      } }
      let runs = 0
      await expect(runContinuityBootstrap(f.request, {
        processDeps, config: async () => {
          configurationReads++
          if (configurationReads === 1 && ["wrapper-race", "claim-race"].includes(problem)) await transactContinuity(f.file, undefined, state => {
            if (problem === "wrapper-race") state.batches[0].targets[0].launch!.bootstrapProcess = f.wrapper
            else state.claims[0].phase = "uncertain"
          })
          if (configurationReads === 1 && problem === "readback-cancel") {
            const inspect = processDeps.inspect!
            processDeps.inspect = async pid => {
              const result = await inspect(pid)
              if (pid === process.pid) await transactContinuity(f.file, undefined, state => { state.batches[0].cancellation = "cancelling" })
              return result
            }
          }
          if (configurationReads === 2 && problem === "runner-race") await transactContinuity(f.file, undefined, state => {
            state.batches[0].targets[0].launch!.milestones.push("runner-start-issued")
          })
          return f.config
        }, run: async () => { runs++; return 0 },
      })).rejects.toThrow()
      expect(runs).toBe(0)
      if (problem === "wrapper-race") expect(f.target().launch!.phase).toBe("created")
      if (problem === "runner-race") expect(f.target().reopen).toBe("uncertain")
    })
  it.each(["configuration", "source-present", "wrapper-unknown", "wrapper-uid", "readback-missing"] as const)(
    "durably blocks an unstarted replacement after %s preflight failure", async problem => {
      const f = await replacement()
      if (problem === "readback-missing") await transactContinuity(f.file, undefined, state => {
        state.batches[0].targets[0].launch!.workspaceId = null
      })
      const processDeps: ProcessProofDeps = { ...f.processDeps, inspect: async pid => {
        if (problem === "source-present" && pid === 10) return {
          state: "present", generation: f.binding.process, parentPid: 1, processGroupId: 10,
          foregroundProcessGroupId: 10, ttyDevice: fs.statSync("/dev/null").rdev,
          executable: f.config.profiles[0].executable, entryScript: null, cwd: f.home,
        }
        if (pid === process.pid && problem === "wrapper-unknown") return { state: "unknown", reason: "untracked" }
        const observed = await f.processDeps.inspect!(pid)
        if (pid === process.pid && problem === "wrapper-uid" && observed.state === "present") {
          return { ...observed, generation: { ...observed.generation, uid: process.getuid!() + 1 } }
        }
        return observed
      } }
      await expect(runContinuityBootstrap(f.request, {
        config: async () => { if (problem === "configuration") throw new Error("policy unavailable"); return f.config },
        processDeps, run: async () => { throw new Error("must never start") },
      })).rejects.toThrow()
      expect(f.target()).toMatchObject({ reopen: "blocked", launch: { phase: "blocked" } })
      expect(f.target().reasons).toEqual(["fresh-bootstrap-preflight-failed"])
      expect(readContinuityState(f.file).claims[0].phase).toBe("uncertain")
      expect(f.target().launch!.milestones).not.toContain("runner-start-issued")
    })
  it.each(["slow-proof", "eager-wrapper"] as const)("waits for durable creation readback in the %s startup ordering", async ordering => {
    const f = await fixture()
    const prepared = await f.prepare()
    await f.finalEvidence(prepared.batchId)
    await f.coordinator.processPendingJudgments()
    f.end()
    const wrapper = { pid: process.pid, birth: `darwin:200:${process.pid}`, uid: process.getuid!() }
    const processDeps: ProcessProofDeps = { ...f.options.processDeps, inspect: async pid => pid === process.pid ? {
      state: "present", generation: wrapper, parentPid: 1, processGroupId: 20, foregroundProcessGroupId: 20,
      ttyDevice: fs.statSync("/dev/null").rdev, executable: "/trusted/ouro", entryScript: null, cwd: f.home,
    } : { state: "absent" } }
    let releaseProof!: () => void
    const proofGate = new Promise<void>(resolve => { releaseProof = resolve })
    let wrapperDone: Promise<void> | undefined
    let started = false
    const coordinator = createContinuityCoordinator({ ...f.options, host: { ...f.options.host,
      launchContinuity: async request => {
        wrapperDone = runContinuityBootstrap({ agent: "ouro", storePath: f.file, batchId: prepared.batchId,
          targetId: request.targetId, attemptId: request.attemptId }, {
          processDeps,
          config: async () => { if (ordering === "slow-proof") await proofGate; return f.config },
          run: async () => {
            const launch = readContinuityState(f.file).batches[0].targets[0].launch!
            expect(launch.phase).toBe("created")
            expect(launch.workspaceId).toBe("workspace-new")
            expect(launch.bootstrapProcess).toEqual(wrapper)
            started = true
            return 0
          },
        })
        // Observe rejection immediately; the assertion below still receives the original error.
        void wrapperDone.catch(() => {})
        if (ordering === "eager-wrapper") await new Promise(resolve => setTimeout(resolve, 30))
        return { workspaceId: "workspace-new", surfaceId: "surface-new" }
      },
    } })
    await coordinator.reopen({ requestId: "reopen1", batchId: prepared.batchId, selection: "all" }, f.origin("reopen1"))
    releaseProof()
    await wrapperDone
    expect(started).toBe(true)
  })
  it("persists the real wrapper before starting one fresh harness with no first-work instruction", async () => {
    const f = await replacement()
    let started = false
    await runContinuityBootstrap(f.request, { config: async () => f.config, processDeps: f.processDeps,
      run: async (executable, args, cwd) => {
        expect(f.target().launch?.bootstrapProcess).toEqual(f.wrapper)
        expect(executable).toBe(f.config.profiles[0].executable)
        expect(cwd).toBe(f.home)
        expect(args.slice(0, 4)).toEqual(["--allow-all", "--session-id", f.target().launch!.nativeSessionId, "--interactive"])
        expect(args.at(-1)).toContain("Restore only")
        expect(args.at(-1)).toContain("Do not execute the next action")
        expect(args).not.toContain("--resume")
        started = true
        return 0
      },
    })
    expect(started).toBe(true)
    expect(f.target().reopen).not.toBe("launched")
    expect(f.target().launch?.phase).toBe("uncertain")
    await expect(runContinuityBootstrap(f.request, { config: async () => f.config, processDeps: f.processDeps,
      run: async () => { throw new Error("must not reissue") } })).rejects.toThrow()
  })
  it("grants execution at the same replacement Stop only after a verified restore ACK, then requires execution ACK", async () => {
    const f = await replacement()
    await f.registerWrapper()
    f.writeAck("bootstrap")
    const grant = await handleContinuityStop(f.stop(1), f.context)
    expect(grant).toMatchObject({ decision: "block" })
    expect(JSON.stringify(grant)).toContain("Run fixture test")
    expect(f.target()).toMatchObject({ reopen: "launching", launch: { phase: "grant-issued", actor: f.actor } })
    expect(readContinuityState(f.file).claims[0]).toMatchObject({ phase: "transferred", actor: f.actor })
    f.writeAck("execute")
    expect(await handleContinuityStop(f.stop(2), f.context)).toEqual({})
    expect(f.target()).toMatchObject({ reopen: "launched", launch: { phase: "working", actor: f.actor } })
    expect((await f.coordinator.status()).counts.launched).toBe(1)
    expect(await handleContinuityStop(f.stop(3), f.context)).toEqual({})
    expect(f.target().rounds).toHaveLength(1)
  })
  it("restores a valid large handoff by verified references instead of overflowing the native brief", async () => {
    const f = await replacement(true)
    let started = false
    await runContinuityBootstrap(f.request, { config: async () => f.config, processDeps: f.processDeps,
      run: async (_executable, args) => {
        expect(Buffer.byteLength(args.at(-1)!)).toBeLessThanOrEqual(16384)
        started = true
        return 0
      },
    })
    expect(started).toBe(true)
    expect(f.target().reopen).not.toBe("launched")
  })
  it("records an observed incompatible replacement as unsupported instead of leaving a misleading pending launch", async () => {
    const f = await replacement()
    await f.registerWrapper()
    f.writeAck("bootstrap")
    f.context.profiles[0].version = "unverified"
    expect(await handleContinuityStop(f.stop(1), f.context)).toEqual({})
    expect(f.target().reopen).toBe("unsupported")
    expect(readContinuityState(f.file).claims[0].phase).toBe("uncertain")
  })
  it.each(["missing", "wrong-nonce", "no-wrapper", "cancelled"] as const)("never grants ordinary work after %s bootstrap proof", async problem => {
    const f = await replacement()
    if (problem !== "no-wrapper") await f.registerWrapper()
    if (problem !== "missing") f.writeAck("bootstrap", problem === "wrong-nonce" ? "wrong" : undefined)
    if (problem === "cancelled") await f.coordinator.cancel(f.request.batchId, f.origin("cancel1"))
    expect(await handleContinuityStop(f.stop(1), f.context)).toEqual({})
    expect(f.target().launch?.phase).not.toBe("grant-issued")
    expect(f.target().reopen).not.toBe("launched")
    if (problem !== "no-wrapper" && problem !== "cancelled") {
      f.writeAck("bootstrap")
      expect(await handleContinuityStop(f.stop(2), f.context)).toEqual({})
      expect(f.target().launch?.phase).toBe("uncertain")
    }
  })
  it("retains transferred ownership when the execute grant or acknowledgement is lost", async () => {
    const f = await replacement()
    await f.registerWrapper()
    f.writeAck("bootstrap")
    await handleContinuityStop(f.stop(1), f.context)
    expect(await handleContinuityStop(f.stop(2), f.context)).toEqual({})
    expect(f.target().launch?.phase).toBe("uncertain")
    expect(readContinuityState(f.file).claims[0]).toMatchObject({ phase: "uncertain", actor: f.actor })
    f.writeAck("execute")
    expect(await handleContinuityStop(f.stop(3), f.context)).toEqual({})
    expect(f.target().reopen).toBe("uncertain")
    await f.coordinator.cancel(f.request.batchId, f.origin("cancel1"))
    expect(readContinuityState(f.file).claims).toHaveLength(1)
  })
})
