import { describe, expect, it, vi } from "vitest"

import { emitNervesEvent } from "../../nerves/runtime"
import { sanctuaryMediaCatalogRequiredToolCalls } from "../../senses/sanctuary-media-catalog-contract"

vi.mock("../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

const requiredTools = ["sanctuary_search_media_catalog"]

function catalogResult(totalItems = 11_870, titles: string[] = ["Moonstruck", "The Princess Bride"]): string {
  return JSON.stringify({ ok: true, data: { totalItems, matchedItems: titles.length, items: titles.map((untrustedTitle) => ({ untrustedTitle, type: "Movie" })) } })
}

describe("Sanctuary media catalog contract", () => {
  it.each([
    "Of the films you have in stock, do you have a favorite?",
    "Do we have the movie Moonstruck?",
    "What movie should I watch?",
    "First we gotta get you able to see the lib or this is moot.",
  ])("requires the restricted catalog read for household media shelf questions (%s)", (request) => {
    const contract = sanctuaryMediaCatalogRequiredToolCalls(request, ["unraid_get_system", ...requiredTools, "settle"])
    expect(contract).toMatchObject({
      names: requiredTools,
      retryMessage: expect.stringMatching(/sanctuary_search_media_catalog.*catalog evidence/is),
      validateRequiredToolResult: expect.any(Function),
    })
    expect(emitNervesEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      component: "senses",
      event: "senses.sanctuary_media_catalog_obligation",
      meta: { requiredToolNames: requiredTools },
    }))
  })

  it("keeps a simple visibility answer direct, compact, and in household language", () => {
    const contract = sanctuaryMediaCatalogRequiredToolCalls("Can you see the library now?", requiredTools)!
    expect(contract.validateRequiredToolResult?.("sanctuary_search_media_catalog", catalogResult(), {})).toBe(true)
    expect(contract.validateTerminalAnswer("Yes—the shelf is visible again. I can currently see 11,870 movies and episodes.")).toBeUndefined()
    expect(contract.validateTerminalAnswer("Yes—I can see about 11,870 titles on the shelf.")).toBeUndefined()
    expect(contract.validateTerminalAnswer("Yes—I’ve got access to all 11,870 titles in the library.")).toBeUndefined()
    expect(contract.validateTerminalAnswer("Yes—I’m looking at all 11,870 titles in the library.")).toBeUndefined()
    expect(contract.validateTerminalAnswer("Yes—I can clearly see all 11,870 titles on the shelf.")).toBeUndefined()
    expect(contract.validateTerminalAnswer("Yes—I have all 11,870 titles on the shelf.")).toBeUndefined()

    for (const answer of [
      "Yes, the bounded catalog read returned 11,870 inventory items.",
      "Yes. Jellyfin reports roughly 11,870 items on the shelf right now.",
      "Yes. The catalog has 11,870 titles.",
      "Yes. The shelf has 11,870 titles.",
      "Yes—I have no access to the library, but it lists 11,870 titles.",
      "Yes, I can see your point. The shelf has 11,870 titles.",
      "Yes—I can see none of the 11,870 titles on the shelf.",
      "Yes—I can see zero of the 11,870 titles on the shelf.",
      "Yes—I can see 11,870 titles on the shelf. The library is not accessible.",
      "Yes—I can see 11,870 titles on the shelf. I can see 11,870 titles on the shelf.",
      "Yes—I can never see all 11,870 titles on the shelf.",
      "Yes—I can probably not see all 11,870 titles on the shelf.",
      "Yes—I have lost access to all 11,870 titles in the library.",
      "Yes—I can see all 11,870 titles on the shelf. The shelf is invisible.",
      "Yes—I can see only 2 of the 11,870 titles on the shelf.",
      "Yes—I can see fewer than 11,870 titles in the library.",
      "Yes—I can see 11,870 titles in the library, but access is unavailable.",
      "Yes—I can see 11,870 titles in the library, though nothing is accessible.",
      "Yes—I can see your point about the 11,870 titles in the library.",
      "Yes—I have reservations about the 11,870 titles in the library.",
      "Yes—I can see 11,870 titles like Moonstruck and The Princess Bride.",
      "Yes, I can see it. What would you like me to pick a favorite from?",
      "Yes, I can see it. Would you like me to recommend something?",
      "Yes—yes—I can see 11,870 titles on the shelf.",
      "No—the shelf is not visible, despite the successful read of 11,870 items.",
      "Yes—I can see 11,870 titles on the shelf. Anything else?",
      "Yes—the shelf is visible.",
      "Yes, I can see it. This is a third sentence. And this is a fourth.",
      `Yes, I can see it. ${"A".repeat(230)}`,
    ]) expect(contract.validateTerminalAnswer(answer), answer).toBeDefined()
  })

  it("allows technical language only when the user explicitly asks for technical detail", () => {
    const contract = sanctuaryMediaCatalogRequiredToolCalls("Technically, can you see the Jellyfin library endpoint now?", requiredTools)!
    expect(contract.validateRequiredToolResult?.("sanctuary_search_media_catalog", catalogResult(), {})).toBe(true)
    expect(contract.validateTerminalAnswer("Yes—I can see all 11,870 titles in the library; the catalog endpoint responded normally.")).toBeUndefined()
    expect(contract.validateTerminalAnswer("Yes, access is unavailable for all 11,870 titles.")).toBeDefined()
    expect(contract.validateTerminalAnswer("Yes, I can see only 2 of the 11,870 titles.")).toBeDefined()
  })

  it("allows concise grounded title lookup answers without applying visibility-only rules", () => {
    const contract = sanctuaryMediaCatalogRequiredToolCalls("Do we have the movie Moonstruck?", requiredTools)!
    expect(contract.validateToolCallBeforeDispatch?.("sanctuary_search_media_catalog", {})).toContain("requested title")
    expect(contract.validateToolCallBeforeDispatch?.("sanctuary_search_media_catalog", { query: "Alien" })).toMatch(/moonstruck/iu)
    expect(contract.validateToolCallBeforeDispatch?.("sanctuary_search_media_catalog", { query: "Moonstruck" })).toBeUndefined()
    expect(contract.validateRequiredToolResult?.("sanctuary_search_media_catalog", catalogResult(11_870, ["Moonstruck"]), { query: "Moonstruck" })).toBe(true)
    expect(contract.validateTerminalAnswer("Yes—Moonstruck is on the shelf.")).toBeUndefined()
    expect(contract.validateTerminalAnswer("No—Moonstruck is not on the shelf.")).toContain("Lead with yes")
    expect(contract.validateTerminalAnswer("Yes—it is on the shelf.")).toContain("requested title")
    expect(contract.validateTerminalAnswer("You need to check Jellyfin logs to be sure.")).toContain("Do not send Ari")
  })

  it("grounds a natural-language absent-title answer in an exact search", () => {
    const contract = sanctuaryMediaCatalogRequiredToolCalls("Is Moonstruck in the library?", requiredTools)!
    expect(contract.validateToolCallBeforeDispatch?.("sanctuary_search_media_catalog", { query: "Moonstruck" })).toBeUndefined()
    expect(contract.validateRequiredToolResult?.("sanctuary_search_media_catalog", catalogResult(11_870, []), { query: "Moonstruck" })).toBe(true)
    expect(contract.validateTerminalAnswer("No—Moonstruck isn’t on the shelf right now.")).toBeUndefined()
    expect(contract.validateTerminalAnswer("Yes—Moonstruck is on the shelf.")).toBeDefined()
  })

  it.each([
    "Is Moonstruck on the shelf?",
    "Is Moonstruck in Jellyfin?",
    "Hey, do we have Moonstruck?",
    "Is Moonstruck on the shelf now?",
  ])("recognizes natural title-location questions (%s)", (request) => {
    const contract = sanctuaryMediaCatalogRequiredToolCalls(request, requiredTools)!
    expect(contract.validateToolCallBeforeDispatch?.("sanctuary_search_media_catalog", {})).toContain("requested title")
    expect(contract.validateToolCallBeforeDispatch?.("sanctuary_search_media_catalog", { query: "Moonstruck" })).toBeUndefined()
    expect(contract.validateRequiredToolResult?.("sanctuary_search_media_catalog", catalogResult(11_870, ["Moonstruck"]), { query: "Moonstruck" })).toBe(true)
    expect(contract.validateTerminalAnswer("Yes—Moonstruck is on the shelf.")).toBeUndefined()
  })

  it("matches short titles only as complete normalized phrases", () => {
    const lookup = sanctuaryMediaCatalogRequiredToolCalls("Do we have Up?", requiredTools)!
    expect(lookup.validateRequiredToolResult?.("sanctuary_search_media_catalog", catalogResult(11_870, ["Up"]), { query: "Up" })).toBe(true)
    expect(lookup.validateTerminalAnswer("Yes—Up is on the shelf.")).toBeUndefined()
    expect(lookup.validateTerminalAnswer("Yes—a superb shelf choice.")).toContain("requested title")

    const favorite = sanctuaryMediaCatalogRequiredToolCalls("Which movie is your favorite?", requiredTools)!
    expect(favorite.validateRequiredToolResult?.("sanctuary_search_media_catalog", catalogResult(11_870, ["It"]), { query: "It" })).toBe(true)
    expect(favorite.validateTerminalAnswer("It. Ominous, economical, effective.")).toBeUndefined()
    expect(favorite.validateTerminalAnswer("With superb taste, as usual.")).toContain("returned by the current catalog")
  })

  it("allows a decisive grounded favorite while rejecting self-erasure and hedging", () => {
    const contract = sanctuaryMediaCatalogRequiredToolCalls("Of the films you have in stock, do you have a favorite?", requiredTools)!
    expect(contract.validateRequiredToolResult?.("sanctuary_search_media_catalog", catalogResult(11_870, ["The Princess Bride"]), { query: "The Princess Bride" })).toBe(true)
    expect(contract.validateTerminalAnswer("The Princess Bride. Nimble, quotable, and suspiciously good for household morale.")).toBeUndefined()
    expect(contract.validateTerminalAnswer("Moonstruck. A tidy bit of household magic.")).toContain("returned by the current catalog")
    for (const answer of [
      "I can’t watch it, but I’d pick The Princess Bride.",
      "I don't actually watch films, but if I had to pick, perhaps The Princess Bride.",
      "The Princess Bride. What are you in the mood for?",
    ]) expect(contract.validateTerminalAnswer(answer), answer).toBeDefined()
  })

  it("allows an addition only after an exact absent-title search", () => {
    const contract = sanctuaryMediaCatalogRequiredToolCalls("What movie should we add?", requiredTools)!
    expect(contract.validateToolCallBeforeDispatch?.("sanctuary_search_media_catalog", {})).toContain("candidate title")
    expect(contract.validateToolCallBeforeDispatch?.("sanctuary_search_media_catalog", { query: "Spirited Away" })).toBeUndefined()
    expect(contract.validateRequiredToolResult?.("sanctuary_search_media_catalog", catalogResult(11_870, []), { query: "Spirited Away" })).toBe(true)
    expect(contract.validateTerminalAnswer("Spirited Away. The shelf is poorer without it.")).toBeUndefined()
    expect(contract.validateTerminalAnswer("I added Spirited Away to the request queue.")).toBeDefined()
    const present = sanctuaryMediaCatalogRequiredToolCalls("What movie should we add?", requiredTools)!
    expect(present.validateRequiredToolResult?.("sanctuary_search_media_catalog", catalogResult(11_870, ["Spirited Away"]), { query: "Spirited Away" })).toBe(true)
    expect(present.validateTerminalAnswer("Spirited Away. The shelf is poorer without it.")).toContain("shows that candidate is absent")
  })

  it("keeps other catalog requests useful without visibility-only limits", () => {
    const contract = sanctuaryMediaCatalogRequiredToolCalls("Show me three films from the shelf.", requiredTools)!
    expect(contract.validateToolCallBeforeDispatch?.("sanctuary_search_media_catalog", { limit: "12" })).toContain("3")
    expect(contract.validateToolCallBeforeDispatch?.("sanctuary_search_media_catalog", { limit: "3" })).toBeUndefined()
    expect(contract.validateRequiredToolResult?.("sanctuary_search_media_catalog", catalogResult(11_870, ["Moonstruck", "Arrival", "Alien"]), { limit: "3" })).toBe(true)
    expect(contract.validateTerminalAnswer("Moonstruck, Arrival, and Alien are on the shelf.")).toBeUndefined()
    expect(contract.validateTerminalAnswer("Heat, Jaws, and Solaris are on the shelf.")).toContain("returned catalog titles")
    expect(contract.validateTerminalAnswer("Moonstruck, Arrival, Alien, and Heat are on the shelf.")).toContain("returned catalog titles")
    const numeric = sanctuaryMediaCatalogRequiredToolCalls("List 3 movies from the library.", requiredTools)!
    expect(numeric.retryMessage).toContain("limit 3")
    const openEnded = sanctuaryMediaCatalogRequiredToolCalls("Sample the movie catalog.", requiredTools)!
    expect(openEnded.retryMessage).toContain("base any named titles")
    expect(openEnded.validateRequiredToolResult?.("sanctuary_search_media_catalog", catalogResult(11_870, ["Moonstruck", "Arrival"]), {})).toBe(true)
    expect(openEnded.validateTerminalAnswer("Moonstruck and Arrival are on the shelf.")).toBeUndefined()
    expect(openEnded.validateTerminalAnswer("Moonstruck and Heat are on the shelf.")).toContain("returned catalog titles")
    expect(openEnded.validateTerminalAnswer("Heat and Solaris are on the shelf.")).toContain("returned catalog titles")

    const broad = sanctuaryMediaCatalogRequiredToolCalls("What films do we have?", requiredTools)!
    expect(broad.validateRequiredToolResult?.("sanctuary_search_media_catalog", catalogResult(11_870, ["Moonstruck", "Arrival"]), {})).toBe(true)
    expect(broad.validateTerminalAnswer("Moonstruck and Arrival are on the shelf.")).toBeUndefined()
    expect(broad.validateTerminalAnswer("Heat and Solaris are on the shelf.")).toContain("returned catalog titles")

    const count = sanctuaryMediaCatalogRequiredToolCalls("How many films do we have?", requiredTools)!
    expect(count.validateRequiredToolResult?.("sanctuary_search_media_catalog", catalogResult(11_870), {})).toBe(true)
    expect(count.validateTerminalAnswer("There are 11,870 movies and episodes on the shelf.")).toBeUndefined()
    expect(count.validateTerminalAnswer("There are 12,000 movies and episodes on the shelf.")).toContain("11,870")
    expect(count.validateTerminalAnswer("There are 11,870 movies and episodes on the shelf, including Heat.")).toContain("only the verified count")
    expect(count.validateTerminalAnswer("There are 11,870 movies and 11,870 episodes on the shelf.")).toContain("once")

    const visibleCount = sanctuaryMediaCatalogRequiredToolCalls("How many movies can you see in the library?", requiredTools)!
    expect(visibleCount.retryMessage).toContain("current shelf count")
    expect(visibleCount.validateRequiredToolResult?.("sanctuary_search_media_catalog", catalogResult(11_870), {})).toBe(true)
    expect(visibleCount.validateTerminalAnswer("There are 11,870 movies and episodes on the shelf.")).toBeUndefined()
  })

  it("rejects malformed or failed catalog evidence", () => {
    const contract = sanctuaryMediaCatalogRequiredToolCalls("Can you see the library?", requiredTools)!
    expect(contract.validateRequiredToolResult?.("other", catalogResult(), {})).toBe(false)
    expect(contract.validateRequiredToolResult?.("sanctuary_search_media_catalog", "not-json", {})).toBe(false)
    expect(contract.validateRequiredToolResult?.("sanctuary_search_media_catalog", JSON.stringify({ ok: false, error: { code: "unavailable" } }), {})).toBe(false)
    expect(contract.validateRequiredToolResult?.("sanctuary_search_media_catalog", JSON.stringify({ ok: true, data: { totalItems: 4, matchedItems: 1, items: [null, "bad", [], {}, { untrustedTitle: 7 }, { untrustedTitle: " " }, { untrustedTitle: "Moonstruck" }] } }), {})).toBe(true)
    expect(contract.validateToolCallBeforeDispatch?.("other", {})).toBeUndefined()
  })

  it.each([
    "status?",
    "Why is storage so full?",
    "Can you restart Books?",
    "Show me the logs.",
    "Show me my tasks.",
  ])("does not activate outside media catalog intent (%s)", (request) => {
    expect(sanctuaryMediaCatalogRequiredToolCalls(request, requiredTools)).toBeUndefined()
  })

  it("does not activate when the relationship profile cannot use the catalog tool", () => {
    expect(sanctuaryMediaCatalogRequiredToolCalls("Do we have Moonstruck?", ["unraid_get_system"])).toBeUndefined()
  })
})
