import { describe, expect, it } from "vitest"
import { shelfClaimError, withShelfDisclosure } from "../../heart/shelf-claims"

const search = (result: unknown, name = "media_search") => ({ name, args: {}, result: typeof result === "string" ? result : JSON.stringify(result) })

describe("shelfClaimError", () => {
  it("passes a reply that makes no shelf claim, with or without a lookup", () => {
    expect(shelfClaimError("Silly or swoony tonight?", [])).toBeNull()
    expect(shelfClaimError("the fall guy or bullet train. I can check if we have them.", [])).toBeNull()
  })

  it("does not read a denial or an offer to check as a claim", () => {
    const tools = [search({ items: [{ title: "Dune", on_shelf: false }] })]
    expect(shelfClaimError("Dune isn't on the shelf yet. want me to request it?", tools)).toBeNull()
    expect(shelfClaimError("Want me to check if it's in our library?", [])).toBeNull()
    expect(shelfClaimError("Dune is not on the shelf, but Arrival is on the shelf.", tools)).toContain("no library lookup this turn found what you named")
    // A denial word reaches only the few words before the claim, and "no" alone is not one.
    for (const reply of ["No worries — Dune is on the shelf", "Didn't look, but Dune's in our library", "Dr. No is on the shelf"])
      expect(shelfClaimError(reply, []), reply).not.toBeNull()
  })

  it("puts the truth in front of an unbacked claim: what the lookup showed missing, or that nothing was checked", () => {
    expect(withShelfDisclosure("all on the shelf.", [])).toBe("I haven't checked the library for that yet, so I can't promise it's on the shelf.\n\nall on the shelf.")
    const tools = [search({ items: [{ title: "Hot Tub Time Machine", on_shelf: false }] })]
    expect(withShelfDisclosure("Hot Tub Time Machine is on the shelf.", tools)).toBe("My lookup shows Hot Tub Time Machine isn't on the shelf.\n\nHot Tub Time Machine is on the shelf.")
  })

  // 2026-10-11, Rach handoff turns 5 and 6: lists called "all on the shelf" / "shelf-ready" with no lookup that turn.
  it("rejects a shelf claim when no library lookup ran this turn", () => {
    for (const reply of ["the fall guy, bullet train, red one. all on the shelf.", "sonic 3, big hero 6. all shelf-ready.", "Baywatch is ready to play.", "We have it in our library."])
      expect(shelfClaimError(reply, [search("not json"), { name: "web_search", args: {}, result: "Baywatch" }]), reply).toContain("no library lookup this turn found what you named")
  })

  it("passes a claim for a title the lookup found on the shelf, by media_search item, Jellyfin match or the legacy catalog", () => {
    expect(shelfClaimError("**The Love Hypothesis** (2026) is on the shelf and ready to play.", [search({ items: [{ title: "The Love Hypothesis", on_shelf: true }] })])).toBeNull()
    expect(shelfClaimError("Thor Ragnarok is on the shelf.", [search({ items: [], library_matches: [{ title: "Thor: Ragnarok", in_jellyfin: true }] })])).toBeNull()
    expect(shelfClaimError("Deadpool & Wolverine is on the shelf.", [search({ ok: true, data: { items: [{ untrustedTitle: "Deadpool and Wolverine" }] } }, "sanctuary_search_media_catalog")])).toBeNull()
  })

  // Turn 4: the search listed titles as missing, and the reply still offered them as playable.
  it("rejects a claim that names a title the lookup showed is not on the shelf", () => {
    const tools = [search({ items: [{ title: "Baywatch", on_shelf: true }, { title: "Hot Tub Time Machine", on_shelf: false }], lookup_candidates: [{ title: "21 Jump Street" }] })]
    expect(shelfClaimError("baywatch and hot tub time machine are on the shelf.", tools)).toContain("Hot Tub Time Machine not on the shelf")
    expect(shelfClaimError("baywatch and 21 jump street are on the shelf.", tools)).toContain("21 Jump Street not on the shelf")
  })

  it("ignores titles it cannot use: missing, too short, or a library match not yet in Jellyfin", () => {
    const tools = [search({ items: [{ title: "Up", on_shelf: true }, { on_shelf: true }, { title: "Cars" }], library_matches: [{ title: "Cars", in_jellyfin: false }] })]
    expect(shelfClaimError("Up is on the shelf.", tools)).not.toBeNull()
    expect(shelfClaimError("Cars is on the shelf.", tools)).not.toBeNull()
  })
})
