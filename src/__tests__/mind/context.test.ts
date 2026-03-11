import { describe, it, expect, vi, beforeEach } from "vitest"
import type OpenAI from "openai"

// Mock fs for session persistence tests
vi.mock("fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}))

// Mock config for postTurn tests
vi.mock("../../heart/config", () => ({
  getContextConfig: vi.fn().mockReturnValue({ maxTokens: 80000, contextMargin: 20 }),
}))

import * as fs from "fs"

// cachedBuildSystem and resetSystemPromptCache removed in Unit 1G
// (per-friend context makes 60s TTL cache incorrect)

describe("removed cache functions", () => {
  beforeEach(() => { vi.resetModules() })

  it("cachedBuildSystem no longer exists", async () => {
    const context = await import("../../mind/context")
    expect("cachedBuildSystem" in context).toBe(false)
  })

  it("resetSystemPromptCache no longer exists", async () => {
    const context = await import("../../mind/context")
    expect("resetSystemPromptCache" in context).toBe(false)
  })
})

describe("trimMessages", () => {
  beforeEach(() => { vi.resetModules() })

  // New signature: trimMessages(messages, maxTokens, contextMargin, actualTokenCount?)

  it("when actualTokenCount exceeds maxTokens, messages are trimmed", async () => {
    const { trimMessages } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "old msg" },
      { role: "assistant", content: "old reply" },
      { role: "user", content: "new msg" },
      { role: "assistant", content: "new reply" },
    ]
    // actualTokenCount=120000, maxTokens=80000, margin=20 -> trimTarget=64000
    // perMessageCost = 120000/5 = 24000
    // Need to drop until remaining <= 64000
    // Drop msg[1] (24000): 120000-24000 = 96000 > 64000
    // Drop msg[2] (24000): 96000-24000 = 72000 > 64000
    // Drop msg[3] (24000): 72000-24000 = 48000 <= 64000
    // Result: [sys, msg[4]] = 2 messages
    const result = trimMessages(msgs, 80000, 20, 120000)
    expect(result.length).toBe(2)
    expect(result[0].role).toBe("system")
    expect(result[1]).toBe(msgs[4])
  })

  it("when actualTokenCount is under maxTokens, no trimming occurs", async () => {
    const { trimMessages } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]
    const result = trimMessages(msgs, 80000, 20, 50000)
    expect(result).toEqual(msgs)
    expect(result).not.toBe(msgs) // new array
  })

  it("system prompt (index 0) is always preserved", async () => {
    const { trimMessages } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "big message" },
    ]
    // Force heavy trimming
    const result = trimMessages(msgs, 1000, 20, 50000)
    expect(result.length).toBe(1)
    expect(result[0].role).toBe("system")
  })

  it("trims to target: maxTokens * (1 - contextMargin/100)", async () => {
    const { trimMessages } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]
    // actualTokenCount=100, maxTokens=80, margin=25 -> trimTarget=60
    // perMessageCost=100/4=25
    // Drop msg[1] (25): 100-25=75 > 60
    // Drop msg[2] (25): 75-25=50 <= 60
    // Result: [sys, msg[3]] = 2 messages
    const result = trimMessages(msgs, 80, 25, 100)
    expect(result.length).toBe(2)
    expect(result[0].role).toBe("system")
    expect(result[1]).toBe(msgs[3])
  })

  it("when actualTokenCount is 0, no trimming occurs (cold start)", async () => {
    const { trimMessages } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]
    const result = trimMessages(msgs, 80000, 20, 0)
    expect(result).toEqual(msgs)
  })

  it("when actualTokenCount is undefined, no trimming occurs (cold start)", async () => {
    const { trimMessages } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]
    const result = trimMessages(msgs, 80000, 20)
    expect(result).toEqual(msgs)
  })

  it("no trimming when message count is high but tokens are under maxTokens", async () => {
    const { trimMessages } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
    ]
    for (let i = 0; i < 299; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: "hi" })
    }
    expect(msgs.length).toBe(300)
    // Token count is under maxTokens — no trimming despite high message count
    const result = trimMessages(msgs, 80000, 20, 1000)
    expect(result.length).toBe(300)
    expect(result[0].role).toBe("system")
  })

  it("single message (system only) -- nothing to trim", async () => {
    const { trimMessages } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "hello" },
    ]
    const result = trimMessages(msgs, 80000, 20, 500)
    expect(result.length).toBe(1)
    expect(result[0].role).toBe("system")
  })

  it("all messages would be trimmed -- only system remains", async () => {
    const { trimMessages } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]
    // Extreme: actualTokenCount very high relative to maxTokens
    const result = trimMessages(msgs, 100, 20, 10000)
    expect(result.length).toBe(1)
    expect(result[0].role).toBe("system")
  })

  it("treats assistant tool_calls and following tool results as one trimmable block", async () => {
    const { trimMessages } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" },
          },
        ],
      } as any,
      { role: "tool", tool_call_id: "call_1", content: "ok" } as any,
      { role: "tool", tool_call_id: "call_1", content: "more" } as any,
      { role: "user", content: "latest intent" },
    ]

    const result = trimMessages(msgs, 100, 20, 500)
    expect(result[0].role).toBe("system")
    expect(result.length).toBe(1)
  })

  it("does not mutate input array", async () => {
    const { trimMessages } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "reply" },
    ]
    const originalLength = msgs.length
    trimMessages(msgs, 100, 20, 5000)
    expect(msgs.length).toBe(originalLength)
  })

  it("no trimming when actualTokenCount is undefined regardless of message count", async () => {
    const { trimMessages } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
    ]
    for (let i = 0; i < 250; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: "hi" })
    }
    expect(msgs.length).toBe(251)
    const result = trimMessages(msgs, 80000, 20)
    expect(result.length).toBe(251)
    expect(result[0].role).toBe("system")
  })
})

