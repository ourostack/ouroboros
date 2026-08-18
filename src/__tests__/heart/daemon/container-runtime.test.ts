import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import { readContainerRuntimePolicy } from "../../../heart/daemon/container-runtime"

describe("container runtime policy", () => {
  it("accepts only the locked scheduler/update policy", () => {
    expect(readContainerRuntimePolicy({ readFile: () => JSON.stringify({ scheduler: "supercronic", updates: "disabled" }) })).toEqual({ scheduler: "supercronic", updates: "disabled" })
    expect(() => readContainerRuntimePolicy({ readFile: () => JSON.stringify({ scheduler: "cron", updates: "disabled" }) })).toThrow()
  })

  it("packages the process inspector required by fail-fast orphan cleanup", () => {
    const dockerfile = fs.readFileSync("deploy/unraid/Dockerfile", "utf8")
    expect(dockerfile).toMatch(/apt-get install[^\n]*\bprocps\b/u)
  })
})
