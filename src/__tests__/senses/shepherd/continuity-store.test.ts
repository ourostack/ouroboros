import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cancelContinuityBatch, continuityHold, continuityStatePath, createContinuityBatch,
  readContinuityState, reserveContinuityClaim, reserveContinuityDispatch, transactContinuity,
} from "../../../senses/shepherd/continuity-store"
import type { ContinuityBatch, ContinuityBinding, ContinuityState } from "../../../senses/shepherd/continuity-types"

function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "continuity-store-")))
  return { home, file: continuityStatePath(home, "machine1") }
}

function binding(agent = "ouro", taskKey = "root:track/task"): ContinuityBinding {
  return {
    id: `binding-${agent}`, agent, host: "cmux", incarnation: "host-1", surfaceId: `surface-${agent}`,
    surfaceGeneration: "surface-1", nativeSessionId: `native-${agent}`, runner: "copilot",
    process: { pid: 100, birth: "1:123456789", uid: process.getuid!() }, wrapper: null,
    launchCwd: "/desk", worktree: "/code", rootId: "desk", taskRef: "track/task", taskKey,
    profileId: "worker", profileFingerprint: "a".repeat(64), configFingerprint: "b".repeat(64),
    enrollmentEpoch: "epoch1",
  }
}

function batch(agent = "ouro", taskKey = "root:track/task", requestId = `request-${agent}`): ContinuityBatch {
  return {
    id: `batch-${agent}`, agent, requestId, bodyHash: createHash("sha256").update(taskKey).digest("hex"),
    origin: { actorId: "operator", requestId }, createdAt: "2026-10-15T03:00:00.000Z", cancellation: "none",
    targets: [{
      id: `target-${agent}`, binding: binding(agent, taskKey), generation: 1,
      state: "pending-boundary", reopen: "not-requested", rounds: [], reasons: [],
      assurance: { checkpoint: "unverified", endReadiness: "unconfirmed", backgroundCoverage: "unknown", jobInventory: "unverified", reopen: "unverified", observedAt: null, qualifications: [] },
      receipt: null, launch: null,
    }],
  }
}

function dispatch(requestId = "dispatch1") {
  return { agent: "ouro", host: "cmux", surface: "surface-ouro", requestId, bodyHash: "c".repeat(64) }
}

async function holder(file: string, commitOnTerm = false): Promise<ChildProcess> {
  const sqliteModule = require.resolve("better-sqlite3")
  const script = `
    const Database = require(${JSON.stringify(sqliteModule)});
    const db = new Database(process.argv[1]);
    db.exec("BEGIN IMMEDIATE");
    const row = db.prepare("SELECT payload FROM continuity_state WHERE id=1").get();
    const state = JSON.parse(row.payload);
    state.revision++;
    db.prepare("UPDATE continuity_state SET revision=?, payload=? WHERE id=1").run(state.revision, JSON.stringify(state));
    process.stdout.write("held\\n");
    process.on("SIGTERM", () => { db.exec(${JSON.stringify(commitOnTerm ? "COMMIT" : "ROLLBACK")}); db.close(); process.exit(0); });
    setInterval(() => {}, 1000);
  `
  const child = spawn(process.execPath, ["-e", script, file], { stdio: ["ignore", "pipe", "pipe"] })
  const output = await once(child.stdout!, "data")
  expect(String(output[0])).toBe("held\n")
  return child
}