describe("saveSession", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.writeFileSync).mockReset()
    vi.mocked(fs.mkdirSync).mockReset()
  })

  it("writes messages wrapped in versioned envelope", async () => {
    const { saveSession } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]
    saveSession("/tmp/test-session.json", msgs)

    expect(fs.mkdirSync).toHaveBeenCalledWith("/tmp", { recursive: true })
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      "/tmp/test-session.json",
      JSON.stringify({ version: 1, messages: msgs }, null, 2),
    )
  })

  it("creates parent directories recursively", async () => {
    const { saveSession } = await import("../../mind/context")
    saveSession("/a/b/c/session.json", [])

    expect(fs.mkdirSync).toHaveBeenCalledWith("/a/b/c", { recursive: true })
  })

  // --- Unit 3c: saveSession with lastUsage ---

  it("includes lastUsage in JSON envelope when provided", async () => {
    const { saveSession } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
    ]
    const usage = { input_tokens: 100, output_tokens: 50, reasoning_tokens: 10, total_tokens: 150 }
    saveSession("/tmp/session.json", msgs, usage)

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      "/tmp/session.json",
      JSON.stringify({ version: 1, messages: msgs, lastUsage: usage }, null, 2),
    )
  })

  it("omits lastUsage from envelope when not provided", async () => {
    const { saveSession } = await import("../../mind/context")
    saveSession("/tmp/session.json", [])

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
    const parsed = JSON.parse(written)
    expect(parsed.lastUsage).toBeUndefined()
  })

  it("writes persisted continuity state when mustResolveBeforeHandoff is true", async () => {
    const { saveSession } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
    ]

    ;(saveSession as any)("/tmp/session.json", msgs, undefined, { mustResolveBeforeHandoff: true })

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      "/tmp/session.json",
      JSON.stringify(
        { version: 1, messages: msgs, state: { mustResolveBeforeHandoff: true } },
        null,
        2,
      ),
    )
  })

  it("omits persisted continuity state when mustResolveBeforeHandoff is false", async () => {
    const { saveSession } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
    ]

    ;(saveSession as any)("/tmp/session.json", msgs, undefined, { mustResolveBeforeHandoff: false })

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      "/tmp/session.json",
      JSON.stringify({ version: 1, messages: msgs }, null, 2),
    )
  })

  it("repairs back-to-back assistant messages on save", async () => {
    const { saveSession } = await import("../../mind/context")
    const msgs: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "first" },
      { role: "assistant", content: "second" },
    ]
    saveSession("/tmp/session.json", msgs)

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
    const parsed = JSON.parse(written)
    // Should have merged the two assistant messages
    expect(parsed.messages).toHaveLength(3)
    expect(parsed.messages[2].content).toContain("first")
    expect(parsed.messages[2].content).toContain("second")
  })
})

