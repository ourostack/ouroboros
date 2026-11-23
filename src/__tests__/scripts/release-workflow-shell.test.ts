import * as fs from "fs"
import * as path from "path"

import { describe, expect, it } from "vitest"

const repoRoot = path.resolve(__dirname, "../../..")

// GitHub's default shell is `bash -e {0}`, without pipefail, so `cmd | tee log` passes whatever cmd did. In the
// release workflows that hid a failing release preflight for every pull request (run 45088040046).
describe("release workflow shells", () => {
  for (const workflow of [".github/workflows/coverage.yml", ".github/workflows/container-publish.yml"]) {
    it(`${workflow} runs every step under pipefail`, () => {
      const text = fs.readFileSync(path.join(repoRoot, workflow), "utf8")
      expect(text).toMatch(/^defaults:\n {2}run:\n {4}shell: bash\n/mu)
      const overrides = [...text.matchAll(/^\s+shell: (.+)$/gmu)].map((match) => match[1].trim()).filter((shell) => shell !== "bash")
      expect(overrides).toEqual([])
    })
  }
})
