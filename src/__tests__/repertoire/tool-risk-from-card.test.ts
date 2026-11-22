import { describe, expect, it } from "vitest"

import { riskProfileForTool } from "../../repertoire/tools"
import { baseToolDefinitions, type ToolDefinition, type ToolDoorCard } from "../../repertoire/tools-base"
import { teamsToolDefinitions } from "../../repertoire/tools-teams"
import { mailToolDefinitions } from "../../repertoire/tools-mail"
import { voiceToolDefinitions } from "../../repertoire/tools-voice"
import { bundleToolDefinitions } from "../../repertoire/tools-bundle"
import { voiceLocalAudioToolDefinition } from "../../repertoire/tools-voice-local"

const schema = (name: string) => ({ type: "function" as const, function: { name, description: name, parameters: { type: "object", properties: {} } } })
const card = (name: string, effect: ToolDoorCard["effect"]): ToolDoorCard => ({ id: `tool:${name}`, group: "g", when: "w", effect, errors: [] })
const definition = (name: string, ax?: ToolDoorCard): ToolDefinition => ({ tool: schema(name), handler: () => "", ...(ax ? { ax } : {}) })

describe("risk without a riskProfile", () => {
  it("takes a read card at its word", () => {
    expect(riskProfileForTool(definition("peek", card("peek", "read")), "peek", {})).toEqual({ mutates: "none", risk: "low" })
  })

  it("treats any other card as a high-risk change", () => {
    for (const effect of ["write", "consequential", "person-only"] as const) {
      const profile = riskProfileForTool(definition("poke", card("poke", effect)), "poke", {})
      expect(profile, effect).toMatchObject({ risk: "high", mutates: ["durable_state_write", "external_side_effect"] })
      expect(profile.reason, effect).toContain(`card says ${effect}`)
    }
  })

  it("never counts a tool with neither a card nor a riskProfile as low risk", () => {
    const profile = riskProfileForTool(definition("mystery"), "mystery", {})
    expect(profile).toMatchObject({ risk: "high", mutates: ["durable_state_write", "external_side_effect"] })
    expect(profile.reason).toContain("no Ouro AX card")
  })
})

describe("declared riskProfiles", () => {
  const all = [...baseToolDefinitions, ...teamsToolDefinitions, ...mailToolDefinitions, ...voiceToolDefinitions, ...bundleToolDefinitions, voiceLocalAudioToolDefinition]
  const find = (name: string) => all.find((entry) => entry.tool.function.name === name)!

  it("gives every native tool an explicit riskProfile", () => {
    const missing = all.filter((entry) => entry.riskProfile === undefined && entry.tool.function.name !== "shell").map((entry) => entry.tool.function.name)
    expect(missing).toEqual([])
  })

  it("marks joining a call as high risk, and keeps hanging up, leaving and reporting a failure usable during a hold", () => {
    expect(riskProfileForTool(find("voice_end_call"), "voice_end_call", {})).toMatchObject({ risk: "low" })
    expect(riskProfileForTool(find("voice_join_local_audio"), "voice_join_local_audio", {})).toMatchObject({ risk: "high", mutates: "external_side_effect" })
    for (const action of ["status", "leave"]) expect(riskProfileForTool(find("voice_join_local_audio"), "voice_join_local_audio", { action })).toEqual({ mutates: "none", risk: "low" })
    expect(riskProfileForTool(find("report_failure"), "report_failure", {})).toMatchObject({ risk: "low" })
  })

  it("lets ado_query read with GET or a WIQL POST, and treats any other POST as a change", () => {
    const ado = find("ado_query")
    expect(riskProfileForTool(ado, "ado_query", { path: "/_apis/wit/workitems/1" })).toMatchObject({ risk: "low" })
    expect(riskProfileForTool(ado, "ado_query", { method: "POST", path: "/Proj/_apis/wit/wiql?api-version=7.0" })).toMatchObject({ risk: "low" })
    expect(riskProfileForTool(ado, "ado_query", { method: "POST", path: "/_apis/wit/workitems/$Task" })).toMatchObject({ risk: "high", mutates: "external_side_effect" })
    expect(riskProfileForTool(ado, "ado_query", { method: "POST", path: "/_apis/wit/workitems/$Task?x=/_apis/wit/wiql" })).toMatchObject({ risk: "high" })
    expect(riskProfileForTool(ado, "ado_query", { method: "PATCH", path: "/_apis/wit/wiql" })).toMatchObject({ risk: "high" })
    expect(riskProfileForTool(ado, "ado_query", { method: "post" })).toMatchObject({ risk: "high" })
  })
})
