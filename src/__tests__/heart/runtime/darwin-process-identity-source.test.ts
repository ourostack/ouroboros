import { createHash } from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { describe, expect, it, vi } from "vitest"

import {
  createDarwinProcessIdentitySource,
  parseDarwinBootId,
  readDarwinBootEvidence,
  type ProcessProofRunner,
} from "../../../heart/runtime/darwin-process-proof"

function runner(helperBytes: Buffer): ProcessProofRunner {
  return {
    readFile: vi.fn(() => helperBytes),
    realpath: vi.fn((value) => value),
    run: vi.fn((_executable, argv) => ({
      status: 0,
      stderr: "",
      stdout: `{"executableRealpath":"/usr/local/bin/node","pid":${argv[1]},"schemaVersion":1,"startIdentity":"darwin-proc:1770000000:000123","uid":501}\n`,
    })),
  }
}

describe("packaged Darwin process identity source", () => {
  it("parses fresh kernel boot evidence into a generation-safe canonical ID", () => {
    expect(parseDarwinBootId("{ sec = 1770000000, usec = 42 } Thu Jul 23 00:00:00 2026\n"))
      .toBe("darwin-boot:1770000000:000042")
    for (const invalid of [
      "",
      "{ sec = 0, usec = 0 }\n",
      "{ sec = 1, usec = 1000000 }\n",
      "sec = 1, usec = 2",
      "x".repeat(8193),
    ]) {
      expect(() => parseDarwinBootId(invalid)).toThrow(/boot evidence/i)
    }
  })

  it("reads bounded boot evidence through the fixed sysctl runner contract", () => {
    expect(readDarwinBootEvidence(() => ({ status: 0, stdout: "boot bytes", stderr: "" }))).toBe("boot bytes")
    expect(() => readDarwinBootEvidence(() => ({ status: 1, stdout: "", stderr: "" }))).toThrow(/status 1/i)
    expect(() => readDarwinBootEvidence(() => ({ status: null, stdout: "", stderr: "failed" }))).toThrow(/status unknown/i)
    expect(readDarwinBootEvidence(() => ({ status: 0, stdout: null, stderr: null }))).toBe("")
  })

  it.runIf(process.platform === "darwin")("reads the host kernel boot tuple through the fixed sysctl invocation", () => {
    expect(parseDarwinBootId(readDarwinBootEvidence())).toMatch(/^darwin-boot:[1-9][0-9]*:[0-9]{6}$/)
  })

  it("binds the packaged helper bytes and returns fresh boot/process proof", () => {
    const helperBytes = Buffer.from("trusted helper")
    const sha256 = createHash("sha256").update(helperBytes).digest("hex")
    const proofRunner = runner(helperBytes)
    const readBootEvidence = vi.fn(() => "{ sec = 1770000000, usec = 42 } Thu Jul 23 00:00:00 2026\n")
    const source = createDarwinProcessIdentitySource({
      packageRoot: "/package",
      platform: "darwin",
      arch: "arm64",
      runner: proofRunner,
      readText: vi.fn((filePath) => {
        expect(filePath).toBe("/package/assets/native/process-proof/process-proof-darwin.sha256")
        return `${sha256}  process-proof-darwin\n`
      }),
      readBootEvidence,
    })

    expect(source.readBootId()).toBe("darwin-boot:1770000000:000042")
    expect(source.readProcess(4242)).toEqual({
      uid: 501,
      pid: 4242,
      startIdentity: "darwin-proc:1770000000:000123",
      executableRealpath: "/usr/local/bin/node",
    })
    expect(readBootEvidence).toHaveBeenCalledTimes(1)
    expect(proofRunner.run).toHaveBeenCalledWith(
      "/package/assets/native/process-proof/process-proof-darwin",
      ["--pid", "4242"],
      8192,
    )
  })

  it("fails closed on unsupported hosts and malformed release provenance", () => {
    const helperBytes = Buffer.from("trusted helper")
    const proofRunner = runner(helperBytes)
    const base = {
      packageRoot: "/package",
      arch: "arm64",
      runner: proofRunner,
      readBootEvidence: () => "{ sec = 1770000000, usec = 42 }\n",
    }
    expect(() => createDarwinProcessIdentitySource({
      ...base,
      platform: "linux",
      readText: () => "0".repeat(64) + "  process-proof-darwin\n",
    })).toThrow(/unsupported/i)
    for (const record of ["", "0".repeat(64), "0".repeat(64) + " process-proof-darwin\n", "g".repeat(64) + "  process-proof-darwin\n"]) {
      expect(() => createDarwinProcessIdentitySource({
        ...base,
        platform: "darwin",
        readText: () => record,
      })).toThrow(/provenance/i)
    }
  })

  it.runIf(process.platform === "darwin")("loads default platform, architecture, file, runner, and boot seams", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-packaged-process-source-"))
    const assetRoot = path.join(root, "assets", "native", "process-proof")
    fs.mkdirSync(assetRoot, { recursive: true })
    fs.writeFileSync(
      path.join(assetRoot, "process-proof-darwin.sha256"),
      `${"0".repeat(64)}  process-proof-darwin\n`,
    )
    try {
      expect(createDarwinProcessIdentitySource({ packageRoot: root })).toMatchObject({
        readBootId: expect.any(Function),
        readProcess: expect.any(Function),
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
