import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { history, TODAYS_PAIRS } from "./successions-fixture"
import { FIRST_MESSAGE_SCAN_BYTES, isHandedOff, namedPredecessor, readSuccessions, refreshSuccessions, successorOf } from "../../../senses/app-sessions/handoff"

const A = "aaaaaaaa-0000-4000-8000-000000000001"
const B = "bbbbbbbb-0000-4000-8000-000000000002"
const C = "cccccccc-0000-4000-8000-000000000003"

let agentRoot: string
const refresh = (listed: string[]) => refreshSuccessions(agentRoot, { stateDir }, listed)
let stateDir: string

beforeEach(() => {
  agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-"))
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-state-"))
})
afterEach(() => {
  fs.rmSync(agentRoot, { recursive: true, force: true })
  fs.rmSync(stateDir, { recursive: true, force: true })
})

describe("the session a first message succeeds", () => {
  const known = (value: string): string | null => [A, B, C].find(id => id.startsWith(value)) ?? null

  it("reads the structured Succeeds line anywhere in the first 16 KB, and nowhere after", () => {
    expect(namedPredecessor(`Succeeds: ${A}\n\nCarry on.`, B, known)).toEqual({ predecessor: A, marker: "structured" })
    expect(namedPredecessor(`# Kickoff\n\n**Succeeds:** ${A.toUpperCase()}\n`, B, known)).toEqual({ predecessor: A, marker: "structured" })
    expect(namedPredecessor(`${"x".repeat(17_000)}\nSucceeds: ${A}`, B, known)).toBeNull()
  })

  it("does not take a Succeeds mention inside a sentence, a placeholder, or the session itself", () => {
    expect(namedPredecessor(`Kickoffs begin with \`Succeeds: ${A}\` from now on.`, B, known)).toBeNull()
    expect(namedPredecessor("Succeeds: <predecessor session id>", B, known)).toBeNull()
    expect(namedPredecessor(`Succeeds: ${B}`, B, known)).toBeNull()
  })

  it("falls back to the older wording only where the message opens, with an id close after it", () => {
    expect(namedPredecessor(`You are the successor of ${A.slice(0, 8)}.`, B, known)).toEqual({ predecessor: A, marker: "free-text" })
    expect(namedPredecessor(`${"Context. ".repeat(300)}You are the successor to ${A}.`, B, known)).toBeNull()
    expect(namedPredecessor(`Hand off to a fresh successor when the history grows. ${A}`, B, known)).toBeNull()
    expect(namedPredecessor(`You are the successor to ${"words ".repeat(60)}${A}`, B, known)).toBeNull()
    expect(namedPredecessor("You are the successor to deadbeef.", B, known)).toBeNull()
  })

  it("recognises each of today's real hand-offs from its kickoff", () => {
    const ids = TODAYS_PAIRS.flat().filter(value => /^[0-9a-f-]{36}$/.test(value))
    for (const [predecessor, successor, kickoff] of TODAYS_PAIRS) {
      expect(namedPredecessor(kickoff, successor, value => ids.filter(id => id.startsWith(value))[0] ?? null)).toEqual({ predecessor, marker: "free-text" })
    }
  })
})

