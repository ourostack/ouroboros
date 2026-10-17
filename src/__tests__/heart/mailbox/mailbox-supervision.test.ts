import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  buildShepherdSupervisionView,
  type ShepherdSupervisionSnapshot,
} from "../../../heart/shepherd/supervision"
import { readMailboxSupervision } from "../../../heart/mailbox/mailbox-supervision"

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
        lastDecision: "done", withheldReason: "No current mandate", authority: "absent", capability: "unsupported",
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
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("Shepherd supervision projection", () => {
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
