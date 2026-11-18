import { describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const { bumpReleaseVersion } = require(path.resolve(__dirname, "../../../scripts/release-bump.cjs"))

const ROOT = path.resolve(__dirname, "../../..")

// Ouro Current (ourostack/ouro-ui scripts/current) cannot run release:bump, so .github/ouro-current.json tells it which
// files carry the version and where. Each entry replaces the first match of its pattern in the file as the entries
// before it left it; this holds that to what release:bump writes, so a new version file fails here first.
describe(".github/ouro-current.json", () => {
  it("moves the version in exactly the files and places release:bump does, and names changelog.json", () => {
    const rules = JSON.parse(fs.readFileSync(path.join(ROOT, ".github/ouro-current.json"), "utf8"))
    const next = "0.1.0-alpha.999999"
    const declared = new Map<string, string>()
    for (const entry of rules.version) {
      const text = declared.get(entry.path) ?? fs.readFileSync(path.join(ROOT, entry.path), "utf8")
      const match = new RegExp(entry.pattern, "m").exec(text)
      expect(match?.[1], `${entry.path}: ${entry.pattern}`).toBeTruthy()
      const start = match!.index + match![0].indexOf(match![1])
      declared.set(entry.path, text.slice(0, start) + next + text.slice(start + match![1].length))
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-current-rules-"))
    const { changedFiles } = bumpReleaseVersion({ ...copyTo(root), version: next, changes: ["x"] })
    const bumped = changedFiles.filter((file: string) => file !== "changelog.json")
    expect([...declared.keys()].sort()).toEqual([...bumped].sort())
    for (const file of bumped) expect(declared.get(file), file).toBe(fs.readFileSync(path.join(root, file), "utf8"))

    expect(rules.changelog).toMatchObject({ path: "changelog.json", json: "versions" })
  })
})

// The release files, copied into `root`, so release:bump writes there and not in the checkout.
function copyTo(root: string): { root: string } {
  for (const file of ["package.json", "package-lock.json", "npm-shrinkwrap.json", "packages/ouro.bot/package.json", "changelog.json", "deploy/unraid/sanctuary.xml", "deploy/unraid/sanctuary.ouro/bundle-meta.json"]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.copyFileSync(path.join(ROOT, file), path.join(root, file))
  }
  return { root }
}
