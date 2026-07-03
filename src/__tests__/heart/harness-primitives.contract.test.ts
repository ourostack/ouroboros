import { describe, expect, it } from "vitest"

import {
  HARNESS_PRIMITIVES_ENTRYPOINT,
  HARNESS_BOOTSTRAP_PHASES,
} from "../../heart/harness"
import type { HarnessToolCall } from "../../heart/harness"

describe("harness primitives contract", () => {
  it("exports bootstrap scaffolding constants", () => {
    expect(HARNESS_PRIMITIVES_ENTRYPOINT).toBe("harness/primitives")
    expect(HARNESS_BOOTSTRAP_PHASES).toEqual(["bundle", "psyche", "private-runtime"])
  })

  it("provides a typed tool-call surface", () => {
    const call: HarnessToolCall = {
      tool: "shell",
      input: { cmd: "pwd" },
      rationale: "inspect cwd",
    }

    expect(call.tool).toBe("shell")
    expect(call.input).toEqual({ cmd: "pwd" })
  })
})
