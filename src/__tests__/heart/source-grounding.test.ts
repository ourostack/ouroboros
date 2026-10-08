import { describe, expect, it } from "vitest"
import { candidateNames, isLookupToolCall, sourceGroundingError, type TurnToolRecord } from "../../heart/source-grounding"

const SYSTEM = "you are the butler. you manage Radarr, Sonarr and Jellyfin for Ari. answer from primary sources. honestly keep replies short."
const lookup = (result: string): TurnToolRecord => ({ name: "web_search", args: { query: "x" }, result })

describe("isLookupToolCall", () => {
  it("accepts web search, web fetch and read tools, catalog lookups, curl and the books tool", () => {
    expect(isLookupToolCall({ name: "web_search", args: {}, result: "" })).toBe(true)
    expect(isLookupToolCall({ name: "web_fetch", args: {}, result: "" })).toBe(true)
    expect(isLookupToolCall({ name: "fetch_url", args: {}, result: "" })).toBe(true)
    expect(isLookupToolCall({ name: "media_search", args: {}, result: "" })).toBe(true)
    expect(isLookupToolCall({ name: "shell", args: { command: "curl -s https://en.wikipedia.org/wiki/Cradle" }, result: "" })).toBe(true)
    expect(isLookupToolCall({ name: "shell", args: { command: "books search --title x" }, result: "" })).toBe(true)
  })
  it("rejects memory, state and unrelated tools", () => {
    expect(isLookupToolCall({ name: "search_facts", args: {}, result: "" })).toBe(false)
    expect(isLookupToolCall({ name: "consult_notes", args: {}, result: "" })).toBe(false)
    expect(isLookupToolCall({ name: "shell", args: { command: "ls -la" }, result: "" })).toBe(false)
    expect(isLookupToolCall({ name: "shell", args: {}, result: "" })).toBe(false)
    expect(isLookupToolCall({ name: "read_file", args: { path: "/tmp/x" }, result: "" })).toBe(false)
  })
})

describe("candidateNames", () => {
  const common = new Set(["honestly", "the", "i"])
  it("finds capitalised names mid-sentence and drops possessives", () => {
    expect(candidateNames("i like Lindon and Yerin's sword", common)).toEqual(["Lindon", "Yerin"])
  })
  it("ignores short tokens, short acronyms and the pronoun I", () => {
    expect(candidateNames("so I think the AX of an A2A PR is OK and DNS", common)).toEqual([])
  })
  it("ignores common words at sentence starts but keeps unknown ones", () => {
    expect(candidateNames("Honestly it is fine. Philomena is oblivious.\nBunty is next", common)).toEqual(["Philomena", "Bunty"])
  })
  it("treats a list marker or quote as a sentence start", () => {
    expect(candidateNames("- The Cradle\n* \"Honestly\" he said", common)).toEqual(["Cradle"])
  })
  it("de-duplicates case-insensitively", () => {
    expect(candidateNames("Dross, then dross again, Dross", common)).toEqual(["Dross"])
  })
  it("does not treat a mid-sentence dash as a sentence start", () => {
    expect(candidateNames("fits — Magma wins", common)).toEqual(["Magma"])
  })
})

describe("sourceGroundingError", () => {
  const base = { systemText: SYSTEM, userText: "channel more dross from cradle energy. name the Cradle characters whose energy fits" }

  it("passes replies that make no claim about a work", () => {
    expect(sourceGroundingError({ ...base, answer: "Radarr is up and Jellyfin is fine.", tools: [] })).toBeNull()
    expect(sourceGroundingError({ ...base, answer: "the characters are a mystery.", tools: [] })).toBeNull()
  })

  it("passes house vocabulary even in a reply that mentions a show", () => {
    expect(sourceGroundingError({ ...base, answer: "the show is on the shelf; Radarr and Sonarr agree, Ari.", tools: [] })).toBeNull()
  })

  it("blocks invented characters when nothing was looked up", () => {
    const error = sourceGroundingError({ ...base, answer: "the show has Philomena, Magma and Bunty. same energy, Ari.", tools: [] })
    expect(error).toContain("Philomena")
    expect(error).toContain("Magma")
    expect(error).toContain("Bunty")
    expect(error).toContain("web_search")
    expect(error).toContain("nothing this turn")
  })

  it("blocks names that no lookup result contains, even after a lookup ran", () => {
    const error = sourceGroundingError({ ...base, answer: "the books feature Lindon and Yorick.", tools: [lookup("Lindon is the protagonist of Cradle")] })
    expect(error).toContain("Yorick")
    expect(error).not.toContain("Lindon,")
    expect(error).toContain("do not appear")
  })

  it("passes when every name appears in the lookup results", () => {
    expect(sourceGroundingError({ ...base, answer: "the books have Lindon, Yerin and Eithan's schemes.", tools: [lookup("Lindon, Yerin and Eithan Arelius")] })).toBeNull()
  })

  it("accepts names any tool returned, but memory does not count as a lookup of the work", () => {
    const memory: TurnToolRecord = { name: "search_facts", args: {}, result: "Yorick Magma Dross" }
    expect(sourceGroundingError({ ...base, answer: "the books feature Yorick.", tools: [memory] })).toBeNull()
    expect(sourceGroundingError({ ...base, answer: "Dross is a sentient parasite in the books.", tools: [memory] })).toContain("Dross")
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
})
