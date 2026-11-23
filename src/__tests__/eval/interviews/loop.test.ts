import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ProviderRuntime, ProviderTurnRequest } from "../../../heart/core"
import type { Arm } from "../../../eval/interviews/guest/arms"
import { messageOf, NO_CALLBACKS, runConversation, withoutThinking } from "../../../eval/interviews/guest/loop"
import { personaPrompt, runInterviewGuest } from "../../../eval/interviews/guest/run"
import { createStreamChannel, serveProxyRuntime, type ProxyMessage } from "../../../eval/transport/provider-proxy"

type Step = { content?: string; calls?: Array<{ name: string; arguments: string }> } | Error

/** A model that answers each call with the next scripted step, recording every request and tool output. */
function scripted(steps: Step[]): ProviderRuntime & { requests: ProviderTurnRequest[]; outputs: string[]; resets: number } {
  const queue = [...steps]
  const rt = {
    requests: [] as ProviderTurnRequest[], outputs: [] as string[], resets: 0,
    id: "minimax", model: "m", client: null, capabilities: new Set(),
    streamTurn: async (request: ProviderTurnRequest) => {
      rt.requests.push(structuredClone({ ...request, callbacks: undefined }) as unknown as ProviderTurnRequest)
      const step = queue.shift() ?? { content: "done" }
      if (step instanceof Error) throw step
      return { content: step.content ?? "", toolCalls: (step.calls ?? []).map((call, i) => ({ id: `c${rt.requests.length}-${i}`, ...call })), outputItems: [] }
    },
    appendToolOutput: (_id: string, output: string) => { rt.outputs.push(output) },
    resetTurnState: () => { rt.resets += 1 },
    ping: async () => undefined, classifyError: () => "unknown",
  }
  return rt as unknown as ProviderRuntime & { requests: ProviderTurnRequest[]; outputs: string[]; resets: number }
}

const arm: Arm = {
  key: "test",
  tools: [{ name: "ouro_find", description: "Find with Ouro", parameters: { type: "object", properties: { q: { type: "string", description: "query for shadcn" } } } }],
  call: async (name, args) => {
    if (args === "boom") throw new Error("the tool broke at /home/ouro")
    if (args === "raw") throw "raw failure"
    if (args === "refused") return { text: "argument id must be a number", isError: true }
    return { text: `${name} ran ${args} in sanctuary.ouro`, isError: false }
  },
  operationOf: () => null,
}

describe("the neutral loop", () => {
  it("marks a failed call the same way in every arm and scrubs the system prompt", async () => {
    const model = scripted([{ calls: [{ name: "tool_find", arguments: "refused" }] }, { content: "ok" }])
    const conversation = await runConversation({ runtime: model, product: "X", system: "You are the Ouro Butler.", prefix: [], userTexts: ["job"], arm })
    expect(conversation.timeline[0]).toMatchObject({ result: "Error: argument id must be a number" })
    expect(model.requests[0]!.messages[0]).toEqual({ role: "system", content: "You are the tool Butler." })
  })

  it("runs the job then the debrief in one conversation, sending tool results back and scrubbing the arm's texts", async () => {
    const model = scripted([
      { content: "<think>MiniMax plan</think>Looking", calls: [{ name: "tool_find", arguments: "{}" }, { name: "tool_find", arguments: "boom" }] },
      { content: "Done: removed 187." },
      { calls: [{ name: "tool_find", arguments: "raw" }] },
      { content: "<think>hmm</think>6\nIt helped." },
    ])
    const conversation = await runConversation({ runtime: model, product: "X", system: "persona\n\nYour tools for this job are tool interface T.", prefix: [{ role: "user", content: "earlier" }], userTexts: ["job", "debrief"], arm })
    expect(conversation.turns).toEqual([{ start: 0, finalReply: "Done: removed 187.", outcome: "settled", calls: 2 }, { start: 3, finalReply: "6\nIt helped.", outcome: "settled", calls: 2 }])
    expect(conversation.timeline).toEqual([
      { kind: "call", name: "tool_find", args: "{}", result: "tool_find ran {} in sanctuary.tool" },
      { kind: "call", name: "tool_find", args: "boom", result: "error: the tool broke at /home/tool" },
      { kind: "reply", text: "Done: removed 187." },
      { kind: "call", name: "tool_find", args: "raw", result: "error: raw failure" },
      { kind: "reply", text: "6\nIt helped." },
    ])
    expect(model.outputs).toHaveLength(3)
    expect(model.resets).toBe(2)
    const first = model.requests[0]!
    expect(first.activeTools).toEqual([{ type: "function", function: { name: "tool_find", description: "Find with tool", parameters: { type: "object", properties: { q: { type: "string", description: "query for tool" } } } } }])
    expect(first.messages).toEqual([{ role: "system", content: "persona\n\nYour tools for this job are tool interface T." }, { role: "user", content: "earlier" }, { role: "user", content: "job" }])
    const last = model.requests[3]!.messages
    expect(last[3]).toEqual({ role: "assistant", content: "Looking", tool_calls: [{ id: "c1-0", type: "function", function: { name: "tool_find", arguments: "{}" } }, { id: "c1-1", type: "function", function: { name: "tool_find", arguments: "boom" } }] })
    expect(last.find((m) => m.role === "user" && m.content === "debrief")).toBeDefined()
    expect(last.at(-2)).toEqual({ role: "assistant", tool_calls: [{ id: "c3-0", type: "function", function: { name: "tool_find", arguments: "raw" } }] })
  })

  it("ends the whole conversation at a provider error, sending no later turn", async () => {
    const model = scripted([new Error("not sent: the job conversation's call limit of 12 is used up")])
    const conversation = await runConversation({ runtime: model, product: "X", system: "s", prefix: [], userTexts: ["job", "debrief"], arm })
    expect(conversation.turns).toEqual([{ start: 0, finalReply: "", outcome: "provider-error: not sent: the job conversation's call limit of 12 is used up", calls: 1 }])
    expect(model.requests).toHaveLength(1)
    const raw = scripted([])
    raw.streamTurn = async () => { throw "plain" }
    expect((await runConversation({ runtime: raw, product: "X", system: "s", prefix: [], userTexts: ["job"], arm })).turns[0]!.outcome).toBe("provider-error: plain")
  })

  it("streams nothing", () => {
    for (const callback of Object.values(NO_CALLBACKS)) expect((callback as (...args: unknown[]) => unknown)()).toBeUndefined()
  })

  it("drops inline reasoning, even unclosed", () => {
    expect(withoutThinking("<think>a</think> b <think>c")).toBe("b")
  })
})

