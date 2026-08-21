import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Tests for the static source scanner that extracts component:event keys
 * from emitNervesEvent calls in production source files.
 *
 * The scanner should:
 * 1. Extract component and event string literals from emitNervesEvent calls
 * 2. Support both single-line and multi-line calls
 * 3. Reject template literals and variables (only static strings)
 * 4. Return component:event keys
 */

// We'll import the scanner once it's implemented
// For now the import will fail (red)
import { scanSourceForNervesKeys } from "../../nerves/coverage/source-scanner"

describe("source scanner", () => {
  it("extracts keys from single-line emitNervesEvent calls", () => {
    const source = `
import { emitNervesEvent } from "../nerves/runtime"
emitNervesEvent({ component: "engine", event: "engine.turn_start", message: "start" })
`
    const keys = scanSourceForNervesKeys(source)
    expect(keys).toContain("engine:engine.turn_start")
  })

  it("extracts keys from multi-line emitNervesEvent calls", () => {
    const source = `
emitNervesEvent({
  component: "mind",
  event: "mind.step_start",
  message: "step",
})
`
    const keys = scanSourceForNervesKeys(source)
    expect(keys).toContain("mind:mind.step_start")
  })

  it("extracts static keys from emitNervesEventDurable calls", () => {
    const source = `
await emitNervesEventDurable({
  component: "senses",
  event: "telegram.callback_recovery_settled",
  message: "recovered",
})
`
    expect(scanSourceForNervesKeys(source)).toEqual(["senses:telegram.callback_recovery_settled"])
  })

  it("retains literal enforcement for emitNervesEventDurable calls", () => {
    const source = `
await emitNervesEventDurable({ component: "senses", event, message: "dynamic" })
await emitNervesEventDurable({ component: componentName, event: "telegram.callback_recovery_settled", message: "dynamic" })
`
    expect(scanSourceForNervesKeys(source)).toEqual([])
  })

  it("discovers both production Telegram settlement keys through their durable emitters", () => {
    const source = readFileSync(join(process.cwd(), "src", "senses", "telegram-approval-runtime.ts"), "utf8")
    const keys = scanSourceForNervesKeys(source)
    expect(keys).toContain("senses:telegram.callback_settled")
    expect(keys).toContain("senses:telegram.callback_recovery_settled")
  })

  it("extracts multiple keys from one file", () => {
    const source = `
emitNervesEvent({ component: "engine", event: "engine.turn_start", message: "start" })
emitNervesEvent({ component: "engine", event: "engine.turn_end", message: "end" })
emitNervesEvent({ component: "tools", event: "tool.start", message: "tool" })
`
    const keys = scanSourceForNervesKeys(source)
    expect(keys).toContain("engine:engine.turn_start")
    expect(keys).toContain("engine:engine.turn_end")
    expect(keys).toContain("tools:tool.start")
    expect(keys).toHaveLength(3)
  })

  it("ignores template literals for component or event", () => {
    const source = `
emitNervesEvent({ component: \`dynamic-\${name}\`, event: "some.event", message: "msg" })
emitNervesEvent({ component: "engine", event: \`engine.\${action}\`, message: "msg" })
`
    const keys = scanSourceForNervesKeys(source)
    expect(keys).toHaveLength(0)
  })

  it("ignores variable references for component or event", () => {
    const source = `
emitNervesEvent({ component: componentVar, event: "some.event", message: "msg" })
emitNervesEvent({ component: "engine", event: eventVar, message: "msg" })
`
    const keys = scanSourceForNervesKeys(source)
    expect(keys).toHaveLength(0)
  })

  it("returns empty array for file with no emitNervesEvent calls", () => {
    const source = `
export function doSomething() { return 42 }
`
    const keys = scanSourceForNervesKeys(source)
    expect(keys).toHaveLength(0)
  })

  it("handles double-quoted strings", () => {
    const source = `
emitNervesEvent({ component: "engine", event: "engine.turn_start", message: "start" })
`
    const keys = scanSourceForNervesKeys(source)
    expect(keys).toContain("engine:engine.turn_start")
  })

  it("handles single-quoted strings", () => {
    const source = `
emitNervesEvent({ component: 'engine', event: 'engine.turn_start', message: 'start' })
`
    const keys = scanSourceForNervesKeys(source)
    expect(keys).toContain("engine:engine.turn_start")
  })

  it("deduplicates keys", () => {
    const source = `
emitNervesEvent({ component: "engine", event: "engine.turn_start", message: "one" })
emitNervesEvent({ component: "engine", event: "engine.turn_start", message: "two" })
`
    const keys = scanSourceForNervesKeys(source)
    expect(keys).toContain("engine:engine.turn_start")
    expect(keys).toHaveLength(1)
  })
})
