import { describe, expect, it, vi } from "vitest"

import { buildFindToolsSchema, findToolsDefinition, formatFindToolsResult } from "../../repertoire/deferred-tools"
import { getSpecialistTools, specialistToolDefinitions } from "../../heart/hatch/specialist-tools"
import { createVoiceLocalAudioToolDefinition, voiceLocalAudioToolDefinition } from "../../repertoire/tools-voice-local"

const codeOf = (text: string): string | undefined => /\(code: ([a-z-]+)\)$/.exec(text)?.[1]

describe("find_tools card", () => {
  it("declares find_tools as a read that changes nothing outside the turn", () => {
    expect(findToolsDefinition.tool.function.name).toBe(buildFindToolsSchema([]).function.name)
    expect(findToolsDefinition.ax).toMatchObject({ id: "tool:find_tools", group: "turn-skills", effect: "read" })
    expect(findToolsDefinition.riskProfile).toEqual({ mutates: "none", risk: "low" })
  })

  it("ends a search with no match with the code its card names", () => {
    const code = codeOf(formatFindToolsResult([]))
    expect(findToolsDefinition.ax.errors.map((error) => error.code)).toContain(code)
  })
})

describe("hatch specialist cards", () => {
  it("gives complete_adoption and list_directory cards in the hatch group, and keeps the tool list", () => {
    expect(getSpecialistTools().map((tool) => tool.function.name)).toEqual(["complete_adoption", "settle", "read_file", "write_file", "list_directory"])
    expect(specialistToolDefinitions.map((definition) => definition.ax.id)).toEqual(["tool:complete_adoption", "tool:list_directory"])
    for (const definition of specialistToolDefinitions) expect(definition.ax.group).toBe("hatch")
  })

  it("marks list_directory as a read and complete_adoption as a write with a high-risk profile", () => {
    const [adopt, list] = specialistToolDefinitions
    expect(list!.ax.effect).toBe("read")
    expect(list!.riskProfile).toEqual({ mutates: "none", risk: "low" })
    expect(adopt!.ax.effect).toBe("write")
    expect(adopt!.riskProfile).toMatchObject({ risk: "high" })
  })
})

describe("voice_join_local_audio card", () => {
  const deps = { launch: vi.fn(async () => ({ ok: false as const, message: "BlackHole 2ch is missing" })), leave: vi.fn(async () => "left"), status: vi.fn(async () => "status") }
  const definition = createVoiceLocalAudioToolDefinition(deps)
  const codes = new Set(voiceLocalAudioToolDefinition.ax!.errors.map((error) => error.code))
  const ctx = (overrides: Record<string, unknown> = {}) => ({
    agentName: "slugger",
    currentUserMessage: "join my call",
    context: { friend: { id: "ari", name: "Ari", trustLevel: "family" }, channel: { channel: "cli" }, isGroupChat: false },
    ...overrides,
  }) as never

  it("declares the tool in the turn-voice group as a write", () => {
    expect(voiceLocalAudioToolDefinition.ax).toMatchObject({ id: "tool:voice_join_local_audio", group: "turn-voice", effect: "write" })
  })

  it("ends each refusal with a code the card names", async () => {
    const results = [
      await definition.handler({}, undefined),
      await definition.handler({ device: "MacBook Microphone" }, ctx()),
      await definition.handler({ action: "dance" }, ctx()),
      await definition.handler({}, ctx({ agentName: undefined })),
      await definition.handler({ silent_consent: "Everyone agreed to a silent join today." }, ctx()),
      await definition.handler({}, ctx()),
    ]
    for (const result of results) expect(codes.has(codeOf(result)!), result).toBe(true)
  })
})
