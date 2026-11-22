import { beforeEach, describe, expect, it, vi } from "vitest"

const nervesEvents: Array<Record<string, unknown>> = vi.hoisted(() => [])
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

const mockGetAgentName = vi.fn(() => "ouroboros")
vi.mock("../../heart/identity", () => ({
  getAgentName: () => mockGetAgentName(),
}))

// tools-base assembles every tool module and tools-vault imports withCode from it, so load tools-base first, as the runtime does.
import "../../repertoire/tools-base"
import { vaultToolDefinitions } from "../../repertoire/tools-vault"

function findTool(name: string) {
  const def = vaultToolDefinitions.find((d) => d.tool.function.name === name)
  if (!def) throw new Error(`Tool "${name}" not found`)
  return def
}

describe("vault_setup tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
    mockGetAgentName.mockReturnValue("ouroboros")
  })

  it("is registered with the correct name", () => {
    const tool = findTool("vault_setup")
    expect(tool.tool.function.name).toBe("vault_setup")
  })

  it("has a person-only card, since only a person can type the vault secret", () => {
    expect(findTool("vault_setup").ax).toMatchObject({ id: "tool:vault_setup", group: "turn-vault", effect: "person-only" })
  })

  it("does not require confirmation", () => {
    const tool = findTool("vault_setup")
    expect(tool.confirmationRequired).toBeUndefined()
  })

  it("returns human-terminal instructions without exposing or persisting secrets", async () => {
    mockGetAgentName.mockReturnValue("slugger")
    const tool = findTool("vault_setup")

    const result = await tool.handler({})

    expect(result).toContain("Vault setup is human-required.")
    expect(result).toContain("Creating or unlocking a vault requires secret entry")
    expect(result).toContain("ouro vault create --agent slugger")
    expect(result).toContain("ouro vault unlock --agent slugger")
    expect(result).not.toContain("masterPassword")
    expect(result).not.toContain("secrets.json")
    expect(result).toMatch(/ \(code: human-required\)$/)
  })

  it("emits nerves events", async () => {
    const tool = findTool("vault_setup")
    await tool.handler({})

    expect(nervesEvents.some((e) => e.event === "repertoire.vault_tool_call")).toBe(true)
  })
})
