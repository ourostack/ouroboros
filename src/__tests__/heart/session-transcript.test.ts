import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
}))

import * as fs from "fs"

function stripTranscriptMetadata(text: string): string {
  return text.replace(/\[[^\]]*\|\s*(system|user|assistant|tool)\s*\|\s*evt-\d+\]\s*/g, "[$1] ")
}

function sessionEvent(sequence: number, role: string, content: string | null, toolCalls: unknown[] = [], at?: string) {
  const timestamp = at ?? `2026-04-28T23:00:${String(sequence % 60).padStart(2, "0")}.000Z`
  return {
    id: `evt-${String(sequence).padStart(6, "0")}`,
    sequence,
    role,
    content,
    name: null,
    toolCallId: role === "tool" ? "call_1" : null,
    toolCalls,
    attachments: [],
    time: {
      authoredAt: timestamp,
      authoredAtSource: "local",
      observedAt: null,
      observedAtSource: "unknown",
      recordedAt: timestamp,
      recordedAtSource: "local",
    },
    relations: {
      replyToEventId: null,
      threadRootEventId: null,
      references: [],
      toolCallId: role === "tool" ? "call_1" : null,
      supersedesEventId: null,
      redactsEventId: null,
    },
    provenance: {
      captureKind: "live",
      legacyVersion: null,
      sourceMessageIndex: null,
    },
  }
}

