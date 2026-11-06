import { describe, it, expect, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { parseOuroCommand, usage } from "../../../heart/daemon/cli-parse"

describe("ouro doctor CLI parsing", () => {
  it("parses 'doctor' as { kind: 'doctor', json: false }", () => {
    expect(parseOuroCommand(["doctor"])).toEqual({ kind: "doctor", json: false })
  })

  it("parses 'doctor --json' with json: true", () => {
    expect(parseOuroCommand(["doctor", "--json"])).toEqual({ kind: "doctor", json: true })
  })

  it("parses 'doctor --category Daemon' with the category set", () => {
    expect(parseOuroCommand(["doctor", "--category", "Daemon"])).toEqual({ kind: "doctor", category: "Daemon" })
  })

  it("ignores --category without a value", () => {
    expect(parseOuroCommand(["doctor", "--category"])).toEqual({ kind: "doctor" })
  })

  it("parses 'doctor --strict' with strict: true", () => {
    expect(parseOuroCommand(["doctor", "--strict"])).toEqual({ kind: "doctor", strict: true })
  })

  it("parses 'doctor --strict --category Daemon' with both fields", () => {
    expect(parseOuroCommand(["doctor", "--strict", "--category", "Daemon"])).toEqual({
      kind: "doctor",
      category: "Daemon",
      strict: true,
    })
  })

  it("usage() output includes 'doctor'", () => {
    const text = usage()
    expect(text).toContain("doctor")
  })
})
