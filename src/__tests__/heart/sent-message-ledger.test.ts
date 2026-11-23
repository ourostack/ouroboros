import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { recordSentMessage, sentMessageLookup, SENT_MESSAGE_LEDGER_MAX_ENTRIES, SENT_MESSAGE_LEDGER_MAX_TEXT } from "../../heart/sent-message-ledger"

const roots: string[] = []
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sent-ledger-"))
  roots.push(root)
  return root
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe("sent message ledger", () => {
  it("finds a message the agent sent by the app's id, only in its own conversation", () => {
    const agentRoot = tempRoot()
    const scope = { agentRoot, channel: "teams", conversationId: "conv-a" }
    recordSentMessage(scope, "m1", "  the plan is ready  ")
    expect(sentMessageLookup(scope)("m1")).toEqual({ text: "the plan is ready", fromAgent: true })
    expect(sentMessageLookup({ ...scope, conversationId: "conv-b" })("m1")).toBeNull()
    expect(sentMessageLookup(scope)("m2")).toBeNull()
    expect(fs.existsSync(path.join(agentRoot, "state", "senses", "sent-messages", "teams.json"))).toBe(true)
  })

  it("keeps the newest copy of a re-sent id, excerpts long text and keeps only the newest entries", () => {
    const scope = { agentRoot: tempRoot(), channel: "teams/x", conversationId: "c" }
    recordSentMessage(scope, "m1", "first")
    recordSentMessage(scope, "m1", "second")
    expect(sentMessageLookup(scope)("m1")).toEqual({ text: "second", fromAgent: true })
    recordSentMessage(scope, "long", "x".repeat(SENT_MESSAGE_LEDGER_MAX_TEXT + 50))
    expect(sentMessageLookup(scope)("long")?.text).toHaveLength(SENT_MESSAGE_LEDGER_MAX_TEXT)
    // Fill the ledger to its limit with older entries; the next send pushes out the oldest, which is m1.
    const file = path.join(scope.agentRoot, "state", "senses", "sent-messages", "teams_x.json")
    const existing = JSON.parse(fs.readFileSync(file, "utf8")) as { entries: unknown[] }
    const filler = Array.from({ length: SENT_MESSAGE_LEDGER_MAX_ENTRIES - existing.entries.length }, (_, index) => ({ key: `filler-${index}`, text: "old", sentAt: "2026-01-01T00:00:00.000Z" }))
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [...existing.entries, ...filler] }))
    recordSentMessage(scope, "newest", "newest text")
    expect(sentMessageLookup(scope)("m1")).toBeNull()
    expect(sentMessageLookup(scope)("long")?.text).toHaveLength(SENT_MESSAGE_LEDGER_MAX_TEXT)
    expect(sentMessageLookup(scope)("newest")).toEqual({ text: "newest text", fromAgent: true })
  })

  it("ignores empty sends and unreadable or foreign ledger files", () => {
    const agentRoot = tempRoot()
    const scope = { agentRoot, channel: "teams", conversationId: "c" }
    recordSentMessage(scope, "", "text")
    recordSentMessage(scope, "m1", "   ")
    expect(sentMessageLookup(scope)("m1")).toBeNull()
    const file = path.join(agentRoot, "state", "senses", "sent-messages", "teams.json")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "not json")
    expect(sentMessageLookup(scope)("m1")).toBeNull()
    fs.writeFileSync(file, JSON.stringify({ version: 1 }))
    expect(sentMessageLookup(scope)("m1")).toBeNull()
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [null, { key: 1 }] }))
    recordSentMessage(scope, "m1", "kept")
    expect(sentMessageLookup(scope)("m1")).toEqual({ text: "kept", fromAgent: true })
  })

  it("never throws when the ledger cannot be written", () => {
    const agentRoot = tempRoot()
    fs.writeFileSync(path.join(agentRoot, "state"), "a file where the folder should be")
    expect(() => recordSentMessage({ agentRoot, channel: "teams", conversationId: "c" }, "m1", "hi")).not.toThrow()
    expect(() => recordSentMessage({ agentRoot, channel: "teams", conversationId: "c" }, "m1", "hi", new Date(0))).not.toThrow()
  })
})
