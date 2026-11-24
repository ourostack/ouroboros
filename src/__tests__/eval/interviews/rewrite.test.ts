import { describe, expect, it } from "vitest"
import type { ProviderTurnRequest } from "../../../heart/core"
import { replace, rewriteRequest, type Replacement } from "../../../eval/interviews/rewrite"

const LIST: readonly Replacement[] = [
  { pattern: /You are Acme, based on Zeta-5\./g, with: "You are a coding agent." },
  { pattern: /acme/gi, with: "agent" },
  { pattern: /zeta/gi, with: "model" },
]

const request = (over: Partial<ProviderTurnRequest> = {}): ProviderTurnRequest => ({
  systemPrompt: { stable: "You are Acme, based on Zeta-5. Acme helps.", volatile: "cwd /home/acme" },
  activeTools: [{ type: "function", function: { name: "acme_shell", description: "Run a command in Acme.", parameters: { type: "object", properties: { cmd: { type: "string", description: "an ACME command" } } } } }],
  messages: [
    { role: "system", content: "Acme system" },
    { role: "user", content: [{ type: "text", text: "use acme" }] },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "acme_shell", arguments: "{\"cmd\":\"ls /home/acme\"}" } }] },
    { role: "tool", tool_call_id: "c1", content: "/home/acme/zeta.txt" },
  ],
  callbacks: { onTextChunk: () => undefined } as never,
  ...over,
})

describe("an arm's replacement list", () => {
  it("applies every replacement in order, so a whole sentence is replaced before its words are", () => {
    expect(replace("You are Acme, based on Zeta-5. Then ACME and zeta.", LIST)).toBe("You are a coding agent. Then agent and model.")
  })

  it("rewrites every text the request puts in front of the model, and nothing else", () => {
    const callbacks = { onTextChunk: () => undefined } as never
    const signal = new AbortController().signal
    const { request: out } = rewriteRequest(request({ callbacks, signal, traceId: "acme-trace" }), LIST)
    expect(out.systemPrompt).toEqual({ stable: "You are a coding agent. agent helps.", volatile: "cwd /home/agent" })
    expect(out.activeTools[0]!.function).toEqual({ name: "agent_shell", description: "Run a command in agent.", parameters: { type: "object", properties: { cmd: { type: "string", description: "an agent command" } } } })
    expect(out.messages).toEqual([
      { role: "system", content: "agent system" },
      { role: "user", content: [{ type: "text", text: "use agent" }] },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "agent_shell", arguments: "{\"cmd\":\"ls /home/agent\"}" } }] },
      { role: "tool", tool_call_id: "c1", content: "/home/agent/model.txt" },
    ])
    // What the harness keeps for itself is the same object, unrewritten.
    expect(out.callbacks).toBe(callbacks)
    expect(out.signal).toBe(signal)
    // A trace id is sent as metadata by some providers, so a brand word in it is rewritten too.
    expect(out.traceId).toBe("agent-trace")
    expect(rewriteRequest(request({ traceId: "Acme-turn-1" }), LIST).request.traceId).toBe("agent-turn-1")
    expect(rewriteRequest(request({}), LIST).request).not.toHaveProperty("traceId")
  })

  it("rewrites deferred tools too, and leaves the original request as it was", () => {
    const original = request({ deferredTools: [{ type: "function", function: { name: "acme_find", description: "Find in Acme." } }] })
    const before = JSON.stringify(original)
    const { request: out } = rewriteRequest(original, LIST)
    expect(out.deferredTools![0]!.function).toEqual({ name: "agent_find", description: "Find in agent." })
    expect(JSON.stringify(original)).toBe(before)
    // A request with no system prompt is sent with none.
    const { systemPrompt: _none, ...bare } = request()
    expect(rewriteRequest(bare, LIST).request).not.toHaveProperty("systemPrompt")
  })

  it("gives back the harness's own name for a tool the model calls by its rewritten name", () => {
    const { toolName } = rewriteRequest(request({ deferredTools: [{ type: "function", function: { name: "acme_find" } }] }), LIST)
    expect(toolName("agent_shell")).toBe("acme_shell")
    expect(toolName("agent_find")).toBe("acme_find")
    expect(toolName("plain")).toBe("plain")
  })

  it("counts how many matches each tier of the list rewrote, in what the model is sent", () => {
    const tiered: readonly Replacement[] = [
      { pattern: /You are Acme, based on Zeta-5\./g, with: "You are a coding agent.", tier: "sentence" },
      { pattern: /acme/gi, with: "agent", tier: "word" },
      { pattern: /zeta/gi, with: "model", tier: "word" },
    ]
    // The sentence once; then "acme" ten times (the prompt twice, the tool three times, the messages five) and "zeta"
    // once, in the tool result. The sentence's own words are gone before the word tier runs.
    expect(rewriteRequest(request(), tiered).rewrites).toStrictEqual({ sentence: 1, word: 11 })
    // A replacement with no tier counts as "list"; a tier that matched nothing is left out.
    expect(rewriteRequest(request({ systemPrompt: undefined, activeTools: [], messages: [{ role: "user", content: "zeta" }] }), LIST).rewrites).toStrictEqual({ list: 1 })
  })

  it("leaves a provider's encrypted reasoning as it was returned, and rewrites the readable summary beside it", () => {
    // Rewriting letters inside ciphertext would corrupt it.
    const item = { type: "reasoning", id: "rs+Acme/1=", encrypted_content: "q8AcmEzeta+/x=", summary: [{ type: "summary_text", text: "Asking Acme." }] }
    const assistant = { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "acme_shell", arguments: "{}" } }], _reasoning_items: [item] }
    const { request: out, rewrites } = rewriteRequest(request({ systemPrompt: undefined, activeTools: [], messages: [assistant] as never }), LIST)
    expect((out.messages[0] as unknown as { _reasoning_items: unknown[] })._reasoning_items).toEqual([{ ...item, summary: [{ type: "summary_text", text: "Asking agent." }] }])
    // Only the summary's "Acme" and the call's name were rewritten; nothing in the ciphertext was counted.
    expect(rewrites).toStrictEqual({ list: 2 })
  })

  it("refuses a replacement that would rewrite only the first match, or two tools that would share a name", () => {
    expect(() => replace("acme acme", [{ pattern: /acme/i, with: "agent" }])).toThrow("replacement /acme/i must be global (the g flag)")
    const clash = request({ activeTools: [
      { type: "function", function: { name: "acme_shell" } },
      { type: "function", function: { name: "agent_shell" } },
    ] })
    expect(() => rewriteRequest(clash, LIST)).toThrow("tools acme_shell and agent_shell would both be called agent_shell")
  })
})
