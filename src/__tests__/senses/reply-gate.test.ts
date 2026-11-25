import { beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"

const mockEmitNervesEvent = vi.hoisted(() => vi.fn())
vi.mock("../../nerves/runtime", async () => {
  const actual = await vi.importActual<typeof import("../../nerves/runtime")>("../../nerves/runtime")
  return {
    ...actual,
    emitNervesEvent: (...args: Parameters<typeof actual.emitNervesEvent>) => {
      mockEmitNervesEvent(...args)
      return actual.emitNervesEvent(...args)
    },
  }
})

const mockGetAzureConfig = vi.hoisted(() => vi.fn())
vi.mock("../../heart/config", async () => {
  const actual = await vi.importActual<typeof import("../../heart/config")>("../../heart/config")
  return { ...actual, getAzureConfig: () => mockGetAzureConfig() }
})

const mockTokenProvider = vi.hoisted(() => vi.fn())
vi.mock("../../heart/providers/azure", () => ({
  createAzureTokenProvider: (clientId?: string) => mockTokenProvider(clientId),
}))

import * as identity from "../../heart/identity"
import {
  DEFAULT_REPLY_AT_VALUE,
  appendGatedObserve,
  askReplyGate,
  decisionModelUrl,
  namesAgent,
  readReplyGateConfig,
  recentConversation,
} from "../../senses/reply-gate"

const azure = { endpoint: "https://contoso.cognitiveservices.azure.com/", deployment: "gpt", apiVersion: "x", apiKey: "k" }

function answer(score: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => ({ answers: { how_valuable: { score } } }),
    text: async () => "slow down",
  })
}

const chat: ChatCompletionMessageParam[] = [
  { role: "system", content: "You are Slugger." },
  { role: "user", content: "Maya: lunch anyone?" },
]

