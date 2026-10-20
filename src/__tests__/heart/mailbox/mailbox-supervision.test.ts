import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildShepherdSupervisionView,
  shepherdObservationClockBarrier,
  type ShepherdSupervisionSnapshot,
} from "../../../heart/shepherd/supervision"
import { readMailboxSupervision } from "../../../heart/mailbox/mailbox-supervision"
import { registerGlobalLogSink, type LogEvent } from "../../../nerves"

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, fstatSync: vi.fn(actual.fstatSync), readSync: vi.fn(actual.readSync) }
})

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  vi.mocked(fs.fstatSync).mockReset().mockImplementation(actual.fstatSync)
  vi.mocked(fs.readSync).mockReset().mockImplementation(actual.readSync)
})

const now = Date.parse("2026-10-17T20:00:00.000Z")
const roots: string[] = []

function snapshot(): ShepherdSupervisionSnapshot {
  return {
    schemaVersion: 1,
    agentName: "slugger",
    observedAt: new Date(now).toISOString(),
    sourceHealth: { host: "ok", guidance: "ok", mandates: "ok", returns: "ok", custody: "ok", notices: "ok" },
    sessions: {
      totalCount: 1,
      truncated: false,
      items: [{
        host: "cmux", session: "pane:1", instance: "process:123:456", label: "test terminal",
        harness: "copilot", project: "/project", activity: "idle", observedAt: new Date(now).toISOString(),
        lastDecision: "done", lastAction: "let_through", lastReason: "Reported finished", lastActionAt: new Date(now).toISOString(),
        withheldReason: "No current mandate", authority: "absent", capability: "unsupported",
      }],
    },
    timeline: {
      totalCount: 1,
      truncated: false,
      items: [{ id: "return:1", host: "cmux", session: "pane:1", instance: "process:123:456",
        at: new Date(now).toISOString(), kind: "judgment", summary: "done" }],
    },
    custody: { revision: 0, bytes: 4096, capacity: "normal", claims: { totalCount: 0, truncated: false, items: [] } },
    sourceErrors: [],
  }
}

