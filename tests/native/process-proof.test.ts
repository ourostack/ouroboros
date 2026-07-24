import { execFileSync, spawnSync } from "child_process"
import { createHash } from "crypto"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  inspectDarwinProcess,
  type ProcessProofRunner,
} from "../../src/heart/runtime/darwin-process-proof"

const tempRoots: string[] = []

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

function compileFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ouro-process-proof-"))
  tempRoots.push(root)
  const executable = join(root, "process-proof-darwin")
  execFileSync("/usr/bin/xcrun", [
    "--sdk",
    "macosx",
    "clang",
    "-std=c17",
    "-Wall",
    "-Wextra",
    "-Werror",
    join(process.cwd(), "native", "process-proof", "process-proof-darwin.c"),
    "-o",
    executable,
  ])
  return executable
}

function fixtureRunner(stdout: string): ProcessProofRunner & { run: ReturnType<typeof vi.fn> } {
  return {
    readFile: vi.fn(() => Buffer.from("trusted-helper")),
    realpath: vi.fn((value: string) => value),
    run: vi.fn(() => ({ status: 0, stdout, stderr: "" })),
  }
}

describe.runIf(process.platform === "darwin")("Darwin process-proof native helper", () => {
  it("compiles warning-free and accepts only --pid followed by one canonical decimal PID", () => {
    const executable = compileFixture()
    const good = spawnSync(executable, ["--pid", String(process.pid)], { encoding: "utf8" })
    expect(good.status, good.stderr).toBe(0)
    expect(good.stderr).toBe("")

    for (const argv of [[], ["--pid"], ["--pid", "0"], ["--pid", "01"], ["--pid", "+1"], ["--pid", "1.0"], ["--pid", "1", "extra"], ["--contract"]]) {
      const rejected = spawnSync(executable, argv, { encoding: "utf8" })
      expect(rejected.status).toBe(64)
      expect(rejected.stdout).toBe("")
      expect(rejected.stderr).toMatch(/usage:.*--pid <decimal>/i)
    }
  })

  it("returns one bounded canonical record with kernel UID, real path, and microsecond start identity", () => {
    const executable = compileFixture()
    const before = readdirSync(join(executable, ".."))
    const result = spawnSync(executable, ["--pid", String(process.pid)], { encoding: "utf8" })
    const after = readdirSync(join(executable, ".."))

    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(8192)
    expect(result.stdout.endsWith("\n")).toBe(true)
    expect(result.stdout.trim().split("\n")).toHaveLength(1)
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>
    expect(parsed).toEqual({
      executableRealpath: expect.stringMatching(/^\//),
      pid: process.pid,
      schemaVersion: 1,
      startIdentity: expect.stringMatching(/^darwin-proc:\d+:\d{6}$/),
      uid: process.getuid!(),
    })
    expect(result.stdout.trim()).toBe(JSON.stringify(parsed))
    expect(after).toEqual(before)

    const source = readFileSync(join(process.cwd(), "native", "process-proof", "process-proof-darwin.c"), "utf8")
    expect(source).toContain("proc_pidinfo")
    expect(source).toContain("PROC_PIDTBSDINFO")
    expect(source).toContain("pbi_start_tvsec")
    expect(source).toContain("pbi_start_tvusec")
    expect(source).toContain("proc_pidpath")
    expect(source).not.toMatch(/\b(system|exec|posix_spawn|fork)\s*\(/)
  })
})

describe("Darwin process-proof protocol wrapper", () => {
  const helperSha256 = createHash("sha256").update("trusted-helper").digest("hex")
  const output = "{\"executableRealpath\":\"/usr/local/bin/runtime\",\"pid\":42,\"schemaVersion\":1,\"startIdentity\":\"darwin-proc:1770000000:000123\",\"uid\":501}\n"

  it("binds helper bytes, architecture, exact argv, canonical output, and executable realpath", () => {
    const runner = fixtureRunner(output)

    expect(inspectDarwinProcess(42, {
      platform: "darwin",
      arch: "arm64",
      helperPath: "/package/process-proof-darwin",
      helperSha256,
      runner,
    })).toEqual({
      pid: 42,
      uid: 501,
      startIdentity: "darwin-proc:1770000000:000123",
      executableRealpath: "/usr/local/bin/runtime",
    })
    expect(runner.run).toHaveBeenCalledWith("/package/process-proof-darwin", ["--pid", "42"], 8192)
    expect(runner.readFile).toHaveBeenCalledWith("/package/process-proof-darwin")
    expect(runner.realpath).toHaveBeenCalledWith("/usr/local/bin/runtime")
  })

  it("preserves microseconds so same-second PID reuse cannot compare equal", () => {
    const first = inspectDarwinProcess(42, {
      platform: "darwin", arch: "x64", helperPath: "/helper", helperSha256, runner: fixtureRunner(output),
    })
    const second = inspectDarwinProcess(42, {
      platform: "darwin", arch: "x64", helperPath: "/helper", helperSha256,
      runner: fixtureRunner(output.replace(":000123\"", ":000124\"")),
    })

    expect(first.startIdentity).not.toBe(second.startIdentity)
  })

  it("rejects unsupported platforms and architectures before execution", () => {
    const runner = fixtureRunner(output)
    for (const variant of [
      { platform: "linux", arch: "x64" },
      { platform: "darwin", arch: "ia32" },
    ]) {
      expect(() => inspectDarwinProcess(42, {
        ...variant,
        helperPath: "/helper",
        helperSha256,
        runner,
      })).toThrow(/unsupported/i)
    }
    expect(runner.run).not.toHaveBeenCalled()
  })

  it("rejects helper-byte drift before execution", () => {
    const runner = fixtureRunner(output)
    expect(() => inspectDarwinProcess(42, {
      platform: "darwin",
      arch: "arm64",
      helperPath: "/helper",
      helperSha256: "0".repeat(64),
      runner,
    })).toThrow(/helper.*hash|provenance/i)
    expect(runner.run).not.toHaveBeenCalled()
  })

  it("rejects noncanonical, oversized, mismatched, malformed, or noisy helper output", () => {
    const invalid = [
      output.replace("\"pid\":42", "\"pid\":43"),
      output.replace("000123", "123"),
      output.replace("\"uid\":501", "\"uid\":-1"),
      output.replace("/usr/local/bin/runtime", "relative/runtime"),
      output.replace("{\"executableRealpath\"", "{\"uid\":501,\"executableRealpath\"").replace(",\"uid\":501}", "}"),
      `${output}extra\n`,
      "x".repeat(8193),
    ]

    for (const stdout of invalid) {
      expect(() => inspectDarwinProcess(42, {
        platform: "darwin", arch: "arm64", helperPath: "/helper", helperSha256, runner: fixtureRunner(stdout),
      })).toThrow(/process proof|canonical|bounded|output/i)
    }

    const noisy = fixtureRunner(output)
    noisy.run.mockReturnValue({ status: 0, stdout: output, stderr: "noise" })
    expect(() => inspectDarwinProcess(42, {
      platform: "darwin", arch: "arm64", helperPath: "/helper", helperSha256, runner: noisy,
    })).toThrow(/process proof|stderr/i)
  })
})
