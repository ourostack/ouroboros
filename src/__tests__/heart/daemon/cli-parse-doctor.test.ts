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

  it("usage() output includes 'doctor'", () => {
    const text = usage()
    expect(text).toContain("doctor")
  })
})
