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

    const shellCalls = result.timeline.filter((entry) => entry.kind === "call" && entry.name === "shell")
    expect(shellCalls).toHaveLength(1)
    expect(shellCalls[0]).toMatchObject({ kind: "call", name: "shell", args: JSON.stringify({ command: "echo hi" }) })
    expect(shellCalls[0]!.kind === "call" && shellCalls[0]!.result).toContain("hi")
    expect(result.finalReply).toBe("done")
    expect(result.outcome).toBe("settled")
    expect(result.steps).toBe(2)
    expect(result.timeline.at(-1)).toEqual({ kind: "reply", text: "done" })
    expect(seen[0]!.activeTools.map((tool) => tool.function.name)).toContain("shell")
    const firstRequest = JSON.stringify(seen[0]!.messages)
    expect(firstRequest).toContain("Of course. What should I check?")
    expect(firstRequest).toContain("Say hi from the shell, please.")
  }, 60_000)

  it("reports a provider error as an errored turn, with the reply the owner was sent", async () => {
    const runtime = scriptedRuntime([], [])
    runtime.streamTurn = async () => { throw Object.assign(new Error("provider unavailable"), { retryable: false }) }
    const result = await runTelegramTurn({ agentRoot, prefix: [], userText: "hello", providerRuntime: runtime })
    expect(result.outcome).toBe("errored")
    expect(result.steps).toBe(1)
    expect(result.timeline.filter((entry) => entry.kind === "call")).toEqual([])
    expect(result.finalReply).not.toBe("")
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
})
