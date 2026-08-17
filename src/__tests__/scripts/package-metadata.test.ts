import { describe, expect, it } from "vitest"
import * as fs from "fs"
import * as path from "path"

const packageJson = require(path.resolve(__dirname, "../../../package.json"))
const wrapperPackageJson = require(path.resolve(__dirname, "../../../packages/ouro.bot/package.json"))
const {
  PACKAGE_PAYLOAD_PATH_PREFIXES,
} = require(path.resolve(__dirname, "../../../scripts/package-assets.cjs"))

describe("package metadata", () => {
  it("declares the same Node runtime floor on the CLI and public wrapper", () => {
    expect(wrapperPackageJson.engines?.node).toBe(packageJson.engines.node)
  })

  it("ships the RepairGuide bundle in the npm package", () => {
    expect(packageJson.files).toContain("RepairGuide.ouro/")
  })

  it("uses the deterministic build helper without a skip fallback", () => {
    expect(packageJson.scripts.build).toBe("node scripts/build.cjs")
    expect(packageJson.scripts.build).not.toContain("||")
    expect(packageJson.scripts.build).not.toContain("build skipped")
  })

  it("builds and verifies package assets before npm pack", () => {
    expect(packageJson.scripts["package:verify-assets"]).toBe("node scripts/package-assets.cjs")
    expect(packageJson.scripts.prepack).toContain("npm run build")
    expect(packageJson.scripts.prepack).toContain("npm run package:verify-assets")
  })

  it("keeps package asset verification aligned with npm package files", () => {
    expect([...packageJson.files].sort()).toEqual([
      ...PACKAGE_PAYLOAD_PATH_PREFIXES,
      "changelog.json",
    ].sort())
  })

  it("gates publish on both packed artifact E2E suites", () => {
    expect(packageJson.scripts["test:e2e:ouro-bot-package"]).toBe("node scripts/ouro-bot-package-e2e.cjs")
    const workflow = fs.readFileSync(path.resolve(__dirname, "../../../.github/workflows/coverage.yml"), "utf8")
    const packageJob = workflow.slice(workflow.indexOf("  package-e2e:"), workflow.indexOf("  publish:"))
    expect(packageJob).toContain("npm run test:e2e:package")
    expect(packageJob).toContain("npm run test:e2e:ouro-bot-package")
  })

  it("pins mailparser to the last release before its vulnerable html conversion chain", () => {
    expect(packageJson.dependencies.mailparser).toBe("3.9.8")
  })
})
