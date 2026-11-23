import { describe, expect, it } from "vitest"
import { PROVIDER_CREDENTIALS } from "../../../heart/identity"
import { WATCH_PROVIDERS, dailyCounts, rowFromLine } from "../../../eval/watch/rows"
import { summaryLine } from "./fixtures"

const CANARY = "zebracanary7731"
const salt = "0".repeat(64)
const context = { salt, bundleCommitAtWatch: "a".repeat(40) }

describe("Watch rows", () => {
  it("keeps a turn summary as a private row, with the turn named only by a salted hash", () => {
    const result = rowFromLine(summaryLine(), context)
    expect(result.kind).toBe("row")
    if (result.kind !== "row") return
    expect(result.row).toMatchObject({
      day: "2026-11-23", channel: "bluebubbles", outcome: "settled", errorClass: "none", bundleCommitAtWatch: "a".repeat(40),
      runtimeVersion: "0.1.0-alpha.1500", provider: "github-copilot", model: "claude-opus-5.5", steps: 1, inputTokens: 100,
      toolCalls: { shell: 1 },
    })
    expect(result.row.turn).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.stringify(result.row)).not.toContain("trace-1")
    const other = rowFromLine(summaryLine(), { ...context, salt: "1".repeat(64) })
    expect(other.kind === "row" && other.row.turn).not.toBe(result.row.turn)
  })

  it("skips other events without parsing them, even ones that mention the event name", () => {
    expect(rowFromLine(JSON.stringify({ event: "engine.turn_end", meta: {} }), context)).toEqual({ kind: "skip" })
    expect(rowFromLine(JSON.stringify({ event: "x", message: "engine.turn_summary" }), context)).toEqual({ kind: "skip" })
    expect(rowFromLine(`{not json ${CANARY}`, context)).toEqual({ kind: "skip" })
  })

  it("skips a line that is only the event's name", () => {
    expect(rowFromLine('"engine.turn_summary"', context)).toEqual({ kind: "skip" })
    expect(rowFromLine('null', context)).toEqual({ kind: "skip" })
  })

  it("rejects a broken summary line by reason only", () => {
    expect(rowFromLine(`{"event":"engine.turn_summary",${CANARY}`, context)).toEqual({ kind: "rejected", reason: "parse" })
  })

  it.each([
    ["a channel outside the list", { channel: CANARY }],
    ["an outcome outside the list", { outcome: CANARY }],
    ["an error class outside the list", { errorClass: CANARY }],
    ["a provider that isn't an id", { provider: `${CANARY} words` }],
    ["a provider outside the list", { provider: CANARY }],
    ["a model with a capital or a slash", { model: `Tell/${CANARY}` }],
    ["a negative count", { steps: -1 }],
    ["a fractional count", { inputTokens: 1.5 }],
    ["a count given as text", { toolErrors: "1" }],
    ["a tool count that isn't a count", { toolCalls: { shell: -2 } }],
    ["tool calls that aren't a map", { toolCalls: [1] }],
  ])("rejects a summary with %s, by reason only", (_name, overrides) => {
    expect(rowFromLine(summaryLine(overrides), context)).toEqual({ kind: "rejected", reason: "schema" })
  })

  it("leaves out a field the event gained later, and keeps a summary from before runtimeVersion", () => {
    const newer = rowFromLine(summaryLine({ note: CANARY }), context)
    expect(newer.kind).toBe("row")
    expect(JSON.stringify(newer)).not.toContain(CANARY)
    const older = JSON.parse(summaryLine())
    delete older.meta.runtimeVersion
    expect(rowFromLine(JSON.stringify(older), context)).toMatchObject({ kind: "row", row: { runtimeVersion: "unknown" } })
  })

  it("keeps a tool name that isn't shaped like one only as other", () => {
    for (const name of [`${CANARY} said hi`, `tell-${CANARY}`, `Tell${CANARY}`, `mcp:${CANARY} x`]) {
      const result = rowFromLine(summaryLine({ toolCalls: { shell: 1, [name]: 2, [`${name}2`]: 1 } }), context)
      expect(result).toMatchObject({ kind: "row", row: { toolCalls: { shell: 1, other: 3 } } })
      expect(JSON.stringify(result)).not.toContain(CANARY)
    }
    expect(rowFromLine(summaryLine({ toolCalls: { "mcp:ouro-slugger": 1, unknown: 1 } }), context)).toMatchObject({ row: { toolCalls: { "mcp:ouro-slugger": 1, unknown: 1 } } })
  })

  it.each([
    ["a missing field", (line: string) => line.replace('"steps":1,', "")],
    ["a timestamp that isn't one", (line: string) => line.replace("2026-11-23T10:00:00.000Z", CANARY)],
    ["a timestamp that isn't text", (line: string) => JSON.stringify({ ...JSON.parse(line), ts: 5 })],
    ["no meta", (line: string) => JSON.stringify({ ...JSON.parse(line), meta: null })],
    ["no trace id", (line: string) => JSON.stringify({ ...JSON.parse(line), trace_id: 7 })],
  ])("rejects a summary line with %s", (_name, edit) => {
    expect(rowFromLine(edit(summaryLine()), context)).toEqual({ kind: "rejected", reason: "schema" })
  })

  it("knows every provider an agent can be configured with", () => {
    expect([...WATCH_PROVIDERS].sort()).toEqual(Object.keys(PROVIDER_CREDENTIALS).sort())
  })

  it("adds rows up by day and channel", () => {
    const rows = [
      summaryLine(),
      summaryLine({ outcome: "errored", errorClass: "rate-limit", stepBudgetExhausted: 1 }),
      summaryLine({ channel: "mail" }),
      summaryLine({}, { ts: "2026-11-24T01:00:00.000Z" }),
    ].map((line) => rowFromLine(line, context)).flatMap((result) => result.kind === "row" ? [result.row] : [])
    const counts = dailyCounts(rows)
    expect(counts["2026-11-23"].bluebubbles).toMatchObject({
      turns: 2, steps: 2, stepBudgetStops: 1, toolCalls: 2, inputTokens: 200,
      outcomes: { settled: 1, errored: 1 }, errorClasses: { "rate-limit": 1 },
    })
    expect(counts["2026-11-23"].mail.turns).toBe(1)
    expect(counts["2026-11-24"].bluebubbles.turns).toBe(1)
  })
})
