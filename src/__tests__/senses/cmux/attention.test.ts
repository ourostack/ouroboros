import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  applyAck,
  applyEventFrame,
  cmuxVersionAtLeast,
  emptyCmuxState,
  escalationMessage,
  pendingFeedItems,
  readCmuxState,
  rememberEscalation,
  surfaceForSession,
  writeCmuxState,
} from "../../../senses/cmux/attention"
import { feedEvent } from "./fake-cmux"

const NOW = "2026-10-10T20:00:00.000Z"
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("cmux attention state", () => {
  it("tracks each surface's agent, session and lifecycle from Feed hook events", () => {
    const state = emptyCmuxState(NOW)

    expect(applyEventFrame(state, feedEvent(1, { hook_event_name: "SessionStart" }), NOW)).toEqual({ feedCheck: false })
    expect(state.surfaces["SF-1"]).toEqual({
      workspaceId: "WS-1", agent: "claude", sessionId: "claude-s1", cwd: "/Users/a/code/repo",
      lifecycle: "idle", lastHook: "SessionStart", lastTool: null, at: NOW,
    })
    applyEventFrame(state, feedEvent(2, { hook_event_name: "PreToolUse", tool_name: "Bash" }), NOW)
    expect(state.surfaces["SF-1"]).toMatchObject({ lifecycle: "working", lastHook: "PreToolUse", lastTool: "Bash" })
    applyEventFrame(state, feedEvent(3, { hook_event_name: "Stop" }), NOW)
    expect(state.surfaces["SF-1"]).toMatchObject({ lifecycle: "idle", lastTool: "Bash" })
    applyEventFrame(state, feedEvent(4, { hook_event_name: "SessionEnd" }), NOW)
    expect(state.surfaces["SF-1"]!.lifecycle).toBe("ended")
    expect(state).toMatchObject({ bootId: "BOOT-1", seq: 4 })
  })

  it("asks for a Feed check when an agent waits on the human", () => {
    for (const payload of [
      { hook_event_name: "PermissionRequest", tool_name: "Bash" },
      { hook_event_name: "Notification" },
      { hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" },
      { hook_event_name: "PreToolUse", tool_name: "ExitPlanMode" },
    ]) {
      const state = emptyCmuxState(NOW)
      expect(applyEventFrame(state, feedEvent(1, payload), NOW)).toEqual({ feedCheck: true })
      expect(state.surfaces["SF-1"]!.lifecycle).toBe("waiting")
    }
    const state = emptyCmuxState(NOW)
    expect(applyEventFrame(state, feedEvent(1, { hook_event_name: "Stop" }, { name: "feed.item.resolved" }), NOW)).toEqual({ feedCheck: true })
    expect(state.surfaces).toEqual({})
  })

  it("ignores frames that are not Feed hook events, forgets closed surfaces, and keeps the cursor", () => {
    const state = emptyCmuxState(NOW)
    applyEventFrame(state, feedEvent(1, { hook_event_name: "Stop" }), NOW)
    expect(applyEventFrame(state, { type: "heartbeat", boot_id: "BOOT-1", latest_seq: 9 }, NOW)).toEqual({ feedCheck: false })
    expect(state.seq).toBe(1)
    applyEventFrame(state, feedEvent(2, { hook_event_name: "Stop" }, { name: "feed.item.completed" }), NOW)
    applyEventFrame(state, { type: "event", seq: 3, boot_id: "BOOT-1", name: "surface.closed", category: "surface", surface_id: "SF-1", payload: {} }, NOW)
    expect(state).toMatchObject({ seq: 3, surfaces: {} })
    applyEventFrame(state, feedEvent(4, { surface_id: null, hook_event_name: "Stop" }, { surface_id: null }), NOW)
    applyEventFrame(state, feedEvent(5, { hook_event_name: 7 }), NOW)
    applyEventFrame(state, { type: "event", seq: 6, boot_id: "BOOT-1", name: "feed.item.received", payload: "not an object" }, NOW)
    applyEventFrame(state, { type: "event", seq: "x", name: "surface.closed" }, NOW)
    applyEventFrame(state, { type: "event", seq: 7, name: "workspace.selected" }, NOW)
    applyEventFrame(state, { type: "event", seq: 7, name: "surface.closed", payload: {} }, NOW)
    expect(state).toMatchObject({ seq: 7, bootId: "BOOT-1", surfaces: {} })
  })

  it("fills missing hook fields with nulls and the envelope ids", () => {
    const state = emptyCmuxState(NOW)
    applyEventFrame(state, {
      type: "event", seq: 1, boot_id: "B", name: "feed.item.received", source: "codex", workspace_id: "WS-9", surface_id: "SF-9",
      payload: { hook_event_name: "PreToolUse" },
    }, NOW)
    expect(state.surfaces["SF-9"]).toEqual({
      workspaceId: "WS-9", agent: "codex", sessionId: null, cwd: null, lifecycle: "working", lastHook: "PreToolUse", lastTool: null, at: NOW,
    })
    applyEventFrame(state, { type: "event", seq: 2, boot_id: "B", name: "feed.item.received", surface_id: "SF-8", payload: { hook_event_name: "Stop" } }, NOW)
    expect(state.surfaces["SF-8"]).toMatchObject({ workspaceId: null, agent: "unknown" })
  })

  it("keeps at most 100 surfaces, dropping the stalest", () => {
    const state = emptyCmuxState(NOW)
    for (let index = 0; index < 101; index += 1) {
      const at = new Date(Date.parse(NOW) + (index === 0 ? 500 : index) * 1000).toISOString()
      applyEventFrame(state, feedEvent(index, { surface_id: `SF-${index}`, hook_event_name: "Stop" }, { surface_id: `SF-${index}` }), at)
    }
    expect(Object.keys(state.surfaces)).toHaveLength(100)
    expect(state.surfaces["SF-1"]).toBeUndefined()
    expect(state.surfaces["SF-0"]).toBeDefined()
    expect(state.surfaces["SF-100"]).toBeDefined()
  })

  it("persists state privately and reads damaged or missing state as empty", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-state-"))
    dirs.push(dir)
    const file = path.join(dir, "senses", "cmux", "state.json")
    expect(readCmuxState(file, NOW)).toEqual(emptyCmuxState(NOW))

    const state = emptyCmuxState(NOW)
    applyEventFrame(state, feedEvent(7, { hook_event_name: "Stop" }), NOW)
    rememberEscalation(state, "req-1")
    writeCmuxState(file, state)
    expect(readCmuxState(file, NOW)).toEqual(state)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)

    fs.writeFileSync(file, "[]")
    expect(readCmuxState(file, NOW)).toEqual(emptyCmuxState(NOW))
    fs.writeFileSync(file, JSON.stringify({ seq: 4, connected: true, lastError: "refused" }))
    expect(readCmuxState(file, NOW)).toEqual({ ...emptyCmuxState(NOW), seq: 4, connected: true, lastError: "refused" })
    fs.writeFileSync(file, "{not json")
    expect(readCmuxState(file, NOW)).toEqual(emptyCmuxState(NOW))
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, bootId: 3, seq: "x", surfaces: [], escalated: [1, "a"] }))
    expect(readCmuxState(file, NOW)).toEqual({ ...emptyCmuxState(NOW), escalated: ["a"] })
  })

  it("remembers escalated request ids once, newest last, at most 500", () => {
    const state = emptyCmuxState(NOW)
    for (let index = 0; index < 502; index += 1) rememberEscalation(state, `r${index}`)
    rememberEscalation(state, "r501")
    expect(state.escalated).toHaveLength(500)
    expect(state.escalated[0]).toBe("r2")
    expect(state.escalated.at(-1)).toBe("r501")
  })

  it("finds the surface that runs a Feed workstream", () => {
    const state = emptyCmuxState(NOW)
    applyEventFrame(state, feedEvent(1, { hook_event_name: "Stop" }), NOW)
    expect(surfaceForSession(state, "claude-s1")).toEqual({ surfaceId: "SF-1", activity: state.surfaces["SF-1"] })
    expect(surfaceForSession(state, "claude-other")).toBeNull()
  })
})

