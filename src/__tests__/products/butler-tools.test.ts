import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ProductToolSelectionInput } from "../../heart/product/types"
import { BUTLER_HOUSE_CARE_TOOL_NAMES, product, selectButlerTools } from "../../products/butler"
import { houseCareToolDefinitions } from "../../repertoire/tools-house-care"
import { rootHostToolDefinition } from "../../repertoire/tools-sanctuary-host"
import * as identity from "../../heart/identity"

/** The Butler's tools (J3) and status (J7), as its product registers them. */
function input(overrides: Partial<ProductToolSelectionInput>): ProductToolSelectionInput {
  return {
    channel: "inner", relationshipScoped: false, providerCapabilities: new Set(["approval-continuation"]),
    context: { agentName: "butler" },
    registered: (name) => houseCareToolDefinitions.find((definition) => definition.tool.function.name === name),
    ...overrides,
  }
}

afterEach(() => { vi.restoreAllMocks() })

describe("the Butler's tools", () => {
  it("register the root-host tool, which carries its own authorize, and scope remote and relationship turns", () => {
    expect(product.tools!.definitions).toEqual([rootHostToolDefinition])
    expect(rootHostToolDefinition.authorize).toEqual(expect.any(Function))
    expect(product.tools!.relationshipScoped).toBe(true)
    expect(product.tools!.select).toBe(selectButlerTools)
  })

  it("name the house-care tools core registers", () => {
    expect([...BUTLER_HOUSE_CARE_TOOL_NAMES]).toEqual(houseCareToolDefinitions.map((definition) => definition.tool.function.name))
  })

  it("give the Butler's own unscoped inner turns house care, and no other turn", () => {
    expect(selectButlerTools(input({}))).toEqual(houseCareToolDefinitions)
    expect(selectButlerTools(input({ relationshipScoped: true }))).toEqual([])
    expect(selectButlerTools(input({ channel: "cli" }))).toEqual([])
    expect(selectButlerTools(input({ channel: undefined }))).toEqual([])
    expect(() => selectButlerTools(input({ registered: () => undefined }))).toThrow("the Butler's house-care tool house_sweep is not registered")
  })

  it("offer the root-host tool in Telegram only to a turn bound to the owner's verified request", () => {
    expect(selectButlerTools(input({ channel: "telegram" }))).toEqual([])
  })

  it("add the Butler's operational status to query_active_work", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "butler-status-"))
    try {
      vi.spyOn(identity, "getAgentRoot").mockReturnValue(agentRoot)
      const text = await product.status!.activeWorkSections({ agentName: "butler", section: "awaits", offset: 0, limit: 10 })
      expect(text).toBe("## butler operational visibility\n- pending awaits: 0")
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })
})
