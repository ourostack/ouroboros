import { afterEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const {
  copyMailboxUiDist,
} = require(path.resolve(__dirname, "../../../scripts/copy-mailbox-ui-lib.cjs"))

const roots: string[] = []

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-copy-mailbox-ui-test-"))
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

describe("copy-mailbox-ui", () => {
  it("copies Mailbox UI build output into a clean dist destination", () => {
    const repoRoot = makeRoot()
    writeFile(repoRoot, "packages/mailbox-ui/dist/index.html", "<html></html>")
    writeFile(repoRoot, "packages/mailbox-ui/dist/assets/index.js", "console.log('new')")
    writeFile(repoRoot, "dist/mailbox-ui/dist/assets/old.js", "console.log('old')")
    writeFile(repoRoot, "dist/outlook-ui/index.html", "<html></html>")

    copyMailboxUiDist(repoRoot)

    expect(fs.existsSync(path.join(repoRoot, "dist/mailbox-ui/index.html"))).toBe(true)
    expect(fs.existsSync(path.join(repoRoot, "dist/mailbox-ui/assets/index.js"))).toBe(true)
    expect(fs.existsSync(path.join(repoRoot, "dist/mailbox-ui/dist/assets/old.js"))).toBe(false)
    expect(fs.existsSync(path.join(repoRoot, "dist/outlook-ui/index.html"))).toBe(false)
  })

  it("throws when the Mailbox UI source dist does not exist", () => {
    const repoRoot = makeRoot()

    expect(() => copyMailboxUiDist(repoRoot)).toThrow("missing Mailbox UI build output")
  })
})
