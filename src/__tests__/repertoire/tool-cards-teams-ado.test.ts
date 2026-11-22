import { describe, expect, it } from "vitest"
import { teamsToolDefinitions } from "../../repertoire/tools-teams"
import { adoSemanticToolDefinitions } from "../../repertoire/ado-semantic"

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/

describe("Teams, Graph and Azure DevOps tool cards", () => {
  const defs = [...teamsToolDefinitions, ...adoSemanticToolDefinitions]

  it("gives every tool a card named after it, with kebab-case codes", () => {
    expect(defs).toHaveLength(20)
    for (const def of defs) {
      expect(def.ax?.id).toBe(`tool:${def.tool.function.name}`)
      for (const error of def.ax!.errors) expect(error.code).toMatch(KEBAB)
    }
    expect(new Set(teamsToolDefinitions.map((def) => def.ax?.group))).toEqual(new Set(["turn-microsoft"]))
    expect(new Set(adoSemanticToolDefinitions.map((def) => def.ax?.group))).toEqual(new Set(["turn-ado"]))
  })

  it("gives every read card an explicit low-risk profile and keeps ado_query write, because it can POST", () => {
    for (const def of defs.filter((d) => d.ax?.effect === "read")) expect(def.riskProfile).toEqual({ mutates: "none", risk: "low" })
    expect(teamsToolDefinitions.find((def) => def.tool.function.name === "ado_query")!.ax!.effect).toBe("write")
  })

  it("ends a sign-in refusal with the code the card names", async () => {
    const query = teamsToolDefinitions.find((def) => def.tool.function.name === "graph_query")!
    const refusal = await query.handler({ path: "/me" }, {} as never)
    expect(refusal).toMatch(/ \(code: auth-required\)$/)
  })
})
