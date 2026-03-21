import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
}))

import * as fs from "fs"

describe("session-recall", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockReset()
  })

  it("extracts a canonical transcript tail and compact snapshot", async () => {
    const { recallSession } = await import("../../heart/session-recall")

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

    const result = await recallSession({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
      messageCount: 2,
    })

    expect(result).toMatchObject({
      kind: "ok",
      transcript: "[user] latest user question\n[assistant] latest assistant answer",
      summary: "[user] latest user question\n[assistant] latest assistant answer",
      snapshot: expect.stringContaining("recent focus:"),
    })
    expect(result.kind === "ok" ? result.snapshot : "").toContain("latest user question")
    expect(result.kind === "ok" ? result.snapshot : "").not.toContain("oldest question")
  })

  it("uses saved session orientation in both summary and snapshot when available", async () => {
    const { recallSession } = await import("../../heart/session-recall")

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      sessionOrientation: {
        updatedAt: "2026-03-21T09:00:00.000Z",
        goal: "keep the agent oriented",
        constraints: ["keep it simple"],
        progress: ["edit_file src/mind/prompt.ts"],
        readFiles: ["src/mind/context.ts"],
        modifiedFiles: ["src/mind/prompt.ts"],
      },
      messages: [
        { role: "user", content: "what happened?" },
        { role: "assistant", content: "i updated the prompt" },
      ],
    }))

    const result = await recallSession({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
      messageCount: 20,
    })

    expect(result.kind).toBe("ok")
    const ok = result.kind === "ok" ? result : null
    expect(ok?.summary).toContain("session orientation:")
    expect(ok?.summary).toContain("goal: keep the agent oriented")
    expect(ok?.summary).toContain("progress: edit_file src/mind/prompt.ts")
    expect(ok?.snapshot).toContain("goal: keep the agent oriented")
    expect(ok?.snapshot).toContain("files: src/mind/prompt.ts")
  })

  it("uses trust-aware summarization instructions for non-self recall", async () => {
    const { recallSession } = await import("../../heart/session-recall")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "what happened in the group?" },
        { role: "assistant", content: "we resolved the release issue" },
      ],
    }))

    const summarize = vi.fn().mockResolvedValue("Summary: release issue resolved.")

    const result = await recallSession({
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

  it("uses fully transparent summarization instructions for self/inner recall", async () => {
    const { recallSession } = await import("../../heart/session-recall")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "inner checkpoint" },
        { role: "assistant", content: "thinking about penguins" },
      ],
    }))

    const summarize = vi.fn().mockResolvedValue("Summary: thinking about penguins.")

    const result = await recallSession({
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
    const { recallSession } = await import("../../heart/session-recall")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    }))

    const result = await recallSession({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
      messageCount: 20,
    })

    expect(result).toMatchObject({
      kind: "ok",
      transcript: "[user] hello\n[assistant] hi",
      summary: "[user] hello\n[assistant] hi",
    })
  })

  it("normalizes structured content arrays into transcript text", async () => {
    const { recallSession } = await import("../../heart/session-recall")
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

    const result = await recallSession({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
      messageCount: 20,
    })

    expect(result).toMatchObject({
      kind: "ok",
      transcript: "[user] think about penguins\n[assistant] formal little blokes",
      summary: "[user] think about penguins\n[assistant] formal little blokes",
    })
  })

  it("normalizes invalid roles and ignores non-array object content without inventing extra text", async () => {
    const { recallSession } = await import("../../heart/session-recall")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: 42, content: "should be ignored because role is invalid" },
        { role: "user", content: { type: "text", text: "should be ignored because content is not an array" } },
      ],
    }))

    const result = await recallSession({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
      messageCount: 20,
    })

    expect(result).toMatchObject({
      kind: "ok",
      transcript: "[] should be ignored because role is invalid",
      summary: "[] should be ignored because role is invalid",
    })
    expect(result.kind === "ok" ? result.transcript : "").not.toContain("not an array")
  })

  it("ignores malformed non-object session entries while keeping valid messages", async () => {
    const { recallSession } = await import("../../heart/session-recall")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        null,
        "not-a-message",
        { role: "user", content: "keep the real message" },
      ],
    }))

    const result = await recallSession({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
      messageCount: 20,
    })

    expect(result).toMatchObject({
      kind: "ok",
      transcript: "[user] keep the real message",
      summary: "[user] keep the real message",
    })
  })

  it("clips long summaries and latest-turn previews in the snapshot", async () => {
    const { recallSession } = await import("../../heart/session-recall")
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

    const result = await recallSession({
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

  it("returns missing when a history search cannot read the session file", async () => {
    const { searchSessionTranscript } = await import("../../heart/session-recall")
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

  it("searches the full session history and returns matched excerpts with orientation context", async () => {
    const { searchSessionTranscript } = await import("../../heart/session-recall")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      sessionOrientation: {
        updatedAt: "2026-03-21T09:00:00.000Z",
        goal: "keep the billing follow-up grounded",
        constraints: ["answer directly"],
        progress: ["query_session search"],
        readFiles: [],
        modifiedFiles: [],
      },
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
    expect(ok?.snapshot).toContain("goal: keep the billing follow-up grounded")
    expect(ok?.matches).toHaveLength(2)
    expect(ok?.matches[0]).toContain("[assistant] yes, looking now")
    expect(ok?.matches[0]).toContain("[user] the billing fix looked shaky earlier")
    expect(ok?.matches[0]).toContain("[assistant] the billing fix is merged and stable now")
  })

  it("returns a no-match search result with current orientation and latest turn context", async () => {
    const { searchSessionTranscript } = await import("../../heart/session-recall")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      sessionOrientation: {
        updatedAt: "2026-03-21T09:00:00.000Z",
        goal: "stay oriented",
        constraints: ["keep it simple"],
        progress: [],
        readFiles: [],
        modifiedFiles: [],
      },
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
      snapshot: expect.stringContaining("goal: stay oriented"),
    })
    expect(result.kind === "no_match" ? result.snapshot : "").toContain("latest assistant: hi, still on the release thread")
  })

  it("builds no-match snapshots without goal or assistant lines when that context is absent", async () => {
    const { searchSessionTranscript } = await import("../../heart/session-recall")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      sessionOrientation: {
        updatedAt: "2026-03-21T09:00:00.000Z",
        constraints: ["keep it simple"],
        progress: [],
        readFiles: [],
        modifiedFiles: [],
      },
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
    expect(snapshot).toContain("constraints: keep it simple")
    expect(snapshot).toContain("latest user: hello there")
    expect(snapshot).not.toContain("goal:")
    expect(snapshot).not.toContain("latest assistant:")
  })

  it("returns empty for search when the session has no non-system messages", async () => {
    const { searchSessionTranscript } = await import("../../heart/session-recall")
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

  it("treats a blank search query as no match while still surfacing orientation context", async () => {
    const { searchSessionTranscript } = await import("../../heart/session-recall")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      sessionOrientation: {
        updatedAt: "2026-03-21T09:00:00.000Z",
        goal: "stay oriented",
        constraints: [],
        progress: [],
        readFiles: [],
        modifiedFiles: [],
      },
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
      snapshot: expect.stringContaining("goal: stay oriented"),
    })
  })

  it("collapses duplicate history excerpts when repeated matches would produce the same snippet", async () => {
    const { searchSessionTranscript } = await import("../../heart/session-recall")
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
    expect(result.kind === "ok" ? result.matches : []).toEqual([
      "[user] hello there\n[assistant] billing is green now\n[user] hello there",
    ])
  })

  it("returns empty when the session has no non-system messages", async () => {
    const { recallSession } = await import("../../heart/session-recall")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [
        { role: "system", content: "sys" },
      ],
    }))

    const result = await recallSession({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
      messageCount: 20,
    })

    expect(result).toEqual({ kind: "empty" })
  })

  it("returns missing when the session file cannot be read", async () => {
    const { recallSession } = await import("../../heart/session-recall")
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT")
    })

    const result = await recallSession({
      sessionPath: "/mock/agent-root/state/sessions/friend-1/cli/session.json",
      friendId: "friend-1",
      channel: "cli",
      key: "session",
      messageCount: 20,
    })

    expect(result).toEqual({ kind: "missing" })
  })
})
