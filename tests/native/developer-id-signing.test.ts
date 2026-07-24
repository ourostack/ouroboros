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
  execFileSync("/usr/bin/xcrun", [
    "--sdk",
    "macosx",
    "clang",
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

function encodeFrame(fields: Buffer[]): Buffer {
  const count = Buffer.alloc(4)
  count.writeUInt32BE(fields.length)
  return Buffer.concat([count, ...fields.flatMap((field) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(field.length)
    return [length, field]
  })])
}

describe.runIf(process.platform === "darwin")("Developer ID signing native driver", () => {
  it("compiles warning-free and reports its closed stdin-only contract", () => {
    const executable = compileDriver()
    const result = spawnSync(executable, ["--contract"], { encoding: "utf8", env: {} })

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      driver: "developer-id-signing",
      signingAuthority: "workflow-bound",
      secretTransport: "stdin-only",
      acceptedModes: ["--contract", "--validate-frame"],
      frame: { exact: true, maximumFieldBytes: 1048576, requiredFields: 2 },
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
    expect(execFileSync("/usr/bin/nm", ["-u", executable], { encoding: "utf8" })).not.toMatch(
      /\b(_getenv|_secure_getenv|_environ|_NSProcessInfo|_execve|_posix_spawn|_system)\b/,
    )
  })

  it("accepts one exact two-field stdin frame and rejects ambiguous bytes", () => {
    const executable = compileDriver()
    const frame = encodeFrame([Buffer.from("synthetic-p12"), Buffer.from("synthetic-password")])
    const accepted = spawnSync(executable, ["--validate-frame"], {
      encoding: "utf8",
      env: {},
      input: frame,
    })

    expect(accepted.status).toBe(0)
    expect(JSON.parse(accepted.stdout)).toEqual({
      schemaVersion: 1,
      accepted: true,
      fieldCount: 2,
      byteCount: frame.length,
    })
    const poisoned = spawnSync(executable, ["--validate-frame"], {
      encoding: "utf8",
      env: { OURO_DRIVER_FIELD_1: "different", PATH: "/definitely/not/used" },
      input: frame,
    })
    expect(poisoned).toMatchObject({
      status: accepted.status,
      stdout: accepted.stdout,
      stderr: accepted.stderr,
    })
    for (const invalid of [Buffer.alloc(0), frame.subarray(0, frame.length - 1), Buffer.concat([frame, Buffer.from([0])])]) {
      const rejected = spawnSync(executable, ["--validate-frame"], { env: {}, input: invalid })
      expect(rejected.status).toBe(65)
      expect(rejected.stdout).toHaveLength(0)
    }
  })
})
