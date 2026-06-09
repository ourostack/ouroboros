import { describe, expect, it } from "vitest"
import { parseFrontmatter } from "../../util/frontmatter"

describe("parseFrontmatter", () => {
  it("returns empty object on empty input", () => {
    expect(parseFrontmatter("")).toEqual({})
  })

  it("parses a single key:value pair", () => {
    expect(parseFrontmatter("status: drafting")).toEqual({ status: "drafting" })
  })

  it("skips blank lines and unmatched lines", () => {
    const raw = ["", "status: drafting", "not a key value line", "category: bug"].join("\n")
    expect(parseFrontmatter(raw)).toEqual({ status: "drafting", category: "bug" })
  })

  it("strips double-quoted scalars", () => {
    expect(parseFrontmatter(`title: "My Quoted Title"`)).toEqual({ title: "My Quoted Title" })
  })

  it("strips single-quoted scalars", () => {
    expect(parseFrontmatter(`title: 'singled'`)).toEqual({ title: "singled" })
  })

  it("returns null for the literal `null` value", () => {
    expect(parseFrontmatter("assignee: null")).toEqual({ assignee: null })
  })

  it("returns [] for the literal `[]` empty-array value", () => {
    expect(parseFrontmatter("tags: []")).toEqual({ tags: [] })
  })

  it("parses block-style YAML list under a key", () => {
    const raw = ["tags:", "  - alpha", "  - beta", "  - gamma"].join("\n")
    expect(parseFrontmatter(raw)).toEqual({ tags: ["alpha", "beta", "gamma"] })
  })

  it("parses block list with quoted items", () => {
    const raw = ["names:", `  - "Alice"`, "  - 'Bob'"].join("\n")
    expect(parseFrontmatter(raw)).toEqual({ names: ["Alice", "Bob"] })
  })

  it("yields an empty array when a key has no inline value and no list items", () => {
    const raw = ["status:"].join("\n")
    expect(parseFrontmatter(raw)).toEqual({ status: [] })
  })

  it("parses nested key/value maps under a key", () => {
    const raw = ["surface:", "  family: true", "  originator: false"].join("\n")
    expect(parseFrontmatter(raw)).toEqual({ surface: { family: true, originator: false } })
  })

  it("handles CRLF line endings", () => {
    const raw = "status: done\r\ncategory: ship"
    expect(parseFrontmatter(raw)).toEqual({ status: "done", category: "ship" })
  })

  it("preserves order-independence: later key wins on duplicate", () => {
    const raw = "status: drafting\nstatus: done"
    expect(parseFrontmatter(raw)).toEqual({ status: "done" })
  })
})
