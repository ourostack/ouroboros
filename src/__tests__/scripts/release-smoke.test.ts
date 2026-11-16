import { describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const {
  buildNpmExecArgs,
  isNpmExecBinPath,
  lastNonEmptyLine,
  packPublishedTarball,
  PROPAGATION_BACKOFF_MS,
  runPublishedBinResolutionSmoke,
  runPublishedBinVersionSmoke,
  runReleaseSmokeSuite,
} = require(path.resolve(__dirname, "../../../scripts/release-smoke.cjs"))
const {
  REQUIRED_PACKAGE_ASSET_PATHS,
} = require(path.resolve(__dirname, "../../../scripts/package-assets.cjs"))

type ExecCall = {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv | undefined
}

function makeDeps(outputs: Array<string | Error>) {
  const calls: ExecCall[] = []
  const deps = {
    env: { RELEASE_SMOKE_SENTINEL: "preserved" },
    execFileSync: vi.fn((command: string, args: string[], options: {
      cwd: string
      env?: NodeJS.ProcessEnv
    }) => {
      calls.push({ command, args, cwd: options.cwd, env: options.env })
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

function makePublishedPackageDeps(
  outputs: Array<string | Error>,
  options: { withAssets: boolean; env?: NodeJS.ProcessEnv },
) {
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

  const calls: ExecCall[] = []
  const deps = {
    env: options.env ?? { RELEASE_SMOKE_SENTINEL: "preserved" },
    execFileSync: vi.fn((command: string, args: string[], execOptions: {
      cwd: string
      env?: NodeJS.ProcessEnv
    }) => {
      calls.push({ command, args, cwd: execOptions.cwd, env: execOptions.env })
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
  return { deps, calls, binPath, prefixDir }
}

function makeNpmNetworkError(code: string): Error {
  const error = new Error(`Command failed: npm exec\nnpm error code ${code}`)
  Object.assign(error, {
    stderr: `npm error code ${code}\nnpm error network Invalid response body while trying to fetch https://registry.npmjs.org/ouro.bot: aborted\n`,
  })
  return error
}

// Mirrors the exact error npm gave for 0.1.0-alpha.1151 while it still listed the version but 404'd its tarball.
function makeNpm404(url: string): Error {
  const error = new Error(`Command failed: npm exec\nnpm error code E404\nnpm error 404 Not Found - GET ${url} - Not found`)
  Object.assign(error, { stderr: `npm error code E404\nnpm error 404 Not Found - GET ${url} - Not found\nnpm error 404\n` })
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

  it("retries a registry propagation miss (ETARGET) with a bounded backoff, then gives up", () => {
    const etarget = () => Object.assign(new Error("npm error code ETARGET\nnpm error notarget No matching version found for ouro.bot@0.1.0-alpha.880"), {})
    const { deps } = makeDeps([etarget(), etarget(), "/Users/me/.npm/_npx/hash/node_modules/.bin/ouro.bot\n", "installing @ouro.bot/cli@0.1.0-alpha.327...\n\n0.1.0-alpha.327\n"])
    const result = runPublishedBinVersionSmoke({ packageRef: "ouro.bot@0.1.0-alpha.327", binName: "ouro.bot", expectedVersion: "0.1.0-alpha.327" }, deps)
    expect(result.ok).toBe(true)
    expect(deps.sleepSync).toHaveBeenNthCalledWith(1, 10000)
    expect(deps.sleepSync).toHaveBeenNthCalledWith(2, 20000)
    const never = makeDeps(Array.from({ length: PROPAGATION_BACKOFF_MS.length + 2 }, etarget))
    expect(() => runPublishedBinVersionSmoke({ packageRef: "ouro.bot@0.1.0-alpha.327", binName: "ouro.bot", expectedVersion: "0.1.0-alpha.327" }, never.deps)).toThrow(/ETARGET/)
    expect(never.deps.execFileSync).toHaveBeenCalledTimes(PROPAGATION_BACKOFF_MS.length + 1)
    expect(never.deps.sleepSync).toHaveBeenCalledTimes(PROPAGATION_BACKOFF_MS.length)
  })

  it("waits out npm 404ing the exact tarball it just published, for up to about twenty minutes", () => {
    const unserved = () => makeNpm404("https://registry.npmjs.org/@ouro.bot/cli/-/cli-0.1.0-alpha.1151.tgz")
    const { deps } = makeDeps([unserved(), unserved(), unserved(), "/Users/me/.npm/_npx/hash/node_modules/.bin/ouro\n", "0.1.0-alpha.1151\n"])
    const result = runPublishedBinVersionSmoke({ packageName: "@ouro.bot/cli", binName: "ouro", version: "0.1.0-alpha.1151" }, deps)
    expect(result.ok).toBe(true)
    expect(deps.sleepSync).toHaveBeenCalledTimes(3)
    const budgetMs = PROPAGATION_BACKOFF_MS.reduce((sum: number, ms: number) => sum + ms, 0)
    expect(budgetMs).toBeGreaterThanOrEqual(20 * 60 * 1000)
    expect(budgetMs).toBeLessThanOrEqual(25 * 60 * 1000)

    const wrapper = makeDeps([makeNpm404("https://registry.npmjs.org/ouro.bot/-/ouro.bot-0.1.0-alpha.1151.tgz"), "/x/node_modules/.bin/ouro.bot\n", "0.1.0-alpha.1151\n"])
    expect(runPublishedBinVersionSmoke({ packageRef: "ouro.bot@0.1.0-alpha.1151", binName: "ouro.bot", expectedVersion: "0.1.0-alpha.1151" }, wrapper.deps).ok).toBe(true)
    expect(wrapper.deps.sleepSync).toHaveBeenCalledTimes(1)
  })

  it("fails at once on a 404 that is not the exact tarball being smoked", () => {
    for (const url of [
      "https://registry.npmjs.org/@ouro.bot/cli/-/cli-0.1.0-alpha.1150.tgz",
      "https://registry.npmjs.org/@ouro.bot/cli/-/cli-0.1.0-alpha.11510.tgz",
      "https://registry.npmjs.org/@ouro.bot/other/-/other-0.1.0-alpha.1151.tgz",
      "https://registry.npmjs.org/@ouro.bot%2fcli",
    ]) {
      const { deps } = makeDeps([makeNpm404(url), "/x/node_modules/.bin/ouro\n", "0.1.0-alpha.1151\n"])
      expect(() => runPublishedBinVersionSmoke({ packageName: "@ouro.bot/cli", binName: "ouro", version: "0.1.0-alpha.1151" }, deps)).toThrow(/E404/)
      expect(deps.sleepSync).not.toHaveBeenCalled()
    }
  })

  it("packs the exact published tarball once npm serves it", () => {
    const destination = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-release-pack-test-"))
    try {
      const { deps, calls } = makeDeps([makeNpm404("https://registry.npmjs.org/@ouro.bot/cli/-/cli-0.1.0-alpha.1151.tgz"), "ouro.bot-cli-0.1.0-alpha.1151.tgz\n"])
      const packDeps = {
        ...deps,
        existsSync: fs.existsSync,
        mkdirSync: fs.mkdirSync,
        execFileSync: vi.fn((command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) => {
          const output = deps.execFileSync(command, args, options)
          fs.writeFileSync(path.join(destination, "ouro.bot-cli-0.1.0-alpha.1151.tgz"), "tarball")
          return output
        }),
      }
      expect(packPublishedTarball({ packageRef: "@ouro.bot/cli@0.1.0-alpha.1151", destination }, packDeps))
        .toBe(path.join(destination, "ouro.bot-cli-0.1.0-alpha.1151.tgz"))
      expect(calls.map((call) => call.args)).toEqual([
        ["pack", "@ouro.bot/cli@0.1.0-alpha.1151", "--pack-destination", destination],
        ["pack", "@ouro.bot/cli@0.1.0-alpha.1151", "--pack-destination", destination],
      ])
      expect(deps.sleepSync).toHaveBeenCalledTimes(1)

      const missing = makeDeps(["ouro.bot-cli-0.1.0-alpha.1152.tgz\n"])
      expect(() => packPublishedTarball({ packageRef: "@ouro.bot/cli@0.1.0-alpha.1152", destination }, { ...missing.deps, existsSync: fs.existsSync, mkdirSync: fs.mkdirSync }))
        .toThrow(/did not write .*ouro\.bot-cli-0\.1\.0-alpha\.1152\.tgz/)
    } finally {
      fs.rmSync(destination, { recursive: true, force: true })
    }
  })

  it("isolates every asset, resolution, version, and retry child from the operator home", () => {
    const childEnv = {
      HOME: "/real/operator/home",
      USERPROFILE: "C:\\real\\operator\\home",
      PATH: "/sentinel/bin",
      RELEASE_SMOKE_SENTINEL: "preserved",
    }
    const processEnvBefore = { ...process.env }
    const { deps, calls, prefixDir } = makePublishedPackageDeps([
      makeNpmNetworkError("ECONNRESET"),
      "__BIN__\n",
      "__BIN__\n",
      "0.1.0-alpha.327\n",
      "/Users/me/.npm/_npx/hash/node_modules/.bin/ouro.bot\n",
      "installing @ouro.bot/cli@0.1.0-alpha.327...\n\n0.1.0-alpha.327\n",
    ], { withAssets: true, env: childEnv })

    const results = runReleaseSmokeSuite("0.1.0-alpha.327", deps)

    expect(results.map((result: { ok: boolean }) => result.ok)).toEqual([true, true, true])
    expect(calls).toHaveLength(6)
    expect(calls.map((call) => call.args.slice(call.args.indexOf("--") + 1))).toEqual([
      ["which", "ouro"],
      ["which", "ouro"],
      ["which", "ouro"],
      ["ouro", "--version"],
      ["which", "ouro.bot"],
      ["ouro.bot", "--version"],
    ])
    for (const call of calls) {
      expect(call.env).toEqual({
        ...childEnv,
        HOME: prefixDir,
        USERPROFILE: prefixDir,
      })
    }
    expect(new Set(calls.map((call) => call.env)).size).toBe(calls.length)
    expect(deps.env).toEqual(childEnv)
    expect(process.env).toEqual(processEnvBefore)
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
