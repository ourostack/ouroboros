import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
}))

import * as fs from "fs"

function stripTranscriptMetadata(text: string): string {
  return text.replace(/\[[^\]]*\|\s*(system|user|assistant|tool)\s*\|\s*evt-\d+\]\s*/g, "[$1] ")
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

  it("builds snapshots without a latest-user line when the visible transcript is assistant-only", async () => {
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

    expect(result.kind).toBe("ok")
    const snapshot = result.kind === "ok" ? result.snapshot : ""
    expect(snapshot).toContain("latest assistant: i surfaced this note from inner dialog")
    expect(snapshot).not.toContain("latest user:")
  })

  it("returns missing when a history search cannot read the session file", async () => {
    const { searchSessionTranscript } = await import("../../heart/session-transcript")
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT")
    })

    const result = await searchSessionTranscript({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
      query: "billing",
    })

    expect(result).toEqual({ kind: "missing" })
  })

  it("searches the full session history and returns matched excerpts", async () => {
    const { searchSessionTranscript } = await import("../../heart/session-transcript")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: "user", content: "can you check billing history?" },
        { role: "assistant", content: "yes, looking now" },
        { role: "user", content: "the billing fix looked shaky earlier" },
        { role: "assistant", content: "the billing fix is merged and stable now" },
        { role: "user", content: "great, thanks" },
      ],
    }))

    const result = await searchSessionTranscript({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
      query: "billing",
    })

    expect(result.kind).toBe("ok")
    const ok = result.kind === "ok" ? result : null
    expect(ok?.snapshot).toContain('history query: "billing"')
    expect(ok?.matches).toHaveLength(2)
    expect(stripTranscriptMetadata(ok?.matches[0] ?? "")).toContain("[assistant] yes, looking now")
    expect(stripTranscriptMetadata(ok?.matches[0] ?? "")).toContain("[user] the billing fix looked shaky earlier")
    expect(stripTranscriptMetadata(ok?.matches[0] ?? "")).toContain("[assistant] the billing fix is merged and stable now")
  })

  it("returns a no-match search result with the latest turn context", async () => {
    const { searchSessionTranscript } = await import("../../heart/session-transcript")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: "user", content: "hello there" },
        { role: "assistant", content: "hi, still on the release thread" },
      ],
    }))

    const result = await searchSessionTranscript({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
      query: "billing",
    })

    expect(result).toMatchObject({
      kind: "no_match",
      query: "billing",
      snapshot: expect.stringContaining('history query: "billing"'),
    })
    expect(result.kind === "no_match" ? result.snapshot : "").toContain("latest assistant: hi, still on the release thread")
  })

  it("builds no-match snapshots without assistant lines when that context is absent", async () => {
    const { searchSessionTranscript } = await import("../../heart/session-transcript")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: "user", content: "hello there" },
      ],
    }))

    const result = await searchSessionTranscript({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
      query: "billing",
    })

    expect(result.kind).toBe("no_match")
    const snapshot = result.kind === "no_match" ? result.snapshot : ""
    expect(snapshot).toContain('history query: "billing"')
    expect(snapshot).toContain("latest user: hello there")
    expect(snapshot).not.toContain("latest assistant:")
  })

  it("returns empty for search when v2 envelope exists but has zero events", async () => {
    const { searchSessionTranscript } = await import("../../heart/session-transcript")
    const emptyV2Envelope = {
      version: 2,
      events: [],
      projection: { eventIds: [] },
      state: { lastFriendActivityAt: null, mustResolveBeforeHandoff: false },
    }
    vi.mocked(fs.readFileSync).mockImplementation((path: any) => {
      if (String(path).endsWith(".ndjson")) throw new Error("ENOENT")
      return JSON.stringify(emptyV2Envelope)
    })

    const result = await searchSessionTranscript({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
      query: "billing",
    })

    expect(result).toEqual({ kind: "empty" })
  })

  it("returns empty for search when the session has no non-system messages", async () => {
    const { searchSessionTranscript } = await import("../../heart/session-transcript")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: "system", content: "sys" },
      ],
    }))

    const result = await searchSessionTranscript({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
      query: "billing",
    })

    expect(result).toEqual({ kind: "empty" })
  })

  it("treats a blank search query as no match while still surfacing the query snapshot", async () => {
    const { searchSessionTranscript } = await import("../../heart/session-transcript")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: "user", content: "hello there" },
        { role: "assistant", content: "still on the release thread" },
      ],
    }))

    const result = await searchSessionTranscript({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
      query: "   ",
    })

    expect(result).toMatchObject({
      kind: "no_match",
      query: "",
      snapshot: expect.stringContaining('history query: ""'),
    })
  })

  it("collapses duplicate history excerpts when repeated matches would produce the same snippet", async () => {
    const { searchSessionTranscript } = await import("../../heart/session-transcript")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: "user", content: "hello there" },
        { role: "assistant", content: "billing is green now" },
        { role: "user", content: "hello there" },
        { role: "assistant", content: "billing is green now" },
        { role: "user", content: "hello there" },
      ],
    }))

    const result = await searchSessionTranscript({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
      query: "billing",
    })

    expect(result.kind).toBe("ok")
    expect((result.kind === "ok" ? result.matches : []).map(stripTranscriptMetadata)).toEqual([
      "[user] hello there\n[assistant] billing is green now\n[user] hello there",
    ])
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

    expect(result).toEqual({ kind: "empty" })
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