describe("pending Feed items", () => {
  it("keeps only pending decisions that carry a request id", () => {
    const items = pendingFeedItems({
      items: [
        { kind: "permissionRequest", status: "pending", request_id: "r1", source: "claude", tool_name: "Bash", cwd: "/repo", workstream_id: "claude-s1", created_at: "t1", tool_input: "{\"command\":\"ls\"}" },
        { kind: "question", status: "pending", request_id: "r2", workstream_id: "claude-s2", tool_input_truncated: true },
        { kind: "exitPlan", status: "pending", request_id: "r3" },
        { kind: "permissionRequest", status: "resolved", request_id: "r4" },
        { kind: "toolUse", status: "telemetry" },
        { kind: "permissionRequest", status: "pending" },
        "junk",
      ],
    })
    expect(items).toEqual([
      { requestId: "r1", kind: "permissionRequest", source: "claude", toolName: "Bash", cwd: "/repo", workstreamId: "claude-s1", createdAt: "t1", toolInput: "{\"command\":\"ls\"}", toolInputTruncated: false },
      { requestId: "r2", kind: "question", source: "unknown", toolName: null, cwd: null, workstreamId: "claude-s2", createdAt: null, toolInput: null, toolInputTruncated: true },
      { requestId: "r3", kind: "exitPlan", source: "unknown", toolName: null, cwd: null, workstreamId: null, createdAt: null, toolInput: null, toolInputTruncated: false },
    ])
    expect(pendingFeedItems({})).toEqual([])
  })
})

