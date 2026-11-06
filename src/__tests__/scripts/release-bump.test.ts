import { describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const {
  bumpReleaseVersion,
  parseArgs,
} = require(path.resolve(__dirname, "../../../scripts/release-bump.cjs"))

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function makeReleaseRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-release-bump-"))
  writeJson(path.join(root, "package.json"), {
    name: "@ouro.bot/cli",
    version: "0.1.0-alpha.587",
    scripts: {},
  })
  writeJson(path.join(root, "package-lock.json"), {
    name: "@ouro.bot/cli",
    version: "0.1.0-alpha.587",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "@ouro.bot/cli",
        version: "0.1.0-alpha.587",
      },
    },
  })
  writeJson(path.join(root, "packages/ouro.bot/package.json"), {
    name: "ouro.bot",
    version: "0.1.0-alpha.587",
  })
  writeJson(path.join(root, "changelog.json"), {
    versions: [
      {
        version: "0.1.0-alpha.587",
        changes: ["previous release"],
      },
    ],
  })
  return root
}

describe("release-bump helper", () => {
  it("moves cli, lockfile, wrapper, and changelog top entry together", () => {
    const root = makeReleaseRoot()
    try {
      const result = bumpReleaseVersion({
        root,
        version: "0.1.0-alpha.588",
        changes: [
          "Release bump helper now keeps CLI, wrapper, lockfile, and changelog versions aligned.",
          "Future release metadata errors fail before long validation starts.",
        ],
      })

      expect(result).toEqual({
        version: "0.1.0-alpha.588",
        changedFiles: [
          "package.json",
          "package-lock.json",
          "packages/ouro.bot/package.json",
          "changelog.json",
        ],
      })
      expect(readJson(path.join(root, "package.json")).version).toBe("0.1.0-alpha.588")
      expect(readJson(path.join(root, "package-lock.json")).version).toBe("0.1.0-alpha.588")
      expect(readJson(path.join(root, "package-lock.json")).packages[""].version).toBe("0.1.0-alpha.588")
      expect(readJson(path.join(root, "packages/ouro.bot/package.json")).version).toBe("0.1.0-alpha.588")

      const changelog = readJson(path.join(root, "changelog.json"))
      expect(changelog.versions[0]).toEqual({
        version: "0.1.0-alpha.588",
        changes: [
          "Release bump helper now keeps CLI, wrapper, lockfile, and changelog versions aligned.",
          "Future release metadata errors fail before long validation starts.",
        ],
      })
      expect(changelog.versions[1].version).toBe("0.1.0-alpha.587")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("updates an existing top changelog entry instead of duplicating it", () => {
    const root = makeReleaseRoot()
    try {
      writeJson(path.join(root, "changelog.json"), {
        versions: [
          {
            version: "0.1.0-alpha.588",
            changes: ["placeholder"],
          },
          {
            version: "0.1.0-alpha.587",
            changes: ["previous release"],
          },
        ],
      })

      bumpReleaseVersion({
        root,
        version: "0.1.0-alpha.588",
        changes: ["real release note"],
      })

      const changelog = readJson(path.join(root, "changelog.json"))
      expect(changelog.versions).toHaveLength(2)
      expect(changelog.versions[0]).toEqual({
        version: "0.1.0-alpha.588",
        changes: ["real release note"],
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("requires a valid target version and at least one changelog change", () => {
    const root = makeReleaseRoot()
    try {
      expect(() => bumpReleaseVersion({ root, version: "alpha-next", changes: ["note"] })).toThrow(
        "release version must be valid semver",
      )
      expect(() => bumpReleaseVersion({ root, version: "0.1.0-alpha.588", changes: [] })).toThrow(
        "at least one --change entry is required",
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("parses CLI args without losing repeated changelog changes", () => {
    expect(parseArgs([
      "--version",
      "0.1.0-alpha.588",
      "--change",
      "first",
      "--change",
      "second",
    ])).toEqual({
      root: process.cwd(),
      version: "0.1.0-alpha.588",
      changes: ["first", "second"],
    })
  })
})