describe("session transcript", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockReset()
  })

  it("extracts a canonical transcript tail and compact snapshot", async () => {
    const { summarizeSessionTail } = await import("../../heart/session-transcript")

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "oldest question" },
        { role: "assistant", content: "oldest answer" },
        { role: "user", content: "latest user question" },
        { role: "assistant", content: "latest assistant answer" },
      ],
    }))

    const result = await summarizeSessionTail({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
      messageCount: 2,
    })

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(stripTranscriptMetadata(result.transcript)).toBe("[user] latest user question\n[assistant] latest assistant answer")
      expect(stripTranscriptMetadata(result.summary)).toBe("[user] latest user question\n[assistant] latest assistant answer")
      expect(result.snapshot).toContain("recent focus:")
      expect(result.snapshot).toContain("latest user question")
      expect(result.snapshot).not.toContain("oldest question")
    }
  })

  it("omits tool-result chatter from non-inner transcript tails", async () => {
    const { summarizeSessionTail } = await import("../../heart/session-transcript")

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "please check the release" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "very long shell output that should stay out of the chat summary" },
        { role: "assistant", content: "release is merged" },
        { role: "tool", tool_call_id: "call_2", content: "(delivered)" },
      ],
    }))

    const result = await summarizeSessionTail({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/bluebubbles/chat.json",
      friendId: "friend-1",
      channel: "bluebubbles",
      key: "chat",
      messageCount: 10,
    })

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(stripTranscriptMetadata(result.transcript)).toBe("[user] please check the release\n[assistant] release is merged")
      expect(result.snapshot).toContain("latest user: please check the release")
      expect(result.snapshot).toContain("latest assistant: release is merged")
      expect(result.transcript).not.toContain("shell output")
      expect(result.transcript).not.toContain("(delivered)")
    }
  })

  it("renders settle answers as assistant conversation text", async () => {
    const { summarizeSessionTail } = await import("../../heart/session-transcript")

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: "user", content: "what changed?" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "settle", arguments: JSON.stringify({ answer: "the release is clean", intent: "complete" }) } }] },
        { role: "tool", tool_call_id: "call_1", content: "(delivered)" },
      ],
    }))

    const result = await summarizeSessionTail({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/bluebubbles/chat.json",
      friendId: "friend-1",
      channel: "bluebubbles",
      key: "chat",
      messageCount: 10,
    })

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(stripTranscriptMetadata(result.transcript)).toBe("[user] what changed?\n[assistant] the release is clean")
    }
  })

  it("renders same-session send_message calls and ignores malformed tool arguments", async () => {
    const { summarizeSessionTail } = await import("../../heart/session-transcript")

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: "user", content: "are you seeing this?" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_bad", type: "function", function: { name: "settle", arguments: "{" } }] },
        { role: "assistant", content: null, tool_calls: [{ id: "call_array", type: "function", function: { name: "settle", arguments: "[]" } }] },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_missing_target",
            type: "function",
            function: {
              name: "send_message",
              arguments: JSON.stringify({ content: "missing target metadata" }),
            },
          }],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: {
              name: "send_message",
              arguments: JSON.stringify({
                friendId: "friend-1",
                channel: "bluebubbles",
                key: "chat",
                content: "yes, I see the latest text now",
              }),
            },
          }],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_2",
            type: "function",
            function: {
              name: "send_message",
              arguments: JSON.stringify({
                friendId: "friend-2",
                channel: "bluebubbles",
                key: "chat",
                content: "wrong friend",
              }),
            },
          }],
        },
      ],
    }))

    const result = await summarizeSessionTail({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/bluebubbles/chat.json",
      friendId: "friend-1",
      channel: "bluebubbles",
      key: "chat",
      messageCount: 10,
    })

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(stripTranscriptMetadata(result.transcript)).toBe("[user] are you seeing this?\n[assistant] yes, I see the latest text now")
      expect(result.transcript).not.toContain("wrong friend")
    }
  })

  it("uses the default transcript tail size when requested count is invalid", async () => {
    const { summarizeSessionTail } = await import("../../heart/session-transcript")

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: "user", content: "default count please" },
        { role: "assistant", content: "using default count" },
      ],
    }))

    const result = await summarizeSessionTail({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/bluebubbles/chat.json",
      friendId: "friend-1",
      channel: "bluebubbles",
      key: "chat",
      messageCount: 0,
    })

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(stripTranscriptMetadata(result.transcript)).toBe("[user] default count please\n[assistant] using default count")
    }
  })

  it("returns envelope-trimmed empty when the projected tail has no visible user text", async () => {
    const { summarizeSessionTail } = await import("../../heart/session-transcript")
    const staleHighSequence = sessionEvent(1000, "assistant", "old high-sequence answer", [], "2026-04-22T17:15:00.000Z")
    const archivedUser = sessionEvent(1, "user", "latest archived user text", [], "2026-04-28T23:01:00.000Z")
    const projectedAssistant = sessionEvent(2, "assistant", null, [{
      id: "call_1",
      type: "function",
      function: { name: "settle", arguments: JSON.stringify({ answer: "latest delivered answer", intent: "complete" }) },
    }], "2026-04-28T23:02:00.000Z")

    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      if (String(filePath).endsWith(".archive.ndjson")) {
        return `${JSON.stringify(staleHighSequence)}\n${JSON.stringify(archivedUser)}\n`
      }
      return JSON.stringify({
        version: 2,
        events: [projectedAssistant],
        projection: { eventIds: [projectedAssistant.id] },
        state: { lastFriendActivityAt: null, mustResolveBeforeHandoff: false },
      })
    })

    const result = await summarizeSessionTail({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/bluebubbles/chat.json",
      friendId: "friend-1",
      channel: "bluebubbles",
      key: "chat",
      messageCount: 2,
    })

    expect(result).toEqual({ kind: "empty", reason: "envelope_trimmed" })
  })

  it("ignores archive sidecars when assistant-heavy projected tails have no visible user", async () => {
    const { summarizeSessionTail } = await import("../../heart/session-transcript")
    const archivedUser = sessionEvent(10, "user", "latest inbound text", [], "2026-04-28T23:20:00.000Z")
    const projectedAssistants = [11, 12, 13].map((sequence) => sessionEvent(sequence, "assistant", null, [{
      id: `call_${sequence}`,
      type: "function",
      function: { name: "settle", arguments: JSON.stringify({ answer: `assistant visible update ${sequence}`, intent: "progress" }) },
    }], `2026-04-28T23:2${sequence - 10}:00.000Z`))

    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      if (String(filePath).endsWith(".archive.ndjson")) {
        return `${JSON.stringify(archivedUser)}\n`
      }
      return JSON.stringify({
        version: 2,
        events: projectedAssistants,
        projection: { eventIds: projectedAssistants.map((event) => event.id) },
        state: { lastFriendActivityAt: null, mustResolveBeforeHandoff: false },
      })
    })

    const result = await summarizeSessionTail({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/bluebubbles/chat.json",
      friendId: "friend-1",
      channel: "bluebubbles",
      key: "chat",
      messageCount: 2,
    })

    expect(result).toEqual({ kind: "empty", reason: "envelope_trimmed" })
  })

  it("keeps tool-result chatter for self inner transcript tails", async () => {
    const { summarizeSessionTail } = await import("../../heart/session-transcript")

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "inner checkpoint" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "status", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "internal tool trace" },
        { role: "assistant", content: "noted" },
      ],
    }))

    const result = await summarizeSessionTail({
      sessionPath: "/mock/agent-root/state/sessions/self/inner/dialog.json",
      friendId: "self",
      channel: "inner",
      key: "dialog",
      messageCount: 10,
    })

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(stripTranscriptMetadata(result.transcript)).toBe("[user] inner checkpoint\n[tool] internal tool trace\n[assistant] noted")
    }
  })

  it("uses trust-aware summarization instructions for non-self search_notes", async () => {
    const { summarizeSessionTail } = await import("../../heart/session-transcript")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "what happened in the group?" },
        { role: "assistant", content: "we resolved the release issue" },
      ],
    }))

    const summarize = vi.fn().mockResolvedValue("Summary: release issue resolved.")

    const result = await summarizeSessionTail({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/teams/thread.json",
      friendId: "friend-1",
      channel: "teams",
      key: "thread",
      messageCount: 20,
      trustLevel: "friend",
      summarize,
    })

    expect(result.kind).toBe("ok")
    expect(summarize).toHaveBeenCalledWith(
      expect.stringContaining("release issue"),
      expect.stringContaining("trust level: friend"),
    )
  })

  it("uses fully transparent summarization instructions for self/inner search_notes", async () => {
    const { summarizeSessionTail } = await import("../../heart/session-transcript")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "inner checkpoint" },
        { role: "assistant", content: "thinking about penguins" },
      ],
    }))

    const summarize = vi.fn().mockResolvedValue("Summary: thinking about penguins.")

    const result = await summarizeSessionTail({
      sessionPath: "/mock/agent-root/state/sessions/self/inner/dialog.json",
      friendId: "self",
      channel: "inner",
      key: "dialog",
      messageCount: 20,
      summarize,
    })

    expect(result.kind).toBe("ok")
    expect(summarize).toHaveBeenCalledWith(
      expect.stringContaining("penguins"),
      expect.stringContaining("inner dialog"),
    )
    expect(summarize.mock.calls[0][1]).not.toContain("trust level")
  })

  it("falls back to the raw transcript when no summarizer is available", async () => {
    const { summarizeSessionTail } = await import("../../heart/session-transcript")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    }))

    const result = await summarizeSessionTail({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
      messageCount: 20,
    })

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(stripTranscriptMetadata(result.transcript)).toBe("[user] hello\n[assistant] hi")
      expect(stripTranscriptMetadata(result.summary)).toBe("[user] hello\n[assistant] hi")
    }
  })

  it("normalizes structured content arrays into transcript text", async () => {
    const { summarizeSessionTail } = await import("../../heart/session-transcript")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "think about " },
            { type: "image", image_url: "penguin.png" },
            { type: "text", text: "penguins" },
            { type: "text", text: "" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "formal little " },
            { type: "tool_result", data: "ignored" },
            { type: "text", text: null },
            { type: "text", text: "blokes" },
          ],
        },
      ],
    }))

    const result = await summarizeSessionTail({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
      messageCount: 20,
    })

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(stripTranscriptMetadata(result.transcript)).toBe("[user] think about penguins\n[assistant] formal little blokes")
      expect(stripTranscriptMetadata(result.summary)).toBe("[user] think about penguins\n[assistant] formal little blokes")
    }
  })

  it("normalizes invalid roles and ignores non-array object content without inventing extra text", async () => {
    const { summarizeSessionTail } = await import("../../heart/session-transcript")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: 42, content: "should be ignored because role is invalid" },
        { role: "user", content: { type: "text", text: "should be ignored because content is not an array" } },
      ],
    }))

    const result = await summarizeSessionTail({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
      messageCount: 20,
    })

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(stripTranscriptMetadata(result.transcript)).toBe("[user] should be ignored because role is invalid")
      expect(stripTranscriptMetadata(result.summary)).toBe("[user] should be ignored because role is invalid")
      expect(result.transcript).not.toContain("not an array")
    }
  })

  it("ignores malformed non-object session entries while keeping valid messages", async () => {
    const { summarizeSessionTail } = await import("../../heart/session-transcript")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        null,
        "not-a-message",
        { role: "user", content: "keep the real message" },
      ],
    }))

    const result = await summarizeSessionTail({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
      messageCount: 20,
    })

    expect(result.kind).toBe("ok")
    if (result.kind === "ok") {
      expect(stripTranscriptMetadata(result.transcript)).toBe("[user] keep the real message")
      expect(stripTranscriptMetadata(result.summary)).toBe("[user] keep the real message")
    }
  })

  it("clips long summaries and latest-turn previews in the snapshot", async () => {
    const { summarizeSessionTail } = await import("../../heart/session-transcript")
    const longSummary = "summary ".repeat(50).trim()
    const longUser = "user detail ".repeat(30).trim()
    const longAssistant = "assistant detail ".repeat(30).trim()
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: "user", content: longUser },
        { role: "assistant", content: longAssistant },
      ],
    }))

    const result = await summarizeSessionTail({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
      messageCount: 20,
      summarize: vi.fn().mockResolvedValue(longSummary),
    })

    expect(result.kind).toBe("ok")
    const snapshot = result.kind === "ok" ? result.snapshot : ""
    expect(snapshot).toContain("recent focus: ")
    expect(snapshot).toContain("latest user: ")
    expect(snapshot).toContain("latest assistant: ")
    expect(snapshot).toContain("…")
  })

  it("returns envelope-trimmed empty when the visible transcript is assistant-only", async () => {
    const { summarizeSessionTail } = await import("../../heart/session-transcript")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: "assistant", content: "i surfaced this note from inner dialog" },
      ],
    }))

    const result = await summarizeSessionTail({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
      messageCount: 20,
    })

    expect(result).toEqual({ kind: "empty", reason: "envelope_trimmed" })
  })

  it("does not export searchSessionTranscript from the transcript module surface", async () => {
    const moduleExports = await import("../../heart/session-transcript") as Record<string, unknown>

    expect(moduleExports).not.toHaveProperty("searchSessionTranscript")
  })

  it("returns empty when the session has no non-system messages", async () => {
    const { summarizeSessionTail } = await import("../../heart/session-transcript")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: "system", content: "sys" },
      ],
    }))

    const result = await summarizeSessionTail({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
      messageCount: 20,
    })

    expect(result).toEqual({ kind: "empty", reason: "envelope_trimmed" })
  })

  it("returns missing when the session file cannot be read", async () => {
    const { summarizeSessionTail } = await import("../../heart/session-transcript")
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT")
    })

    const result = await summarizeSessionTail({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
      messageCount: 20,
    })

    expect(result).toEqual({ kind: "missing" })
  })
})
