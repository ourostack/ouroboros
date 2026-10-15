import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { runContinuityBootstrap } from "../../../senses/shepherd/continuity-bootstrap"
import { handleContinuityStop, parseNativeContinuityStop } from "../../../senses/shepherd/continuity-hook"
import { reserveContinuityReceiptSlot } from "../../../senses/shepherd/continuity-evidence"
import { readContinuityState, transactContinuity } from "../../../senses/shepherd/continuity-store"
import type { ProcessProofDeps, ProcessProofObservation } from "../../../senses/shepherd/continuity-process"
import { fixture } from "./continuity-coordinator-fixture"

async function replacement(large = false) {
  const f = await fixture()
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
      if (![process.pid, 20, 30].includes(pid)) return { state: "unknown", reason: "untracked" }
      const generation = pid === process.pid ? wrapper : pid === 20 ? actor : { ...actor, pid: 30, birth: "darwin:200:30" }
      return { state: "present", generation, parentPid: pid === 30 ? 20 : pid === 20 ? process.pid : 1,
        processGroupId: 20, foregroundProcessGroupId: pid === 30 ? null : 20,
        ttyDevice: pid === 30 ? null : fs.statSync("/dev/null").rdev,
        executable: pid === 20 ? f.config.profiles[0].executable : "/trusted/ouro", entryScript: null, cwd: f.home }
    },
  }
  const request = { agent: "ouro", storePath: f.file, batchId: prepared.batchId, targetId: target().id, attemptId: target().launch!.attemptId }
  const context = { agent: "ouro", storePath: f.file, adapterPid: 30, profiles: f.config.profiles,
    configFingerprint: f.binding.configFingerprint, processDeps }
  const stop = (n: number) => parseNativeContinuityStop("copilot", { sessionId: target().launch!.nativeSessionId,
    cwd: f.home, timestamp: `2026-10-15T04:00:${String(n).padStart(2, "0")}Z`, stopReason: "end_turn", stop_hook_active: true })
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
