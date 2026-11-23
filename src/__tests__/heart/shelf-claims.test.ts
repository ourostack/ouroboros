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

  // 2026-11-19 on 0.1.0-alpha.1222: "i'll tell you when it's ready to watch" got "My lookup shows You Can See Everything
  // isn't on the shelf." stuck in front of a reply that already said so.
  it("does not read a promise about later as a claim", () => {
    const tools = [search({ items: [{ title: "You Can See Everything", on_shelf: false }] })]
    for (const reply of [
      "You Can See Everything isn't here yet. i'm checking twice a day and will tell you when it's ready to watch",
      "I'll ping you once it's on the shelf.",
      "It should be in the library by Friday.",
      "Nothing to do until it's ready to play.",
      "It will be on the shelf as soon as a real copy is out.",
    ]) expect(shelfClaimError(reply, tools), reply).toBeNull()
    expect(shelfClaimError("You Can See Everything is ready to watch.", tools)).not.toBeNull()
  })

  it("puts the truth in front of an unbacked claim: what the lookup showed missing, or that nothing was checked", () => {
    expect(withShelfDisclosure("all on the shelf.", [])).toBe("I haven't checked the library for that yet, so I can't promise it's on the shelf.\n\nall on the shelf.")
    const tools = [search({ items: [{ title: "Hot Tub Time Machine", on_shelf: false }] })]
    expect(withShelfDisclosure("Hot Tub Time Machine is on the shelf.", tools)).toBe("My lookup shows Hot Tub Time Machine isn't on the shelf.\n\nHot Tub Time Machine is on the shelf.")
  })

  it("names a missing title once when the lookup lists it both as a result and as a candidate", () => {
    const tools = [search({ items: [{ title: "Paddington 2", on_shelf: false }], lookup_candidates: [{ title: "Paddington 2" }] })]
    expect(withShelfDisclosure("Paddington 2 is on the shelf.", tools)).toBe("My lookup shows Paddington 2 isn't on the shelf.\n\nPaddington 2 is on the shelf.")
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

  // 2026-11-07, release gate: the search found The Chef Show on the shelf and the reply said "It's in the library".
  it("passes a claim that names no title when this turn's lookup found something on the shelf", () => {
    const found = [search({ items: [{ title: "The Chef Show", on_shelf: true }, { title: "The Chef Show: Extra", on_shelf: false }] })]
    expect(shelfClaimError("It's in the library and marked available.", found)).toBeNull()
    expect(shelfClaimError("It's in the library.", [search({ items: [{ title: "Dune", on_shelf: false }] })])).toContain("no library lookup this turn found what you named")
    expect(shelfClaimError("It's in the library.", [])).toContain("no library lookup this turn found what you named")
  })

  it("ignores titles it cannot use: missing, too short, or a library match not yet in Jellyfin", () => {
    const tools = [search({ items: [{ title: "Up", on_shelf: true }, { on_shelf: true }, { title: "Cars" }], library_matches: [{ title: "Cars", in_jellyfin: false }] })]
    expect(shelfClaimError("Up is on the shelf.", tools)).not.toBeNull()
    expect(shelfClaimError("Cars is on the shelf.", tools)).not.toBeNull()
  })

  // 2026-11-19, Telegram: the Butler added a book with the bundle's books CLI and said it "is in the library", and the
  // gate told Ari it hadn't checked. The book library backs a book claim; a failed or empty run does not.
  const shell = (command: string, result: unknown) => ({ name: "shell", args: { command }, result: typeof result === "string" ? result : JSON.stringify(result) })
  const BOOK_REPLY = "How to Win Friends and Influence People is in the library and on its way to your PocketBook."
  it("passes a book claim this turn's books CLI backs", () => {
    for (const tools of [
      [shell("./books get 'How to Win Friends and Influence People' --deliver", { ok: true, title: "How to Win Friends and Influence People" })],
      [shell("cd ~/bundle && ./books library find 'How to Win Friends'", { ok: true, results: [{ title: "How to Win Friends and Influence People" }] })],
      [shell("books library add ~/Downloads/how-to-win.epub", "added: How to Win Friends and Influence People (id 42)")],
      [shell("./books deliver 42", { ok: true })],
      [shell("./books library add book.epub", "42")],
    ]) expect(shelfClaimError(BOOK_REPLY, tools), tools[0].args.command).toBeNull()
  })

  it("does not count a books run that failed or found nothing", () => {
    for (const tools of [
      [shell("./books get 'How to Win Friends' --deliver", { ok: false, error: "no match" })],
      [shell("./books library find 'How to Win Friends'", { ok: true, results: [] })],
      [shell("./books get 'How to Win Friends' --deliver", "error: Command failed: exit 1")],
      [shell("ls books", "books")],
      [{ name: "shell", args: {}, result: "ok" }],
      [shell("./books library add book.epub", "  ")],
    ]) expect(shelfClaimError(BOOK_REPLY, tools), tools[0].args.command).not.toBeNull()
  })

  // 2026-11-23, eval replay: the agent ran the books CLI through a shell variable (`B=…/books; $B library find …`), looked
  // again after removing a copy, and said the clean one "is the only copy on the shelf now". The gate did not see the
  // lookup and put "I haven't checked the library" in front of a reply that had checked.
  const ALMANAC = { ok: true, results: [{ id: 189, title: "The Harbour Almanac" }] }
  const ALMANAC_REPLY = "done, the messy copy (187) is out of the library. The Harbour Almanac (189), the clean one, is the only copy on the shelf now."
  it("sees the books CLI run through a variable or alias the same command sets", () => {
    for (const command of [
      "B=/home/ouro/AgentBundles/house.ouro/books/books; $B library find \"The Harbour Almanac\"",
      "B=/home/ouro/AgentBundles/house.ouro/books/books; $B library remove 187; $B library find \"The Harbour Almanac\"",
      "B=\"/home/ouro/bundle/books/books\" && \"$B\" library find 'The Harbour Almanac'",
      "export BOOKS='/home/ouro/bundle/books/books'; ${BOOKS} library find 'The Harbour Almanac'",
      "cd ~/bundle; alias bk=./books; bk library find 'The Harbour Almanac'",
      "alias bk='/home/ouro/bundle/books/books'\nbk get 'The Harbour Almanac' --deliver",
    ]) {
      const tools = [shell(command, ALMANAC)]
      expect(shelfClaimError(ALMANAC_REPLY, tools), command).toBeNull()
    }
  })

  it("still discloses when the variable or alias is not the books CLI, or the run did not look anything up", () => {
    for (const command of [
      "$B library find 'The Harbour Almanac'",
      "B=/usr/bin/calibredb; $B library find 'The Harbour Almanac'",
      "alias bk=ls; bk library find 'The Harbour Almanac'",
      "B=/home/ouro/bundle/books/books; $B library remove 187",
    ]) {
      const tools = [shell(command, ALMANAC)]
      expect(shelfClaimError(ALMANAC_REPLY, tools), command).not.toBeNull()
    }
    // No lookup at all: the reply still goes out with the truth in front.
    expect(withShelfDisclosure(ALMANAC_REPLY, [shell("B=/home/ouro/bundle/books/books; $B library remove 187", { ok: true })]))
      .toBe(`I haven't checked the library for that yet, so I can't promise it's on the shelf.\n\n${ALMANAC_REPLY}`)
  })

  // The next turn the Butler apologised for that line, and the gate put it in front of the apology too.
  it("never gates a reply that apologises for or corrects an earlier disclosure", () => {
    for (const reply of [
      "Sorry about that line saying I hadn't checked the library. The book is in the library and on its way.",
      "Ignore the note above, my mistake: it's in our library.",
      "Apologies, the \"can't promise it's on the shelf\" line was wrong. It's in the library.",
    ]) expect(shelfClaimError(reply, []), reply).toBeNull()
    // Saying sorry is not enough on its own: the reply has to be about the disclosure.
    expect(shelfClaimError("Sorry for the wait! Dune is on the shelf.", [])).not.toBeNull()
  })

  it("does not say it hasn't checked when a lookup ran and found nothing to match", () => {
    expect(withShelfDisclosure("It's in the library.", [search({ items: [{ title: "Dune", on_shelf: false }] })]))
      .toBe("My library lookup didn't find that, so I can't promise it's on the shelf.\n\nIt's in the library.")
  })
})
