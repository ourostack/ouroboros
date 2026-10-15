import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it, vi } from "vitest"
import { handleContinuityStop, parseNativeContinuityStop, renderContinuityRoundInstruction } from "../../../senses/shepherd/continuity-hook"
import { continuityStatePath, createContinuityBatch, readContinuityState, transactContinuity } from "../../../senses/shepherd/continuity-store"
import type { ContinuityBatch, ContinuityProfile, ContinuityRunner } from "../../../senses/shepherd/continuity-types"
import type { ProcessProofDeps, ProcessProofObservation } from "../../../senses/shepherd/continuity-process"
import * as continuityStore from "../../../senses/shepherd/continuity-store"

async function fixture(runner: ContinuityRunner = "copilot", prepared = true) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "continuity-hook-")))
  const file = continuityStatePath(home, "machine1")
  const stat = fs.statSync(home)
  const profile: ContinuityProfile = {
    id: "worker", runner, launcher: "direct", executable: `/trusted/${runner}`, argv: runner === "copilot" ? ["--allow-all"] : [],
    rootIds: ["desk"], settingsPath: path.join(home, "settings.json"),
    version: runner === "copilot" ? "1.0.97" : runner === "claude" ? "2.1.299" : "0.162.1",
    executableIdentity: { dev: 1, ino: 1 }, fingerprint: "a".repeat(64),
  }
  const actor = { pid: 10, birth: "darwin:100:10", uid: process.getuid!() }
  const processDeps: ProcessProofDeps = {
    platform: "darwin", inspect: async (pid): Promise<ProcessProofObservation> => ({
      state: "present", generation: pid === 10 ? actor : { ...actor, pid, birth: `darwin:100:${pid}` },
      parentPid: pid === 30 ? 10 : 1, processGroupId: 10, foregroundProcessGroupId: pid === 30 ? null : 10,
      ttyDevice: pid === 30 ? null : 1, executable: pid === 30 ? "/trusted/ouro" : profile.executable,
      entryScript: null, cwd: home,
    }),
  }
  const context = { agent: "ouro", storePath: file, adapterPid: 30, profiles: [profile],
    configFingerprint: "c".repeat(64), processDeps }
  const stop = (n = 1) => parseNativeContinuityStop(runner, runner === "copilot" ?
    { sessionId: "native1", cwd: home, timestamp: `2026-10-15T04:00:${String(n).padStart(2, "0")}Z`, stopReason: "end_turn", stop_hook_active: n > 1 } :
    { session_id: "native1", cwd: home, hook_event_name: "Stop", stop_hook_active: n > 1,
      ...(runner === "codex" ? { turn_id: `turn${n}`, transcript_path: null, last_assistant_message: null } : {}) })
  await handleContinuityStop(stop(0), context)
  const enrollment = readContinuityState(file).enrollments[0]
  const batch: ContinuityBatch = {
    id: "batch1", agent: "ouro", requestId: "request1", bodyHash: "b".repeat(64),
    origin: { actorId: "operator", requestId: "request1" }, createdAt: "2026-10-15T04:00:00Z", cancellation: "none",
    targets: [{
      id: "target1", generation: 1, state: "pending-boundary", reopen: "not-requested", rounds: [], reasons: [],
      binding: {
        id: "binding1", agent: "ouro", host: "cmux", incarnation: "host1", surfaceId: "surface1", surfaceGeneration: "sg1",
        nativeSessionId: "native1", runner, process: actor, wrapper: null, launchCwd: home, worktree: home,
        rootId: "desk", root: { id: "desk", path: home, namespace: "track", receiptBase: ".receipts",
          launchRoots: [home], worktreeRoots: [home], identity: { dev: stat.dev, ino: stat.ino } },
        taskRef: "track/task", taskKey: `${home}:track/task`, profileId: "worker",
        profileFingerprint: profile.fingerprint, configFingerprint: context.configFingerprint, enrollmentEpoch: enrollment.id,
      },
      assurance: { checkpoint: "unverified", endReadiness: "unconfirmed", backgroundCoverage: "unknown", jobInventory: "unverified",
        reopen: "unverified", observedAt: null, qualifications: [] },
      receipt: null, projection: null, observedTransitions: [], launch: null,
    }],
  }
  if (prepared) await transactContinuity(file, undefined, state => createContinuityBatch(state, batch))
  const target = () => readContinuityState(file).batches[0].targets[0]
  const writeReceipt = (options: { confirmation?: boolean; corruptCheckpoint?: boolean; nonce?: string; nextAction?: string } = {}) => {
    const current = target()
    const round = current.rounds[current.rounds.length - 1]
    const checkpoint = { goal: "Finish this disposable task", scope: "Fixture only", decisions: ["Preserve dirty work"],
      nextAction: options.nextAction ?? "Run targeted test", knownJobs: [], uncertainMutations: [], references: ["task.md"] }
    const checkpointFile = path.join(home, "track/task/continuity.json")
    fs.mkdirSync(path.dirname(checkpointFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(checkpointFile, options.corruptCheckpoint ? "invalid" : JSON.stringify(checkpoint), { mode: 0o600 })
    const receipt = {
      schemaVersion: 1, batchId: "batch1", bindingId: "binding1", generation: 1, round: round.kind,
      nonce: options.nonce ?? round.nonce, launchAttemptId: null,
      checkpoint: { rootId: "desk", relativePath: "track/task/continuity.json",
        sha256: createHash("sha256").update(fs.readFileSync(checkpointFile)).digest("hex") },
      task: { ref: "track/task", rootId: "desk", launchCwd: home, worktree: home, branch: "fixture", head: "a".repeat(40), nextAction: checkpoint.nextAction },
      confirmation: options.confirmation ?? true, knownJobs: [], uncertainMutations: [],
    }
    const slot = path.join(home, round.receiptSlot)
    fs.mkdirSync(path.dirname(slot), { recursive: true, mode: 0o700 })
    fs.writeFileSync(slot, JSON.stringify(receipt), { mode: 0o600 })
  }
  return { home, file, actor, profile, processDeps, context, stop, target, writeReceipt, batch }
}

describe("native continuity Stop broker", () => {
  afterEach(() => vi.restoreAllMocks())
  it("accepts exact Copilot camelCase normal Stop and continuation flag", () => {
    const stop = parseNativeContinuityStop("copilot", { sessionId: "id1", cwd: "/desk", timestamp: "2026-10-15T04:00:00Z",
      stopReason: "end_turn", stop_hook_active: true, transcriptPath: "/private/transcript" })
    expect(stop).toMatchObject({ runner: "copilot", nativeSessionId: "id1", normal: true, stopHookActive: true })
    expect(JSON.stringify(stop)).not.toContain("transcript")
  })
  it.each(["claude", "codex"] as const)("accepts %s native Stop and null optional fields", runner => {
    expect(parseNativeContinuityStop(runner, { session_id: "id1", cwd: "/desk", hook_event_name: "Stop",
      stop_hook_active: false, ...(runner === "codex" ? { turn_id: "turn1" } : {}),
      transcript_path: null, last_assistant_message: null })).toMatchObject({ normal: true })
  })
  it.each(["error", "interrupt", "shutdown", "tool_error"])("does not continue Copilot %s", stopReason => {
    expect(parseNativeContinuityStop("copilot", { sessionId: "id", cwd: "/desk", timestamp: "2026-10-15T04:00:00Z", stopReason }).normal).toBe(false)
  })
  it("rejects missing native fields and wrong identity spellings without accepting raw PIDs", () => {
    for (const value of [null, [], {}, { session_id: "wrong", cwd: "/desk", stopReason: "end_turn" }]) {
      expect(() => parseNativeContinuityStop("copilot", value)).toThrow()
    }
    expect(() => parseNativeContinuityStop("codex", { session_id: "id", cwd: "/desk", hook_event_name: "Stop", stop_hook_active: false })).toThrow()
    expect(() => parseNativeContinuityStop("claude", { session_id: "id", cwd: "/desk", hook_event_name: "Stop", stop_hook_active: "yes" })).toThrow()
  })
  it.each(["copilot", "claude", "codex"] as const)("enrolls proven %s callbacks but emits nothing without an own family batch", async runner => {
    const f = await fixture(runner, false)
    expect(await handleContinuityStop(f.stop(1), f.context)).toEqual({})
    const state = readContinuityState(f.file)
    expect(state.enrollments).toHaveLength(1)
    expect(state.enrollments[0]).toMatchObject({ agent: "ouro", runner, process: f.actor, launchCwd: f.home })
  })
  it("issues preparation and same-Stop followup, then persists qualified evidence with no fourth wake", async () => {
    const f = await fixture()
    const first = await handleContinuityStop(f.stop(1), f.context)
    expect(first).toMatchObject({ decision: "block" })
    expect(JSON.stringify(first)).toContain("preparation")
    expect(JSON.stringify(first)).not.toContain("send_keys")
    const round = f.target().rounds[0]
    expect(round.phase).toBe("issued")
    expect(Buffer.byteLength(renderContinuityRoundInstruction(f.target(), round))).toBeLessThanOrEqual(16384)
    f.writeReceipt()
    const followup = await handleContinuityStop(f.stop(2), f.context)
    expect(followup).toMatchObject({ decision: "block" })
    expect(JSON.stringify(followup)).toContain("Are you sure")
    expect(f.target().rounds.map(value => value.kind)).toEqual(["preparation", "followup"])
    f.writeReceipt()
    expect(await handleContinuityStop(f.stop(3), f.context)).toEqual({})
    expect(f.target()).toMatchObject({ state: "verifying", projection: { goal: "Finish this disposable task" },
      assurance: { endReadiness: "agent-confirmed-as-of-native-boundary", backgroundCoverage: "unknown" } })
    expect(await handleContinuityStop(f.stop(4), f.context)).toEqual({})
    expect(f.target().rounds).toHaveLength(2)
  })
  it("ignores duplicate host transitions and never reissues a lost/missing receipt", async () => {
    const f = await fixture()
    await handleContinuityStop(f.stop(1), f.context)
    expect(await handleContinuityStop(f.stop(1), f.context)).toEqual({})
    expect(await handleContinuityStop(f.stop(2), f.context)).toEqual({})
    expect(f.target().rounds).toHaveLength(1)
    expect(f.target().state).toBe("uncertain")
    f.writeReceipt()
    expect(await handleContinuityStop(f.stop(3), f.context)).toEqual({})
    expect(f.target().rounds).toHaveLength(1)
  })
  it("uses at most one deterministic correction after followup, even with engine counter resets", async () => {
    const f = await fixture()
    await handleContinuityStop(f.stop(1), f.context)
    f.writeReceipt()
    await handleContinuityStop(f.stop(2), f.context)
    f.writeReceipt({ confirmation: false })
    expect(await handleContinuityStop({ ...f.stop(3), stopHookActive: false }, f.context)).toMatchObject({ decision: "block" })
    expect(f.target().rounds.map(round => round.kind)).toEqual(["preparation", "followup", "correction"])
    f.writeReceipt({ confirmation: false })
    expect(await handleContinuityStop(f.stop(4), f.context)).toEqual({})
    expect(f.target().state).toBe("blocked")
    expect(await handleContinuityStop(f.stop(5), f.context)).toEqual({})
    expect(f.target().rounds).toHaveLength(3)
  })
  it("correlates a correction receipt and never treats malformed/missing nonce as consumption", async () => {
    const f = await fixture()
    await handleContinuityStop(f.stop(1), f.context)
    f.writeReceipt({ nonce: "other" })
    expect(await handleContinuityStop(f.stop(2), f.context)).toEqual({})
    expect(f.target()).toMatchObject({ state: "uncertain", rounds: [{ phase: "uncertain" }] })
  })
  it("permits one checkpoint correction at the final boundary but no async late wake", async () => {
    const f = await fixture()
    await handleContinuityStop(f.stop(1), f.context)
    f.writeReceipt()
    await handleContinuityStop(f.stop(2), f.context)
    f.writeReceipt({ corruptCheckpoint: true })
    expect(await handleContinuityStop(f.stop(3), f.context)).toMatchObject({ decision: "block" })
    f.writeReceipt()
    expect(await handleContinuityStop(f.stop(4), f.context)).toEqual({})
    expect(f.target().assurance.endReadiness).toBe("agent-confirmed-as-of-native-boundary")
    expect(await handleContinuityStop(f.stop(5), f.context)).toEqual({})
    expect(f.target().rounds).toHaveLength(3)
  })
  it("blocks mismatched generations and unsupported installed versions without a terminal fallback", async () => {
    const f = await fixture()
    f.actor.birth = "darwin:101:10"
    expect(await handleContinuityStop(f.stop(1), f.context)).toEqual({})
    expect(f.target().state).toBe("blocked")
    const codex = await fixture("codex")
    codex.profile.version = "0.999.0"
    expect(await handleContinuityStop(codex.stop(1), codex.context)).toEqual({})
    expect(codex.target().state).toBe("unsupported")
  })
  it("leaves other agents, interrupted boundaries and cancelled batches untouched", async () => {
    const f = await fixture()
    expect(await handleContinuityStop(f.stop(1), { ...f.context, agent: "other" })).toEqual({})
    expect(await handleContinuityStop({ ...f.stop(2), normal: false }, f.context)).toEqual({})
    expect(f.target().rounds).toHaveLength(0)
    await transactContinuity(f.file, undefined, state => { state.batches[0].cancellation = "cancelling" })
    expect(await handleContinuityStop(f.stop(3), f.context)).toEqual({})
    expect(f.target().rounds).toHaveLength(0)
  })
  it("fails closed when native caller inspection stalls beyond the two-second budget", async () => {
    const f = await fixture()
    vi.useFakeTimers()
    try {
      const pending = handleContinuityStop(f.stop(1), { ...f.context, processDeps: { ...f.processDeps, inspect: () => new Promise(() => {}) } })
      await vi.advanceTimersByTimeAsync(2000)
      expect(await pending).toEqual({})
      expect(f.target().state).toBe("unsupported")
    } finally { vi.useRealTimers() }
  })
  it("does not reissue a reserved round after a callback crash before stdout", async () => {
    const f = await fixture()
    await handleContinuityStop(f.stop(1), f.context)
    await transactContinuity(f.file, undefined, state => { state.batches[0].targets[0].rounds[0].phase = "reserved" })
    expect(await handleContinuityStop(f.stop(2), f.context)).toEqual({})
    expect(f.target()).toMatchObject({ state: "uncertain", rounds: [{ phase: "uncertain" }] })
    expect(f.target().rounds).toHaveLength(1)
  })
  it("allows the required followup to repair an acknowledged preparation's bad checkpoint", async () => {
    const f = await fixture()
    await handleContinuityStop(f.stop(1), f.context)
    f.writeReceipt({ corruptCheckpoint: true })
    expect(await handleContinuityStop(f.stop(2), f.context)).toMatchObject({ decision: "block" })
    expect(f.target().reasons).toEqual(["checkpoint-unverified"])
    f.writeReceipt()
    expect(await handleContinuityStop(f.stop(3), f.context)).toEqual({})
    expect(f.target().assurance.endReadiness).toBe("agent-confirmed-as-of-native-boundary")
  })
  it("rejects native cwd/config/profile mismatches and missing reserved slot authority", async () => {
    for (const field of ["cwd", "config", "profile", "slot"]) {
      const f = await fixture()
      if (field === "cwd") {
        expect(await handleContinuityStop({ ...f.stop(1), cwd: `${f.home}/other` }, f.context)).toEqual({})
        expect(f.target().reasons).toEqual(["native-cwd"])
      } else if (field === "config") {
        expect(await handleContinuityStop(f.stop(1), { ...f.context, configFingerprint: "d".repeat(64) })).toEqual({})
        expect(f.target().reasons).toEqual(["native-binding"])
      } else if (field === "profile") {
        f.profile.fingerprint = "d".repeat(64)
        expect(await handleContinuityStop(f.stop(1), f.context)).toEqual({})
        expect(f.target().reasons).toEqual(["native-binding"])
      } else {
        await handleContinuityStop(f.stop(1), f.context)
        f.writeReceipt()
        await transactContinuity(f.file, undefined, state => { state.batches[0].targets[0].rounds[0].receiptSlot = "other.json" })
        expect(await handleContinuityStop(f.stop(2), f.context)).toEqual({})
        expect(f.target().reasons).toEqual(["receipt-unacknowledged"])
      }
    }
  })
  it("does not continue ambiguous own sessions, stale enrollment epochs or malformed state", async () => {
    const f = await fixture()
    await transactContinuity(f.file, undefined, state => {
      const next = structuredClone(state.batches[0])
      next.id = "batch2"
      next.requestId = "request2"
      next.origin.requestId = "request2"
      const target = next.targets[0]
      target.id = "target2"
      target.binding.id = "binding2"
      target.binding.surfaceId = "surface2"
      target.binding.taskRef = "track/other"
      target.binding.taskKey = `${f.home}:track/other`
      createContinuityBatch(state, next)
    })
    expect(await handleContinuityStop(f.stop(1), f.context)).toEqual({})
    expect(f.target().rounds).toHaveLength(0)
    expect(f.target().state).toBe("blocked")
    const epoch = await fixture("copilot", false)
    epoch.batch.targets[0].binding.enrollmentEpoch = "not-observed"
    await transactContinuity(epoch.file, undefined, state => createContinuityBatch(state, epoch.batch))
    expect(await handleContinuityStop(epoch.stop(1), epoch.context)).toEqual({})
    expect(epoch.target().state).toBe("blocked")
    const stale = await fixture()
    // A selected binding cannot be edited; changing trusted config creates a different enrollment.
    expect(await handleContinuityStop(stale.stop(1), { ...stale.context, profiles: [] })).toEqual({})
    expect(stale.target().state).toBe("unsupported")
  })
  it("rejects oversized block instructions rather than truncating their path or nonce", async () => {
    const f = await fixture()
    const target = f.target()
    target.reasons = Array.from({ length: 64 }, () => "x".repeat(4096))
    expect(() => renderContinuityRoundInstruction(target, {
      batchId: "batch1", kind: "preparation", nonce: "nonce", receiptSlot: ".receipts/x.json",
      attemptId: "attempt", expectedRevision: 0, phase: "reserved",
    })).toThrow(/byte limit/)
  })
  it("validates malformed raw native flags, timestamps and snake-case events", () => {
    expect(() => parseNativeContinuityStop("copilot", { sessionId: "id", cwd: "/desk", timestamp: "invalid", stopReason: "end_turn" })).toThrow()
    expect(() => parseNativeContinuityStop("copilot", { sessionId: "id", cwd: "/desk", timestamp: "2026-10-15T04:00:00Z",
      stopReason: "end_turn", stop_hook_active: "yes" })).toThrow()
    expect(() => parseNativeContinuityStop("claude", { session_id: "id", cwd: "/desk", stop_hook_active: false })).toThrow()
    expect(() => parseNativeContinuityStop("claude", { session_id: "id", cwd: "/desk", hook_event_name: "Stop" })).toThrow()
    expect(parseNativeContinuityStop("claude", { session_id: "id", cwd: "/desk", stop_hook_active: true, hook_event_name: "Other" }).normal).toBe(false)
  })
  it("supports end-only bindings with null profile metadata and OS cwd unavailable", async () => {
    const f = await fixture("claude", false)
    f.batch.targets[0].binding.profileId = null
    f.batch.targets[0].binding.profileFingerprint = null
    await transactContinuity(f.file, undefined, state => createContinuityBatch(state, f.batch))
    const inspect = f.processDeps.inspect!
    f.processDeps.inspect = async pid => {
      const value = await inspect(pid)
      return value.state === "present" ? { ...value, cwd: null } : value
    }
    expect(await handleContinuityStop(f.stop(1), f.context)).toMatchObject({ decision: "block" })
  })
  it("uses short lock waits and refuses progress without inventing an empty successful store", async () => {
    const f = await fixture()
    const db = new Database(f.file)
    db.exec("BEGIN IMMEDIATE")
    try {
      const start = performance.now()
      expect(await handleContinuityStop(f.stop(1), f.context)).toEqual({})
      expect(performance.now() - start).toBeLessThan(2000)
      expect(f.target().rounds).toHaveLength(0)
    } finally { db.exec("ROLLBACK"); db.close() }
  })
  it("does not publish a reserved instruction when cancellation wins the revision race", async () => {
    const f = await fixture()
    const original = continuityStore.transactContinuity
    let calls = 0
    vi.spyOn(continuityStore, "transactContinuity").mockImplementation(async (...args) => {
      const result = await Reflect.apply(original, undefined, args)
      if (++calls === 2) {
        await original(f.file, result.revision, state => { state.batches[0].cancellation = "cancelling" })
      }
      return result
    })
    expect(await handleContinuityStop(f.stop(1), f.context)).toEqual({})
    expect(readContinuityState(f.file).batches[0].cancellation).toBe("cancelling")
    expect(f.target().rounds[0].phase).toBe("reserved")
  })
  it("does not issue after its reservation consumes the native time budget", async () => {
    const f = await fixture()
    let now = 0
    vi.spyOn(Date, "now").mockImplementation(() => now)
    const original = continuityStore.transactContinuity
    let calls = 0
    vi.spyOn(continuityStore, "transactContinuity").mockImplementation(async (...args) => {
      const result = await Reflect.apply(original, undefined, args)
      if (++calls === 2) now = 2000
      return result
    })
    expect(await handleContinuityStop(f.stop(1), f.context)).toEqual({})
    expect(f.target().rounds[0].phase).toBe("reserved")
  })
  it("does not reserve if native verification already consumed the callback budget", async () => {
    const f = await fixture()
    let now = 0
    let reads = 0
    vi.spyOn(Date, "now").mockImplementation(() => now)
    const inspect = f.processDeps.inspect!
    f.processDeps.inspect = async pid => {
      const result = await inspect(pid)
      if (++reads === 4) now = 2000
      return result
    }
    expect(await handleContinuityStop(f.stop(1), f.context)).toEqual({})
    expect(f.target().rounds).toHaveLength(0)
  })
  it("fails unsupported unprepared callbacks without creating guessed enrollments", async () => {
    const f = await fixture("copilot", false)
    f.profile.version = "unverified"
    expect(await handleContinuityStop(f.stop(1), f.context)).toEqual({})
    expect(readContinuityState(f.file).enrollments).toHaveLength(1)
  })
  it("retains an uncertain reservation when persistence fails before issued/output", async () => {
    const f = await fixture()
    const original = continuityStore.transactContinuity
    let calls = 0
    vi.spyOn(continuityStore, "transactContinuity").mockImplementation(async (...args) => {
      if (++calls === 3) throw new Error("fixture persistence interruption")
      return Reflect.apply(original, undefined, args)
    })
    expect(await handleContinuityStop(f.stop(1), f.context)).toEqual({})
    expect(f.target()).toMatchObject({ state: "uncertain", rounds: [{ phase: "reserved" }] })
    expect(await handleContinuityStop(f.stop(2), f.context)).toEqual({})
    expect(f.target().rounds).toHaveLength(1)
  })
  it("persists the same bounded multiline narrative accepted by the evidence schema", async () => {
    const f = await fixture()
    await handleContinuityStop(f.stop(1), f.context)
    f.writeReceipt({ nextAction: "Run the test\nThen reconcile its result" })
    expect(await handleContinuityStop(f.stop(2), f.context)).toMatchObject({ decision: "block" })
    f.writeReceipt({ nextAction: "Run the test\nThen reconcile its result" })
    expect(await handleContinuityStop(f.stop(3), f.context)).toEqual({})
    expect(f.target().projection?.nextAction).toBe("Run the test\nThen reconcile its result")
  })
  it("does not lose or reissue the existing issued round when followup reservation fails", async () => {
    const f = await fixture()
    await handleContinuityStop(f.stop(1), f.context)
    f.writeReceipt()
    const original = continuityStore.transactContinuity
    let calls = 0
    vi.spyOn(continuityStore, "transactContinuity").mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error("fixture followup reservation failure")
      return Reflect.apply(original, undefined, args)
    })
    expect(await handleContinuityStop(f.stop(2), f.context)).toEqual({})
    expect(f.target()).toMatchObject({ state: "uncertain", rounds: [{ phase: "issued" }] })
    expect(await handleContinuityStop(f.stop(3), f.context)).toEqual({})
    expect(f.target().rounds).toHaveLength(1)
  })
})
