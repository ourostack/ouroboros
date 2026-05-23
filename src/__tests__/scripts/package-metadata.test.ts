import { describe, expect, it } from "vitest"
import * as path from "path"

const packageJson = require(path.resolve(__dirname, "../../../package.json"))

describe("package metadata", () => {
  it("ships the RepairGuide bundle in the npm package", () => {
    expect(packageJson.files).toContain("RepairGuide.ouro/")
  })

  it("uses the deterministic Mailbox UI copy helper during build", () => {
    expect(packageJson.scripts.build).toContain("node scripts/copy-mailbox-ui.cjs")
  })

  it("builds and verifies package assets before npm pack", () => {
    expect(packageJson.scripts["package:verify-assets"]).toBe("node scripts/package-assets.cjs")
    expect(packageJson.scripts.prepack).toContain("npm run build")
    expect(packageJson.scripts.prepack).toContain("npm run package:verify-assets")
  })
})