describe("loadSession", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockReset()
  })

  // --- Unit 3c: loadSession returns { messages, lastUsage } ---

  it("returns { messages, lastUsage } from valid session file", async () => {
    const { loadSession } = await import("../../mind/context")
    const msgs = [{ role: "system", content: "sys" }, { role: "user", content: "hi" }]
    const usage = { input_tokens: 100, output_tokens: 50, reasoning_tokens: 10, total_tokens: 150 }
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ version: 1, messages: msgs, lastUsage: usage }),
    )
    const result = loadSession("/tmp/session.json")
    expect(result).toEqual({ messages: msgs, lastUsage: usage })
  })

  it("returns lastUsage: undefined when not present in saved file", async () => {
    const { loadSession } = await import("../../mind/context")
    const msgs = [{ role: "system", content: "sys" }]
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ version: 1, messages: msgs }),
    )
    const result = loadSession("/tmp/session.json")
    expect(result).toEqual({ messages: msgs, lastUsage: undefined })
  })

  it("returns persisted continuity state when the saved envelope has a boolean mustResolveBeforeHandoff", async () => {
    const { loadSession } = await import("../../mind/context")
    const msgs = [{ role: "system", content: "sys" }]
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ version: 1, messages: msgs, state: { mustResolveBeforeHandoff: true } }),
    )
    const result = loadSession("/tmp/session.json")
    expect(result).toEqual({ messages: msgs, lastUsage: undefined, state: { mustResolveBeforeHandoff: true } })
  })

  it("ignores malformed optional continuity state instead of rejecting the session", async () => {
    const { loadSession } = await import("../../mind/context")
    const msgs = [{ role: "system", content: "sys" }]
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ version: 1, messages: msgs, state: { mustResolveBeforeHandoff: "yes please" } }),
    )
    const result = loadSession("/tmp/session.json")
    expect(result).toEqual({ messages: msgs, lastUsage: undefined, state: undefined })
  })

  it("returns null when file is missing (ENOENT)", async () => {
    const { loadSession } = await import("../../mind/context")
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      const err: any = new Error("ENOENT")
      err.code = "ENOENT"
      throw err
    })
    expect(loadSession("/tmp/missing.json")).toBeNull()
  })

  it("returns null when file contains invalid JSON", async () => {
    const { loadSession } = await import("../../mind/context")
    vi.mocked(fs.readFileSync).mockReturnValue("not valid json{{{")
    expect(loadSession("/tmp/corrupt.json")).toBeNull()
  })

  it("returns null when version is unrecognized", async () => {
    const { loadSession } = await import("../../mind/context")
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ version: 99, messages: [] }),
    )
    expect(loadSession("/tmp/future.json")).toBeNull()
  })

  it("returns null on other read errors", async () => {
    const { loadSession } = await import("../../mind/context")
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("EPERM")
    })
    expect(loadSession("/tmp/noperm.json")).toBeNull()
  })

  it("repairs back-to-back assistant messages on load", async () => {
    const { loadSession } = await import("../../mind/context")
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
          { role: "assistant", content: "first" },
          { role: "assistant", content: "second" },
        ],
      }),
    )
    const result = loadSession("/tmp/session.json")
    expect(result).not.toBeNull()
    expect(result!.messages).toHaveLength(3)
    expect((result!.messages[2] as any).content).toContain("first")
    expect((result!.messages[2] as any).content).toContain("second")
  })
})

describe("deleteSession", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.unlinkSync).mockReset()
  })

  it("removes the session file", async () => {
    const { deleteSession } = await import("../../mind/context")
    deleteSession("/tmp/session.json")
    expect(fs.unlinkSync).toHaveBeenCalledWith("/tmp/session.json")
  })

  it("is a no-op when file is missing (ENOENT)", async () => {
    const { deleteSession } = await import("../../mind/context")
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      const err: any = new Error("ENOENT")
      err.code = "ENOENT"
      throw err
    })
    expect(() => deleteSession("/tmp/missing.json")).not.toThrow()
  })

  it("re-throws non-ENOENT errors", async () => {
    const { deleteSession } = await import("../../mind/context")
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      const err: any = new Error("EPERM")
      err.code = "EPERM"
      throw err
    })
    expect(() => deleteSession("/tmp/noperm.json")).toThrow("EPERM")
  })
})

// --- Unit 3e: postTurn function ---

