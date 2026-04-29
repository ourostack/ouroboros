import { describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const {
  buildLocalInstallArgs,
  runLocalTarballCommandSmoke,
  runLocalTarballBinVersionSmoke,
  runPackageE2ESuite,
} = require(path.resolve(__dirname, "../../../scripts/package-e2e.cjs"))
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
    mkdtempSync: vi.fn(() => "/tmp/ouro-package-e2e-abcd"),
    rmSync: vi.fn(),
    tmpdir: vi.fn(() => "/tmp"),
  }
  return { deps, calls }
}

function writeRequiredPackageAssets(packageRoot: string): void {
  for (const relativePath of REQUIRED_PACKAGE_ASSET_PATHS) {
    const filePath = path.join(packageRoot, relativePath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, "ok")
  }
}

function makePackageInstallDeps(outputs: Array<string | Error>) {
  const prefixDir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-package-e2e-test-"))
  const calls: Array<{ command: string; args: string[]; cwd: string }> = []
  const deps = {
    execFileSync: vi.fn((command: string, args: string[], options: { cwd: string }) => {
      calls.push({ command, args, cwd: options.cwd })
      if (command === "npm" && args[0] === "install") {
        writeRequiredPackageAssets(path.join(prefixDir, "node_modules", "@ouro.bot", "cli"))
      }
      const next = outputs.shift()
      if (next instanceof Error) throw next
      return next
    }),
    mkdtempSync: vi.fn(() => prefixDir),
    rmSync: vi.fn((target: string, options: fs.RmOptions) => fs.rmSync(target, options)),
    tmpdir: vi.fn(() => os.tmpdir()),
    platform: process.platform,
  }
  return { deps, calls, prefixDir }
}

describe("package-e2e", () => {
  it("builds npm install args for an isolated prefix and local tarball", () => {
    expect(
      buildLocalInstallArgs("/tmp/ouro-package-e2e-abcd", "/tmp/ouro-cli-0.1.0.tgz"),
    ).toEqual([
      "install",
      "--prefix",
      "/tmp/ouro-package-e2e-abcd",
      "/tmp/ouro-cli-0.1.0.tgz",
    ])
  })

  it("verifies a local tarball-installed ouro binary from an isolated prefix", () => {
    const { deps, calls } = makeDeps([
      "",
      "0.1.0-alpha.430\n",
    ])

    const result = runLocalTarballBinVersionSmoke({
      tarballPath: "/tmp/ouro-cli-0.1.0-alpha.430.tgz",
      binName: "ouro",
      version: "0.1.0-alpha.430",
    }, deps)

    expect(result.ok).toBe(true)
    expect(result.message).toContain("verified")
    expect(calls[0]).toMatchObject({ command: "npm", cwd: "/tmp/ouro-package-e2e-abcd" })
    expect(calls[1]).toMatchObject({
      command: path.join("/tmp/ouro-package-e2e-abcd", "node_modules", ".bin", "ouro"),
      cwd: "/tmp/ouro-package-e2e-abcd",
    })
    expect(deps.rmSync).toHaveBeenCalledWith("/tmp/ouro-package-e2e-abcd", { recursive: true, force: true })
  })

  it("fails when the installed ouro binary reports the wrong version", () => {
    const { deps } = makeDeps([
      "",
      "0.1.0-alpha.429\n",
    ])

    const result = runLocalTarballBinVersionSmoke({
      tarballPath: "/tmp/ouro-cli-0.1.0-alpha.430.tgz",
      binName: "ouro",
      version: "0.1.0-alpha.430",
    }, deps)

    expect(result.ok).toBe(false)
    expect(result.message).toContain("reported 0.1.0-alpha.429")
  })

  it("can smoke installed help output from the local tarball", () => {
    const { deps, calls } = makeDeps([
      "",
      "Set up providers, portable integrations, and local senses from one guided screen\n",
    ])

    const result = runLocalTarballCommandSmoke({
      tarballPath: "/tmp/ouro-cli-0.1.0-alpha.430.tgz",
      binName: "ouro",
      args: ["help"],
      expectOutput: "Set up providers, portable integrations, and local senses from one guided screen",
    }, deps)

    expect(result.ok).toBe(true)
    expect(calls[1]).toMatchObject({
      command: path.join("/tmp/ouro-package-e2e-abcd", "node_modules", ".bin", "ouro"),
      args: ["help"],
    })
  })

  it("runs the current local package e2e suite", () => {
    const { deps } = makePackageInstallDeps([
      "",
      "0.1.0-alpha.430\n",
      "",
      "Set up providers, portable integrations, and local senses from one guided screen\n",
      "",
    ])

    const results = runPackageE2ESuite({
      tarballPath: "/tmp/ouro-cli-0.1.0-alpha.430.tgz",
      version: "0.1.0-alpha.430",
    }, deps)

    expect(results).toHaveLength(3)
    expect(results.map((result: { ok: boolean }) => result.ok)).toEqual([true, true, true])
    expect(results[2].message).toContain("package assets verified")
  })

  it("reports package asset failures from the local package e2e suite", () => {
    const { deps } = makeDeps([
      "",
      "0.1.0-alpha.430\n",
      "",
      "Set up providers, portable integrations, and local senses from one guided screen\n",
      "",
    ])

    const results = runPackageE2ESuite({
      tarballPath: "/tmp/ouro-cli-0.1.0-alpha.430.tgz",
      version: "0.1.0-alpha.430",
    }, deps)

    expect(results).toHaveLength(3)
    expect(results[2].ok).toBe(false)
    expect(results[2].message).toContain("missing required package assets")
  })
})
