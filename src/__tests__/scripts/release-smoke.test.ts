import { describe, expect, it, vi } from "vitest"
import * as path from "path"

const {
  buildNpmExecArgs,
  isNpmExecBinPath,
  lastNonEmptyLine,
  runPublishedBinResolutionSmoke,
  runPublishedBinVersionSmoke,
  runReleaseSmokeSuite,
} = require(path.resolve(__dirname, "../../../scripts/release-smoke.cjs"))

function makeDeps(outputs: Array<string | Error>) {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = []
  const deps = {
    execFileSync: vi.fn((command: string, args: string[], options: { cwd: string }) => {
      calls.push({ command, args, cwd: options.cwd })
      const next = outputs.shift()
      if (next instanceof Error) throw next
      return next
    }),
    mkdtempSync: vi.fn(() => "/tmp/ouro-release-smoke-abcd"),
    rmSync: vi.fn(),
    tmpdir: vi.fn(() => "/tmp"),
  }
  return { deps, calls }
}

describe("release-smoke", () => {
  it("builds npm exec args with an isolated prefix before the requested package", () => {
    const args = buildNpmExecArgs(
      "/tmp/ouro-release-smoke-abcd",
      "@ouro.bot/cli@0.1.0-alpha.327",
      "ouro",
      ["--version"],
    )

    expect(args).toEqual([
      "exec",
      "--yes",
      "--prefix",
      "/tmp/ouro-release-smoke-abcd",
      "--package",
      "@ouro.bot/cli@0.1.0-alpha.327",
      "--",
      "ouro",
      "--version",
    ])
  })

  it("recognizes npm exec package bin paths", () => {
    expect(isNpmExecBinPath("/Users/me/.npm/_npx/hash/node_modules/.bin/ouro", "ouro")).toBe(true)
    expect(isNpmExecBinPath("/opt/homebrew/bin/ouro", "ouro")).toBe(false)
  })

  it("uses the final non-empty output line as the reported version", () => {
    const output = "installing @ouro.bot/cli@0.1.0-alpha.327...\n\n0.1.0-alpha.327\n"
    expect(lastNonEmptyLine(output)).toBe("0.1.0-alpha.327")
  })

  it("verifies the requested package binary from the isolated npm exec path", () => {
    const { deps, calls } = makeDeps([
      "/Users/me/.npm/_npx/hash/node_modules/.bin/ouro\n",
      "0.1.0-alpha.327\n",
    ])

    const result = runPublishedBinVersionSmoke({
      packageName: "@ouro.bot/cli",
      binName: "ouro",
      version: "0.1.0-alpha.327",
    }, deps)

    expect(result.ok).toBe(true)
    expect(result.message).toContain("verified")
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ command: "npm", cwd: "/tmp/ouro-release-smoke-abcd" })
    expect(calls[0].args).toContain("--prefix")
    expect(calls[0].args).toContain("/tmp/ouro-release-smoke-abcd")
    expect(deps.rmSync).toHaveBeenCalledWith("/tmp/ouro-release-smoke-abcd", { recursive: true, force: true })
  })

  it("fails when npm exec resolves a stale global binary", () => {
    const { deps } = makeDeps([
      "/opt/homebrew/bin/ouro\n",
    ])

    const result = runPublishedBinVersionSmoke({
      packageName: "@ouro.bot/cli",
      binName: "ouro",
      version: "0.1.0-alpha.327",
    }, deps)

    expect(result.ok).toBe(false)
    expect(result.message).toContain("not an npm exec package binary")
    expect(result.resolvedPath).toBe("/opt/homebrew/bin/ouro")
    expect(deps.execFileSync).toHaveBeenCalledTimes(1)
    expect(deps.rmSync).toHaveBeenCalledWith("/tmp/ouro-release-smoke-abcd", { recursive: true, force: true })
  })

  it("fails when the resolved package binary reports the wrong version", () => {
    const { deps } = makeDeps([
      "/Users/me/.npm/_npx/hash/node_modules/.bin/ouro\n",
      "0.1.0-alpha.323\n",
    ])

    const result = runPublishedBinVersionSmoke({
      packageName: "@ouro.bot/cli",
      binName: "ouro",
      version: "0.1.0-alpha.327",
    }, deps)

    expect(result.ok).toBe(false)
    expect(result.message).toContain("reported 0.1.0-alpha.323")
  })

  it("can verify a bootstrap package by exact package ref and isolated bin resolution only", () => {
    const { deps } = makeDeps([
      "/Users/me/.npm/_npx/hash/node_modules/.bin/ouro.bot\n",
    ])

    const result = runPublishedBinResolutionSmoke({
      packageName: "ouro.bot",
      binName: "ouro.bot",
      version: "0.1.0-alpha.327",
    }, deps)

    expect(result.ok).toBe(true)
    expect(result.message).toContain("resolved from npm exec package")
    expect(deps.execFileSync).toHaveBeenCalledTimes(1)
  })

  it("smokes both supported published binaries", () => {
    const { deps } = makeDeps([
      "/Users/me/.npm/_npx/hash/node_modules/.bin/ouro\n",
      "0.1.0-alpha.327\n",
      "/Users/me/.npm/_npx/hash/node_modules/.bin/ouro.bot\n",
    ])

    const results = runReleaseSmokeSuite("0.1.0-alpha.327", deps)

    expect(results.map((result: { ok: boolean }) => result.ok)).toEqual([true, true])
  })
})
