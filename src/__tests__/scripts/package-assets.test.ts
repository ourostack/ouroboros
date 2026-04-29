import { afterEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const {
  REQUIRED_PACKAGE_ASSET_PATHS,
  DISALLOWED_PACKAGE_ASSET_PATH_PREFIXES,
  listPackageFiles,
  packageRootFromBinPath,
  validatePackageAssets,
} = require(path.resolve(__dirname, "../../../scripts/package-assets.cjs"))

const roots: string[] = []

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-package-assets-test-"))
  roots.push(root)
  return root
}

function writeFile(root: string, relativePath: string, content = "ok"): void {
  const filePath = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

function writeRequiredAssets(root: string): void {
  for (const relativePath of REQUIRED_PACKAGE_ASSET_PATHS) {
    writeFile(root, relativePath)
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe("package asset validation", () => {
  it("declares RepairGuide files as required package assets", () => {
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("RepairGuide.ouro/agent.json")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("RepairGuide.ouro/psyche/IDENTITY.md")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("RepairGuide.ouro/psyche/SOUL.md")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("RepairGuide.ouro/skills/diagnose-bootstrap-drift.md")
    expect(REQUIRED_PACKAGE_ASSET_PATHS).toContain("RepairGuide.ouro/skills/diagnose-vault-expired.md")
  })

  it("declares stale nested Mailbox UI dist as disallowed", () => {
    expect(DISALLOWED_PACKAGE_ASSET_PATH_PREFIXES).toContain("dist/mailbox-ui/dist/")
    expect(DISALLOWED_PACKAGE_ASSET_PATH_PREFIXES).toContain("dist/outlook-ui/")
  })

  it("passes when required assets are present and no stale paths exist", () => {
    const root = makeRoot()
    writeRequiredAssets(root)
    writeFile(root, "dist/mailbox-ui/index.html")
    writeFile(root, "dist/mailbox-ui/assets/index.js")

    const result = validatePackageAssets(root)

    expect(result).toEqual({
      ok: true,
      packageRoot: root,
      missing: [],
      disallowed: [],
      message: "package assets verified",
    })
  })

  it("lists package files recursively and ignores non-file entries", () => {
    const root = makeRoot()
    writeFile(root, "b/file.txt")
    writeFile(root, "a/file.txt")
    fs.symlinkSync(path.join(root, "a", "file.txt"), path.join(root, "linked-file.txt"))

    expect(listPackageFiles(root)).toEqual([
      "a/file.txt",
      "b/file.txt",
    ])
  })

  it("treats a missing package root as missing all required package assets", () => {
    const root = path.join(makeRoot(), "missing-root")

    const result = validatePackageAssets(root)

    expect(result.ok).toBe(false)
    expect(result.missing).toEqual([...REQUIRED_PACKAGE_ASSET_PATHS].sort())
    expect(result.disallowed).toEqual([])
  })

  it("fails with clear missing-path messages when required assets are absent", () => {
    const root = makeRoot()
    writeFile(root, "RepairGuide.ouro/agent.json")

    const result = validatePackageAssets(root)

    expect(result.ok).toBe(false)
    expect(result.missing).toContain("RepairGuide.ouro/psyche/IDENTITY.md")
    expect(result.message).toContain("missing required package assets")
    expect(result.message).toContain("RepairGuide.ouro/psyche/IDENTITY.md")
  })

  it("fails with clear disallowed-path messages when stale Mailbox UI output is present", () => {
    const root = makeRoot()
    writeRequiredAssets(root)
    writeFile(root, "dist/mailbox-ui/dist/index.html")
    writeFile(root, "dist/mailbox-ui/dist/assets/old.js")

    const result = validatePackageAssets(root)

    expect(result.ok).toBe(false)
    expect(result.disallowed).toEqual([
      "dist/mailbox-ui/dist/assets/old.js",
      "dist/mailbox-ui/dist/index.html",
    ])
    expect(result.message).toContain("disallowed package assets")
    expect(result.message).toContain("dist/mailbox-ui/dist/index.html")
  })

  it("fails when legacy Outlook UI output remains in the package", () => {
    const root = makeRoot()
    writeRequiredAssets(root)
    writeFile(root, "dist/outlook-ui/index.html")

    const result = validatePackageAssets(root)

    expect(result.ok).toBe(false)
    expect(result.disallowed).toEqual(["dist/outlook-ui/index.html"])
    expect(result.message).toContain("dist/outlook-ui/index.html")
  })

  it("derives the package root from a symlinked npm .bin path", () => {
    const root = makeRoot()
    const packageRoot = path.join(root, "node_modules", "@ouro.bot", "cli")
    const binDir = path.join(root, "node_modules", ".bin")
    const entry = path.join(packageRoot, "dist", "heart", "daemon", "ouro-entry.js")
    const bin = path.join(binDir, "ouro")
    fs.mkdirSync(path.dirname(entry), { recursive: true })
    fs.mkdirSync(binDir, { recursive: true })
    writeFile(packageRoot, "package.json", JSON.stringify({ name: "@ouro.bot/cli" }))
    fs.writeFileSync(entry, "#!/usr/bin/env node\n")
    fs.symlinkSync(entry, bin)

    expect(packageRootFromBinPath(bin, "@ouro.bot/cli")).toBe(packageRoot)
  })

  it("derives the scoped package root from a plain npm .bin shim path", () => {
    const root = makeRoot()
    const packageRoot = path.join(root, "node_modules", "@ouro.bot", "cli")
    const bin = path.join(root, "node_modules", ".bin", "ouro")
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    writeFile(packageRoot, "package.json", JSON.stringify({ name: "@ouro.bot/cli" }))
    fs.writeFileSync(bin, "#!/usr/bin/env node\n")

    expect(packageRootFromBinPath(bin, "@ouro.bot/cli")).toBe(packageRoot)
  })

  it("derives the package root from realpath when the bin path is outside node_modules", () => {
    const root = makeRoot()
    const packageRoot = path.join(root, "actual-package")
    const entry = path.join(packageRoot, "dist", "heart", "daemon", "ouro-entry.js")
    const bin = path.join(root, "bin", "ouro")
    fs.mkdirSync(path.dirname(entry), { recursive: true })
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    writeFile(packageRoot, "package.json", JSON.stringify({ name: "@ouro.bot/cli" }))
    fs.writeFileSync(entry, "#!/usr/bin/env node\n")
    fs.symlinkSync(entry, bin)

    expect(packageRootFromBinPath(bin, "@ouro.bot/cli")).toBe(fs.realpathSync(packageRoot))
  })

  it("throws clearly when a package root cannot be derived from the bin path", () => {
    const root = makeRoot()
    const bin = path.join(root, "node_modules", ".bin", "ouro")
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(bin, "#!/usr/bin/env node\n")

    expect(() => packageRootFromBinPath(bin, "@ouro.bot/cli")).toThrow(
      `could not derive @ouro.bot/cli package root from ${bin}`,
    )
  })

  it("keeps searching when a nearby package.json belongs to a different package", () => {
    const root = makeRoot()
    const packageRoot = path.join(root, "node_modules", "@ouro.bot", "cli")
    const bin = path.join(root, "node_modules", ".bin", "ouro")
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    writeFile(packageRoot, "package.json", JSON.stringify({ name: "not-ouro" }))
    fs.writeFileSync(bin, "#!/usr/bin/env node\n")

    expect(() => packageRootFromBinPath(bin, "@ouro.bot/cli")).toThrow(
      `could not derive @ouro.bot/cli package root from ${bin}`,
    )
  })

  it("rejects malformed package.json files while deriving package roots", () => {
    const root = makeRoot()
    const packageRoot = path.join(root, "node_modules", "@ouro.bot", "cli")
    const bin = path.join(root, "node_modules", ".bin", "ouro")
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    writeFile(packageRoot, "package.json", "{")
    fs.writeFileSync(bin, "#!/usr/bin/env node\n")

    expect(() => packageRootFromBinPath(bin, "@ouro.bot/cli")).toThrow(
      `could not derive @ouro.bot/cli package root from ${bin}`,
    )
  })

  it("throws clearly when the bin path and fallback package path do not exist", () => {
    const root = makeRoot()
    const bin = path.join(root, "missing", ".bin", "ouro")

    expect(() => packageRootFromBinPath(bin, "@ouro.bot/cli")).toThrow(
      `could not derive @ouro.bot/cli package root from ${bin}`,
    )
  })

  it("stops package root derivation at the filesystem root", () => {
    expect(() => packageRootFromBinPath(path.parse(process.cwd()).root, "@ouro.bot/cli")).toThrow(
      "could not derive @ouro.bot/cli package root",
    )
  })
})
