import { describe, it, expect, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { parseOuroCommand, usage } from "../../../heart/daemon/cli-parse"

describe("ouro doctor CLI parsing", () => {
  it("parses 'doctor' as { kind: 'doctor' }", () => {
    expect(parseOuroCommand(["doctor"])).toEqual({ kind: "doctor" })
  })

  it("usage() output includes 'doctor'", () => {
    const text = usage()
    expect(text).toContain("doctor")
  })
})