describe("the interview guest", () => {
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "interview-guest-")) })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  function wire(model: ProviderRuntime) {
    const hostToGuest = new PassThrough()
    const guestToHost = new PassThrough()
    const host = createStreamChannel(guestToHost, hostToGuest)
    const received: ProxyMessage[] = []
    host.onMessage((msg) => received.push(msg))
    serveProxyRuntime(host, model, { take: () => true })
    return { stdin: hostToGuest, stdout: guestToHost, received }
  }

  it("fills the persona's names and leaves out missing files", () => {
    fs.mkdirSync(path.join(root, "psyche"))
    fs.writeFileSync(path.join(root, "psyche", "IDENTITY.md"), "I am {{butler}} for {{household}}, and {{owner}} runs it. {{other}}\n")
    fs.writeFileSync(path.join(root, "psyche", "TACIT.md"), "Tacit.")
    expect(personaPrompt(root)).toBe("I am Butler for the household, and Ari runs it. {{other}}\n\nTacit.")
  })

  it("runs the conversation from the turn file with the host's model and answers with its turns", async () => {
    fs.mkdirSync(path.join(root, "psyche"))
    fs.writeFileSync(path.join(root, "psyche", "SOUL.md"), "Soul of {{butler}}.")
    const turnFile = path.join(root, "turn.json")
    fs.writeFileSync(turnFile, JSON.stringify({ product: "X", arm: "cli-shell", labelLine: "Your tools for this job are tool interface J.", prefix: [], userText: "job", followUps: ["debrief"] }))
    const model = scripted([{ calls: [{ name: "shell", arguments: JSON.stringify({ command: "books ledger" }) }] }, { content: "done" }, { content: "5\nfine" }])
    const { stdin, stdout, received } = wire(model)
    const core = async () => ({ code: 0, json: { ok: true, entries: [] }, output: "" })
    const outcome = await runInterviewGuest({ stdin, stdout, turnFile, bundle: root, core })
    expect(outcome).toMatchObject({ ok: true, result: { finalReply: "done", outcome: "settled", turns: [{ start: 0, calls: 2 }, { start: 2, finalReply: "5\nfine", calls: 1 }] } })
    expect(model.requests[0]!.messages[0]).toEqual({ role: "system", content: "Soul of Butler.\n\nYour tools for this job are tool interface J." })
    await new Promise((resolve) => setImmediate(resolve))
    expect(received.at(-1)).toMatchObject({ type: "done", outcome: { ok: true } })
  })

  it.each([
    ["a missing turn file", null, /ENOENT/],
    ["a turn file without follow-ups", JSON.stringify({ product: "X", arm: "ouro", labelLine: "l", prefix: [], userText: "u" }), /needs product, arm, labelLine/],
    ["an unknown arm", JSON.stringify({ product: "X", arm: "codex", labelLine: "l", prefix: [], userText: "u", followUps: [] }), /no X arm codex/],
  ])("reports %s as its done message", async (_why, text, error) => {
    const turnFile = path.join(root, "turn.json")
    if (text !== null) fs.writeFileSync(turnFile, text)
    const { stdin, stdout } = wire(scripted([]))
    expect(await runInterviewGuest({ stdin, stdout, turnFile, bundle: root })).toMatchObject({ ok: false, error: expect.stringMatching(error) })
  })

  it("says a caught value's message", () => {
    expect(messageOf(new Error("e"))).toBe("e")
    expect(messageOf("plain")).toBe("plain")
  })
})
