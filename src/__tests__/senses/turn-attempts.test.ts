import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { describeTurnSpokes, openTurnAttempts, outwardSendObserver, turnSpoke, turnSpokeForTool } from "../../senses/turn-attempts"

const roots: string[] = []
function agentRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "turn-attempts-"))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("turn attempts that survive a restart", () => {
  it("counts attempts on disk, so a new process sees the same count", () => {
    const root = agentRoot()
    const store = openTurnAttempts(root, "test-sense", { now: () => Date.parse("2026-11-22T10:00:00.000Z") })
    expect(store.get("message-1")).toBeNull()
    expect(store.beginAttempt("message-1")).toBe(1)
    expect(store.beginAttempt("message-1")).toBe(2)

    const reopened = openTurnAttempts(root, "test-sense")
    expect(reopened.get("message-1")).toEqual({
      schemaVersion: 1,
      sense: "test-sense",
      id: "message-1",
      attempts: 2,
      spoke: [],
      updatedAt: "2026-11-22T10:00:00.000Z",
    })
    expect(reopened.beginAttempt("message-1")).toBe(3)
  })

  it("gives back a clean shutdown's attempt, never below zero", () => {
    const root = agentRoot()
    const store = openTurnAttempts(root, "test-sense")
    store.beginAttempt("message-1")
    store.refundAttempt("message-1")
    store.refundAttempt("message-1")
    expect(store.get("message-1")?.attempts).toBe(0)
    store.refundAttempt("never-started")
    expect(store.get("never-started")).toBeNull()
  })

  it("keeps what went out, when, and its outbound record, but never the text itself", () => {
    const root = agentRoot()
    const store = openTurnAttempts(root, "test-sense")
    store.beginAttempt("message-1")
    const spoke = turnSpoke("speak", "checking on that now", "bbout_0123", Date.parse("2026-11-22T10:01:00.000Z"))
    store.noteSpoke("message-1", spoke)
    // A send noted before any attempt was counted still holds its record.
    store.noteSpoke("message-2", turnSpoke("speak", "hi"))

    const saved = openTurnAttempts(root, "test-sense").get("message-1")
    expect(saved?.spoke).toEqual([{
      kind: "speak",
      sentAt: "2026-11-22T10:01:00.000Z",
      outboundRecordId: "bbout_0123",
      textHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      textLength: "checking on that now".length,
    }])
    expect(JSON.stringify(saved)).not.toContain("checking on that now")
    expect(openTurnAttempts(root, "test-sense").get("message-2")).toMatchObject({ attempts: 0, spoke: [expect.objectContaining({ kind: "speak", outboundRecordId: null })] })
  })

  it("clears an inbound's record once it has its outcome", () => {
    const root = agentRoot()
    const store = openTurnAttempts(root, "test-sense")
    store.beginAttempt("message-1")
    store.clear("message-1")
    store.clear("message-1")
    expect(openTurnAttempts(root, "test-sense").get("message-1")).toBeNull()
  })

  it("reads an unreadable record as none, so one bad file cannot stop the sense", () => {
    const root = agentRoot()
    const store = openTurnAttempts(root, "test-sense")
    store.beginAttempt("message-1")
    const dir = path.join(root, "state", "senses", "test-sense", "turn-attempts")
    const [file] = fs.readdirSync(dir)
    fs.writeFileSync(path.join(dir, file!), "{ not json")
    expect(store.get("message-1")).toBeNull()
    fs.writeFileSync(path.join(dir, file!), JSON.stringify({ schemaVersion: 1, id: "other" }))
    expect(store.get("message-1")).toBeNull()
    fs.writeFileSync(path.join(dir, file!), "null")
    expect(store.get("message-1")).toBeNull()
    expect(store.beginAttempt("message-1")).toBe(1)
  })

  it("names the tools that message a person, so a turn that used one counts as having spoken", () => {
    expect(turnSpokeForTool("send_message", { friendId: "ari", channel: "telegram", content: "the build is out" }, 0)).toEqual({
      kind: "tool:send_message",
      sentAt: "1970-01-01T00:00:00.000Z",
      outboundRecordId: null,
      textHash: expect.stringMatching(/^sha256:/),
      textLength: "the build is out".length,
    })
    // Routing to its own private runtime reaches nobody.
    expect(turnSpokeForTool("send_message", { friendId: "self", channel: "inner", content: "note" })).toBeNull()
    expect(turnSpokeForTool("surface", { content: "ready" })?.kind).toBe("tool:surface")
    expect(turnSpokeForTool("teams_send_message", { message: "hello" })?.textLength).toBe(5)
    expect(turnSpokeForTool("mail_send", { draftId: "d1" })).toMatchObject({ kind: "tool:mail_send", textHash: null, textLength: null })
    expect(turnSpokeForTool("send_file", { path: "/tmp/a" })?.kind).toBe("tool:send_file")
    expect(turnSpokeForTool("house_digest_send", {})?.kind).toBe("tool:house_digest_send")
    expect(turnSpokeForTool("read_file", { path: "/tmp/a" })).toBeNull()
    expect(turnSpokeForTool("speak", { message: "hi" })).toBeNull()
  })

  it("names what went out for the recorded outcome", () => {
    expect(describeTurnSpokes([])).toBe("a message")
    expect(describeTurnSpokes([turnSpoke("speak", "hi", null, 0)])).toBe("1 send (speak at 1970-01-01T00:00:00.000Z)")
    expect(describeTurnSpokes([turnSpoke("speak", "hi", null, 0), turnSpoke("tool:surface", null, null, 1000)])).toBe("2 sends (speak at 1970-01-01T00:00:00.000Z, tool:surface at 1970-01-01T00:00:01.000Z)")
  })

  it("notes a person-messaging tool from the turn's events when it starts, and nothing else", () => {
    const noted: string[] = []
    const sink = outwardSendObserver((spoke) => noted.push(spoke.kind))
    sink.onEvent({ type: "tool_started", data: { name: "send_message", args: { friendId: "ari", channel: "telegram", content: "hi" } } })
    sink.onEvent({ type: "tool_started", data: { name: "house_digest_send" } })
    sink.onEvent({ type: "tool_started", data: { name: "read_file", args: { path: "/tmp/a" } } })
    sink.onEvent({ type: "tool_completed", data: { name: "surface", summary: "", success: true } })
    expect(noted).toEqual(["tool:send_message", "tool:house_digest_send"])
  })
})
