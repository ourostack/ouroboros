import { describe, expect, it } from "vitest"
import {
  classifySteeringFollowUpEffect,
  normalizeContinuityClauses,
  resolveMustResolveBeforeHandoff,
} from "../../senses/continuity"

describe("continuity helpers", () => {
  it("normalizes punctuation-heavy clauses into exact inventory form", () => {
    expect(normalizeContinuityClauses("Don't return control until complete or blocked!!!")).toEqual([
      "dont return control until complete or blocked",
    ])
  })

  it("preserves the prior flag when ingress text is absent", () => {
    expect(resolveMustResolveBeforeHandoff(true, undefined)).toBe(true)
    expect(resolveMustResolveBeforeHandoff(false, undefined)).toBe(false)
  })

  it("applies cancel and no-handoff clauses left to right", () => {
    expect(resolveMustResolveBeforeHandoff(true, ["cancel that. work autonomously on this."])).toBe(true)
    expect(resolveMustResolveBeforeHandoff(false, ["work autonomously on this. never mind."])).toBe(false)
  })

  it("classifies steering follow-up effects deterministically", () => {
    expect(classifySteeringFollowUpEffect("only come back if blocked")).toBe("set_no_handoff")
    expect(classifySteeringFollowUpEffect("stop working on that")).toBe("clear_and_supersede")
    expect(classifySteeringFollowUpEffect("hey wait a sec you're doing that wrong")).toBe("none")
  })
})
