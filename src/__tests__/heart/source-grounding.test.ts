import { describe, expect, it } from "vitest"
import { candidateNames, isLookupToolCall, lowercaseListNames, mentions, sourceGroundingError, sourceGroundingFinding, withUnverifiedDisclosure, type TurnToolRecord } from "../../heart/source-grounding"

const lookup = (result: string): TurnToolRecord => ({ name: "web_search", args: { query: "x" }, result })
const REAL_USER = "channel more dross from cradle energy. name the Cradle characters whose energy fits"

describe("isLookupToolCall", () => {
  it("accepts web search, web fetch and read tools, catalog lookups, curl and the books tool", () => {
    for (const name of ["web_search", "web_fetch", "fetch_url", "media_search", "media_episodes"]) expect(isLookupToolCall({ name, args: {}, result: "" })).toBe(true)
    expect(isLookupToolCall({ name: "shell", args: { command: "curl -s https://en.wikipedia.org/wiki/Cradle" }, result: "" })).toBe(true)
    expect(isLookupToolCall({ name: "shell", args: { command: "books search --title x" }, result: "" })).toBe(true)
  })
  it("rejects memory, notes, the diary, ordinary shell and file reads", () => {
    for (const name of ["search_facts", "consult_notes", "consult_diary", "get_friend_note", "read_file"]) expect(isLookupToolCall({ name, args: {}, result: "" })).toBe(false)
    expect(isLookupToolCall({ name: "shell", args: { command: "ls -la" }, result: "" })).toBe(false)
    expect(isLookupToolCall({ name: "shell", args: {}, result: "" })).toBe(false)
  })
})

describe("mentions", () => {
  it("matches whole words only, case-insensitively and across Unicode", () => {
    expect(mentions("Dross is here", "dross")).toBe(true)
    expect(mentions("the Drossel flies", "Dross")).toBe(false)
    expect(mentions("Gross profit", "Dross")).toBe(false)
    expect(mentions("Dross's humor", "Dross")).toBe(true)
    expect(mentions("Éowyn rides", "Éowyn")).toBe(true)
    expect(mentions("Éowyns", "Éowyn")).toBe(false)
    expect(mentions("R2-D2 and C.3PO", "C.3PO")).toBe(true)
  })
})

describe("candidateNames", () => {
  it("finds capitalised names mid-sentence and drops possessives", () => {
    expect(candidateNames("i like Lindon and Yerin's sword")).toEqual(["Lindon", "Yerin"])
  })
  it("ignores short tokens, short acronyms, house vocabulary, months and weekdays", () => {
    expect(candidateNames("so I think the AX of an A2A PR is OK and DNS, Ari said Radarr runs on Tuesday in March with Lodash")).toEqual([])
  })
  it("ignores common words at sentence and bullet starts but keeps every other one", () => {
    expect(candidateNames("Honestly it is fine. Philomena is oblivious.\nBunty is next\n- Lindon fights\n* Yerin too")).toEqual(["Philomena", "Bunty", "Lindon", "Yerin"])
  })
  it("treats only label words as labels: 'Status:' is a label, 'Lindon:' is a name", () => {
    expect(candidateNames("Status: fine.\nNote: ok\n- Lindon: the lead")).toEqual(["Lindon"])
  })
  it("treats a quote as a sentence start and de-duplicates case-insensitively", () => {
    expect(candidateNames("\"The\" Cradle, Dross, then dross again, Dross")).toEqual(["Cradle", "Dross"])
  })
  it("does not treat a mid-sentence dash as a sentence start", () => {
    expect(candidateNames("fits — Magma wins")).toEqual(["Magma"])
  })
})

describe("lowercaseListNames", () => {
  it("finds two or more lowercase names in a list a work cue introduces", () => {
    expect(lowercaseListNames("the characters: lindon, yerin and eithan fit")).toEqual(["lindon", "yerin", "eithan"])
    expect(lowercaseListNames("cast includes sloane, wick; and mercy")).toEqual(["sloane", "wick", "mercy"])
  })
  it("ignores a single lowercase item, common words and lists with no work cue", () => {
    expect(lowercaseListNames("the characters: lindon")).toEqual([])
    expect(lowercaseListNames("names like others, etc, more")).toEqual([])
    expect(lowercaseListNames("fruits: apples, pears and plums")).toEqual([])
    expect(lowercaseListNames("the bands: radarr, sonarr, them")).toEqual([])
  })
})

