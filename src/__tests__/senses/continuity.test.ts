import { afterEach, describe, expect, it, vi } from "vitest"

import { setRuntimeLogger } from "../../nerves/runtime"
import {
  classifySteeringFollowUpEffect,
  normalizeContinuityClauses,
  resolveMustResolveBeforeHandoff,
} from "../../senses/continuity"

describe("continuity helpers", () => {
  afterEach(() => {
    setRuntimeLogger(null)
    vi.restoreAllMocks()
  })

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

  it("emits continuity resolution diagnostics", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    setRuntimeLogger(logger)

    expect(resolveMustResolveBeforeHandoff(false, ["work autonomously on this."])).toBe(true)

    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      component: "senses",
      event: "senses.continuity_state_resolved",
      message: "resolved continuity handoff state from ingress text",
      meta: expect.objectContaining({
        initialValue: false,
        finalValue: true,
        ingressCount: 1,
      }),
    }))
  })

  it("classifies steering follow-up effects deterministically", () => {
    expect(classifySteeringFollowUpEffect("only come back if blocked")).toBe("set_no_handoff")
    expect(classifySteeringFollowUpEffect("stop working on that")).toBe("clear_and_supersede")
    expect(classifySteeringFollowUpEffect("hey wait a sec you're doing that wrong")).toBe("none")
  })

  it("emits steering follow-up classification diagnostics", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    setRuntimeLogger(logger)

    expect(classifySteeringFollowUpEffect("stop working on that")).toBe("clear_and_supersede")

    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      component: "senses",
      event: "senses.continuity_follow_up_classified",
      message: "classified steering follow-up continuity effect",
      meta: expect.objectContaining({
        effect: "clear_and_supersede",
        clauseCount: 1,
      }),
    }))
  })
})