describe("postTurn", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.writeFileSync).mockReset()
    vi.mocked(fs.mkdirSync).mockReset()
  })

  it("trims messages when usage.input_tokens exceeds maxTokens and saves with lastUsage", async () => {
    const { getContextConfig } = await import("../../heart/config")
    vi.mocked(getContextConfig).mockReturnValue({ maxTokens: 80000, contextMargin: 20 })

    const { postTurn } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "old" },
      { role: "assistant", content: "old reply" },
      { role: "user", content: "new" },
      { role: "assistant", content: "new reply" },
    ]
    const usage = { input_tokens: 120000, output_tokens: 50, reasoning_tokens: 10, total_tokens: 120050 }
    postTurn(messages, "/tmp/sess.json", usage)

    // Messages should be trimmed (120000 > 80000)
    expect(messages.length).toBeLessThan(5)
    expect(messages[0].role).toBe("system")
    // Session should be saved with lastUsage
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1)
    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
    expect(written.lastUsage).toEqual(usage)
  })

  it("does not trim when usage is undefined (cold start) but still saves session", async () => {
    const { getContextConfig } = await import("../../heart/config")
    vi.mocked(getContextConfig).mockReturnValue({ maxTokens: 80000, contextMargin: 20 })

    const { postTurn } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]
    postTurn(messages, "/tmp/sess.json")

    expect(messages.length).toBe(2)
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1)
  })

  it("does not trim when usage.input_tokens is under maxTokens, saves with lastUsage", async () => {
    const { getContextConfig } = await import("../../heart/config")
    vi.mocked(getContextConfig).mockReturnValue({ maxTokens: 80000, contextMargin: 20 })

    const { postTurn } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]
    const usage = { input_tokens: 50000, output_tokens: 10, reasoning_tokens: 0, total_tokens: 50010 }
    postTurn(messages, "/tmp/sess.json", usage)

    expect(messages.length).toBe(2)
    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
    expect(written.lastUsage).toEqual(usage)
  })

  it("mutates messages array in place (splice, not copy)", async () => {
    const { getContextConfig } = await import("../../heart/config")
    vi.mocked(getContextConfig).mockReturnValue({ maxTokens: 100, contextMargin: 20 })

    const { postTurn } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]
    const originalRef = messages
    const usage = { input_tokens: 10000, output_tokens: 10, reasoning_tokens: 0, total_tokens: 10010 }
    postTurn(messages, "/tmp/sess.json", usage)

    // Same reference, mutated in place
    expect(messages).toBe(originalRef)
    expect(messages.length).toBeLessThan(4)
    expect(messages[0].role).toBe("system")
  })

  it("saves with (possibly trimmed) messages and usage", async () => {
    const { getContextConfig } = await import("../../heart/config")
    vi.mocked(getContextConfig).mockReturnValue({ maxTokens: 80000, contextMargin: 20 })

    const { postTurn } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]
    const usage = { input_tokens: 50000, output_tokens: 10, reasoning_tokens: 0, total_tokens: 50010 }
    postTurn(messages, "/tmp/sess.json", usage)

    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
    expect(written.version).toBe(1)
    expect(written.messages).toEqual(messages)
    expect(written.lastUsage).toEqual(usage)
  })

  it("handles empty messages array (only system prompt)", async () => {
    const { getContextConfig } = await import("../../heart/config")
    vi.mocked(getContextConfig).mockReturnValue({ maxTokens: 80000, contextMargin: 20 })

    const { postTurn } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
    ]
    const usage = { input_tokens: 1000, output_tokens: 10, reasoning_tokens: 0, total_tokens: 1010 }
    postTurn(messages, "/tmp/sess.json", usage)

    expect(messages.length).toBe(1)
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1)
  })

  it("runs extract-before-trim hook with pre-trim messages so dropped context can be captured", async () => {
    const { getContextConfig } = await import("../../heart/config")
    vi.mocked(getContextConfig).mockReturnValue({ maxTokens: 100, contextMargin: 20 })

    const { postTurn } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "remember: old memory that will be trimmed" },
      { role: "assistant", content: "old reply" },
      { role: "user", content: "new message" },
    ]
    const usage = { input_tokens: 10000, output_tokens: 10, reasoning_tokens: 0, total_tokens: 10010 }

    let hookCalled = false
    let sawOldMessage = false

    ;(postTurn as any)(
      messages,
      "/tmp/sess.json",
      usage,
      {
        beforeTrim: (preTrimMessages: any[]) => {
          hookCalled = true
          sawOldMessage = preTrimMessages.some((m) =>
            typeof m.content === "string" && m.content.includes("old memory that will be trimmed"),
          )
        },
      },
    )

    expect(hookCalled).toBe(true)
    expect(sawOldMessage).toBe(true)
    expect(messages.some((m) => typeof m.content === "string" && m.content.includes("old memory that will be trimmed"))).toBe(false)
  })

  it("continues saving session when extract-before-trim hook throws", async () => {
    const { getContextConfig } = await import("../../heart/config")
    vi.mocked(getContextConfig).mockReturnValue({ maxTokens: 80000, contextMargin: 20 })

    const { postTurn } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ]
    const usage = { input_tokens: 1000, output_tokens: 10, reasoning_tokens: 0, total_tokens: 1010 }

    expect(() =>
      (postTurn as any)(
        messages,
        "/tmp/sess.json",
        usage,
        {
          beforeTrim: () => {
            throw new Error("hook failed")
          },
        },
      ),
    ).not.toThrow()
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1)
  })

  it("continues saving session when extract-before-trim hook throws non-Error values", async () => {
    const { getContextConfig } = await import("../../heart/config")
    vi.mocked(getContextConfig).mockReturnValue({ maxTokens: 80000, contextMargin: 20 })

    const { postTurn } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ]
    const usage = { input_tokens: 1000, output_tokens: 10, reasoning_tokens: 0, total_tokens: 1010 }

    expect(() =>
      (postTurn as any)(
        messages,
        "/tmp/sess.json",
        usage,
        {
          beforeTrim: () => {
            throw "hook failed as string"
          },
        },
      ),
    ).not.toThrow()
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1)
  })
})

