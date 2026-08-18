import { describe, expect, it } from "vitest"
import { readContainerRuntimePolicy } from "../../../heart/daemon/container-runtime"

describe("container runtime policy", () => {
  it("accepts only the locked scheduler/update policy", () => {
    expect(readContainerRuntimePolicy({ readFile: () => JSON.stringify({ scheduler: "supercronic", updates: "disabled" }) })).toEqual({ scheduler: "supercronic", updates: "disabled" })
    expect(() => readContainerRuntimePolicy({ readFile: () => JSON.stringify({ scheduler: "cron", updates: "disabled" }) })).toThrow()
  })
})
