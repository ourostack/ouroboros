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

function encodeFrame(fields: Buffer[]): Buffer {
  const count = Buffer.alloc(4)
  count.writeUInt32BE(fields.length)
  return Buffer.concat([count, ...fields.flatMap((field) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(field.length)
    return [length, field]
  })])
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
      acceptedModes: ["--contract", "--validate-frame"],
      frame: { exact: true, maximumFieldBytes: 1048576, requiredFields: 2 },
    })
    expect(result.stderr).toBe("")
  })

  it("rejects unknown argv without reading environment secrets", () => {
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
    const result = spawnSync(executable, ["--sign"], {
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
      join(process.cwd(), "native", "developer-id-pair-canary", "driver.c"),
      "utf8",
    )).not.toMatch(/\b(getenv|secure_getenv|environ)\b/)
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
    for (const invalid of [Buffer.alloc(0), frame.subarray(0, frame.length - 1), Buffer.concat([frame, Buffer.from([0])])]) {
      const rejected = spawnSync(executable, ["--validate-frame"], { env: {}, input: invalid })
      expect(rejected.status).toBe(65)
      expect(rejected.stdout).toHaveLength(0)
    }
  })
})