describe("reply gate", () => {
  beforeEach(() => {
    mockEmitNervesEvent.mockReset()
    mockGetAzureConfig.mockReset().mockReturnValue(azure)
    mockTokenProvider.mockReset()
  })

  it("is off without replyGate in agent.json", async () => {
    const fetchImpl = vi.fn()
    expect(await askReplyGate({ agentName: "slugger", config: undefined, messages: chat, fetchImpl })).toEqual({ reply: true, reason: "off" })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("stays quiet below the threshold and asks the decision model one scored question", async () => {
    const fetchImpl = answer(0.2)
    const verdict = await askReplyGate({ agentName: "slugger", config: { deployment: "decision-1-1" }, messages: chat, fetchImpl })

    expect(verdict).toEqual({ reply: false, reason: "not-worth-it", value: 0.2 })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe("https://contoso.cognitiveservices.azure.com/providers/microsoft/v1/systemone")
    expect(init.headers).toMatchObject({ "api-key": "k" })
    const body = JSON.parse(init.body)
    expect(body.model).toBe("decision-1-1")
    expect(body.state.conversation).toEqual([{ from: "group member", text: "Maya: lunch anyone?" }])
    expect(body.questions.how_valuable.type).toBe("score")
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "senses.reply_gate_end", meta: expect.objectContaining({ reply: false, replyAt: DEFAULT_REPLY_AT_VALUE }) }))
  })

  it("replies at or above the configured threshold", async () => {
    const verdict = await askReplyGate({ agentName: "slugger", config: { deployment: "d", replyAtValue: 2 }, messages: chat, fetchImpl: answer(2) })
    expect(verdict).toEqual({ reply: true, reason: "worth-it", value: 2 })
  })

  it("signs in with an Azure token when the vault holds no API key, and honours the turn's abort signal", async () => {
    const getToken = vi.fn().mockResolvedValue("tok")
    mockTokenProvider.mockReturnValue(getToken)
    mockGetAzureConfig.mockReturnValue({ ...azure, apiKey: "", managedIdentityClientId: "mi" })
    const fetchImpl = answer(3)
    const controller = new AbortController()
    await askReplyGate({ agentName: "slugger", config: { deployment: "d" }, messages: chat, fetchImpl, signal: controller.signal })

    expect(mockTokenProvider).toHaveBeenCalledWith("mi")
    expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({ Authorization: "Bearer tok" })
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })

  it("uses a token provider without a managed identity client id when none is stored", async () => {
    mockTokenProvider.mockReturnValue(vi.fn().mockResolvedValue("tok"))
    await askReplyGate({ agentName: "slugger", config: { deployment: "d" }, messages: chat, fetchImpl: answer(3), azureConfig: { ...azure, apiKey: "" } })
    expect(mockTokenProvider).toHaveBeenCalledWith(undefined)
  })

  it("calls Foundry with the platform fetch by default", async () => {
    const fetchImpl = answer(0)
    vi.stubGlobal("fetch", fetchImpl)
    try {
      await askReplyGate({ agentName: "slugger", config: { deployment: "d" }, messages: chat })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("uses an injected token getter", async () => {
    const fetchImpl = answer(3)
    await askReplyGate({ agentName: "slugger", config: { deployment: "d" }, messages: chat, fetchImpl, azureConfig: { ...azure, apiKey: "" }, getToken: async () => "given" })
    expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({ Authorization: "Bearer given" })
  })

  it.each([
    ["an HTTP error", answer(1, false, 429), "HTTP 429"],
    ["an answer without a score", answer("high"), "no how_valuable score"],
    ["a network failure", vi.fn().mockRejectedValue("offline"), "offline"],
  ])("runs the turn when the decision model gives %s", async (_label, fetchImpl, error) => {
    const verdict = await askReplyGate({ agentName: "slugger", config: { deployment: "d" }, messages: chat, fetchImpl })
    expect(verdict).toEqual({ reply: true, reason: "failed" })
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "senses.reply_gate_error", meta: expect.objectContaining({ error: expect.stringContaining(error) }) }))
  })

  it("runs the turn and says how to fix it when the azure provider has no endpoint", async () => {
    mockGetAzureConfig.mockReturnValue({ ...azure, endpoint: "" })
    const verdict = await askReplyGate({ agentName: "slugger", config: { deployment: "d" }, messages: chat, fetchImpl: vi.fn() })
    expect(verdict.reason).toBe("failed")
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ error: expect.stringContaining("ouro auth --agent <agent> --provider azure") }) }))
  })

  it("always runs the turn when the latest message names the agent", async () => {
    const fetchImpl = vi.fn()
    const verdict = await askReplyGate({ agentName: "Slugger", config: { deployment: "d" }, messages: [{ role: "user", content: "hey @slugger, what's the plan?" }], fetchImpl })
    expect(verdict).toEqual({ reply: true, reason: "named" })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("lets the turn decide when there are no words to read", async () => {
    const fetchImpl = vi.fn()
    const photo: ChatCompletionMessageParam[] = [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:," } }] }]
    expect(await askReplyGate({ agentName: "slugger", config: { deployment: "d" }, messages: photo, fetchImpl })).toEqual({ reply: true, reason: "no-text" })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe("recentConversation", () => {
  it("reads people's words and the agent's own settle and speak words, newest twenty", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: [{ type: "text", text: "Leo: tacos?" }, { type: "image_url", image_url: { url: "data:," } }] },
      {
        role: "assistant",
        content: "thinking aloud",
        tool_calls: [
          { id: "1", type: "function", function: { name: "speak", arguments: JSON.stringify({ message: "on it" }) } },
          { id: "2", type: "function", function: { name: "settle", arguments: JSON.stringify({ answer: "Thursday 10:00" }) } },
          { id: "3", type: "function", function: { name: "settle", arguments: "{not json" } },
          { id: "4", type: "function", function: { name: "read_file", arguments: "{}" } },
          { id: "5", type: "function", function: { name: "settle", arguments: JSON.stringify({ answer: 3 }) } },
        ],
      },
      { role: "tool", tool_call_id: "1", content: "ok" },
      { role: "assistant", content: null },
      { role: "user", content: "   " },
    ]
    expect(recentConversation("slugger", messages)).toEqual([
      { from: "group member", text: "Leo: tacos?" },
      { from: "slugger", text: "thinking aloud\non it\nThursday 10:00" },
    ])
    const many = Array.from({ length: 30 }, (_, i): ChatCompletionMessageParam => ({ role: "user", content: `m${i}` }))
    const recent = recentConversation("slugger", many)
    expect(recent).toHaveLength(20)
    expect(recent[0].text).toBe("m10")
  })
})

describe("namesAgent", () => {
  it("matches the agent's name as a word, not inside another", () => {
    expect(namesAgent("Slugger", "SLUGGER can you help")).toBe(true)
    expect(namesAgent("slugger", "thanks @slugger!")).toBe(true)
    expect(namesAgent("slugger", "sluggers are slow")).toBe(false)
    expect(namesAgent("a.b", "ping a.b")).toBe(true)
  })
})

describe("decisionModelUrl", () => {
  it("serves from the resource root even when the vault endpoint carries an OpenAI path", () => {
    expect(decisionModelUrl("https://x.openai.azure.com/openai/deployments/gpt")).toBe("https://x.openai.azure.com/providers/microsoft/v1/systemone")
  })
})

describe("appendGatedObserve", () => {
  it("writes the same observe call and silenced result an LLM turn that chose silence writes", () => {
    const messages: ChatCompletionMessageParam[] = []
    appendGatedObserve(messages, 0.24)
    expect(messages).toHaveLength(2)
    const call = messages[0] as { tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> }
    expect(call.tool_calls[0].function.name).toBe("observe")
    expect(JSON.parse(call.tool_calls[0].function.arguments).reason).toBe("reply gate: a reply was worth 0.2 of 3")
    expect(messages[1]).toEqual({ role: "tool", tool_call_id: call.tool_calls[0].id, content: "(silenced)" })
  })
})

describe("readReplyGateConfig", () => {
  function bundle(replyGate?: unknown): string {
    const bundles = fs.mkdtempSync(path.join(os.tmpdir(), "reply-gate-"))
    const root = path.join(bundles, "fixture.ouro")
    fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({
      version: 2,
      enabled: true,
      humanFacing: { provider: "azure", model: "gpt" },
      agentFacing: { provider: "azure", model: "gpt" },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["t"] },
      ...(replyGate === undefined ? {} : { replyGate }),
    }))
    vi.spyOn(identity, "getAgentRoot").mockReturnValue(root)
    return bundles
  }

  it("reads replyGate from agent.json", () => {
    bundle({ deployment: "decision-1-1", replyAtValue: 2 })
    expect(readReplyGateConfig("fixture")).toEqual({ deployment: "decision-1-1", replyAtValue: 2 })
  })

  it("is undefined when agent.json has no replyGate", () => {
    bundle()
    expect(readReplyGateConfig("fixture")).toBeUndefined()
  })

  it("throws with the shape to write when replyGate is invalid", () => {
    bundle({ deployment: "" })
    expect(() => readReplyGateConfig("fixture")).toThrow(/replyGate must be/)
  })
})

describe("validateReplyGate", () => {
  it.each([
    [{ deployment: "d" }, { deployment: "d" }],
    [{ deployment: " d ", replyAtValue: 0 }, { deployment: "d", replyAtValue: 0 }],
  ])("accepts %j", (raw, expected) => {
    expect(identity.validateReplyGate(raw, "agent.json")).toEqual(expected)
  })

  it.each([[null], [[]], [{ deployment: 1 }], [{ deployment: "d", replyAtValue: 4 }], [{ deployment: "d", replyAtValue: -1 }], [{ deployment: "d", replyAtValue: "2" }], [{ deployment: "d", replyAtValue: Number.NaN }]])(
    "refuses %j",
    (raw) => {
      expect(() => identity.validateReplyGate(raw, "agent.json")).toThrow(/replyGate must be/)
      expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "error", message: "agent config has invalid replyGate" }))
    },
  )
})
