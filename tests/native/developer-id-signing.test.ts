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
  const root = mkdtempSync(join(tmpdir(), "ouro-signing-driver-"))
  tempRoots.push(root)
  const output = join(root, "driver")
  execFileSync("/usr/bin/clang", [
    "-std=c17",
    "-Wall",
    "-Wextra",
    "-Werror",
    join(process.cwd(), "native", "developer-id-signing", "driver.c"),
    "-o",
    output,
  ])
  return output
}

describe("Developer ID signing native driver", () => {
  it("compiles warning-free and reports its closed stdin-only contract", () => {
    const executable = compileDriver()
    const result = spawnSync(executable, ["--contract"], { encoding: "utf8", env: {} })

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      driver: "developer-id-signing",
      signingAuthority: "workflow-bound",
      secretTransport: "stdin-only",
    })
    expect(result.stderr).toBe("")
  })

  it("does not accept secret-bearing argv or environment variables", () => {
    const executable = compileDriver()
    const contractWithoutEnvironment = spawnSync(executable, ["--contract"], {
      encoding: "utf8",
      env: {},
    })
    const contractWithPoisonedEnvironment = spawnSync(executable, ["--contract"], {
      encoding: "utf8",
      env: {
        DEVELOPER_ID_APPLICATION_P12: "must-not-be-read",
        DEVELOPER_ID_APPLICATION_PASSWORD: "must-not-be-read",
      },
    })
    const result = spawnSync(executable, ["--p12", "secret"], {
      encoding: "utf8",
      env: { DEVELOPER_ID_APPLICATION_P12: "must-not-be-read" },
    })

    expect(result.status).toBe(64)
    expect(result.stdout).toBe("")
    expect(result.stderr).toMatch(/usage:.*--contract/i)
    expect(contractWithPoisonedEnvironment).toMatchObject({
      status: contractWithoutEnvironment.status,
      stdout: contractWithoutEnvironment.stdout,
      stderr: contractWithoutEnvironment.stderr,
    })
    expect(readFileSync(
      join(process.cwd(), "native", "developer-id-signing", "driver.c"),
      "utf8",
    )).not.toMatch(/\b(getenv|secure_getenv|environ)\b/)
  })
})