describe("sourceGroundingError", () => {
  const base = { userText: REAL_USER }

  it("passes replies that make no claim about a work", () => {
    expect(sourceGroundingError({ ...base, answer: "Radarr is up and Jellyfin is fine.", tools: [] })).toBeNull()
    expect(sourceGroundingError({ ...base, answer: "the characters are a mystery.", tools: [] })).toBeNull()
  })

  it("passes house vocabulary even in a reply that mentions a show", () => {
    expect(sourceGroundingError({ ...base, answer: "the show is on the shelf; Radarr and Sonarr agree, Ari.", tools: [] })).toBeNull()
  })

  it("blocks the real invented cast when nothing was looked up", () => {
    const error = sourceGroundingError({ ...base, answer: "From the show, the fits are Philomena, Magma and Bunty. same energy, Ari.", tools: [] })
    expect(error).toContain("Philomena")
    expect(error).toContain("Magma")
    expect(error).toContain("Bunty")
    expect(error).toContain("web_search")
    expect(error).toContain("nothing this turn")
  })

  it("blocks names no lookup result contains, even after a lookup ran", () => {
    const error = sourceGroundingError({ ...base, answer: "the books feature Lindon and Yorick.", tools: [lookup("Lindon is the protagonist of Cradle")] })
    expect(error).toContain("Yorick")
    expect(error).not.toContain("Lindon,")
    expect(error).toContain("do not appear")
  })

  it("passes when every name appears in the lookup results", () => {
    expect(sourceGroundingError({ ...base, answer: "the books have Lindon, Yerin and Eithan's schemes.", tools: [lookup("Lindon, Yerin and Eithan Arelius")] })).toBeNull()
  })

  it("does not let a substring of a looked-up word clear a name", () => {
    expect(sourceGroundingError({ ...base, answer: "the books feature Drossel and Wick.", tools: [lookup("Dross, Wicked, Gross")] })).toContain("Drossel")
  })

  it("does not let memory, notes, the diary or ordinary shell output clear a name", () => {
    for (const name of ["search_facts", "consult_notes", "consult_diary", "get_friend_note"]) {
      const memory: TurnToolRecord = { name, args: {}, result: "Yorick Magma Dross Philomena" }
      expect(sourceGroundingError({ ...base, answer: "the books feature Yorick and Magma.", tools: [memory] }), name).toContain("Yorick")
    }
    const shell: TurnToolRecord = { name: "shell", args: { command: "cat notes.md" }, result: "Yorick Magma" }
    expect(sourceGroundingError({ ...base, answer: "the books feature Yorick and Magma.", tools: [shell] })).toContain("Yorick")
  })

  it("flags names at the start of a sentence or a bullet that are not common words", () => {
    expect(sourceGroundingError({ ...base, answer: "Some options from the books:\n- Philomena\n- Magma\nLindon too", tools: [] })).toContain("Philomena")
    expect(sourceGroundingError({ ...base, answer: "Wick fights in the book. Sloane lies.", tools: [] })).toContain("Wick")
  })

  it("flags a lowercase list of names next to a work cue", () => {
    expect(sourceGroundingError({ ...base, answer: "the characters: philomena, magma and bunty fit.", tools: [] })).toContain("philomena")
  })

  it("is not fooled by a system prompt: a name in the prompt is still unsourced until it is looked up", () => {
    // the gate never reads the system prompt, so SOUL mentioning Dross cannot exempt it
    expect(sourceGroundingError({ userText: "tell me about the series", answer: "In the books, Dross is a sentient parasite and Suriel keeps secrets.", tools: [] })).toContain("Dross")
    expect(sourceGroundingError({ ...base, answer: "Dross is a sentient parasite in the books.", tools: [] })).toContain("Dross")
  })

  it("does not read a leading label as a name", () => {
    expect(sourceGroundingError({ ...base, answer: "Healthy: the show is fine.\nSnoozed: nothing.", tools: [] })).toBeNull()
  })

  it("lets a reply echo names the person used without a lookup when it claims nothing about them", () => {
    expect(sourceGroundingError({ ...base, answer: "which Cradle series do you mean, and what about Dross?", tools: [] })).toBeNull()
  })

  it("requires a lookup before a claim about a name the person used", () => {
    const error = sourceGroundingError({ ...base, answer: "Dross is a sentient parasite in the books.", tools: [] })
    expect(error).toContain("Dross")
    expect(error).toContain("nothing this turn")
    expect(sourceGroundingError({ ...base, answer: "Dross is a sentient parasite in the books.", tools: [lookup("Dross is Lindon's Presence, a spirit of sorts")] })).toBeNull()
    expect(sourceGroundingError({ ...base, answer: "Cradle isn't a show; it is a book series.", tools: [] })).toContain("Cradle")
    expect(sourceGroundingError({ ...base, answer: "the books say Dross's dry humor works.", tools: [] })).toContain("Dross")
  })

  it("does not flag a developer reply with a weak cue and unlisted tool names", () => {
    const dev = "escape the special characters; use Lodash and Vitest, then run the series of checks."
    expect(sourceGroundingError({ userText: "how do I escape regex input?", answer: dev, tools: [] })).toBeNull()
    expect(sourceGroundingError({ userText: "how do I escape regex input?", answer: "escape the special characters with Zorblax.", tools: [] })).toBeNull()
  })

  it("flags a weak cue only with two or more unsourced names", () => {
    expect(sourceGroundingError({ userText: "?", answer: "the characters Zorblax and Quuxil appear.", tools: [] })).toContain("Zorblax")
  })
})

describe("sourceGroundingFinding and withUnverifiedDisclosure", () => {
  it("returns the kind, names and lookup count", () => {
    expect(sourceGroundingFinding({ userText: "?", answer: "the books feature Yorick.", tools: [lookup("nothing")] })).toMatchObject({ kind: "invented", names: ["Yorick"], lookups: 1 })
    expect(sourceGroundingFinding({ userText: "tell me about Dross", answer: "Dross is a spirit in the books.", tools: [] })).toMatchObject({ kind: "unsourced_claim", names: ["Dross"], lookups: 0 })
    expect(sourceGroundingFinding({ userText: "?", answer: "all fine", tools: [] })).toBeNull()
  })
  it("prefixes a plain disclosure naming what could not be verified", () => {
    expect(withUnverifiedDisclosure("Wick fights.", ["Wick"])).toBe("I couldn't verify Wick against a source, so treat that as unconfirmed.\n\nWick fights.")
    expect(withUnverifiedDisclosure("x", ["Wick", "Sloane"])).toContain("treat those as unconfirmed")
  })
})
