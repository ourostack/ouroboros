import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProviderRuntime, ProviderTurnRequest } from "../../../heart/core"
import { resetConfigCache } from "../../../heart/config"
import { resetIdentity } from "../../../heart/identity"
import { createProxyRuntime, serveProxyRuntime, type ProxyChannel, type ProxyMessage } from "../../../eval/transport/provider-proxy"
import { recordModelTraffic, runTelegramTurn, withSystemLine } from "../../../eval/transport/telegram-turn"

function scriptedRuntime(steps: Array<{ name: string; arguments: Record<string, string> }>, seen: ProviderTurnRequest[]): ProviderRuntime {
  return {
    id: "minimax", model: "eval-scripted", client: {}, capabilities: new Set(),
    resetTurnState: () => undefined, appendToolOutput: () => undefined, ping: async () => undefined, classifyError: () => "unknown",
    streamTurn: async (request) => {
      seen.push(request)
      const step = steps[seen.length - 1]
      if (!step) throw new Error("script ran out")
      return { content: "", toolCalls: [{ id: `call-${seen.length}`, name: step.name, arguments: JSON.stringify(step.arguments) }], outputItems: [] }
    },
  }
}

/** Every file under a folder, with its size and modification time. */
function snapshot(root: string): Map<string, string> {
  return new Map(fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => {
    const file = path.join(entry.parentPath, entry.name)
    const stat = fs.statSync(file)
    return [path.relative(root, file), `${stat.size}:${stat.mtimeMs}`]
  }))
}