function fixture(value: unknown = snapshot()): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mailbox-supervision-"))
  roots.push(root)
  const dir = path.join(root, "state", "senses", "shepherd")
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, "supervision-observation.json")
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 })
  return { root, file }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("Shepherd supervision projection", () => {
  const managed = {
    kind: "agent_session", provider: "copilot", profileSha256: "a".repeat(64), qualification: "qualified",
    qualificationReason: null, workCoverage: "complete", renderCaptureStartedAt: new Date(now - 100).toISOString(),
  }

  it.each([null, "invalid"])("does not discharge a future-clock barrier when a read has no usable timestamp: %j", at => {
    expect(shepherdObservationClockBarrier(now + 60_000, at, now + 61_000)).toBe(now + 60_000)
  })

  it("reads managed replicas and weakens stale qualification and work coverage without mutating stored evidence", () => {
    const input = snapshot()
    Object.assign(input.sessions.items[0], { managed: { ...managed } })
    const { root, file } = fixture(input)
    const before = fs.readFileSync(file)
    const fresh = readMailboxSupervision("slugger", { agentRoot: root, nowMs: now })
    expect(fresh.sessions.items[0]).toMatchObject({ managed })
    const stale = readMailboxSupervision("slugger", { agentRoot: root, nowMs: now + 30_001 })
    expect(stale.sessions.items[0]).toMatchObject({ managed: {
      qualification: "unknown", qualificationReason: "observation_not_current", workCoverage: "unknown",
      renderCaptureStartedAt: "2026-10-17T19:59:59.900Z",
    } })
    expect(fs.readFileSync(file)).toEqual(before)
  })

  it("weakens managed readiness when the capture bound is stale even if inventory was just refreshed", () => {
    const input = snapshot()
    Object.assign(input.sessions.items[0], { managed: { ...managed, renderCaptureStartedAt: new Date(now - 30_001).toISOString() } })
    expect(buildShepherdSupervisionView(input, now).sessions.items[0]).toMatchObject({
      activity: "unknown", capability: "unknown", managed: { qualification: "unknown", workCoverage: "unknown" },
    })
  })

  it.each([
    { provider: "invented" }, { profileSha256: "not-a-digest" }, { qualification: "qualified", qualificationReason: "blocker" },
    { qualification: "unqualified", qualificationReason: null }, { workCoverage: "empty" },
    { renderCaptureStartedAt: "invalid" }, { renderCaptureStartedAt: new Date(now + 1).toISOString() },
    { token: "must-not-leak" },
  ])("rejects malformed managed replica metadata %j", patch => {
    const input = snapshot()
    Object.assign(input.sessions.items[0], { managed: { ...managed, ...patch } })
    const { root } = fixture(input)
    expect(readMailboxSupervision("slugger", { agentRoot: root, nowMs: now }).sourceErrors)
      .toContainEqual(expect.objectContaining({ code: "observation_invalid" }))
  })

  it("traces an unavailable observation without leaking source content, paths or raw errors", () => {
    const { root } = fixture({ private: "PRIVATE_OBSERVATION_SENTINEL" })
    const events: LogEvent[] = []
    const unregister = registerGlobalLogSink(event => events.push(event))
    try {
      expect(readMailboxSupervision("slugger", { agentRoot: root, nowMs: now }).freshness.status).toBe("unknown")
      expect(events).toContainEqual(expect.objectContaining({
        event: "heart.shepherd_observation_unavailable", meta: { code: "observation_invalid" },
      }))
      expect(JSON.stringify(events)).not.toContain("PRIVATE_OBSERVATION_SENTINEL")
      expect(JSON.stringify(events)).not.toContain(root)
    } finally { unregister() }
  })

  it("derives disjoint counts from returned rows and never certifies a done judgment", () => {
    const input = snapshot()
    const view = buildShepherdSupervisionView(input, now)
    expect(view.freshness).toEqual({ status: "fresh", observedAt: input.observedAt, ageMs: 0 })
    expect(view.counts).toEqual({ working: 0, idle: 1, shell: 0, unknown: 0 })
    expect(view.sessions.items[0].lastDecisionLabel).toBe("Agent reports finished")
    expect(view.timeline.items[0].summary).toBe("Agent reports finished")
    expect(input.timeline.items[0].summary).toBe("done")
  })

  it("ages each observation without refreshing history or retaining current authority claims", () => {
    const input = snapshot()
    input.sessions.items[0].authority = "active"
    const view = buildShepherdSupervisionView(input, now + 30_001)
    expect(view.freshness.status).toBe("stale")
    expect(view.sessions.items[0]).toMatchObject({ freshness: { status: "stale", ageMs: 30_001 }, activity: "unknown", authority: "unknown" })
    expect(view.counts).toEqual({ working: 0, idle: 0, shell: 0, unknown: 1 })
    expect(view.timeline.items).toHaveLength(1)
  })

  it("marks per-row failures unknown without erasing healthy rows or history", () => {
    const input = snapshot()
    input.sessions.items.push({ ...input.sessions.items[0], session: "pane:2", activity: "unknown", observedAt: null })
    input.sessions.totalCount = 2
    input.sourceHealth.mandates = "error"
    input.sourceErrors.push({ source: "mandates", code: "read_failed", detail: "Mandate store is unreadable" })
    const view = buildShepherdSupervisionView(input, now)
    expect(view.health).toBe("degraded")
    expect(view.counts).toEqual({ working: 0, idle: 1, shell: 0, unknown: 1 })
    expect(view.sessions.items[0].authority).toBe("unknown")
    expect(view.timeline.items).toHaveLength(1)
  })

  it("does not turn unavailable or future host observations into zero terminals", () => {
    const input = snapshot()
    input.sourceHealth.host = "error"
    expect(buildShepherdSupervisionView(input, now).counts).toBeNull()
    const future = buildShepherdSupervisionView(snapshot(), now - 1)
    expect(future.freshness.status).toBe("unknown")
    expect(future.counts).toBeNull()
  })

  it("keeps truncation explicit while counting only displayed rows", () => {
    const input = snapshot()
    input.sessions.totalCount = 350
    input.sessions.truncated = true
    const view = buildShepherdSupervisionView(input, now)
    expect(view.sessions).toMatchObject({ totalCount: 350, truncated: true })
    expect(view.counts?.idle).toBe(1)
  })
})

