import { afterEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const {
  copyOutlookUiDist,
} = require(path.resolve(__dirname, "../../../scripts/copy-outlook-ui-lib.cjs"))

const roots: string[] = []

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-copy-outlook-ui-test-"))
  roots.push(root)
  return root
}

function writeFile(root: string, relativePath: string, content = "ok"): void {
  const filePath = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe("copy-outlook-ui", () => {
  it("copies Outlook UI build output into a clean dist destination", () => {
    const repoRoot = makeRoot()
    writeFile(repoRoot, "packages/outlook-ui/dist/index.html", "<html></html>")
    writeFile(repoRoot, "packages/outlook-ui/dist/assets/index.js", "console.log('new')")
    writeFile(repoRoot, "dist/outlook-ui/dist/assets/old.js", "console.log('old')")

    copyOutlookUiDist(repoRoot)

    expect(fs.existsSync(path.join(repoRoot, "dist/outlook-ui/index.html"))).toBe(true)
    expect(fs.existsSync(path.join(repoRoot, "dist/outlook-ui/assets/index.js"))).toBe(true)
    expect(fs.existsSync(path.join(repoRoot, "dist/outlook-ui/dist/assets/old.js"))).toBe(false)
  })

  it("throws when the Outlook UI source dist does not exist", () => {
    const repoRoot = makeRoot()

    expect(() => copyOutlookUiDist(repoRoot)).toThrow("missing Outlook UI build output")
  })
})