describe("runTelegramTurn", () => {
  let home: string
  let agentRoot: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "eval-telegram-turn-"))
    vi.stubEnv("HOME", home)
    agentRoot = path.join(home, "AgentBundles", "sanctuary.ouro")
    fs.cpSync(path.resolve("deploy/unraid/sanctuary.ouro"), agentRoot, { recursive: true })
    fs.mkdirSync(path.join(agentRoot, "skills"), { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "skills", "books.md"), "# Books\n\nUse the books command to find and send books.\n")
    resetConfigCache()
    resetIdentity()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    resetConfigCache()
    resetIdentity()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it("runs one scripted owner turn through the real pipeline and reads back the shell call and the reply", async () => {
    const seen: ProviderTurnRequest[] = []
    const before = snapshot(agentRoot)
    const result = await runTelegramTurn({
      agentRoot,
      prefix: [
        { role: "user", content: "Could you check something for me?" },
        { role: "assistant", content: "Of course. What should I check?" },
      ],
      userText: "Say hi from the shell, please.",
      providerRuntime: scriptedRuntime([
        { name: "shell", arguments: { command: "echo hi" } },
        { name: "settle", arguments: { answer: "done", intent: "complete" } },
      ], seen),
    })

    expect(result.timeline.map((entry) => entry.kind === "call" ? `call:${entry.name}` : "reply")).toEqual(["call:shell", "call:settle", "reply"])
    const shell = result.timeline[0]!
    expect(shell).toMatchObject({ kind: "call", name: "shell", args: JSON.stringify({ command: "echo hi" }) })
    expect(shell.kind === "call" && shell.result).toContain("hi")
    expect(result.finalReply).toBe("done")
    expect(result.outcome).toBe("settled")
    expect(result.steps).toBe(2)
    expect(result.timeline.at(-1)).toEqual({ kind: "reply", text: "done" })
    const offered = seen[0]!.activeTools.map((tool) => tool.function.name)
    expect(offered).toContain("shell")
    // The owner profile decides the list: load_skill is in it, and the prompt names skills without carrying their text.
    expect(offered).toContain("load_skill")
    expect(JSON.stringify(seen[0]!.messages)).not.toContain("Use the books command")
    // What the turn wrote in the bundle, as the doc comment lists it, and nothing beside it.
    const after = snapshot(agentRoot)
    const written = [...after].filter(([file, stamp]) => before.get(file) !== stamp).map(([file]) => file.split(path.sep)[0])
    expect([...new Set(written)].sort()).toEqual(["arc", "friends", "state"])
    expect(fs.existsSync(path.join(agentRoot, "friends", "eval-owner.json"))).toBe(true)
    expect(fs.readdirSync(path.join(agentRoot, "state", "sessions", "eval-owner", "telegram")).filter((name) => name.endsWith(".json"))).toHaveLength(1)
    const firstRequest = JSON.stringify(seen[0]!.messages)
    expect(firstRequest).toContain("Of course. What should I check?")
    expect(firstRequest).toContain("Say hi from the shell, please.")
  }, 60_000)

  it("adds the interviews' line to every request's system prompt, and answers later owner messages in the same chat as their own turns", async () => {
    const seen: ProviderTurnRequest[] = []
    const line = "You are working in environment K."
    const result = await runTelegramTurn({
      agentRoot, prefix: [{ role: "user", content: "Morning." }, { role: "assistant", content: "Morning, Ari." }], userText: "Say hi from the shell, please.",
      providerRuntime: scriptedRuntime([
        { name: "shell", arguments: { command: "echo hi" } },
        { name: "settle", arguments: { answer: "done", intent: "complete" } },
        { name: "settle", arguments: { answer: "6\nIt went fine.", intent: "complete" } },
      ], seen),
      systemLine: line,
      followUps: ["How did that go?"],
    })
    expect(seen).toHaveLength(3)
    for (const request of seen) {
      expect(request.systemPrompt!.volatile.endsWith(`\n\n${line}`)).toBe(true)
      const system = request.messages[0]!
      expect(system.role).toBe("system")
      expect(String(system.content).endsWith(`\n\n${line}`)).toBe(true)
      expect(String(system.content).split(line)).toHaveLength(2)
    }
    // The later message is answered in the same conversation: it sees the first answer and the prefix.
    const third = JSON.stringify(seen[2]!.messages)
    expect(third).toContain("How did that go?")
    expect(third).toContain("Morning, Ari.")
    expect(third).toContain("done")
    // The job's reply and outcome are the first turn's; each turn says where it starts, as the interviews' guests do.
    expect(result.finalReply).toBe("done")
    expect(result.outcome).toBe("settled")
    expect(result.steps).toBe(3)
    expect(result.timeline.map((entry) => entry.kind === "call" ? `call:${entry.name}` : `reply:${entry.text}`)).toEqual([
      "call:shell", "call:settle", "reply:done", "call:settle", "reply:6\nIt went fine.",
    ])
    expect(result.turns).toEqual([
      { start: 0, finalReply: "done", outcome: "settled", calls: 2 },
      { start: 3, finalReply: "6\nIt went fine.", outcome: "settled", calls: 1 },
    ])
  }, 60_000)

  it("runs a replay-eval turn as before when no line or later message is given", async () => {
    const seen: ProviderTurnRequest[] = []
    const result = await runTelegramTurn({
      agentRoot, prefix: [], userText: "hello",
      providerRuntime: scriptedRuntime([{ name: "settle", arguments: { answer: "hi", intent: "complete" } }], seen),
    })
    // The same result, field for field, with nothing added, and a system prompt the turn alone wrote.
    expect(Object.keys(result)).toEqual(["timeline", "finalReply", "outcome", "steps"])
    expect(result).toEqual({ timeline: [{ kind: "call", name: "settle", args: JSON.stringify({ answer: "hi", intent: "complete" }), result: expect.any(String) }, { kind: "reply", text: "hi" }], finalReply: "hi", outcome: "settled", steps: 1 })
    expect(String(seen[0]!.messages[0]!.content)).toBe([seen[0]!.systemPrompt!.stable, seen[0]!.systemPrompt!.volatile].filter(Boolean).join("\n\n"))
    expect(JSON.stringify(seen[0])).not.toContain("environment")
  }, 60_000)

  it("reports a provider error as an errored turn after one call, never retrying or rebuilding the provider", async () => {
    const runtime = scriptedRuntime([], [])
    let calls = 0
    runtime.streamTurn = async () => { calls += 1; throw Object.assign(new Error("too many requests"), { status: 429 }) }
    runtime.classifyError = () => "rate-limit"
    const result = await runTelegramTurn({ agentRoot, prefix: [], userText: "hello", providerRuntime: runtime })
    expect(result.outcome).toBe("errored")
    expect(calls).toBe(1)
    expect(result.steps).toBe(1)
    expect(result.timeline.filter((entry) => entry.kind === "call")).toEqual([])
    expect(result.finalReply).toMatch(/\w/)
  }, 60_000)

  it("holds a settle to the production answer checks: an unbacked shelf claim is sent back", async () => {
    const seen: ProviderTurnRequest[] = []
    const result = await runTelegramTurn({
      agentRoot, prefix: [], userText: "Please put the almanac on my shelf.",
      providerRuntime: scriptedRuntime([
        { name: "settle", arguments: { answer: "The Harbour Almanac is on the shelf now.", intent: "complete" } },
        { name: "settle", arguments: { answer: "I haven't looked yet.", intent: "complete" } },
      ], seen),
    })
    expect(result.steps).toBe(2)
    expect(result.timeline.filter((entry) => entry.kind === "reply")).toEqual([{ kind: "reply", text: "I haven't looked yet." }])
    expect(result.finalReply).toBe("I haven't looked yet.")
  }, 60_000)

  it("reads the whole reply back as the person sees it, across Telegram's message splits and HTML", async () => {
    const long = `${"The tide came in. ".repeat(300)}**Done** & <ok>`
    const result = await runTelegramTurn({
      agentRoot, prefix: [], userText: "Tell me everything.",
      providerRuntime: scriptedRuntime([{ name: "settle", arguments: { answer: long, intent: "complete" } }], []),
    })
    expect(result.timeline.filter((entry) => entry.kind === "reply").length).toBeGreaterThan(1)
    expect(result.finalReply.replace(/\s+/g, " ")).toBe(long.replace("**Done**", "Done").replace(/\s+/g, " ").trim())
  }, 60_000)

  it("surfaces the turn's own failure, such as a shelf question needing a media tool the sandbox does not offer", async () => {
    await expect(runTelegramTurn({
      agentRoot, prefix: [], userText: "Is the almanac on the shelf?",
      providerRuntime: scriptedRuntime([{ name: "settle", arguments: { answer: "Yes.", intent: "complete" } }], []),
    })).rejects.toThrow("required tool is not advertised for this channel: media_search")
  }, 60_000)

  it("fails a second run on the same bundle rather than reading back a stale turn", async () => {
    const run = () => runTelegramTurn({
      agentRoot, prefix: [], userText: "hello",
      providerRuntime: scriptedRuntime([{ name: "settle", arguments: { answer: "hi", intent: "complete" } }], []),
    })
    await run()
    // The sense has already recorded an outcome for this bundle's message, so it does not run it again.
    await expect(run()).rejects.toThrow("the sense did not run the turn")
  }, 60_000)


  it("runs the same turn with the provider on the far side of the proxy, taking one budget unit per model call", async () => {
    const pair = { toGuest: [] as Array<(msg: ProxyMessage) => void>, toHost: [] as Array<(msg: ProxyMessage) => void> }
    const lines: string[] = []
    const end = (listeners: Array<(msg: ProxyMessage) => void>, peer: Array<(msg: ProxyMessage) => void>): ProxyChannel => ({
      send: (msg) => { const line = JSON.stringify(msg); lines.push(line); queueMicrotask(() => peer.forEach((fn) => fn(JSON.parse(line) as ProxyMessage))) },
      onMessage: (fn) => { listeners.push(fn) },
    })
    let units = 0
    serveProxyRuntime(end(pair.toHost, pair.toGuest), scriptedRuntime([
      { name: "shell", arguments: { command: "echo hi" } },
      { name: "settle", arguments: { answer: "done", intent: "complete" } },
    ], []), { take: () => { units += 1; return true } })
    const result = await runTelegramTurn({ agentRoot, prefix: [], userText: "Say hi from the shell, please.", providerRuntime: await createProxyRuntime(end(pair.toGuest, pair.toHost)) })
    expect(result.outcome).toBe("settled")
    expect(result.finalReply).toBe("done")
    expect(result.timeline[0]).toMatchObject({ kind: "call", name: "shell" })
    expect(units).toBe(2)
    expect(lines.some((line) => line.includes('"type":"appendToolOutput"'))).toBe(true)
  }, 60_000)

  it("refuses a bundle that is not where the agent's own turn would look for it", async () => {
    await expect(runTelegramTurn({
      agentRoot: path.join(home, "elsewhere"),
      prefix: [],
      userText: "hello",
      providerRuntime: scriptedRuntime([], []),
    })).rejects.toThrow("must be the sanctuary bundle")
  })

  it("takes the fake house as an argument, so its agent decides where the bundle must be", async () => {
    await expect(runTelegramTurn({
      agentRoot,
      prefix: [],
      userText: "hello",
      providerRuntime: scriptedRuntime([], []),
      house: { agentName: "other-house", ownerProfileId: "other-owner", toolContext: {} },
    })).rejects.toThrow(`agentRoot must be the other-house bundle at ${path.join(home, "AgentBundles", "other-house.ouro")}`)
  })
})

