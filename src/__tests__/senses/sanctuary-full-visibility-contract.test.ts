import { describe, expect, it } from "vitest"

import { sanctuaryFullVisibilityRequiredToolCalls } from "../../senses/sanctuary-full-visibility-contract"

const requiredNames = ["query_active_work", "query_cares", "unraid_get_system", "unraid_list_containers"]
const advertised = [...requiredNames, "settle", "speak"]

describe("Sanctuary full-visibility read contract", () => {
  it.each([
    "What are you working on?",
    "What's going on with Sanctuary?",
    "  WHAT’S GOING ON WITH SANCTUARY?!  ",
  ])("requires all current household evidence for %j", (request) => {
    const contract = sanctuaryFullVisibilityRequiredToolCalls(request, advertised)

    expect(contract).toEqual({
      names: requiredNames,
      retryMessage: "Before answering, read current active work, cares, system health, and service state. Then give Ari one compact household summary; do not ask him to choose a status slice.",
    })
  })

  it.each([
    "status?",
    "How much space is left?",
    "What's going on with the movie request?",
    "What are you working on tomorrow?",
    "",
  ])("leaves unrelated requests alone for %j", (request) => {
    expect(sanctuaryFullVisibilityRequiredToolCalls(request, advertised)).toBeUndefined()
  })

  it("stays inactive unless every current read is actually advertised", () => {
    for (const missing of requiredNames) {
      expect(sanctuaryFullVisibilityRequiredToolCalls("What's going on with Sanctuary?", advertised.filter((name) => name !== missing))).toBeUndefined()
    }
  })
})
