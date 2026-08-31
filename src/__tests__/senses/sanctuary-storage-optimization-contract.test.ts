import { describe, expect, it, vi } from "vitest"

import { emitNervesEvent } from "../../nerves/runtime"
import { sanctuaryStorageOptimizationRequiredToolCalls } from "../../senses/sanctuary-storage-optimization-contract"

vi.mock("../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

const requiredTools = ["unraid_get_storage", "sanctuary_get_media_optimization"]

describe("Sanctuary storage optimization contract", () => {
  it.each([
    "What's using all the space, and can we make it smaller?",
    "WHAT IS USING THE STORAGE — CAN WE SHRINK IT?",
    "Find what is taking up space and reclaim some of it.",
  ])("requires both safe reads for explicit storage diagnosis plus shrink intent (%s)", (request) => {
    expect(sanctuaryStorageOptimizationRequiredToolCalls(request, ["query_cares", ...requiredTools, "settle"])).toEqual({
      names: requiredTools,
      retryMessage: expect.stringMatching(/safe reads.*largest.*Unmanic.*Jellyfin.*sample encode.*savings.*shell.*QDirStat/is),
    })
    expect(emitNervesEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      component: "senses",
      event: "senses.sanctuary_storage_optimization_obligation",
      meta: { requiredToolNames: requiredTools },
    }))
  })

  it.each([
    ["How much space is left?", requiredTools],
    ["Why is storage so full?", requiredTools],
    ["Make this image smaller", requiredTools],
    ["What's using all the space, and can we make it smaller?", ["unraid_get_storage"]],
    ["What's using all the space, and can we make it smaller?", ["sanctuary_get_media_optimization"]],
  ])("does not activate outside the exact authorized capability and intent (%s)", (request, advertised) => {
    expect(sanctuaryStorageOptimizationRequiredToolCalls(request, advertised)).toBeUndefined()
  })
})
