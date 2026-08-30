import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const fault = vi.hoisted(() => ({ lstatPath: "", eventPath: "", eventReads: 0, renamePath: "", privilegedSpoolRoot: "" }))

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    lstatSync: ((candidate: fs.PathLike, ...args: unknown[]) => {
      if (String(candidate) === fault.lstatPath) throw Object.assign(new Error("lstat denied"), { code: "EACCES" })
      const value = (actual.lstatSync as (...values: unknown[]) => unknown)(candidate, ...args)
      return path.resolve(String(candidate)) === path.resolve(fault.privilegedSpoolRoot)
        ? new Proxy(value as fs.Stats, { get(target, property, receiver) { return property === "uid" ? 0 : Reflect.get(target, property, receiver) } })
        : value
    }) as typeof actual.lstatSync,
    readFileSync: ((candidate: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (candidate === "/proc/self/mountinfo" && fault.privilegedSpoolRoot) return `1 1 0:1 / ${fault.privilegedSpoolRoot} ro,nosuid - bind none ro\n`
      const value = (actual.readFileSync as (...values: unknown[]) => unknown)(candidate, ...args)
      if (String(candidate) !== fault.eventPath || ++fault.eventReads !== 2 || typeof value !== "string") return value
      const record = JSON.parse(value) as { disposition: Record<string, unknown> }
      return JSON.stringify({ ...record, disposition: { ...record.disposition, awaitId: "changed-await" } })
    }) as typeof actual.readFileSync,
    renameSync: ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (path.resolve(String(oldPath)) === path.resolve(fault.renamePath)) throw Object.assign(new Error("rename raced"), { code: "ENOENT" })
      return actual.renameSync(oldPath, newPath)
    }) as typeof actual.renameSync,
  }
})

const getAgentRoot = vi.fn()
vi.mock("../../heart/identity", () => ({ getAgentRoot: () => getAgentRoot(), getAgentName: () => "slugger" }))
vi.mock("../../heart/awaiting/await-alert", () => ({ deliverAwaitAlert: vi.fn().mockResolvedValue({ attempted: true, delivery: { status: "delivered_now" } }) }))

import { readVerifiedPendingObligations } from "../../arc/obligations"
import { claimExternalEvent, commitExternalEventDisposition, getExternalEventRoot, recordExternalEvent, scanPrivilegedEventSpool } from "../../heart/external-events/router"
import { awaitingToolDefinitions, inspectRelationshipFollowUp } from "../../repertoire/tools-awaiting"

const fileAwait = awaitingToolDefinitions.find((entry) => entry.tool.function.name === "await_condition")!
const resolveAwait = awaitingToolDefinitions.find((entry) => entry.tool.function.name === "resolve_await")!

describe("await authority filesystem failures", () => {
  let root: string
  let previousHome: string | undefined

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "await-fs-failure-"))
    previousHome = process.env.HOME
    process.env.HOME = root
    getAgentRoot.mockReturnValue(root)
    fault.lstatPath = ""
    fault.eventPath = ""
    fault.eventReads = 0
    fault.renamePath = ""
    fault.privilegedSpoolRoot = ""
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("preserves a request await when the obligation path cannot be inspected", async () => {
    const route = { friendId: "sibling", channel: "telegram", key: "telegram:777:888" }
    await fileAwait.handler({ name: "inspect_error", condition: "ready", cadence: "5m" }, {
      currentSession: { ...route, sessionPath: "/tmp/session.json" },
      relationshipAuthorization: { requestId: "request-inspect", authorizedContextScopes: [], advertisedToolNames: [], authorizeTool: vi.fn() },
    } as any)
    const [obligation] = readVerifiedPendingObligations(root)
    const obligationPath = path.join(root, "arc", "obligations", `${obligation!.id}.json`)
    fs.writeFileSync(obligationPath, "{not-json", "utf8")
    fault.lstatPath = obligationPath

    expect(() => inspectRelationshipFollowUp(root, { ...route, requestId: "request-inspect", awaitName: "inspect_error" })).toThrow("lstat denied")
  })

  it("rejects resolution when exact external-event authority changes between verification and use", async () => {
    const event = recordExternalEvent({ agent: "slugger", source: "guard", eventType: "health.observed", eventId: "race", observationRevision: "rev-1" }, { root: getExternalEventRoot() })
    const claim = claimExternalEvent(event.recordPath, { owner: "worker", expectedVersion: event.version, expectedGeneration: event.generation })
    commitExternalEventDisposition(event.recordPath, {
      owner: "worker",
      expectedVersion: claim.version,
      expectedGeneration: claim.generation,
      disposition: { classifiedRevision: "rev-1", classification: "snoozed", stewardPolicy: { kind: "none" }, decision: "silent", reason: "later", nextWake: { kind: "at", at: "2099-01-01T00:00:00.000Z" }, careId: null, awaitId: "event_race", actionRefs: ["bounded-action-receipt"], verificationRefs: ["bounded-verification-receipt"] },
    })
    await fileAwait.handler({ name: "event_race", condition: "ready", cadence: "5m", wake_at: "2099-01-01T00:00:00.000Z" }, {
      context: { friend: { id: "owner" } },
      currentExternalEvent: claim,
    } as any)
    fault.eventPath = event.recordPath
    fault.eventReads = 0

    await expect(resolveAwait.handler({ name: "event_race", verdict: "yes", observation: "ready" }, undefined)).rejects.toThrow("authority changed")
  })

  it("fails closed when a stale record lock is won by another contender during rename", () => {
    const eventRoot = path.join(root, "events")
    const event = recordExternalEvent({ agent: "slugger", source: "guard", eventType: "health.observed", eventId: "record-lock-race" }, { root: eventRoot })
    const lockPath = `${event.recordPath}.lock`
    fs.mkdirSync(lockPath)
    fs.utimesSync(lockPath, new Date(0), new Date(0))
    fault.renamePath = lockPath

    expect(() => claimExternalEvent(event.recordPath, { owner: "worker", expectedVersion: event.version, expectedGeneration: event.generation })).toThrow("record is busy")
  })

  it("leaves a stale privileged replay lock alone when another contender wins its rename", () => {
    const spoolRoot = path.join(root, "privileged-spool")
    const eventRoot = path.join(root, "privileged-events")
    const lockPath = path.join(eventRoot, "sanctuary", "sanctuary-usenet", ".privileged-replay.lock")
    fs.mkdirSync(spoolRoot, { recursive: true, mode: 0o755 })
    fs.chmodSync(spoolRoot, 0o755)
    fs.mkdirSync(lockPath, { recursive: true })
    fs.utimesSync(lockPath, new Date(0), new Date(0))
    fault.privilegedSpoolRoot = spoolRoot
    fault.renamePath = lockPath

    expect(scanPrivilegedEventSpool({ spoolRoot, eventRoot })).toEqual({ accepted: 0, rejected: 0, replayed: 0 })
    expect(fs.existsSync(lockPath)).toBe(true)
  })
})
