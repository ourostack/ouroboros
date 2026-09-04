import { describe, expect, it, vi } from "vitest"

import { emitNervesEvent } from "../../nerves/runtime"
import { sanctuaryMediaCatalogRequiredToolCalls } from "../../senses/sanctuary-media-catalog-contract"

vi.mock("../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

const requiredTools = ["sanctuary_search_media_catalog"]

describe("Sanctuary media catalog contract", () => {
  it.each([
    "Of the films you have in stock, do you have a favorite?",
    "Do we have the movie Moonstruck?",
    "What movie should I watch?",
  ])("requires the restricted catalog read for household media shelf questions (%s)", (request) => {
    const contract = sanctuaryMediaCatalogRequiredToolCalls(request, ["unraid_get_system", ...requiredTools, "settle"])
    expect(contract).toMatchObject({
      names: requiredTools,
      retryMessage: expect.stringMatching(/sanctuary_search_media_catalog.*taste.*favorite.*catalog evidence/is),
    })
    expect(contract?.validateTerminalAnswer("I don't actually watch films; I am just a bot.")).toContain("catalog evidence")
    expect(contract?.validateTerminalAnswer("From the shelf, I’d pick The Princess Bride. I can’t watch it, but the catalog gives me enough to choose.")).toBeUndefined()
    expect(emitNervesEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      component: "senses",
      event: "senses.sanctuary_media_catalog_obligation",
      meta: { requiredToolNames: requiredTools },
    }))
  })

  it.each([
    "status?",
    "Why is storage so full?",
    "Can you restart Books?",
  ])("does not activate outside media catalog intent (%s)", (request) => {
    expect(sanctuaryMediaCatalogRequiredToolCalls(request, requiredTools)).toBeUndefined()
  })

  it("does not activate when the relationship profile cannot use the catalog tool", () => {
    expect(sanctuaryMediaCatalogRequiredToolCalls("Do we have Moonstruck?", ["unraid_get_system"])).toBeUndefined()
  })
})
