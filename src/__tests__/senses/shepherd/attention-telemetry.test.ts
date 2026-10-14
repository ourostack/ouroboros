import { describe, expect, it } from "vitest"
import { FrontendSessionConflictError, FrontendTurnConflictError } from "../../../heart/frontend-turn-errors"
import { attentionPage } from "../../../senses/shepherd/attention-page"
import { attentionSidebar } from "../../../senses/shepherd/attention-sidebar"
import { registerGlobalLogSink, type LogEvent } from "../../../nerves"

describe("attention transport diagnostics", () => {
  it("traces conflicts and UI generation without recording private locators or entry credentials", () => {
    const events: LogEvent[] = []
    const unregister = registerGlobalLogSink(event => events.push(event))
    const token = "a".repeat(64)
    try {
      new FrontendTurnConflictError("private-turn-locator")
      new FrontendSessionConflictError("private-session-locator")
      attentionPage("private-csp-nonce")
      attentionSidebar(`http://127.0.0.1:12345/#${token}`)
      expect(events.map(event => event.event)).toEqual([
        "heart.frontend_turn_conflict", "heart.frontend_session_conflict",
        "senses.shepherd_attention_page_rendered", "senses.shepherd_attention_sidebar_generated",
      ])
      const serialized = JSON.stringify(events)
      for (const value of ["private-turn-locator", "private-session-locator", "private-csp-nonce", token]) expect(serialized).not.toContain(value)
    } finally { unregister() }
  })
})
