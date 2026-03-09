import { describe, expect, it } from "vitest"
import * as path from "path"

// The changelog-gate script exports a validateChangelog function for testability
const { validateChangelog } = require(path.resolve(__dirname, "../../../scripts/changelog-gate.cjs"))

describe("changelog-gate validateChangelog", () => {
  it("passes when current version has a non-empty changelog entry", () => {
    const changelog = {
      versions: [
        {
          version: "0.1.0-alpha.20",
          changes: ["Added version awareness to system prompt"],
        },
      ],
    }

    const result = validateChangelog("0.1.0-alpha.20", changelog)

    expect(result.ok).toBe(true)
  })

  it("fails when current version has no changelog entry", () => {
    const changelog = {
      versions: [
        {
          version: "0.1.0-alpha.19",
          changes: ["Fixed something"],
        },
      ],
    }

    const result = validateChangelog("0.1.0-alpha.20", changelog)

    expect(result.ok).toBe(false)
    expect(result.error).toContain("0.1.0-alpha.20")
  })

  it("fails when current version entry has empty changes array", () => {
    const changelog = {
      versions: [
        {
          version: "0.1.0-alpha.20",
          changes: [],
        },
      ],
    }

    const result = validateChangelog("0.1.0-alpha.20", changelog)

    expect(result.ok).toBe(false)
    expect(result.error).toContain("empty")
  })

  it("fails when versions array is empty", () => {
    const changelog = {
      versions: [],
    }

    const result = validateChangelog("0.1.0-alpha.20", changelog)

    expect(result.ok).toBe(false)
  })

  it("fails when changelog has no versions field", () => {
    const changelog = {}

    const result = validateChangelog("0.1.0-alpha.20", changelog)

    expect(result.ok).toBe(false)
  })

  it("passes when entry has multiple changes", () => {
    const changelog = {
      versions: [
        {
          version: "0.1.0-alpha.20",
          changes: ["Change one", "Change two", "Change three"],
        },
      ],
    }

    const result = validateChangelog("0.1.0-alpha.20", changelog)

    expect(result.ok).toBe(true)
  })

  it("ignores entries for other versions", () => {
    const changelog = {
      versions: [
        { version: "0.1.0-alpha.19", changes: ["Old change"] },
        { version: "0.1.0-alpha.20", changes: ["New change"] },
      ],
    }

    const result = validateChangelog("0.1.0-alpha.20", changelog)

    expect(result.ok).toBe(true)
  })
})
