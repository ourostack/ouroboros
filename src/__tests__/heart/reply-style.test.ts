import { describe, expect, it } from "vitest"
import { BRIEF_MAX_CHARS, briefStyleRequested, briefStyleViolation, savedCommunicationPreference } from "../../heart/reply-style"

describe("briefStyleRequested", () => {
  it("is on when the person asks for brevity in their own words", () => {
    for (const text of ["be brief from now on, no sections", "keep replies short", "keep it tight please", "can you be more concise", "more brevity", "no sections", "short answers only", "be terse"]) {
      expect(briefStyleRequested([text]), text).toBe(true)
    }
  })
  it("is off for ordinary messages and when nothing was said", () => {
    expect(briefStyleRequested([])).toBe(false)
    expect(briefStyleRequested(["what time does the library close?", "short on time today"])).toBe(false)
  })
  it("lets a later message take it back, and a later ask put it on again", () => {
    expect(briefStyleRequested(["be brief", "actually give me more detail on this one"])).toBe(false)
    expect(briefStyleRequested(["be brief", "you can be longer now", "ok be concise again"])).toBe(true)
  })
  it("reads a saved communication preference as the same request", () => {
    expect(briefStyleRequested(["hi"], "Keep replies short")).toBe(true)
    expect(briefStyleRequested(["hi"], "texts after 9pm")).toBe(false)
    expect(briefStyleRequested(["hi"], undefined)).toBe(false)
    expect(briefStyleRequested(["tell me more detail"], "keep replies short")).toBe(false)
  })
})

describe("briefStyleViolation", () => {
  it("passes a short plain answer", () => {
    expect(briefStyleViolation("The library closes at nine. Bring your card.")).toBeNull()
    expect(briefStyleViolation("Did you mean the downtown branch?")).toBeNull()
    expect(briefStyleViolation("**Done.** It is nine.")).toBeNull()
  })
  it("rejects an answer longer than the brief limit", () => {
    expect(briefStyleViolation("x".repeat(BRIEF_MAX_CHARS + 1))).toContain(String(BRIEF_MAX_CHARS))
    expect(briefStyleViolation("x".repeat(BRIEF_MAX_CHARS))).toBeNull()
  })
  it("rejects markdown headers and bold section labels", () => {
    expect(briefStyleViolation("## Status\nall fine")).toContain("section")
    expect(briefStyleViolation("**Status**\nall fine")).toContain("section")
    expect(briefStyleViolation("**Status:** all fine")).toContain("section")
    expect(briefStyleViolation("- **Status** — fine")).toContain("section")
  })
  it("rejects a question tacked onto an answer, but not a lone clarifying question", () => {
    expect(briefStyleViolation("It is nine. Want me to set a reminder?")).toContain("question")
  })
  it("lists every problem at once", () => {
    const error = briefStyleViolation(`## Plan\n${"y".repeat(BRIEF_MAX_CHARS)}. Want more?`)!
    expect(error).toContain("section")
    expect(error).toContain(String(BRIEF_MAX_CHARS))
    expect(error).toContain("question")
  })
})

describe("savedCommunicationPreference", () => {
  it("reads the relationship policy first, then the older tool preferences", () => {
    expect(savedCommunicationPreference(undefined)).toBeUndefined()
    expect(savedCommunicationPreference({})).toBeUndefined()
    expect(savedCommunicationPreference({ relationshipPolicy: { preferences: {} } })).toBeUndefined()
    expect(savedCommunicationPreference({ relationshipPolicy: { preferences: { communication: { value: "keep it short" } } }, toolPreferences: { communication: "old" } })).toBe("keep it short")
    expect(savedCommunicationPreference({ toolPreferences: { communication: "be concise" } })).toBe("be concise")
    expect(savedCommunicationPreference({ relationshipPolicy: { preferences: { communication: { value: null } } } })).toBeUndefined()
  })
})
