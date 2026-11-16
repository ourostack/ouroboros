import { beforeEach, describe, expect, it, vi } from "vitest"
import { getLearnedContextWindow, learnContextWindow, resetLearnedContextWindowsForTests } from "../../heart/model-limits"
import { contextWindowFromModels } from "../../heart/providers/github-copilot"

const listing = [
  { id: "claude-sonnet-5.5", capabilities: { limits: { max_context_window_tokens: 1000000, max_prompt_tokens: 900000 } } },
  { id: "no-limits" },
  { id: "bad", capabilities: { limits: { max_context_window_tokens: "big" } } },
]

describe("context window read from the provider", () => {
  beforeEach(() => resetLearnedContextWindowsForTests())

  it("reads max_context_window_tokens from the models listing", () => {
    expect(contextWindowFromModels(listing, "claude-sonnet-5.5")).toBe(1000000)
    expect(contextWindowFromModels(listing, "no-limits")).toBeUndefined()
    expect(contextWindowFromModels(listing, "bad")).toBeUndefined()
    expect(contextWindowFromModels(listing, "absent")).toBeUndefined()
  })

  it("reads once per model", async () => {
    const fetchContextWindow = vi.fn().mockResolvedValue(1000000)
    const runtime = { id: "github-copilot" as const, model: "claude-sonnet-5.5", fetchContextWindow }
    await learnContextWindow(runtime)
    await learnContextWindow(runtime)
    expect(fetchContextWindow).toHaveBeenCalledTimes(1)
    expect(getLearnedContextWindow("claude-sonnet-5.5")).toBe(1000000)
  })

  it("falls back to the built-in estimate when the read fails, and does not retry", async () => {
    const fetchContextWindow = vi.fn().mockRejectedValue(new Error("offline"))
    const runtime = { id: "github-copilot" as const, model: "claude-sonnet-5.5", fetchContextWindow }
    await learnContextWindow(runtime)
    await learnContextWindow(runtime)
    expect(fetchContextWindow).toHaveBeenCalledTimes(1)
    expect(getLearnedContextWindow("claude-sonnet-5.5")).toBeUndefined()
  })

  it("falls back when the listing lacks the model or the provider cannot report", async () => {
    await learnContextWindow({ id: "github-copilot", model: "m1", fetchContextWindow: async () => undefined })
    await learnContextWindow({ id: "anthropic", model: "m2" })
    expect(getLearnedContextWindow("m1")).toBeUndefined()
    expect(getLearnedContextWindow("m2")).toBeUndefined()
  })
})
