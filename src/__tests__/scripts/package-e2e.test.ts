import { describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { a003Pair } from "../fixtures/a003-session"

const {
  buildLocalInstallArgs,
  localSmokeEnv,
  runLocalTarballCommandSmoke,
  runLocalTarballBinVersionSmoke,
  runLocalTarballSemanticOwnershipSmoke,
  runLocalTarballBlueBubblesHostSmoke,
  runLocalTarballAssetSmoke,
  runPackageE2ESuite,
} = require(path.resolve(__dirname, "../../../scripts/package-e2e.cjs"))
const {
  REQUIRED_PACKAGE_ASSET_PATHS,
} = require(path.resolve(__dirname, "../../../scripts/package-assets.cjs"))

function makeDeps(outputs: Array<string | Error>) {
  const calls: Array<{ command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }> = []
  const deps = {
    execFileSync: vi.fn((command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, cwd: options.cwd, env: options.env })
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
  const calls: Array<{ command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }> = []
  const deps = {
    execFileSync: vi.fn((command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) => {
      calls.push({ command, args, cwd: options.cwd, env: options.env })
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
    env: { HOME: "/Users/real-human", USERPROFILE: "/Users/real-human" },
  }
  return { deps, calls, prefixDir }
}

describe("package-e2e", () => {
  it("A003 boots the exact P0 pre-marker parser against a marker envelope without rewriting bytes", async () => {
    const { execFileSync } = await import("node:child_process")
    const { runInNewContext } = await import("node:vm")
    const ts = await import("typescript")
    const source = execFileSync("git", ["show", "406fa8c4c7242577a445b439ddc6344ef470462a:src/heart/session-events.ts"], { cwd: path.resolve(__dirname, "../../.."), encoding: "utf8" })
    const dependencies: Record<string, unknown> = {
      fs,
      "node:crypto": await import("node:crypto"),
      "../nerves/runtime": { emitNervesEvent: vi.fn() },
      "./structured-output": await import("../../heart/structured-output"),
    }
    const old: Record<string, any> = {}
    runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
      exports: old, require: (name: string) => { if (!(name in dependencies)) throw new Error(`unapproved old-parser dependency ${name}`); return dependencies[name] }, Buffer,
    })
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "a003-pre-marker-boot-"))
    const file = path.join(root, "session.json")
    const { envelope } = a003Pair()
    const bytes = JSON.stringify(envelope, null, 2)
    fs.writeFileSync(file, bytes)
    try {
      const loaded = old.loadSessionEnvelopeFile(file)
      expect(loaded.version).toBe(2)
      expect(loaded.events).toEqual(envelope.events)
      expect(fs.readFileSync(file, "utf8")).toBe(bytes)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it.each(["a003 private repair routing verified", "wrong marker"])("A003 asset E2E executes private and public installed-entrypoint routing: %s", (marker) => {
    const { deps, calls } = makePackageInstallDeps(["", "0.1.0-alpha.430\n", "", "Set up providers, portable integrations, and local senses from one guided screen\n", "", "semantic ownership sqlite verified\n", "", "bluebubbles host helper verified\n", "", marker])
    const results = runPackageE2ESuite({ tarballPath: "/tmp/a003.tgz", version: "0.1.0-alpha.430" }, deps)
    expect(results[4].ok).toBe(marker.startsWith("a003"))
    const smoke = calls.find((call) => call.args.some((arg) => arg.includes("session-redaction-repair-cli-main.js")))
    expect(smoke).toBeDefined()
    expect(smoke?.args.join("\n")).toContain("spawnSync")
    expect(smoke?.args.join("\n")).toContain("ouro-entry.js")
    expect(smoke?.env?.HOME).not.toBe("/Users/real-human")
  })
  it("A003 requires the direct repair module in the installed tarball asset inventory", () => {
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("dist/heart/session-redaction-repair-cli-main.js")
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "a003-package-inventory-"))
    try {
      writeRequiredPackageAssets(root)
      expect(fs.statSync(path.join(root, "dist/heart/session-redaction-repair-cli-main.js")).isFile()).toBe(true)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
  it("A003 refuses an installed package missing the compiled private entrypoint even when its source is present", () => {
    const { deps, calls, prefixDir } = makePackageInstallDeps(["", "a003 private repair routing verified\n"])
    const install = deps.execFileSync.getMockImplementation()!
    deps.execFileSync.mockImplementation((command, args, options) => {
      const output = install(command, args, options)
      if (command === "npm" && args[0] === "install") {
        const packageRoot = path.join(prefixDir, "node_modules", "@ouro.bot", "cli")
        fs.unlinkSync(path.join(packageRoot, "dist/heart/session-redaction-repair-cli-main.js"))
        const source = path.join(packageRoot, "src/heart/session-redaction-repair-cli-main.ts")
        fs.mkdirSync(path.dirname(source), { recursive: true })
        fs.writeFileSync(source, "export {}")
      }
      return output
    })
    const result = runLocalTarballAssetSmoke({ tarballPath: "/tmp/a003.tgz", binName: "ouro" }, deps)
    expect(result).toMatchObject({
      ok: false,
      message: "missing required package assets: dist/heart/session-redaction-repair-cli-main.js",
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe("npm")
    expect(fs.existsSync(prefixDir)).toBe(false)
  })
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

  it("builds an isolated HOME for installed-binary smoke commands", () => {
    const env = localSmokeEnv("/tmp/ouro-package-e2e-abcd", {
      HOME: "/Users/real-human",
      USERPROFILE: "/Users/real-human",
      PATH: "/usr/bin",
    })

    expect(env.HOME).toBe("/tmp/ouro-package-e2e-abcd/home")
    expect(env.USERPROFILE).toBe("/tmp/ouro-package-e2e-abcd/home")
    expect(env.PATH).toBe("/usr/bin")
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
    expect(calls[1].env?.HOME).toBe("/tmp/ouro-package-e2e-abcd/home")
    expect(calls[1].env?.USERPROFILE).toBe("/tmp/ouro-package-e2e-abcd/home")
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
    expect(calls[1].env?.HOME).toBe("/tmp/ouro-package-e2e-abcd/home")
  })

  it("opens and releases the SQLite ownership coordinator from the installed tarball", () => {
    const { deps, calls } = makeDeps([
      "",
      "semantic ownership sqlite verified\n",
    ])

    const result = runLocalTarballSemanticOwnershipSmoke({
      tarballPath: "/tmp/ouro-cli-0.1.0-alpha.430.tgz",
      binName: "ouro",
    }, deps)

    expect(result.ok).toBe(true)
    expect(result.message).toContain("semantic ownership SQLite")
    expect(calls[1]).toMatchObject({
      command: process.execPath,
      cwd: "/tmp/ouro-package-e2e-abcd",
    })
    expect(calls[1].args[0]).toBe("-e")
    expect(calls[1].env?.HOME).toBe("/tmp/ouro-package-e2e-abcd/home")
  })

  it("installs byte-identical executable BlueBubbles host helper from the installed tarball", () => {
    const { deps, calls } = makeDeps([
      "",
      "bluebubbles host helper verified\n",
    ])

    const result = runLocalTarballBlueBubblesHostSmoke({
      tarballPath: "/tmp/ouro-cli-0.1.0-alpha.430.tgz",
      binName: "ouro",
    }, deps)

    expect(result.ok).toBe(true)
    expect(result.message).toContain("BlueBubbles host helper")
    expect(calls[1]).toMatchObject({ command: process.execPath, cwd: "/tmp/ouro-package-e2e-abcd" })
    expect(calls[1].args.join(" ")).toContain("bluebubbles-host-protocol.js")
    expect(calls[1].args.join(" ")).toContain("assets/bluebubbles-host")
  })

  it("runs the current local package e2e suite", () => {
    const { deps } = makePackageInstallDeps([
      "",
      "0.1.0-alpha.430\n",
      "",
      "Set up providers, portable integrations, and local senses from one guided screen\n",
      "",
      "semantic ownership sqlite verified\n",
      "",
      "bluebubbles host helper verified\n",
      "",
      "a003 private repair routing verified\n",
    ])

    const results = runPackageE2ESuite({
      tarballPath: "/tmp/ouro-cli-0.1.0-alpha.430.tgz",
      version: "0.1.0-alpha.430",
    }, deps)

    expect(results).toHaveLength(5)
    expect(results.map((result: { ok: boolean }) => result.ok)).toEqual([true, true, true, true, true])
    expect(results[2].message).toContain("semantic ownership SQLite")
    expect(results[3].message).toContain("BlueBubbles host helper")
    expect(results[4].message).toContain("package assets verified")
  })

  it("reports package asset failures from the local package e2e suite", () => {
    const { deps } = makeDeps([
      "",
      "0.1.0-alpha.430\n",
      "",
      "Set up providers, portable integrations, and local senses from one guided screen\n",
      "",
      "semantic ownership sqlite verified\n",
      "",
      "bluebubbles host helper verified\n",
      "",
    ])

    const results = runPackageE2ESuite({
      tarballPath: "/tmp/ouro-cli-0.1.0-alpha.430.tgz",
      version: "0.1.0-alpha.430",
    }, deps)

    expect(results).toHaveLength(5)
    expect(results[4].ok).toBe(false)
    expect(results[4].message).toContain("missing required package assets")
  })
})