describe("mind observability instrumentation", () => {
  it("trimMessages emits mind step lifecycle events", async () => {
    vi.resetModules()
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({
      emitNervesEvent,
    }))

    const { trimMessages } = await import("../../mind/context")
    trimMessages(
      [
        { role: "system", content: "sys" } as any,
        { role: "user", content: "hello" } as any,
      ],
      100,
      20,
      200,
    )

    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "mind.step_start" }))
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "mind.step_end" }))
  })
})

describe("validateSessionMessages", () => {
  beforeEach(() => { vi.resetModules() })

  it("returns no violations for valid user/assistant sequence", async () => {
    const { validateSessionMessages } = await import("../../mind/context")
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "how?" },
      { role: "assistant", content: "fine" },
    ]
    expect(validateSessionMessages(messages)).toEqual([])
  })

  it("returns no violations for assistant with tool calls followed by tool results then user", async () => {
    const { validateSessionMessages } = await import("../../mind/context")
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "check" },
      { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function" as const, function: { name: "foo", arguments: "{}" } }] },
      { role: "tool", content: "result", tool_call_id: "t1" },
      { role: "assistant", content: "done" },
      { role: "user", content: "ok" },
    ]
    expect(validateSessionMessages(messages)).toEqual([])
  })

  it("detects back-to-back assistant messages", async () => {
    const { validateSessionMessages } = await import("../../mind/context")
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "assistant", content: "hello again" },
    ]
    const violations = validateSessionMessages(messages)
    expect(violations.length).toBeGreaterThan(0)
    expect(violations[0]).toContain("back-to-back assistant")
  })

  it("returns empty for empty message array", async () => {
    const { validateSessionMessages } = await import("../../mind/context")
    expect(validateSessionMessages([])).toEqual([])
  })

  it("returns empty for system-only messages", async () => {
    const { validateSessionMessages } = await import("../../mind/context")
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
    ]
    expect(validateSessionMessages(messages)).toEqual([])
  })
})

describe("repairSessionMessages", () => {
  beforeEach(() => { vi.resetModules() })

  it("merges back-to-back assistant messages", async () => {
    const { repairSessionMessages } = await import("../../mind/context")
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "assistant", content: "hello again" },
    ]
    const repaired = repairSessionMessages(messages)
    expect(repaired.length).toBe(3)
    expect(repaired[2].role).toBe("assistant")
    expect((repaired[2] as any).content).toContain("hello")
    expect((repaired[2] as any).content).toContain("hello again")
  })

  it("returns unchanged for valid messages", async () => {
    const { repairSessionMessages } = await import("../../mind/context")
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]
    const repaired = repairSessionMessages(messages)
    expect(repaired).toEqual(messages)
  })

  it("handles non-string content in back-to-back assistant messages", async () => {
    const { repairSessionMessages } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: null },
      { role: "assistant", content: undefined },
    ]
    const repaired = repairSessionMessages(messages)
    expect(repaired).toHaveLength(3)
    // Both non-string contents should fall back to ""
    expect((repaired[2] as any).content).toBe("\n\n")
  })
})
