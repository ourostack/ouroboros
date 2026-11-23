import { afterEach, describe, expect, it, vi } from "vitest"
import { TurnTally, emitTurnSummary, tallyToolEnds, TURN_SUMMARY_CHANNELS, TURN_SUMMARY_ERROR_CLASSES, TURN_SUMMARY_OUTCOMES } from "../../heart/turn-summary"
import { setRuntimeLogger } from "../../nerves/runtime"
import { createLogger } from "../../nerves/index"

const tool = (name: string) => ({ type: "function" as const, function: { name, description: "d", parameters: { type: "object" } } })

describe("TurnTally", () => {
  it("names an MCP tool only by its server, and keeps offered harness tool names", () => {
    const tally = new TurnTally()
    tally.offer([tool("shell"), tool("find_tools")], [tool("recipe_add")], new Map([["recipe_add", { mcpServer: "spoonjoy" }]]))
    tally.toolEnd("shell", true)
    tally.toolEnd("recipe_add", true)
    const meta = tally.summarize({ channel: "bluebubbles", outcome: "settled", errorClass: "none" })
    expect(meta.toolCalls).toEqual({ "mcp:spoonjoy": 1, shell: 1 })
    expect(meta.eagerDoors).toBe(1)
    expect(meta.deferredDoors).toBe(1)
  })

  it("keeps the largest offer seen over the turn", () => {
    const tally = new TurnTally()
    tally.offer([tool("a"), tool("b")], [tool("c"), tool("d")], new Map())
    tally.offer([tool("settle")], [], new Map())
    const meta = tally.summarize({ channel: "cli", outcome: "settled", errorClass: "none" })
    expect(meta.eagerDoors).toBe(2)
    expect(meta.deferredDoors).toBe(2)
  })

  it("counts a failed call to an unknown name as an unknown call and an error", () => {
    const tally = new TurnTally()
    tally.toolEnd("made_up", false)
    tally.toolEnd("also_made_up", true)
    const meta = tally.summarize({ channel: "cli", outcome: "settled", errorClass: "none" })
    expect(meta).toMatchObject({ unknownToolCalls: 2, toolErrors: 1, toolCalls: { unknown: 2 } })
  })

  it("ignores find_tools' own end, which findTools already counted", () => {
    const tally = new TurnTally()
    tally.offer([tool("find_tools")], [tool("x")], new Map())
    tally.findTools([])
    tally.toolEnd("find_tools", false)
    const meta = tally.summarize({ channel: "cli", outcome: "settled", errorClass: "none" })
    expect(meta).toMatchObject({ findToolsCalls: 1, findToolsLoaded: 0, toolErrors: 0, toolCalls: {} })
  })

  it("counts steps with and without reported usage", () => {
    const tally = new TurnTally()
    tally.step({ input_tokens: 10, output_tokens: 2, reasoning_tokens: 1, total_tokens: 13 }, "p", "m")
    tally.step(undefined, "p", "m")
    const meta = tally.summarize({ channel: "cli", outcome: "settled", errorClass: "none" })
    expect(meta).toMatchObject({ steps: 2, inputTokens: 10, outputTokens: 2, reasoningTokens: 1 })
  })

  it("replaces anything outside the fixed lists", () => {
    const tally = new TurnTally()
    tally.route("has spaces in it", "")
    const meta = tally.summarize({ channel: "smoke-signals", outcome: "mystery", errorClass: "made-up" })
    expect(meta).toMatchObject({ channel: "none", outcome: "errored", errorClass: "unknown", provider: "other", model: "other" })
    expect(new TurnTally().summarize({ channel: undefined, outcome: "rested", errorClass: "none" }).channel).toBe("none")
  })

  it("names the provider unknown until the turn reaches one, and counts each fallback", () => {
    const tally = new TurnTally()
    expect(tally.summarize({ channel: "cli", outcome: "aborted", errorClass: "none" })).toMatchObject({ provider: "unknown", model: "unknown", providerSwitches: 0 })
    tally.route("minimax", "m1")
    tally.step(undefined, "minimax", "m1")
    tally.route("github-copilot", "claude-opus-5.5")
    tally.step(undefined, "github-copilot", "claude-opus-5.5")
    expect(tally.summarize({ channel: "cli", outcome: "settled", errorClass: "none" })).toMatchObject({ provider: "github-copilot", model: "claude-opus-5.5", providerSwitches: 1 })
  })

  it("leaves doors that find_tools loaded out of the up-front count", () => {
    const tally = new TurnTally()
    tally.offer([tool("find_tools"), tool("shell")], [tool("x"), tool("y")], new Map())
    tally.findTools(["x"])
    tally.offer([tool("find_tools"), tool("shell"), tool("x")], [tool("x"), tool("y")], new Map())
    expect(tally.summarize({ channel: "cli", outcome: "settled", errorClass: "none" })).toMatchObject({ eagerDoors: 1, deferredDoors: 2 })
  })

  it("counts a rejected call as a failed call, and a rejected find_tools as a find_tools call", () => {
    const tally = new TurnTally()
    tally.offer([tool("shell")], [], new Map())
    tally.rejected("shell")
    tally.rejected("find_tools")
    expect(tally.summarize({ channel: "cli", outcome: "settled", errorClass: "none" })).toMatchObject({
      toolCalls: { shell: 1 }, toolErrors: 2, findToolsCalls: 1, findToolsLoaded: 0,
    })
  })

  it("lists every Channel and every RunAgentOutcome", () => {
    expect([...TURN_SUMMARY_CHANNELS].sort()).toEqual(["a2a", "bluebubbles", "cli", "inner", "mail", "mcp", "none", "teams", "telegram", "voice"])
    expect([...TURN_SUMMARY_ERROR_CLASSES].sort()).toEqual(["auth-failure", "network-error", "none", "rate-limit", "server-error", "unknown", "usage-limit"])
    expect([...TURN_SUMMARY_OUTCOMES].sort()).toEqual(["aborted", "blocked", "errored", "observed", "rested", "settled", "superseded", "suspended"])
  })
})

