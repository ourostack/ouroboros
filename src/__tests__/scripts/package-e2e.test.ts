import { describe, expect, it, vi } from "vitest"
import * as path from "path"

const {
  buildLocalInstallArgs,
  runLocalTarballBinVersionSmoke,
  runPackageE2ESuite,
} = require(path.resolve(__dirname, "../../../scripts/package-e2e.cjs"))

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

  it("runs the current local package e2e suite", () => {
    const { deps } = makeDeps([
      "",
      "0.1.0-alpha.430\n",
    ])

    const results = runPackageE2ESuite({
      tarballPath: "/tmp/ouro-cli-0.1.0-alpha.430.tgz",
      version: "0.1.0-alpha.430",
    }, deps)

    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(true)
  })
})