describe("withSystemLine", () => {
  it("adds the line to the messages a Responses-style runtime rebuilds its instructions from at reset, once", async () => {
    // Such a runtime builds its body from the messages it was last reset with, not from the request (core resets
    // it with its own messages at the start of every user turn).
    let resetWith: unknown[] = []
    const inner = { ...scriptedRuntime([], []), resetTurnState: (messages: unknown[]) => { resetWith = messages } }
    const wrapped = withSystemLine(inner, "L")
    wrapped.resetTurnState([{ role: "system", content: "base" }, { role: "user", content: "u" }])
    expect(resetWith).toEqual([{ role: "system", content: "base\n\nL" }, { role: "user", content: "u" }])
    wrapped.resetTurnState([{ role: "user", content: "no system" }])
    expect(resetWith).toEqual([{ role: "user", content: "no system" }])
  })

  it("adds the line to an empty prompt as the whole prompt, leaves a first message that is not the system text alone, and keeps the runtime's own fields", async () => {
    const seen: ProviderTurnRequest[] = []
    const inner = scriptedRuntime([{ name: "settle", arguments: {} }, { name: "settle", arguments: {} }], seen)
    const wrapped = withSystemLine(inner, "L")
    await wrapped.streamTurn({ messages: [{ role: "system", content: "" }, { role: "user", content: "u" }], activeTools: [], callbacks: {} as never, systemPrompt: { stable: "s", volatile: "" } })
    expect(seen[0]!.messages).toEqual([{ role: "system", content: "L" }, { role: "user", content: "u" }])
    expect(seen[0]!.systemPrompt).toEqual({ stable: "s", volatile: "L" })
    const parts = [{ type: "text" as const, text: "parts" }]
    await wrapped.streamTurn({ messages: [{ role: "user", content: "u" }, { role: "system", content: parts }], activeTools: [], callbacks: {} as never })
    expect(seen[1]!.messages).toEqual([{ role: "user", content: "u" }, { role: "system", content: parts }])
    expect(seen[1]).not.toHaveProperty("systemPrompt")
    expect(wrapped.model).toBe("eval-scripted")
    await expect(wrapped.ping()).resolves.toBeUndefined()
  })
})

