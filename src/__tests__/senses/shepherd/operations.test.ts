import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { runShepherdOperation, type ShepherdOperationDeps } from "../../../senses/shepherd/operations"
import { readGuidance } from "../../../senses/shepherd/guidance"
import { checkInStorePath, openCheckInStore, type DispatchInput } from "../../../senses/shepherd/checkin-store"
import { readCheckInSnapshot } from "../../../senses/shepherd/recovery"
import { readShepherdMandates } from "../../../heart/shepherd/mandates"

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, renameSync: vi.fn(actual.renameSync), writeFileSync: vi.fn(actual.writeFileSync), unlinkSync: vi.fn(actual.unlinkSync) }
})

let root: string
let deps: ShepherdOperationDeps
let sessions: Array<{ id: string; cwd: string; instance: string }>
const admin = { agent: "ouro", expectedRevision: 0, requestId: "request-1" }
function claim(overrides: Partial<DispatchInput> = {}, state: "unknown" | "not_sent" = "unknown") {
  const store = openCheckInStore(checkInStorePath(root))
  try {
    const result = store.claimDispatch({
      host: "cmux", session: "terminal-1", instance: "pid:7:start:42", screenFingerprint: "screen",
      guidanceRevision: "0", reply: "Continue.", trigger: "immediate", transition: "stop", at: new Date().toISOString(), ...overrides,
    }, "test-worker")!
    store.completeDispatch(result.id, "test-worker", { state, reason: state === "unknown" ? "timeout" : "refused" })
    return result.id
  } finally { store.close() }
}

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  vi.mocked(fs.renameSync).mockReset().mockImplementation(actual.renameSync)
  vi.mocked(fs.writeFileSync).mockReset().mockImplementation(actual.writeFileSync)
  vi.mocked(fs.unlinkSync).mockReset().mockImplementation(actual.unlinkSync)
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-operations-")))
  sessions = [{ id: "terminal-1", cwd: root, instance: "pid:7:start:42" }]
  deps = {
    agentRoot: () => root,
    resolveOwner: async () => ({ actorId: "existing-local-owner" }),
    host: async () => ({ name: "cmux", list: async () => sessions, retirementInventory: async () => sessions.map(session => session.id) }),
    senseStopped: async () => ({ kind: "daemon_lifecycle", checkedAt: new Date().toISOString(), enabled: false, processState: "stopped" }),
  }
})