describe("escalation receipts", () => {
  const item = { requestId: "claude-s1-PermissionRequest-Bash-1791489198880", kind: "permissionRequest", source: "claude", toolName: "Bash", cwd: "/Users/a/code/repo", workstreamId: "claude-s1", createdAt: "2026-10-10T19:59:58Z", toolInput: "{\"command\":\"echo sk-ant-secret\"}", toolInputTruncated: false }

  it("builds one pending-message receipt per Feed request without tool input", () => {
    const state = emptyCmuxState(NOW)
    applyEventFrame(state, feedEvent(1, { hook_event_name: "PermissionRequest", tool_name: "Bash" }), NOW)
    const escalation = escalationMessage("ouroboros", item, surfaceForSession(state, "claude-s1"))
    expect(escalation).toEqual({
      requestId: "claude-s1-PermissionRequest-Bash-1791489198880",
      content: [
        "[cmux Feed request]",
        "Claude Code is waiting for a permission decision (Bash) in repo.",
        "",
        "request_id: claude-s1-PermissionRequest-Bash-1791489198880",
        "workspace_id: WS-1",
        "surface_id: SF-1",
        "cwd: /Users/a/code/repo",
        "created_at: 2026-10-10T19:59:58Z",
        "",
        "cmux waits about 120 seconds for a Feed answer, then the agent falls back to its own terminal prompt. Use cmux_overview and cmux_read to see it, and cmux_signal to tell the human. If you judge it routine under the cmux principles, cmux_reply_once records your judgment (it sends only when the floor, a precedent and a standing grant allow). When the human tells you their answer in a conversation, cmux_correct records it as a precedent.",
      ].join("\n"),
    })
    expect(JSON.stringify(escalation)).not.toContain("sk-ant")
  })

  it("labels questions, plans and unknown agents, and says why a judged request was not answered", () => {
    const question = escalationMessage("a", { ...item, kind: "question", source: "codex", toolName: null, cwd: null, createdAt: null, requestId: "q 1/2" }, null)
    expect(question.content).toContain("Codex is waiting for an answer to a question.")
    expect(question.content).toContain("request_id: q 1/2")
    for (const line of ["workspace_id: unknown", "surface_id: unknown", "cwd: unknown", "created_at: unknown"]) expect(question.content).toContain(line)
    expect(question.content).not.toContain("why it was not answered")
    const judged = escalationMessage("a", item, null, "floor: rm is never answered for the human")
    expect(judged.content).toContain("why it was not answered automatically: floor: rm is never answered for the human")
    const plan = escalationMessage("a", { ...item, kind: "exitPlan", source: "opencode" }, null)
    expect(plan.content).toContain("opencode is waiting for a plan approval (Bash) in repo.")
  })
})

describe("stream acks and cmux versions", () => {
  it("drops the per-terminal picture and jumps to cmux's latest sequence on a resume gap or a new boot", () => {
    const state = emptyCmuxState("2026-10-10T20:00:00.000Z")
    state.seq = 40
    state.surfaces = { SF: { workspaceId: null, agent: "claude", sessionId: "s", cwd: null, lifecycle: "working", lastHook: "PreToolUse", lastTool: null, at: "x" } }
    expect(applyAck(state, { type: "ack", boot_id: "B1", resume: { gap: false, latest_seq: 50 } })).toEqual({ reset: false })
    expect(state).toMatchObject({ bootId: "B1", seq: 40 })
    expect(Object.keys(state.surfaces)).toEqual(["SF"])
    expect(applyAck(state, { type: "ack", boot_id: "B1", resume: { gap: true, latest_seq: 90 } })).toEqual({ reset: true })
    expect(state).toMatchObject({ bootId: "B1", seq: 90, surfaces: {} })
    state.surfaces = { SF: state.surfaces.SF ?? { workspaceId: null, agent: "claude", sessionId: "s", cwd: null, lifecycle: "working", lastHook: "PreToolUse", lastTool: null, at: "x" } }
    expect(applyAck(state, { type: "ack", boot_id: "B2" })).toEqual({ reset: true })
    expect(state).toMatchObject({ bootId: "B2", seq: null, surfaces: {} })
    expect(applyAck(state, { type: "ack" })).toEqual({ reset: false })
    expect(state.bootId).toBe("B2")
  })

  it("compares cmux versions and treats unknown versions as too old", () => {
    expect(cmuxVersionAtLeast("0.65.0", "0.65.0")).toBe(true)
    expect(cmuxVersionAtLeast("0.65.3", "0.65.0")).toBe(true)
    expect(cmuxVersionAtLeast("1.0.0", "0.65.0")).toBe(true)
    expect(cmuxVersionAtLeast("0.64.22", "0.65.0")).toBe(false)
    expect(cmuxVersionAtLeast("0.65.0-beta", "0.65.1")).toBe(false)
    expect(cmuxVersionAtLeast("nightly", "0.65.0")).toBe(false)
    expect(cmuxVersionAtLeast(null, "0.65.0")).toBe(false)
  })
})
