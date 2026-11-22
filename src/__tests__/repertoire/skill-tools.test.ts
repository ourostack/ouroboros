import * as fs from "node:fs"
import * as path from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { declaredTools } from "../../repertoire/skill-summaries"
import { baseToolDefinitions } from "../../repertoire/tools-base"
import { emitNervesEvent } from "../../nerves/runtime"

describe("skills declare their tools", () => {
  beforeEach(() => {
    emitNervesEvent({ component: "repertoire", event: "repertoire.test_run", message: "skill tools test", meta: { test: true } })
  })

  it("reads a frontmatter tools: list, in brackets or bare", () => {
    expect(declaredTools("---\ndescription: x\ntools: [flight_search, flight_book]\n---\n# Skill")).toEqual(["flight_search", "flight_book"])
    expect(declaredTools("---\ntools: weather_lookup,  geocode_search , weather_lookup\n---\nbody")).toEqual(["weather_lookup", "geocode_search"])
    expect(declaredTools("---\r\nTools: [\"a\", 'b']\r\n---\r\n")).toEqual(["a", "b"])
  })

  it("declares nothing without frontmatter, an unclosed block or a tools line", () => {
    expect(declaredTools("# Skill\ntools: [shell]")).toEqual([])
    expect(declaredTools("---\ntools: [shell]\n# never closed")).toEqual([])
    expect(declaredTools("---\ndescription: x\n---\nbody")).toEqual([])
    expect(declaredTools("---\ntools: []\n---\n")).toEqual([])
  })

  it("names only real in-turn tools in the harness's own skills", () => {
    const skillsDir = path.join(__dirname, "../../../skills")
    const known = new Set(baseToolDefinitions.map((definition) => definition.tool.function.name))
    const declared = fs.readdirSync(skillsDir).filter((file) => file.endsWith(".md"))
      .flatMap((file) => declaredTools(fs.readFileSync(path.join(skillsDir, file), "utf-8")).map((name) => [file, name] as const))
    expect(declared.length).toBeGreaterThan(0)
    expect(declared.filter(([, name]) => !known.has(name))).toEqual([])
  })
})