describe("machine continuity transaction authority", () => {
  afterEach(() => { vi.restoreAllMocks() })
  it("maps all agents to one machine store and refuses path-traversal machine IDs", () => {
    const f = fixture()
    expect(f.file).toBe(path.join(f.home, ".ouro-cli/state/shepherd-continuity/machine1/state.sqlite"))
    for (const id of ["", "../other", "/absolute", "x/y", "machine\n"]) {
      expect(() => continuityStatePath(f.home, id)).toThrow()
    }
    expect(() => continuityStatePath("relative", "machine1")).toThrow()
  })

  it("reads absent state without making files and persists restricted state across reopen", async () => {
    const f = fixture()
    expect(readContinuityState(f.file)).toMatchObject({ schemaVersion: 1, revision: 0, batches: [] })
    expect(fs.existsSync(path.dirname(f.file))).toBe(false)
    const result = await transactContinuity(f.file, 0, state => {
      createContinuityBatch(state, batch())
      return "created"
    })
    expect(result).toEqual({ revision: 1, result: "created" })
    expect(readContinuityState(f.file).batches).toHaveLength(1)
    expect(fs.statSync(f.file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(f.file)).mode & 0o777).toBe(0o700)
    for (const suffix of ["-wal", "-shm"]) {
      if (fs.existsSync(f.file + suffix)) expect(fs.statSync(f.file + suffix).mode & 0o777).toBe(0o600)
    }
  })

  it("serializes expected revisions and rolls back throwing or asynchronous callbacks", async () => {
    const f = fixture()
    await transactContinuity(f.file, 0, state => createContinuityBatch(state, batch()))
    await expect(transactContinuity(f.file, 0, () => "stale")).rejects.toThrow(/revision/)
    await expect(transactContinuity(f.file, 1, state => { state.batches = []; throw new Error("stop") })).rejects.toThrow("stop")
    await expect(transactContinuity(f.file, 1, async state => { state.batches = [] })).rejects.toThrow(/synchronous/)
    expect(readContinuityState(f.file)).toMatchObject({ revision: 1, batches: [{ id: "batch-ouro" }] })
  })

  it("freezes selection and deduplicates equal requests without accepting a changed body", async () => {
    const f = fixture()
    await transactContinuity(f.file, 0, state => {
      const original = batch()
      createContinuityBatch(state, original)
      original.targets.length = 0
      expect(createContinuityBatch(state, batch()).id).toBe("batch-ouro")
      expect(() => createContinuityBatch(state, batch("ouro", "root:other/task"))).toThrow(/request/)
    })
    expect(readContinuityState(f.file).batches[0].targets).toHaveLength(1)
  })

  it("excludes competing canonical task owners across agents and survives cancelled live actors", async () => {
    const f = fixture()
    await transactContinuity(f.file, 0, state => createContinuityBatch(state, batch()))
    await expect(transactContinuity(f.file, 1, state => createContinuityBatch(state, batch("other")))).rejects.toThrow(/owner/)
    await transactContinuity(f.file, 1, state => {
      expect(cancelContinuityBatch(state, "batch-ouro", "ouro")).toBe("cancelled")
    })
    await expect(transactContinuity(f.file, 2, state => reserveContinuityClaim(state, {
      taskKey: "root:track/task", agent: "other", batchId: "batch-other", targetId: "target-other",
      bindingId: "binding-other", phase: "source", actor: binding("other").process, attemptId: null,
    }))).rejects.toThrow(/owner/)
    expect(readContinuityState(f.file).claims[0].bindingId).toBe("binding-ouro")
  })

  it("creates shared holds that stop future dispatch but track already-reserved sends", async () => {
    const f = fixture()
    await transactContinuity(f.file, 0, state => {
      expect(reserveContinuityDispatch(state, dispatch()).phase).toBe("reserved")
      createContinuityBatch(state, batch())
      expect(continuityHold(state, "ouro", "cmux", "surface-ouro")?.batchId).toBe("batch-ouro")
      expect(continuityHold(state, "other", "cmux", "surface-ouro")).toBeNull()
      expect(() => reserveContinuityDispatch(state, dispatch("later"))).toThrow(/hold/)
      expect(reserveContinuityDispatch(state, dispatch()).phase).toBe("reserved")
      expect(() => reserveContinuityDispatch(state, { ...dispatch(), bodyHash: "d".repeat(64) })).toThrow(/request/)
      expect(cancelContinuityBatch(state, "batch-ouro", "ouro")).toBe("cancelling")
    })
    const recovered = readContinuityState(f.file)
    expect(recovered.dispatches).toHaveLength(1)
    expect(recovered.batches[0].cancellation).toBe("cancelling")
    expect(continuityHold(recovered, "ouro", "cmux", "surface-ouro")).not.toBeNull()
  })

  it("keeps issued-round and uncertain-launch claims held across cancellation and recovery", async () => {
    const f = fixture()
    await transactContinuity(f.file, 0, state => {
      createContinuityBatch(state, batch())
      const target = state.batches[0].targets[0]
      target.rounds.push({ kind: "preparation", nonce: "nonce", receiptSlot: "receipts/preparation.json", phase: "issued", attemptId: "attempt", expectedRevision: 0 })
      expect(cancelContinuityBatch(state, "batch-ouro", "ouro")).toBe("cancelling")
      state.claims[0].phase = "uncertain"
      state.claims[0].attemptId = "launch-attempt"
    })
    const recovered = readContinuityState(f.file)
    expect(recovered.batches[0].targets[0].rounds[0].phase).toBe("issued")
    expect(recovered.claims[0]).toMatchObject({ phase: "uncertain", attemptId: "launch-attempt" })
    expect(() => reserveContinuityClaim(recovered, { ...recovered.claims[0], bindingId: "replacement" })).toThrow(/owner/)
  })

  it("rejects malformed schema and bounded-state overflow without dropping existing claims", async () => {
    const f = fixture()
    await transactContinuity(f.file, 0, state => createContinuityBatch(state, batch()))
    for (const mutation of [
      (state: ContinuityState) => { state.schemaVersion = 2 as 1 },
      (state: ContinuityState) => { state.batches[0].targets[0].state = "made-up" as "ready" },
      (state: ContinuityState) => { state.batches[0].targets[0].reasons = ["x".repeat(2 * 1024 * 1024)] },
      (state: ContinuityState) => { state.batches = Array.from({ length: 129 }, () => batch()) },
      (state: ContinuityState) => { state.batches[0].targets = Array.from({ length: 257 }, () => batch().targets[0]) },
    ]) await expect(transactContinuity(f.file, 1, mutation)).rejects.toThrow()
    expect(readContinuityState(f.file).claims).toHaveLength(1)
    expect(readContinuityState(f.file).revision).toBe(1)
  })

  it("refuses symlink/unrestricted database paths and never replaces them", async () => {
    const f = fixture()
    await transactContinuity(f.file, 0, () => {})
    const alias = path.join(path.dirname(f.file), "alias.sqlite")
    fs.symlinkSync(f.file, alias)
    expect(() => readContinuityState(alias)).toThrow()
    await expect(transactContinuity(alias, undefined, () => {})).rejects.toThrow()
    fs.chmodSync(f.file, 0o666)
    expect(() => readContinuityState(f.file)).toThrow()
    await expect(transactContinuity(f.file, undefined, () => {})).rejects.toThrow()
    expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true)
  })

  it("does not break a suspended live writer's kernel lock because metadata is old", async () => {
    const f = fixture()
    await transactContinuity(f.file, 0, state => createContinuityBatch(state, batch()))
    const child = await holder(f.file, true)
    try {
      process.kill(child.pid!, "SIGSTOP")
      fs.utimesSync(f.file, new Date(0), new Date(0))
      await expect(transactContinuity(f.file, 1, state => createContinuityBatch(state, batch("other")), { busyTimeoutMs: 100 })).rejects.toThrow(/busy/)
      expect(readContinuityState(f.file).revision).toBe(1)
      process.kill(child.pid!, "SIGCONT")
      process.kill(child.pid!, "SIGTERM")
      await once(child, "exit")
      expect(readContinuityState(f.file).revision).toBe(2)
      expect(readContinuityState(f.file).claims[0].bindingId).toBe("binding-ouro")
      await transactContinuity(f.file, 2, state => createContinuityBatch(state, batch("other", "root:other/task")))
      expect(readContinuityState(f.file).revision).toBe(3)
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        process.kill(child.pid!, "SIGCONT")
        process.kill(child.pid!, "SIGKILL")
        await once(child, "exit")
      }
    }
  })

  it("rolls back only the killed fixture writer and preserves a successor's commits", async () => {
    const f = fixture()
    await transactContinuity(f.file, 0, () => {})
    const child = await holder(f.file)
    process.kill(child.pid!, "SIGKILL")
    await once(child, "exit")
    expect(readContinuityState(f.file).revision).toBe(1)
    await transactContinuity(f.file, 1, state => createContinuityBatch(state, batch()))
    expect(readContinuityState(f.file)).toMatchObject({ revision: 2, batches: [{ id: "batch-ouro" }] })
  })

  it("validates bounded transaction arguments before creating state", async () => {
    const f = fixture()
    for (const busyTimeoutMs of [-1, 5001, 0.5, NaN]) {
      await expect(transactContinuity(f.file, 0, () => {}, { busyTimeoutMs })).rejects.toThrow(/timeout/)
    }
    for (const revision of [-1, 0.5, NaN]) {
      await expect(transactContinuity(f.file, revision, () => {})).rejects.toThrow(/revision/)
    }
    await expect(transactContinuity(f.file, 0, () => Promise.resolve("unsafe"))).rejects.toThrow(/synchronous/)
    await transactContinuity(f.file, undefined, () => 1, { busyTimeoutMs: 0 })
    expect(readContinuityState(f.file).revision).toBe(1)
  })

  it("refuses duplicate keys and mismatched holds/claims/batch actors before commit", async () => {
    const f = fixture()
    await transactContinuity(f.file, 0, state => createContinuityBatch(state, batch()))
    const mutations: Array<(state: ContinuityState) => void> = [
      state => { state.batches.push(structuredClone(state.batches[0])) },
      state => { state.batches.push({ ...structuredClone(state.batches[0]), id: "another" }) },
      state => { state.batches[0].targets.push(structuredClone(state.batches[0].targets[0])) },
      state => { state.claims.push(structuredClone(state.claims[0])) },
      state => { state.holds.push(structuredClone(state.holds[0])) },
      state => { state.batches[0].origin.requestId = "wrong" },
      state => { state.batches[0].targets[0].binding.agent = "other" },
      state => { state.claims[0].batchId = "missing" },
      state => { state.claims[0].targetId = "missing" },
      state => { state.claims[0].taskKey = "wrong" },
      state => { state.claims[0].bindingId = "wrong" },
      state => { state.claims[0].actor = null },
      state => { state.holds[0].batchId = "missing" },
      state => { state.holds[0].targetId = "missing" },
      state => { state.holds[0].host = "wrong" },
      state => { state.holds[0].surface = "wrong" },
    ]
    for (const mutate of mutations) await expect(transactContinuity(f.file, 1, mutate)).rejects.toThrow()
    await transactContinuity(f.file, 1, state => {
      state.holds = []
      reserveContinuityDispatch(state, dispatch())
    })
    await expect(transactContinuity(f.file, 2, state => { state.dispatches.push(structuredClone(state.dispatches[0])) })).rejects.toThrow(/duplicate/)
  })

  it("enforces the 256-target total across multiple individually valid batches", async () => {
    const f = fixture()
    await expect(transactContinuity(f.file, 0, state => {
      state.batches = [batch(), batch("other", "root:other/task")]
      state.batches[0].targets = Array.from({ length: 128 }, (_, i) => ({ ...batch().targets[0], id: `one-${i}` }))
      state.batches[1].targets = Array.from({ length: 129 }, (_, i) => ({ ...batch("other").targets[0], id: `two-${i}` }))
    })).rejects.toThrow(/capacity/)
  })

  it("accepts exactly 2 MiB of validated state and refuses one extra UTF-8 byte", async () => {
    const f = fixture()
    let remaining = 0
    await transactContinuity(f.file, 0, state => {
      state.batches = [batch()]
      state.batches[0].targets = Array.from({ length: 9 }, (_, i) => ({
        ...batch().targets[0], id: `target-${i}`, reasons: Array.from({ length: 64 }, () => "x".repeat(4096)),
      }))
      state.revision = 1
      remaining = Buffer.byteLength(JSON.stringify(state)) - 2 * 1024 * 1024
      for (const target of state.batches[0].targets) {
        for (let i = 0; i < target.reasons.length && remaining > 0; i++) {
          const removed = Math.min(4095, remaining)
          target.reasons[i] = target.reasons[i].slice(removed)
          remaining -= removed
        }
      }
    })
    expect(remaining).toBe(0)
    expect(Buffer.byteLength(JSON.stringify(readContinuityState(f.file)))).toBe(2 * 1024 * 1024)
    await expect(transactContinuity(f.file, 1, state => { state.batches[0].targets[0].reasons[0] += "x" })).rejects.toThrow(/byte capacity/)
    expect(readContinuityState(f.file).revision).toBe(1)
  })

  it("refuses conflicting reservation identities and changed selections even with a copied body hash", async () => {
    const f = fixture()
    await transactContinuity(f.file, 0, state => {
      createContinuityBatch(state, batch())
      const claim = state.claims[0]
      expect(reserveContinuityClaim(state, structuredClone(claim))).toBe(claim)
      for (const change of [{ batchId: "other" }, { targetId: "other" }, { agent: "other" }, { attemptId: "other" }]) {
        expect(() => reserveContinuityClaim(state, { ...claim, ...change })).toThrow(/owner/)
      }
      const changed = batch()
      changed.targets[0].binding.worktree = "/different"
      expect(() => createContinuityBatch(state, changed)).toThrow(/request/)
      const sameId = batch()
      sameId.requestId = "new-request"
      sameId.origin.requestId = sameId.requestId
      expect(() => createContinuityBatch(state, sameId)).toThrow(/batch ID/)
      const sameSurface = batch("ouro", "root:other/task", "another-request")
      sameSurface.id = "batch2"
      expect(() => createContinuityBatch(state, sameSurface)).toThrow(/hold/)
      expect(() => cancelContinuityBatch(state, "batch-ouro", "other")).toThrow(/belong/)
    })
  })

  it("does not reissue a dispatch reservation after recovery or a different host/surface request", async () => {
    const f = fixture()
    await transactContinuity(f.file, 0, state => {
      expect(reserveContinuityDispatch(state, dispatch()).newlyReserved).toBe(true)
      expect(reserveContinuityDispatch(state, dispatch()).newlyReserved).toBe(false)
      for (const change of [{ host: "other" }, { surface: "other" }]) {
        expect(() => reserveContinuityDispatch(state, { ...dispatch(), ...change })).toThrow(/request/)
      }
      state.dispatches[0].phase = "uncertain"
    })
    await transactContinuity(f.file, 1, state => {
      expect(reserveContinuityDispatch(state, dispatch())).toMatchObject({ phase: "uncertain", newlyReserved: false })
    })
  })

  it("keeps a created replacement held, but releases a terminal round's routine-send hold", async () => {
    const f = fixture()
    await transactContinuity(f.file, 0, state => {
      createContinuityBatch(state, batch())
      const target = state.batches[0].targets[0]
      target.launch = {
        attemptId: "attempt", bootstrapNonce: "nonce", bootstrapSlot: "slot", phase: "created",
        nativeSessionId: "new", wrapper: null, actor: binding().process, workspaceId: "workspace", surfaceId: "surface",
        executeNonce: null, executeSlot: null, milestones: ["created"],
      }
      expect(cancelContinuityBatch(state, "batch-ouro", "ouro")).toBe("cancelling")
      target.launch = null
      target.rounds = [{ kind: "preparation", nonce: "n", receiptSlot: "r", phase: "acknowledged", attemptId: "a", expectedRevision: 0 }]
      expect(cancelContinuityBatch(state, "batch-ouro", "ouro")).toBe("cancelled")
      expect(continuityHold(state, "ouro", "cmux", "surface-ouro")).toBeNull()
    })
  })

  it("refuses corrupt persisted rows without inventing an empty successful state", async () => {
    for (const sql of [
      "DELETE FROM continuity_state",
      "UPDATE continuity_state SET revision=-1",
      "UPDATE continuity_state SET revision=2",
      "UPDATE continuity_state SET payload='not-json'",
      `UPDATE continuity_state SET payload='${"x".repeat(2 * 1024 * 1024 + 1)}'`,
    ]) {
      const f = fixture()
      await transactContinuity(f.file, 0, () => {})
      const db = new Database(f.file)
      db.exec(sql)
      db.close()
      expect(() => readContinuityState(f.file)).toThrow()
    }
  })

  it("refuses directory/file symlinks, hardlinks and non-private continuity directories", async () => {
    const f = fixture()
    await transactContinuity(f.file, 0, () => {})
    fs.chmodSync(path.dirname(f.file), 0o755)
    expect(() => readContinuityState(f.file)).toThrow(/private/)
    fs.chmodSync(path.dirname(f.file), 0o700)
    const hardlink = path.join(f.home, "database-copy")
    fs.linkSync(f.file, hardlink)
    expect(() => readContinuityState(f.file)).toThrow(/file/)
    const g = fixture()
    fs.mkdirSync(path.join(g.home, "other"))
    fs.symlinkSync(path.join(g.home, "other"), path.join(g.home, ".ouro-cli"))
    await expect(transactContinuity(g.file, 0, () => {})).rejects.toThrow(/directory/)
    const h = fixture()
    await transactContinuity(h.file, 0, () => {})
    fs.renameSync(h.file, path.join(h.home, "old.sqlite"))
    fs.symlinkSync(path.join(h.home, "old.sqlite"), h.file)
    expect(() => readContinuityState(h.file)).toThrow(/file/)
  })

  it("detects a path identity swap during a transaction and never commits into a successor", async () => {
    const f = fixture()
    await transactContinuity(f.file, 0, () => {})
    await expect(transactContinuity(f.file, 1, state => {
      createContinuityBatch(state, batch())
      const old = path.join(f.home, "old.sqlite")
      fs.renameSync(f.file, old)
      fs.copyFileSync(old, f.file)
      fs.chmodSync(f.file, 0o600)
    })).rejects.toThrow(/identity changed/)
    expect(readContinuityState(f.file).revision).toBe(1)
  })

  it("handles races creating owned paths and propagates real filesystem failures", async () => {
    const mkdir = fs.mkdirSync.bind(fs)
    const f = fixture()
    vi.spyOn(fs, "mkdirSync").mockImplementationOnce((...args: Parameters<typeof fs.mkdirSync>) => {
      mkdir(...args)
      throw Object.assign(new Error("concurrent mkdir"), { code: "EEXIST" })
    })
    await transactContinuity(f.file, 0, () => {})
    const g = fixture()
    vi.mocked(fs.mkdirSync).mockImplementationOnce(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }) })
    await expect(transactContinuity(g.file, 0, () => {})).rejects.toThrow("denied")
    vi.restoreAllMocks()
    const open = fs.openSync.bind(fs)
    const h = fixture()
    vi.spyOn(fs, "openSync").mockImplementationOnce((...args: Parameters<typeof fs.openSync>) => {
      const fd = open(...args)
      fs.closeSync(fd)
      throw Object.assign(new Error("concurrent create"), { code: "EEXIST" })
    })
    await transactContinuity(h.file, 0, () => {})
    const j = fixture()
    vi.mocked(fs.openSync).mockImplementationOnce(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }) })
    await expect(transactContinuity(j.file, 0, () => {})).rejects.toThrow("denied")
  })

  it("rejects foreign directory ownership and propagates failed stat instead of guessing absence", async () => {
    const f = fixture()
    await transactContinuity(f.file, 0, () => {})
    const lstat = fs.lstatSync.bind(fs)
    vi.spyOn(fs, "lstatSync").mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
      const stat = lstat(...args)
      if (stat instanceof fs.Stats && args[0] === f.home) stat.uid = process.getuid!() + 100
      return stat
    })
    expect(() => readContinuityState(f.file)).toThrow(/directory/)
    vi.restoreAllMocks()
    vi.spyOn(fs, "lstatSync").mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
      if (args[0] === f.file) throw Object.assign(new Error("cannot stat"), { code: "EACCES" })
      return lstat(...args)
    })
    expect(() => readContinuityState(f.file)).toThrow("cannot stat")
    await expect(transactContinuity(f.file, 1, () => {})).rejects.toThrow("cannot stat")
  })

  it("rejects noncanonical or traversing database paths", async () => {
    const f = fixture()
    for (const file of ["relative", f.file.replace("/state.sqlite", "/../state.sqlite"), path.join(f.home, "state.sqlite")]) {
      expect(() => readContinuityState(file)).toThrow()
      await expect(transactContinuity(file, undefined, () => {})).rejects.toThrow()
    }
    fs.mkdirSync(path.dirname(f.file), { recursive: true, mode: 0o700 })
    expect(readContinuityState(f.file).revision).toBe(0)
  })

  it("preserves frozen selection and binding authority across all later transactions", async () => {
    const f = fixture()
    await transactContinuity(f.file, 0, state => createContinuityBatch(state, batch()))
    for (const mutate of [
      (state: ContinuityState) => { state.batches[0].targets[0].binding.process.pid = 999 },
      (state: ContinuityState) => { state.batches[0].targets[0].binding.worktree = "/substitution" },
      (state: ContinuityState) => { state.batches[0].targets[0].binding.launchCwd = "/substitution" },
      (state: ContinuityState) => { state.batches[0].targets[0].generation++ },
      (state: ContinuityState) => { state.batches[0].createdAt = "changed" },
      (state: ContinuityState) => { state.batches[0].bodyHash = "d".repeat(64) },
      (state: ContinuityState) => { state.batches[0].origin.actorId = "changed" },
      (state: ContinuityState) => { state.batches[0].targets = [] },
      (state: ContinuityState) => { state.batches = [] },
      (state: ContinuityState) => { state.claims[0].actor!.pid = 999 },
      (state: ContinuityState) => { state.claims[0].actor!.birth = "wrong" },
      (state: ContinuityState) => { state.claims[0].actor!.uid++ },
    ]) await expect(transactContinuity(f.file, 1, mutate)).rejects.toThrow()
    expect(readContinuityState(f.file).revision).toBe(1)
    expect(readContinuityState(f.file).batches[0].targets[0].binding.worktree).toBe("/code")
  })

  it("retains cancelling protection for an uncertain canonical claim with no returned launch object", async () => {
    const f = fixture()
    await transactContinuity(f.file, 0, state => {
      createContinuityBatch(state, batch())
      state.claims[0].phase = "uncertain"
      state.claims[0].attemptId = "unknown-launch"
      expect(cancelContinuityBatch(state, "batch-ouro", "ouro")).toBe("cancelling")
      expect(continuityHold(state, "ouro", "cmux", "surface-ouro")).not.toBeNull()
      expect(() => reserveContinuityDispatch(state, dispatch())).toThrow(/hold/)
    })
    expect(readContinuityState(f.file).claims[0].phase).toBe("uncertain")
  })
})