describe("trusted local-owner operation composition", () => {
  it("inspects without host access and grants fully scoped mandates with unprefixed revocation", async () => {
    const id = claim()
    expect(await runShepherdOperation({ kind: "shepherd.inspect", agent: "ouro", limit: 1, id }, deps))
      .toMatchObject({ entries: [expect.objectContaining({ id })] })
    await runShepherdOperation({
      kind: "shepherd.mandate.grant", ...admin, project: root, task: "Finish tests",
      expiresAt: new Date(Date.now() + 60_000).toISOString(), host: "cmux", session: "terminal-1", instance: "pid:7:start:42",
    }, deps)
    const mandate = readShepherdMandates(root).mandates[0]!
    expect(mandate.target).toMatchObject({ host: "cmux", session: "terminal-1", instance: "pid:7:start:42" })
    await runShepherdOperation({
      kind: "shepherd.mandate.revoke", ...admin, expectedRevision: 1, requestId: "revoke", id: mandate.id.slice("mandate:".length),
    }, deps)
    expect(readShepherdMandates(root).mandates[0]!.status).toBe("revoked")
  })

  it("rejects missing or ambiguous live terminals and handles a verified terminal without cwd", async () => {
    const command = { kind: "shepherd.pause" as const, ...admin, host: "cmux" as const, session: "terminal-1" }
    sessions = []
    await expect(runShepherdOperation(command, deps)).rejects.toThrow(/unique verified/)
    sessions = Array.from({ length: 2 }, () => ({ id: "terminal-1", cwd: root, instance: "process" }))
    await expect(runShepherdOperation(command, deps)).rejects.toThrow(/unique verified/)
    deps.host = async () => ({ name: "cmux", list: async () => [{ id: "terminal-1" }] })
    await runShepherdOperation(command, deps)
    expect(readGuidance(root).pauses[0]).toMatchObject({ paused: true, session: "terminal-1" })
  })

  it("refuses nonexistent dispatches, wrong custody hosts and unsupported operations", async () => {
    const command = { kind: "shepherd.reconcile" as const, ...admin, id: "a".repeat(64), resolution: "retired" as const }
    await expect(runShepherdOperation(command, deps)).rejects.toThrow(/dispatch not found/)
    const id = claim()
    deps.host = async () => ({ name: "herdr", list: async () => [] })
    await expect(runShepherdOperation({ ...command, id }, deps)).rejects.toThrow(/custody host/)
    await expect(Reflect.apply(runShepherdOperation, undefined, [{ ...admin, kind: "unsupported" }, deps]))
      .rejects.toThrow(/unsupported/)
  })

  it("refuses missing custody, incomplete retirement inventories and relative archive paths", async () => {
    const command = { kind: "shepherd.maintenance" as const, ...admin, destination: path.join(root, "archive") }
    await expect(runShepherdOperation(command, deps)).rejects.toThrow(/store is missing/)
    deps.host = async () => ({ name: "cmux", list: async () => [] })
    await expect(runShepherdOperation(command, deps)).rejects.toThrow(/inventory/)
    claim()
    deps.host = async () => ({ name: "cmux", list: async () => [], retirementInventory: async () => [] })
    await expect(runShepherdOperation({ ...command, destination: "relative" }, deps)).rejects.toThrow(/absolute/)
    expect(fs.existsSync(command.destination)).toBe(false)
  })

  it("deduplicates repeated retired process instances before archiving", async () => {
    claim({}, "not_sent")
    claim({ transition: "second-stop", screenFingerprint: "second-screen" }, "not_sent")
    sessions = []
    expect(await runShepherdOperation({
      kind: "shepherd.maintenance", ...admin,
      expectedRevision: readCheckInSnapshot(checkInStorePath(root), { limit: 1 }).revision!, destination: path.join(root, "archive"),
    }, deps)).toMatchObject({ archivedCount: 2 })
  })

  it("bounds retirement evidence across pages without retiring present or foreign-host terminals", async () => {
    claim({ host: "herdr", session: "foreign" })
    claim()
    for (let index = 0; index < 201; index++) claim({ session: `retired-${index}` })
    await expect(runShepherdOperation({
      kind: "shepherd.maintenance", ...admin, destination: path.join(root, "archive"),
    }, deps)).rejects.toThrow(/exceeds 200 retired instances/)
    expect(fs.existsSync(path.join(root, "archive"))).toBe(false)
  })

  it.each(["copying", "prepared", "swapped"])("resumes the actual maintenance operation after a %s interruption", async stage => {
    const id = claim()
    sessions = []
    await runShepherdOperation({
      kind: "shepherd.reconcile", ...admin, id, resolution: "retired",
      expectedRevision: readCheckInSnapshot(checkInStorePath(root), { limit: 1 }).revision!,
    }, deps)
    const command = {
      kind: "shepherd.maintenance" as const, ...admin, requestId: "archive",
      expectedRevision: readCheckInSnapshot(checkInStorePath(root), { limit: 1 }).revision!, destination: path.join(root, "archives"),
    }
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
    const file = checkInStorePath(root)
    if (stage === "copying") {
      vi.mocked(fs.writeFileSync).mockImplementation((candidate, data, options) => {
        if (String(candidate).includes("/archives/custody-") && data === "") throw new Error("interrupted fixture")
        return actual.writeFileSync(candidate, data, options)
      })
    } else if (stage === "prepared") {
      vi.mocked(fs.renameSync).mockImplementation((from, to) => {
        if (String(from).includes(".replacement-") && String(to) === file) throw new Error("interrupted fixture")
        return actual.renameSync(from, to)
      })
    } else {
      vi.mocked(fs.unlinkSync).mockImplementation(candidate => {
        if (String(candidate) === `${file}.maintenance.json`) throw new Error("interrupted fixture")
        return actual.unlinkSync(candidate)
      })
    }
    await expect(runShepherdOperation(command, deps)).rejects.toThrow("interrupted fixture")
    vi.mocked(fs.writeFileSync).mockImplementation(actual.writeFileSync)
    vi.mocked(fs.renameSync).mockImplementation(actual.renameSync)
    vi.mocked(fs.unlinkSync).mockImplementation(actual.unlinkSync)
    expect(() => readCheckInSnapshot(file, { limit: 1 })).toThrow(/maintenance/)
    expect(await runShepherdOperation(command, deps)).toMatchObject({ archivedCount: 1, retainedCount: 0 })
    expect(fs.existsSync(`${file}.maintenance.json`)).toBe(false)
  })

  it("reports unavailable observation and missing custody honestly without contacting the host", async () => {
    deps.host = vi.fn()
    const result = await runShepherdOperation({ kind: "shepherd.status", agent: "ouro" }, deps)
    expect(result).toMatchObject({
      supervision: { freshness: { status: "unknown" } }, custody: { state: "missing", totalCount: null },
      automation: { mode: "legacy_unqualified", mandatesEnforcedForAllTriggers: false, unattendedKeysPossible: false },
    })
    expect(deps.host).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(root, "state"))).toBe(false)
  })

  it("grants and revokes exact mandates with resolved local-owner provenance and request retries", async () => {
    const command = {
      kind: "shepherd.mandate.grant" as const, ...admin, project: root, task: "Finish the approved tests.",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    const receipt = await runShepherdOperation(command, deps)
    expect(await runShepherdOperation(command, deps)).toEqual(receipt)
    const state = readShepherdMandates(root)
    expect(state.mandates[0]).toMatchObject({ target: { project: root }, provenance: { actorId: "existing-local-owner" } })
    await runShepherdOperation({ kind: "shepherd.mandate.revoke", ...admin, expectedRevision: 1, requestId: "revoke", id: state.mandates[0]!.id }, deps)
    expect(readShepherdMandates(root).mandates[0]!.status).toBe("revoked")
  })

  it("authenticates before creating state or resolving a host", async () => {
    deps.resolveOwner = async () => { throw new Error("existing local owner required") }
    deps.host = vi.fn()
    await expect(runShepherdOperation({ kind: "shepherd.pause", ...admin, host: "cmux", session: "terminal-1" }, deps))
      .rejects.toThrow("existing local owner required")
    expect(deps.host).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(root, "state"))).toBe(false)
  })

  it("pauses only a verified host identity and preserves idempotence when its cwd changes", async () => {
    const command = { kind: "shepherd.pause" as const, ...admin, host: "cmux" as const, session: "terminal-1" }
    const first = await runShepherdOperation(command, deps)
    expect(readGuidance(root).pauses[0]).toMatchObject({ host: "cmux", session: "terminal-1", paused: true })
    sessions[0]!.cwd = "/changed"
    expect(await runShepherdOperation(command, deps)).toEqual(first)
    await expect(runShepherdOperation({ ...command, requestId: "different-request" }, deps)).rejects.toThrow(/revision/i)
    await expect(runShepherdOperation({ ...command, host: "herdr", expectedRevision: 1, requestId: "wrong-host" }, deps)).rejects.toThrow(/host/i)
  })

  it("resuming does not release unknown custody", async () => {
    const id = claim()
    await runShepherdOperation({ kind: "shepherd.resume", ...admin, host: "cmux", session: "terminal-1" }, deps)
    expect(readCheckInSnapshot(checkInStorePath(root), { limit: 10 }).entries.find(entry => entry.id === id)?.state).toBe("unknown")
  })

  it("never treats a different foreground instance as retirement or caller intent as delivery proof", async () => {
    const id = claim()
    const expectedRevision = readCheckInSnapshot(checkInStorePath(root), { limit: 10 }).revision!
    sessions[0]!.instance = "pid:8:start:99"
    await expect(runShepherdOperation({ kind: "shepherd.reconcile", ...admin, expectedRevision, id, resolution: "retired" }, deps))
      .rejects.toThrow(/retire|still|inventory/i)
    await expect(runShepherdOperation({ kind: "shepherd.reconcile", ...admin, expectedRevision, id, resolution: "delivered" }, deps))
      .rejects.toThrow(/unsupported|receipt/i)
    expect(readCheckInSnapshot(checkInStorePath(root), { limit: 10 }).entries[0]!.reconciliations).toEqual([])
  })

  it("can retire a missing stable terminal, retaining original unknown outcome", async () => {
    const id = claim()
    sessions = []
    const expectedRevision = readCheckInSnapshot(checkInStorePath(root), { limit: 10 }).revision!
    await runShepherdOperation({ kind: "shepherd.reconcile", ...admin, expectedRevision, id, resolution: "retired" }, deps)
    expect(readCheckInSnapshot(checkInStorePath(root), { limit: 10 }).entries[0])
      .toMatchObject({ id, state: "unknown", retired: true })
  })

  it("refuses retirement without a strict host inventory even when ordinary list appears empty", async () => {
    const id = claim()
    deps.host = async () => ({ name: "cmux", list: async () => [] })
    const expectedRevision = readCheckInSnapshot(checkInStorePath(root), { limit: 10 }).revision!
    await expect(runShepherdOperation({ kind: "shepherd.reconcile", ...admin, expectedRevision, id, resolution: "retired" }, deps))
      .rejects.toThrow(/inventory/i)
  })

  it("refuses maintenance when lifecycle proof is unavailable before producing an archive", async () => {
    deps.senseStopped = async () => { throw new Error("daemon lifecycle unavailable") }
    await expect(runShepherdOperation({ kind: "shepherd.maintenance", ...admin, destination: path.join(root, "archive") }, deps))
      .rejects.toThrow("daemon lifecycle unavailable")
    expect(fs.existsSync(path.join(root, "archive"))).toBe(false)
  })

  it("archives only after actual quiescence and strict retirement, and retries the same intent after compaction", async () => {
    const id = claim()
    sessions = []
    await runShepherdOperation({
      kind: "shepherd.reconcile", ...admin, id, resolution: "retired",
      expectedRevision: readCheckInSnapshot(checkInStorePath(root), { limit: 1 }).revision!,
    }, deps)
    const command = {
      kind: "shepherd.maintenance" as const, ...admin, requestId: "archive",
      expectedRevision: readCheckInSnapshot(checkInStorePath(root), { limit: 1 }).revision!, destination: path.join(root, "archives"),
    }
    const receipt = await runShepherdOperation(command, deps)
    expect(receipt).toMatchObject({ archivedCount: 1, retainedCount: 0 })
    expect(await runShepherdOperation(command, deps)).toEqual(receipt)
    expect(readCheckInSnapshot(checkInStorePath(root), { limit: 1 }).totalCount).toBe(0)
  })
})
