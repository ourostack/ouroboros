import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProviderRuntime, ProviderTurnRequest } from "../../../heart/core"
import { resetConfigCache } from "../../../heart/config"
import { resetIdentity } from "../../../heart/identity"
import { recordModelTraffic, runTelegramTurn } from "../../../eval/transport/telegram-turn"

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
    // The owner profile decides the list: load_skill is not in it, and the skills file is not in the prompt.
    expect(offered).not.toContain("load_skill")
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
    await expect(run()).rejects.toThrow("precommitted ingress")
  }, 60_000)


  it("refuses a bundle that is not where the agent's own turn would look for it", async () => {
    await expect(runTelegramTurn({
      agentRoot: path.join(home, "elsewhere"),
      prefix: [],
      userText: "hello",
      providerRuntime: scriptedRuntime([], []),
    })).rejects.toThrow("must be the sanctuary bundle")
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