describe("following successions through the histories", () => {
  it("finds today's pairs past the hook events, and records each successor's first turn", () => {
    for (const [predecessor, successor, kickoff] of TODAYS_PAIRS) {
      history(stateDir, predecessor, "Earlier work.", { turned: true })
      history(stateDir, successor, kickoff)
    }
    const listed = TODAYS_PAIRS.flatMap(([predecessor, successor]) => [predecessor, successor])
    let known = refresh(listed)
    for (const [predecessor, successor] of TODAYS_PAIRS) {
      expect(known[successor]).toMatchObject({ predecessor, marker: "free-text" })
      expect(known[successor]!.turned).toBeUndefined()
      expect(successorOf(predecessor, known)).toBe(successor)
    }
    const [, first, kickoff] = TODAYS_PAIRS[0]!
    history(stateDir, first, kickoff, { turned: true })
    known = refresh(listed)
    expect(known[first]).toMatchObject({ turned: true })
    expect(readSuccessions(agentRoot)[first]).toMatchObject({ turned: true })
  })

  it("follows a chain to its newest end, prefers the newest of two claims, and survives a loop", () => {
    history(stateDir, A, "Original.")
    history(stateDir, B, `Succeeds: ${A}`, { at: "2026-11-16T10:00:00Z" })
    history(stateDir, C, `Succeeds: ${B}`, { at: "2026-11-16T12:00:00Z" })
    const known = refresh([A, B, C])
    expect(successorOf(A, known)).toBe(C)
    expect(successorOf(C, known)).toBeNull()
    expect(successorOf(B, { [C]: { predecessor: B, offset: 0 }, [A]: { predecessor: B, offset: 0, at: "2026-11-16T13:00:00Z" } })).toBe(A)
    expect(successorOf(A, { [B]: { predecessor: A, offset: 0 }, [A]: { predecessor: B, offset: 0 } })).toBeNull()
  })

  it("resolves a short id only when one history matches it, and ignores sub-agents' and malformed events", () => {
    const twin = "aaaaaaaa-1111-4000-8000-000000000009"
    history(stateDir, A, "Original.")
    history(stateDir, twin, "Other.")
    history(stateDir, B, "You are the successor to aaaaaaaa.")
    history(stateDir, C, `You are the successor to ${A.slice(0, 13)}.`)
    const file = path.join(stateDir, "session-state", "dddddddd-0000-4000-8000-000000000004", "events.jsonl")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, [
      { type: "user.message", agentId: "sub", data: { content: `Succeeds: ${A}` } },
      { type: "hook.end", data: "not an object" },
      { type: "user.message", data: { content: `Succeeds: ${A}` } },
      { type: "assistant.turn_end", agentId: "sub", data: {} },
    ].map(event => JSON.stringify(event)).join("\n") + "\n")
    const known = refresh([A, twin, B, C, "dddddddd-0000-4000-8000-000000000004"])
    expect(known[B]).toMatchObject({ predecessor: null })
    expect(known[C]).toMatchObject({ predecessor: null })
    expect(known["dddddddd-0000-4000-8000-000000000004"]).toMatchObject({ predecessor: A })
    expect(known["dddddddd-0000-4000-8000-000000000004"]!.turned).toBeUndefined()
  })

  it("waits for a first message still to come, and gives up after the scan limit", () => {
    history(stateDir, B, null)
    expect(refresh([B])[B]).toMatchObject({ pending: true, predecessor: null })
    history(stateDir, B, `Succeeds: ${A}`)
    history(stateDir, A, "Original.")
    expect(refresh([A, B])[B]).toMatchObject({ predecessor: A, marker: "structured" })
    history(stateDir, C, null, { padBytes: FIRST_MESSAGE_SCAN_BYTES + 10_000 })
    expect(refresh([A, B, C])[C]!.pending).toBeUndefined()
    fs.rmSync(path.join(stateDir, "session-state"), { recursive: true })
    expect(refresh([A, B, C])).toMatchObject({ [A]: { predecessor: null }, [B]: { predecessor: A } })
  })

  it("keeps only the sessions the app lists and the successions still pending: an archived or vanished one drops out", () => {
    history(stateDir, A, "Original.")
    history(stateDir, B, `Succeeds: ${A}`, { turned: true })
    history(stateDir, C, `Succeeds: ${B}`)
    expect(Object.keys(refresh([A, B, C, A])).sort()).toEqual([A, B, C])
    expect(Object.keys(refresh([A, C])).sort()).toEqual([A, B, C])
    expect(refresh([A])).toMatchObject({ [B]: { predecessor: A } })
    expect(Object.keys(refresh([C]))).toEqual([C])
    expect(readSuccessions(agentRoot)[B]).toBeUndefined()
    expect(refresh([])).toEqual({})
    expect(readSuccessions(agentRoot)).toEqual({})
  })
})

describe("whether a session was handed off", () => {
  it("is true only for a session that a later first message succeeds, as the sense last recorded", () => {
    history(stateDir, A, "Original.")
    history(stateDir, B, `Succeeds: ${A}`)
    expect(isHandedOff(agentRoot, { id: A })).toBe(false)
    refresh([A, B])
    expect(isHandedOff(agentRoot, { id: A })).toBe(true)
    expect(isHandedOff(agentRoot, { id: B })).toBe(false)
  })
})
