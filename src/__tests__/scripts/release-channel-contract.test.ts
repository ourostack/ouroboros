import * as fs from "fs"
import * as path from "path"

import { describe, expect, it } from "vitest"

const repoRoot = path.resolve(__dirname, "../../..")

const supportedClientSurfaces = [
  "README.md",
  "docs/cross-machine-setup.md",
  "docs/testing-guide.md",
  "docs/versioning-strategy.md",
  "packages/ouro.bot/index.js",
  "scripts/teams-sense/deploy-azure.sh",
  "scripts/teams-sense/startup.sh",
]

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8")
}

describe("release channel contract", () => {
  it("keeps supported client install surfaces on latest instead of the legacy alpha tag", () => {
    for (const relativePath of supportedClientSurfaces) {
      const content = readRepoFile(relativePath)
      expect(
        content,
        `${relativePath} must not teach supported clients to consume the stale-prone alpha tag`,
      ).not.toMatch(/(?:@ouro\.bot\/cli|ouro\.bot)@alpha\b/)
    }
  })

  it("documents the selected-tag trusted-publishing contract", () => {
    const docs = readRepoFile("docs/versioning-strategy.md")

    expect(docs).toContain("`latest` is the supported npm dist-tag channel")
    expect(docs).toContain("The legacy `alpha` dist-tag may exist on npm for historical packages")
    expect(docs).toMatch(/The trusted-publishing workflow advances one selected consumption tag per\s+package/)
  })
})
