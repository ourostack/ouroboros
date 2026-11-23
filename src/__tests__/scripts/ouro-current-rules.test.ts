import { describe, expect, it } from "vitest"
import * as fs from "fs"
import * as path from "path"

const { isChangeNotePath } = require(path.resolve(__dirname, "../../../scripts/release-paths.cjs"))
const { parseChangeNote } = require(path.resolve(__dirname, "../../../scripts/release-version.cjs"))

const ROOT = path.resolve(__dirname, "../../..")

// Ouro Current (ourostack/ouro-ui scripts/current) reads .github/ouro-current.json to make its update pull request pass
// this repository's checks. Pull requests here never carry the version (the release job on main sets it), so the rules
// name no version files and ask only for a change note, which the release job folds into changelog.json.
describe(".github/ouro-current.json", () => {
  it("asks for a change note the release job reads, and never for a version bump", () => {
    const rules = JSON.parse(fs.readFileSync(path.join(ROOT, ".github/ouro-current.json"), "utf8"))
    expect(rules.version).toBeUndefined()
    expect(rules.changelog.json).toBeUndefined()

    const fill = (template: string) => template
      .replace("{versionSlug}", "1-3-204")
      .replace("{version}", "1.3.204")
      .replace("{releases}", "Ouro UI v1.3.204")
    expect(isChangeNotePath(fill(rules.changelog.path))).toBe(true)
    expect(parseChangeNote(fill(rules.changelog.text))).toEqual(["Update the Ouro UI files to Ouro UI v1.3.204."])
  })
})