describe("tallyToolEnds", () => {
  it("counts each tool end and still calls the original with its own this", () => {
    const tally = new TurnTally()
    const seen: unknown[] = []
    const callbacks = {
      label: "orig",
      onToolEnd(this: { label: string }, name: string, summary: string, success: boolean) { seen.push([this.label, name, summary, success]) },
    }
    const wrapped = tallyToolEnds(callbacks, tally)
    wrapped.onToolEnd("probe", "summary", false)
    expect(seen).toEqual([["orig", "probe", "summary", false]])
    expect(wrapped.label).toBe("orig")
    expect(tally.summarize({ channel: "cli", outcome: "settled", errorClass: "none" }).toolErrors).toBe(1)
  })

  it("still calls the original when counting throws", () => {
    const tally = new TurnTally()
    vi.spyOn(tally, "toolEnd").mockImplementation(() => { throw new Error("boom") })
    const onToolEnd = vi.fn()
    tallyToolEnds({ onToolEnd }, tally).onToolEnd("probe", "s", true)
    expect(onToolEnd).toHaveBeenCalledWith("probe", "s", true)
  })

  it("hands back a frozen onToolEnd untouched rather than break the proxy", () => {
    const tally = new TurnTally()
    const onToolEnd = vi.fn()
    const wrapped = tallyToolEnds(Object.freeze({ onToolEnd }), tally)
    expect(wrapped.onToolEnd).toBe(onToolEnd)
    wrapped.onToolEnd("probe", "s", true)
    expect(onToolEnd).toHaveBeenCalledTimes(1)
  })
})

describe("emitTurnSummary", () => {
  afterEach(() => setRuntimeLogger(null))

  it("emits engine.turn_summary with the counts", () => {
    const events: any[] = []
    setRuntimeLogger(createLogger({ level: "debug", sinks: [(entry) => events.push(entry)] }))
    const tally = new TurnTally()
    emitTurnSummary(tally, { channel: "mail", outcome: "settled", errorClass: "none", traceId: "t1" })
    emitTurnSummary(tally, { channel: "mail", outcome: "errored", errorClass: "unknown", traceId: "t1" })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ event: "engine.turn_summary", component: "engine", trace_id: "t1", meta: { channel: "mail", steps: 0 } })
  })

  it("swallows a logger that throws", () => {
    const throwing = createLogger({ level: "debug", sinks: [] })
    setRuntimeLogger({ ...throwing, info: () => { throw new Error("disk full") } })
    expect(() => emitTurnSummary(new TurnTally(), { channel: "cli", outcome: "settled", errorClass: "none" })).not.toThrow()
  })
})