describe("recordModelTraffic", () => {
  class ClassRuntime {
    id = "minimax" as const
    model = "eval-class"
    client = {}
    capabilities = new Set<never>()
    appended: Array<[string, string]> = []
    async streamTurn() { return { content: "", toolCalls: [{ id: "a", name: "shell", arguments: "{}" }], outputItems: [] } }
    appendToolOutput(callId: string, output: string) { this.appended.push([callId, output]) }
    resetTurnState() {}
    async ping() {}
    classifyError() { return "rate-limit" as const }
  }

  it("keeps a class runtime's own methods and fields, and ignores output for a call it never saw", async () => {
    const inner = new ClassRuntime()
    const timeline: Parameters<typeof recordModelTraffic>[1] = []
    const { runtime, steps } = recordModelTraffic(inner as unknown as ProviderRuntime, timeline)
    await runtime.streamTurn({ messages: [], activeTools: [], callbacks: {} as never })
    runtime.appendToolOutput("a", "ok")
    runtime.appendToolOutput("unknown", "stray")
    expect(timeline).toEqual([{ kind: "call", name: "shell", args: "{}", result: "ok" }])
    expect(inner.appended).toEqual([["a", "ok"], ["unknown", "stray"]])
    expect(runtime.model).toBe("eval-class")
    expect(runtime.classifyError(new Error("x"))).toBe("rate-limit")
    expect(steps()).toBe(1)
  })

  it("marks every provider failure as not retryable, wrapping a thrown value that is not an Error", async () => {
    const inner = new ClassRuntime()
    inner.streamTurn = async () => { throw "socket closed" }
    const { runtime, steps } = recordModelTraffic(inner as unknown as ProviderRuntime, [])
    const failure = await runtime.streamTurn({ messages: [], activeTools: [], callbacks: {} as never }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({ message: "socket closed", retryable: false })
    expect(steps()).toBe(1)
  })
})
