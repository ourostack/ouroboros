import { execFileSync, spawnSync } from "child_process"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { afterEach, describe, expect, it } from "vitest"

const tempRoots: string[] = []

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

function compileDriver(): string {
  const root = mkdtempSync(join(tmpdir(), "ouro-pair-canary-driver-"))
  tempRoots.push(root)
  const output = join(root, "driver")
  execFileSync("/usr/bin/clang", [
    "-std=c17",
    "-Wall",
    "-Wextra",
    "-Werror",
    join(process.cwd(), "native", "developer-id-pair-canary", "driver.c"),
    "-o",
    output,
  ])
  return output
}

describe("Developer ID pair canary native driver", () => {
  it("compiles warning-free and exposes only the inert contract probe", () => {
    const executable = compileDriver()
    const result = spawnSync(executable, ["--contract"], { encoding: "utf8", env: {} })

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      driver: "developer-id-pair-canary",
      sideEffects: "none",
      secretTransport: "stdin-only",
    })
    expect(result.stderr).toBe("")
  })

  it("rejects unknown argv without reading environment secrets", () => {
    const executable = compileDriver()
    const result = spawnSync(executable, ["--sign"], {
      encoding: "utf8",
      env: { DEVELOPER_ID_APPLICATION_P12: "must-not-be-read" },
    })

    expect(result.status).toBe(64)
    expect(result.stdout).toBe("")
    expect(result.stderr).toMatch(/usage:.*--contract/i)
    expect(readFileSync(
      join(process.cwd(), "native", "developer-id-pair-canary", "driver.c"),
      "utf8",
    )).not.toContain("getenv(")
  })
})
