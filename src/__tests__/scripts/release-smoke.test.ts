import { describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const {
  buildNpmExecArgs,
  isNpmExecBinPath,
  lastNonEmptyLine,
  runPublishedBinResolutionSmoke,
  runPublishedBinVersionSmoke,
  runReleaseSmokeSuite,
} = require(path.resolve(__dirname, "../../../scripts/release-smoke.cjs"))
const {
  REQUIRED_PACKAGE_ASSET_PATHS,
} = require(path.resolve(__dirname, "../../../scripts/package-assets.cjs"))

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
    sleepSync: vi.fn(),
    tmpdir: vi.fn(() => "/tmp"),
  }
  return { deps, calls }
}

function makePublishedPackageDeps(outputs: Array<string | Error>, options: { withAssets: boolean }) {
  const prefixDir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-release-smoke-test-"))
  const packageRoot = path.join(prefixDir, "node_modules", "@ouro.bot", "cli")
  const binDir = path.join(prefixDir, "node_modules", ".bin")
  const binPath = path.join(binDir, "ouro")
  fs.mkdirSync(binDir, { recursive: true })
  fs.mkdirSync(packageRoot, { recursive: true })
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@ouro.bot/cli" }))
  fs.writeFileSync(binPath, "#!/usr/bin/env node\n")
  if (options.withAssets) {
    for (const relativePath of REQUIRED_PACKAGE_ASSET_PATHS) {
      const filePath = path.join(packageRoot, relativePath)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, "ok")
    }
  }

  const calls: Array<{ command: string; args: string[]; cwd: string }> = []
  const deps = {
    execFileSync: vi.fn((command: string, args: string[], options: { cwd: string }) => {
      calls.push({ command, args, cwd: options.cwd })
      const next = outputs.shift()
      if (next instanceof Error) throw next
      if (next === "__BIN__\n") return `${binPath}\n`
      return next
    }),
    mkdtempSync: vi.fn(() => prefixDir),
    rmSync: vi.fn((target: string, options: fs.RmOptions) => fs.rmSync(target, options)),
    sleepSync: vi.fn(),
    tmpdir: vi.fn(() => os.tmpdir()),
  }
  return { deps, calls, binPath }
}

function makeNpmNetworkError(code: string): Error {
  const error = new Error(`Command failed: npm exec\nnpm error code ${code}`)
  Object.assign(error, {
    stderr: `npm error code ${code}\nnpm error network Invalid response body while trying to fetch https://registry.npmjs.org/ouro.bot: aborted\n`,
  })
  return error
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

  it("can verify the supported bootstrap package path at an exact version", () => {
    const { deps } = makeDeps([
      "/Users/me/.npm/_npx/hash/node_modules/.bin/ouro.bot\n",
      "installing @ouro.bot/cli@0.1.0-alpha.327...\n\n0.1.0-alpha.327\n",
    ])

    const result = runPublishedBinVersionSmoke({
      packageRef: "ouro.bot@0.1.0-alpha.327",
      binName: "ouro.bot",
      expectedVersion: "0.1.0-alpha.327",
    }, deps)

    expect(result.ok).toBe(true)
    expect(result.message).toContain("verified at 0.1.0-alpha.327")
    expect(deps.execFileSync).toHaveBeenCalledTimes(2)
  })

  it("retries transient npm registry failures during package binary smoke", () => {
    const { deps } = makeDeps([
      makeNpmNetworkError("ECONNRESET"),
      "/Users/me/.npm/_npx/hash/node_modules/.bin/ouro.bot\n",
      "installing @ouro.bot/cli@0.1.0-alpha.327...\n\n0.1.0-alpha.327\n",
    ])

    const result = runPublishedBinVersionSmoke({
      packageRef: "ouro.bot@0.1.0-alpha.327",
      binName: "ouro.bot",
      expectedVersion: "0.1.0-alpha.327",
    }, deps)

    expect(result.ok).toBe(true)
    expect(result.message).toContain("verified at 0.1.0-alpha.327")
    expect(deps.execFileSync).toHaveBeenCalledTimes(3)
    expect(deps.sleepSync).toHaveBeenCalledWith(5000)
  })

  it("smokes both supported published binaries", () => {
    const { deps } = makePublishedPackageDeps([
      "__BIN__\n",
      "__BIN__\n",
      "0.1.0-alpha.327\n",
      "/Users/me/.npm/_npx/hash/node_modules/.bin/ouro.bot\n",
      "installing @ouro.bot/cli@0.1.0-alpha.327...\n\n0.1.0-alpha.327\n",
    ], { withAssets: true })

    const results = runReleaseSmokeSuite("0.1.0-alpha.327", deps)

    expect(results.map((result: { ok: boolean }) => result.ok)).toEqual([true, true, true])
    expect(results[0].message).toContain("package assets verified")
  })

  it("reports published cli package asset failures", () => {
    const { deps } = makePublishedPackageDeps([
      "__BIN__\n",
      "__BIN__\n",
      "0.1.0-alpha.327\n",
      "/Users/me/.npm/_npx/hash/node_modules/.bin/ouro.bot\n",
      "installing @ouro.bot/cli@0.1.0-alpha.327...\n\n0.1.0-alpha.327\n",
    ], { withAssets: false })

    const results = runReleaseSmokeSuite("0.1.0-alpha.327", deps)

    expect(results).toHaveLength(3)
    expect(results[0].ok).toBe(false)
    expect(results[0].message).toContain("missing required package assets")
    expect(results[1].ok).toBe(true)
    expect(results[2].ok).toBe(true)
  })
})
