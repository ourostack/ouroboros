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
