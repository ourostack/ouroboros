import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type OpenAI from "openai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { a003Envelope, a003Event, a003RetainedHistoryEnvelope } from "../fixtures/a003-session"
import {
  EVENT_CONTENT_MAX_CHARS,
  getIngressTime,
  sanitizeProviderMessages,
  stampIngressRelations,
  stampIngressTime,
  type SessionEnvelope,
} from "../../heart/session-events"
import { loadSession, postTurnPersist, postTurnTrim, saveSession } from "../../mind/context"
import { withSessionTurnLease } from "../../mind/session-transaction"

vi.mock("../../heart/config", async (original) => ({
  ...await original<typeof import("../../heart/config")>(),
  getContextConfig: () => ({ maxTokens: 800, contextMargin: 20 }),
}))
vi.mock("../../nerves/runtime", async (original) => ({
  ...await original<typeof import("../../nerves/runtime")>(),
  emitNervesEvent: vi.fn(),
}))

const roots: string[] = []
function session(envelope = a003Envelope([])) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-identity-"))
  roots.push(root)
  const file = path.join(root, "owner.json")
  fs.writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 })
  return file
}
function raw(file: string): SessionEnvelope {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("D006 current event identity", () => {
  it("refuses to rematerialize a native source that was redacted after the reader snapshot", async () => {
    const repaired = a003RetainedHistoryEnvelope()
    const before = a003Envelope(repaired.events.slice(0, 6))
    const file = session(before)
    await withSessionTurnLease(file, () => {
      const stale = loadSession(file)!.messages.at(-1)!
      expect(stale).toMatchObject({ role: "user", content: "engine-only correction" })
      fs.writeFileSync(file, JSON.stringify(repaired))
      expect(() => postTurnPersist(file, postTurnTrim([stale]))).toThrow("redacted session events")
      expect(raw(file)).toEqual(repaired)
    })
  })

  it("keeps a selected native identity when sanitization creates a different message object", async () => {
    const original = a003Envelope([a003Event(1, "user", "again"), a003Event(2, "assistant", "answer"), a003Event(3, "user", "again")])
    const file = session(original)
    await withSessionTurnLease(file, () => {
      const loaded = loadSession(file)!
      const prepared = postTurnTrim([...loaded.messages])
      prepared.trimmedMessages = sanitizeProviderMessages([loaded.messages[2]!])
      expect(prepared.currentMessages).not.toContain(prepared.trimmedMessages[0])
      postTurnPersist(file, prepared)
      expect(raw(file).events).toEqual(original.events)
      expect(raw(file).projection.eventIds).toEqual(["evt-000003"])
    })
  })

  it.each([
    { rebase: false, repeated: false },
    { rebase: false, repeated: true },
    { rebase: true, repeated: false },
    { rebase: true, repeated: true },
  ])("retains the exact native ingress after prefix replacement (rebase=$rebase, repeated=$repeated)", async ({ rebase, repeated }) => {
    const current = a003Event(3, "user", "current question")
    current.relations.references = ["fixture-precommitted"]
    const original = a003Envelope([
      a003Event(1, "user", repeated ? "current question" : "older question"),
      a003Event(2, "assistant", "older answer"),
      current,
    ])
    const file = session(original)
    await withSessionTurnLease(file, () => {
      const loaded = loadSession(file)!
      const ingress = loaded.messages[2]!
      stampIngressRelations(ingress, { replyToEventId: null, threadRootEventId: null, references: ["fixture-precommitted"] })
      if (rebase) {
        const prepared = postTurnTrim([...loaded.messages])
        prepared.trimmedMessages = prepared.currentMessages.slice(1)
        postTurnPersist(file, prepared)
        expect(raw(file).projection.eventIds).toEqual(["evt-000002", "evt-000003"])
      }
      postTurnPersist(file, postTurnTrim([ingress, { role: "assistant", content: "current answer" }]))
      const after = raw(file)
      expect(after.events.slice(0, 3)).toEqual(original.events)
      expect(after.events).toHaveLength(4)
      expect(after.events.filter((event) => event.relations.references.includes("fixture-precommitted"))).toEqual([current])
      expect(after.projection).toMatchObject({ eventIds: ["evt-000003", "evt-000004"], trimmed: true })
    })
  })

  it("retains a coalesced historical suffix without duplicating its native dialogue or tool records", async () => {
    const original = a003RetainedHistoryEnvelope()
    const file = session(original)
    await withSessionTurnLease(file, () => {
      const loaded = loadSession(file)!
      expect(loaded.messages).toHaveLength(4)
      postTurnPersist(file, postTurnTrim([...loaded.messages.slice(1), { role: "assistant", content: "current answer" }]))
      const after = raw(file)
      expect(after.events.slice(0, 7)).toEqual(original.events)
      expect(after.events).toHaveLength(8)
      expect(after.projection.eventIds).toEqual(["evt-000002", "evt-000003", "evt-000004", "evt-000005", "evt-000008"])
    })
  })

  it.each(["edited", "copied", "repeated"] as const)("does not reuse a native origin when the message is %s", async (mode) => {
    const original = a003Envelope([a003Event(1, "user", "older"), a003Event(2, "assistant", "answer"), a003Event(3, "user", "current")])
    const file = session(original)
    await withSessionTurnLease(file, () => {
      const messages = loadSession(file)!.messages
      const current = messages[2]!
      const replacement = mode === "copied" ? { ...current } : current
      if (mode === "edited") replacement.content = "changed current"
      const next = mode === "repeated" ? [...messages, current] : [replacement]
      postTurnPersist(file, postTurnTrim(next))
      const after = raw(file)
      expect(after.events.slice(0, 3)).toEqual(original.events)
      expect(after.events).toHaveLength(4)
      expect(after.events[3]).toMatchObject({ id: "evt-000004", role: "user", content: mode === "edited" ? "changed current" : "current" })
      expect(new Set(after.projection.eventIds).size).toBe(after.projection.eventIds.length)
    })
  })

  it("projects the selected current occurrence rather than an identical older dialogue", async () => {
    const file = session()
    await withSessionTurnLease(file, () => {
      saveSession(file, [{ role: "user", content: "again" }, { role: "assistant", content: "done" }])
      const before = raw(file)
      const currentUser: OpenAI.ChatCompletionMessageParam = { role: "user", content: "again" }
      stampIngressTime(currentUser)
      stampIngressRelations(currentUser, {
        replyToEventId: "evt-000002", threadRootEventId: "evt-000001", references: ["inbound:current"],
      })
      const messages: OpenAI.ChatCompletionMessageParam[] = [
        ...loadSession(file)!.messages, currentUser, { role: "assistant", content: "done" },
      ]
      const prepared = postTurnTrim(messages, { input_tokens: 1_000, output_tokens: 20, reasoning_tokens: 0, total_tokens: 1_020 })
      expect(prepared.trimmedMessages).toHaveLength(2)
      postTurnPersist(file, prepared)
      const after = raw(file)
      expect(after.projection).toMatchObject({ eventIds: ["evt-000003", "evt-000004"], trimmed: true })
      expect(after.events.slice(0, 2)).toEqual(before.events)
      expect(after.events[2]).toMatchObject({
        id: "evt-000003", role: "user",
        time: { observedAt: getIngressTime(currentUser) },
        relations: { replyToEventId: "evt-000002", threadRootEventId: "evt-000001", references: ["inbound:current"] },
      })
      expect(after.events).toHaveLength(4)
    })
  })

  it("reuses the original native records when a repeated snapshot contains uncapped tool content", async () => {
    const file = session()
    await withSessionTurnLease(file, () => {
      const content = "fixture tool result " + "x".repeat(EVENT_CONTENT_MAX_CHARS * 2)
      const messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "user", content: "read the fixture" },
        { role: "assistant", content: null, tool_calls: [{ id: "large-read", type: "function", function: { name: "read_file", arguments: '{"path":"fixture"}' } }] },
        { role: "tool", tool_call_id: "large-read", content },
        { role: "assistant", content: "read completed" },
      ]
      saveSession(file, messages)
      const before = raw(file)
      expect(before.events[2]!.content).not.toBe(content)
      expect(String(before.events[2]!.content)).toHaveLength(EVENT_CONTENT_MAX_CHARS)
      postTurnPersist(file, postTurnTrim([...messages]))
      const after = raw(file)
      expect(after.events).toEqual(before.events)
      expect(after.projection.eventIds).toEqual(["evt-000001", "evt-000004"])
    })
  })

  it("preserves historical IDs through inline-reasoning replay repair", async () => {
    const call = a003Event(2, "assistant", "<think>historical reasoning</think>read complete")
    call.toolCalls = [{ id: "old-read", type: "function", function: { name: "read_file", arguments: '{"path":"fixture"}' } }]
    const receipt = a003Event(3, "tool", "historical result")
    receipt.toolCallId = "old-read"
    receipt.relations.toolCallId = "old-read"
    const original = a003Envelope([a003Event(1, "user", "read"), call, receipt, a003Event(4, "user", "current question")])
    const file = session(original)
    await withSessionTurnLease(file, () => {
      const messages = [...loadSession(file)!.messages, { role: "assistant" as const, content: "current answer" }]
      expect(messages[1]).toMatchObject({ content: "read complete", tool_calls: [{ id: "old-read" }] })
      postTurnPersist(file, postTurnTrim(messages))
      const after = raw(file)
      expect(after.events.slice(0, 4)).toEqual(original.events)
      expect(after.events).toHaveLength(5)
      expect(after.projection.eventIds).toEqual(["evt-000001", "evt-000002", "evt-000003", "evt-000004", "evt-000005"])
    })
  })

  it("keeps a replay-only missing-result explanation out of the native receipt history", async () => {
    const call = a003Event(2, "assistant", null)
    call.toolCalls = [{ id: "interrupted-read", type: "function", function: { name: "read_file", arguments: '{"path":"fixture"}' } }]
    const original = a003Envelope([a003Event(1, "user", "read"), call])
    const file = session(original)
    await withSessionTurnLease(file, () => {
      const loaded = loadSession(file)!
      expect(loaded.messages).toHaveLength(3)
      expect(loaded.messages[2]).toMatchObject({ role: "tool", content: expect.stringContaining("result was lost") })
      postTurnPersist(file, postTurnTrim([...loaded.messages]))
      expect(raw(file).events).toEqual(original.events)
      expect(raw(file).projection.eventIds).toEqual(["evt-000001", "evt-000002"])
      expect(loadSession(file)!.messages).toEqual(loaded.messages)
    })
  })
})