describe("Mailbox supervision replica reader", () => {
  it.each(["managed", "classic"] as const)("keeps initially future-dated %s evidence invalid after catch-up until a new current observation arrives", async mode => {
    vi.resetModules()
    const { readMailboxSupervision: read } = await import("../../../heart/mailbox/mailbox-supervision")
    let wall = now
    let monotonic = 100
    vi.spyOn(Date, "now").mockImplementation(() => wall)
    vi.spyOn(performance, "now").mockImplementation(() => monotonic)
    const input = withManagedClaim({ backendWriteAdmitted: true, providerAcknowledged: true, providerInputId: "historical-ack" })
    input.observedAt = new Date(now + 60_000).toISOString()
    Object.assign(input.sessions.items[0]!, { observedAt: input.observedAt, capability: "supported", managed: {
      kind: "agent_session", provider: "copilot", profileSha256: "a".repeat(64), qualification: "qualified",
      qualificationReason: null, workCoverage: "complete", renderCaptureStartedAt: input.observedAt,
    } })
    if (mode === "classic") delete input.sessions.items[0]!.managed
    const { root, file } = fixture(input)
    const before = fs.readFileSync(file)
    expect(read("slugger", { agentRoot: root }).sessions.items[0]).toMatchObject({ activity: "unknown", capability: "unknown" })
    wall += 31_000
    monotonic += 31_000
    expect(read("slugger", { agentRoot: root }).freshness.status).toBe("unknown")
    wall += 30_000
    monotonic += 30_000
    const retained = read("slugger", { agentRoot: root })
    expect(retained.sessions.items[0]).toMatchObject({
      activity: "unknown", capability: "unknown",
      ...(mode === "managed" ? { managed: { qualification: "unknown", workCoverage: "unknown", renderCaptureStartedAt: null } } : {}),
    })
    expect(retained.freshness.status).toBe("unknown")
    expect(retained.custody.claims.items[0]).toMatchObject({
      state: "unknown", managed: { providerAcknowledged: true, providerInputId: "historical-ack" },
    })
    expect(fs.readFileSync(file)).toEqual(before)
    wall += 1_000
    monotonic += 1_000
    input.observedAt = new Date(wall).toISOString()
    Object.assign(input.sessions.items[0]!, { observedAt: input.observedAt, managed: {
      kind: "agent_session", provider: "copilot", profileSha256: "a".repeat(64), qualification: "qualified",
      qualificationReason: null, workCoverage: "complete", renderCaptureStartedAt: input.observedAt,
    } })
    if (mode === "classic") delete input.sessions.items[0]!.managed
    fs.writeFileSync(file, JSON.stringify(input))
    expect(read("slugger", { agentRoot: root }).sessions.items[0]).toMatchObject({
      activity: "idle", ...(mode === "managed" ? { managed: { qualification: "qualified", workCoverage: "complete" } } : {}),
    })
  })

  it("does not revive stale managed evidence after the reader clock rolls back", () => {
    const at = Date.now()
    let wall = at
    let monotonic = 100
    vi.spyOn(Date, "now").mockImplementation(() => wall)
    vi.spyOn(performance, "now").mockImplementation(() => monotonic)
    const input = snapshot()
    input.observedAt = new Date(at).toISOString()
    Object.assign(input.sessions.items[0]!, { observedAt: input.observedAt, capability: "supported", managed: {
      kind: "agent_session", provider: "copilot", profileSha256: "a".repeat(64), qualification: "qualified",
      qualificationReason: null, workCoverage: "complete", renderCaptureStartedAt: input.observedAt,
    } })
    const { root, file } = fixture(input)
    const before = fs.readFileSync(file)
    expect(readMailboxSupervision("slugger", { agentRoot: root }).sessions.items[0]).toMatchObject({
      activity: "idle", managed: { qualification: "qualified", workCoverage: "complete" },
    })
    wall += 31_000
    monotonic += 31_000
    expect(readMailboxSupervision("slugger", { agentRoot: root }).sessions.items[0]).toMatchObject({
      activity: "unknown", managed: { qualification: "unknown", workCoverage: "unknown" },
    })
    wall = at + 10_000
    monotonic += 1_000
    expect(readMailboxSupervision("slugger", { agentRoot: root }).sessions.items[0]).toMatchObject({
      activity: "unknown", capability: "unknown", managed: { qualification: "unknown", workCoverage: "unknown" },
    })
    expect(fs.readFileSync(file)).toEqual(before)
  })

  const managedClaim = {
    nativeRequestId: "ffffffff-ffff-4fff-8fff-ffffffffffff", provider: "copilot", profileSha256: "a".repeat(64),
    receiptVersion: 1, editorInserted: true, backendWriteAdmitted: false, providerAcknowledged: false, providerInputId: null,
  }
  function withManagedClaim(patch: Record<string, unknown> = {}, state: "claimed" | "sent" | "not_sent" | "unknown" = "unknown") {
    const input = snapshot()
    input.custody.claims = { totalCount: 1, truncated: false, items: [Object.assign({
      id: "a".repeat(64), host: "cmux", session: "pane:1", instance: "agent_session:owned",
      state, claimedAt: new Date(now).toISOString(), reason: null, retired: false,
    }, { managed: { ...managedClaim, ...patch } })] }
    return input
  }

  it("retains partial managed receipt evidence in a stale replica without turning an unproven write into no effects", () => {
    const { root } = fixture(withManagedClaim())
    const view = readMailboxSupervision("slugger", { agentRoot: root, nowMs: now + 60_000 })
    expect(view.custody.claims.items[0]).toMatchObject({
      state: "unknown", managed: { editorInserted: true, backendWriteAdmitted: false, providerAcknowledged: false },
    })
    Object.assign(view.custody.claims.items[0]!.managed!, { editorInserted: false })
    expect(readMailboxSupervision("slugger", { agentRoot: root, nowMs: now }).custody.claims.items[0]).toMatchObject({
      managed: { editorInserted: true },
    })
  })

  it.each([
    { nativeRequestId: "not-a-uuid" }, { nativeRequestId: null }, { provider: "invented" }, { profileSha256: "bad" },
    { receiptVersion: 2 }, { receiptVersion: null }, { editorInserted: null }, { backendWriteAdmitted: null },
    { providerAcknowledged: null }, { editorInserted: false, backendWriteAdmitted: true },
    { providerAcknowledged: true }, { providerInputId: "invented-ack" }, { providerInputId: "\n" },
    { screen: "private" }, { receiptVersion: null, editorInserted: null, backendWriteAdmitted: null, providerAcknowledged: false },
  ])("rejects corrupt or contradictory managed claim evidence %j", patch => {
    const { root } = fixture(withManagedClaim(patch))
    expect(readMailboxSupervision("slugger", { agentRoot: root, nowMs: now }).sourceErrors)
      .toContainEqual(expect.objectContaining({ code: "observation_invalid" }))
  })

  it.each([
    ["sent", {}], ["not_sent", {}],
    ["not_sent", { backendWriteAdmitted: true, providerAcknowledged: true, providerInputId: "ack" }],
  ] as const)("rejects managed stages that contradict original state %s", (state, patch) => {
    const { root } = fixture(withManagedClaim(patch, state))
    expect(readMailboxSupervision("slugger", { agentRoot: root, nowMs: now }).sourceErrors)
      .toContainEqual(expect.objectContaining({ code: "observation_invalid" }))
  })

  it("keeps a missing bundle or ancestor unavailable without creating it", () => {
    const { root } = fixture()
    expect(readMailboxSupervision("slugger", { agentRoot: path.join(root, "absent") }).freshness.status).toBe("unknown")
    fs.renameSync(path.join(root, "state"), path.join(root, "saved-state"))
    expect(readMailboxSupervision("slugger", { agentRoot: root, nowMs: now }).sourceErrors[0].code).toBe("observation_missing")
    expect(fs.readdirSync(root)).toEqual(["saved-state"])
  })

  it("rejects a replica not owned by the current user", () => {
    const { root } = fixture()
    vi.spyOn(process, "getuid").mockReturnValue(fs.statSync(root).uid + 1)
    expect(readMailboxSupervision("slugger", { agentRoot: root, nowMs: now }).sourceErrors[0].code).toBe("observation_invalid")
  })

  it.each(["identity", "growth", "mutation"] as const)("rejects %s during a bounded read", async fault => {
    const { root } = fixture()
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
    let calls = 0
    if (fault === "growth") vi.mocked(fs.readSync).mockImplementation(() => 2 * 1024 * 1024 + 1)
    else vi.mocked(fs.fstatSync).mockImplementation(fd => {
      const metadata = actual.fstatSync(fd)
      calls++
      if (fault === "identity") metadata.ino++
      else if (calls === 2) metadata.mtimeMs++
      return metadata
    })
    const view = readMailboxSupervision("slugger", { agentRoot: root, nowMs: now })
    expect(view.counts).toBeNull()
    expect(view.sourceErrors[0].code).toBe("observation_invalid")
  })

  it("reads a valid private snapshot without changing its timestamp or bytes", () => {
    const { root, file } = fixture()
    const before = fs.readFileSync(file)
    const view = readMailboxSupervision("slugger", { agentRoot: root, nowMs: now + 50 })
    expect(view.freshness.ageMs).toBe(50)
    expect(view.agentName).toBe("slugger")
    expect(fs.readFileSync(file)).toEqual(before)
  })

  it("reports missing as unavailable rather than healthy empty state and creates nothing", () => {
    const { root, file } = fixture()
    fs.unlinkSync(file)
    const before = fs.readdirSync(path.dirname(file))
    const view = readMailboxSupervision("slugger", { agentRoot: root, nowMs: now })
    expect(view.counts).toBeNull()
    expect(view.health).toBe("degraded")
    expect(view.sourceErrors).toContainEqual(expect.objectContaining({ code: "observation_missing" }))
    expect(fs.readdirSync(path.dirname(file))).toEqual(before)
  })

  it.each([
    ["wrong identity", (input: ShepherdSupervisionSnapshot) => { input.agentName = "other" }],
    ["unsupported version", (input: ShepherdSupervisionSnapshot) => { Object.assign(input, { schemaVersion: 2 }) }],
    ["invalid date", (input: ShepherdSupervisionSnapshot) => { input.observedAt = "yesterday" }],
    ["duplicate terminal", (input: ShepherdSupervisionSnapshot) => { input.sessions.items.push(input.sessions.items[0]); input.sessions.totalCount = 2 }],
    ["false count", (input: ShepherdSupervisionSnapshot) => { input.sessions.totalCount = 0 }],
    ["hidden truncation", (input: ShepherdSupervisionSnapshot) => { input.sessions.totalCount = 2 }],
    ["raw terminal leakage", (input: ShepherdSupervisionSnapshot) => { Object.assign(input.sessions.items[0], { screen: "secret" }) }],
    ["unbounded rows", (input: ShepherdSupervisionSnapshot) => {
      input.sessions.items = Array.from({ length: 201 }, (_, i) => ({ ...input.sessions.items[0], session: `pane:${i}` }))
      input.sessions.totalCount = 201
    }],
    ["unbounded text", (input: ShepherdSupervisionSnapshot) => { input.sessions.items[0].label = "x".repeat(2001) }],
  ])("rejects %s explicitly", (_label, mutate) => {
    const input = snapshot()
    mutate(input)
    const { root } = fixture(input)
    const view = readMailboxSupervision("slugger", { agentRoot: root, nowMs: now })
    expect(view.counts).toBeNull()
    expect(view.sourceErrors).toContainEqual(expect.objectContaining({ code: "observation_invalid" }))
  })

  it.each(["symlink", "hardlink", "public", "oversized", "malformed", "linked-parent"] as const)(
    "rejects an unsafe %s replica", kind => {
      const { root, file } = fixture()
      if (kind === "symlink") {
        fs.renameSync(file, `${file}.target`)
        fs.symlinkSync(`${file}.target`, file)
      } else if (kind === "hardlink") fs.linkSync(file, `${file}.link`)
      else if (kind === "public") fs.chmodSync(file, 0o644)
      else if (kind === "oversized") fs.writeFileSync(file, " ".repeat(2 * 1024 * 1024 + 1))
      else if (kind === "malformed") fs.writeFileSync(file, "{")
      else {
        fs.renameSync(path.dirname(file), `${path.dirname(file)}-target`)
        fs.symlinkSync(`${path.dirname(file)}-target`, path.dirname(file))
      }
      const view = readMailboxSupervision("slugger", { agentRoot: root, nowMs: now })
      expect(view.counts).toBeNull()
      expect(view.sourceErrors).toContainEqual(expect.objectContaining({ code: "observation_invalid" }))
    },
  )
})
