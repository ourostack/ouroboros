import { describe, it, expect } from "vitest"
import { hasToolIntent, detectKick } from "../../heart/kicks"
import type { Kick } from "../../heart/kicks"

describe("hasToolIntent", () => {
  it.each([
    // Explicit intent
    "let me read that file",
    "I'll check that for you",
    "I will look into it",
    "I would like to help with that",
    "I want to read the code",
    // "going to" variants
    "I'm going to run the command",
    "going to check the logs",
    "I am going to investigate",
    // Present continuous
    "i'm querying project capabilities next",
    "i'm checking the database now",
    "I am running the tests",
    "I'm investigating the error",
    // Action announcements
    "I need to check the database",
    "I should look at the logs",
    "I can help with that",
    // Obligation
    "I have to check the logs first",
    "we have to investigate this error",
    "I must verify the configuration",
    "we must check the API response",
    // First person plural intent
    "we need to know which process it uses",
    "we should check the endpoint",
    "we can query the API for that",
    "we'll figure it out",
    "we will check that next",
    "we're going to need the project id",
    "we are going to query the capabilities",
    "let's check the logs",
    // Gerund phase shifts
    "entering execution mode.",
    "starting with the first file",
    "proceeding to the next step",
    "switching to plan B",
    // Temporal narration
    "first, I will check the logs",
    "first I need to read the file",
    "now I will investigate",
    "now we need to know which process it uses",
    "next turn will be strict TDD repair",
    "next, I should look at the code",
    "next I will check the tests",
    "next, we should verify",
    "next we query the API",
    // Sequential narration
    "then I check the database",
    "then we query the project capabilities",
    "after that we can create the work item",
    "once I have the data I can proceed",
    "once we know the process template",
    "before I do that, a quick check",
    "before we proceed, one more thing",
    // Future intent
    "I'm about to call the API",
    "we're about to find out",
    "gonna check the logs real quick",
    // Hedged intent
    "allow me to take a look",
    "time to check the logs",
    // Movement narration
    "moving on to the next step",
    "moving to phase 2",
    // Self-narration
    "my next step is to read the file",
    "my plan is to refactor this",
    "the plan is to query each endpoint",
    "tool calls only from here on",
  ])("returns true for intent phrase: %s", (text) => {
    expect(hasToolIntent(text)).toBe(true)
  })

  it.each([
    "LET ME check that",
    "i'll do it",
    "I WILL handle this",
  ])("is case-insensitive: %s", (text) => {
    expect(hasToolIntent(text)).toBe(true)
  })

  it.each([
    "I\u2019ll read that file",      // curly apostrophe \u2019
    "I\u2018m going to check",       // curly apostrophe \u2018
    "I\u2032ll do that",             // prime \u2032
  ])("handles curly quotes/apostrophes: %s", (text) => {
    expect(hasToolIntent(text)).toBe(true)
  })

  // "Continuing" at start of any line
  it.each([
    "Continuing.",
    "continuing",
    "Continuing",
    "continuing.",
    "Continuing the march to 40+.",
    "Continuing the work on the project",
    "Continuing with the next batch.",
    "Continuing to create tasks.",
    "We're at 32 items.\nContinuing the march to 40+.",
  ])("returns true for continuing at line start: %s", (text) => {
    expect(hasToolIntent(text)).toBe(true)
  })

  // "continues" anywhere in text
  it.each([
    "Backlog theatre continues.",
    "The work continues.",
    "The task continues to be complex",
    "The migration continues smoothly",
  ])("returns true for continues: %s", (text) => {
    expect(hasToolIntent(text)).toBe(true)
  })

  // "Next up" pattern
  it.each([
    "Next up:",
    "next up:",
    "Next up, I'll create the task",
  ])("returns true for next up: %s", (text) => {
    expect(hasToolIntent(text)).toBe(true)
  })

  // False negatives — these should NOT match
  it.each([
    "the process is continuing as expected",
    "What's next up on the agenda?",
  ])("returns false for non-intent similar text: %s", (text) => {
    expect(hasToolIntent(text)).toBe(false)
  })

  it.each([
    "Hello",
    "Here is the result",
    "The file contains data",
    "",
    "the tenant supports all four system processes.",
    "we persist.",
    "done. the work item has been created.",
    "the error is on line 42",
    "I found 3 matching files",
    "everything looks good",
    "that completed successfully",
    "the answer is 42",
  ])("returns false for non-intent text: %s", (text) => {
    expect(hasToolIntent(text)).toBe(false)
  })

  it("narration kick message does NOT self-trigger hasToolIntent", () => {
    // The narration kick message is injected as assistant content.
    // If it triggers hasToolIntent(), the next iteration will detect it
    // as narration again, causing an infinite kick loop (Bug 4).
    const narrationKickMessage = detectKick("let me check that")!.message
    expect(narrationKickMessage).toBeDefined()
    expect(hasToolIntent(narrationKickMessage)).toBe(false)
  })
})

describe("detectKick", () => {
  it("returns empty kick for empty string", () => {
    const kick = detectKick("")
    expect(kick).toEqual({ reason: "empty", message: "I sent an empty message by accident — let me try again." })
  })

  it("returns empty kick for whitespace-only content", () => {
    const kick = detectKick("   \n\t  ")
    expect(kick).toEqual({ reason: "empty", message: expect.stringContaining("empty") })
  })

  it("returns narration kick for content with intent phrases", () => {
    const kick = detectKick("let me read that file for you")
    expect(kick).toEqual({ reason: "narration", message: "I narrated instead of acting. Using the tool now -- if done, calling settle." })
  })

  it("returns tool_required kick when toolChoiceRequired is true and content has no intent", () => {
    const kick = detectKick("here are my thoughts on the matter", { toolChoiceRequired: true })
    expect(kick).toEqual({ reason: "tool_required", message: expect.stringContaining("tool-required") })
  })

  it("returns null for normal content without toolChoiceRequired", () => {
    const kick = detectKick("here is the answer you asked for")
    expect(kick).toBeNull()
  })

  it("prioritizes empty over narration", () => {
    // empty content — even if we hypothetically matched intent, empty wins
    const kick = detectKick("")
    expect(kick!.reason).toBe("empty")
  })

  it("prioritizes narration over tool_required", () => {
    // content has intent phrase AND toolChoiceRequired is true — narration wins
    const kick = detectKick("let me check that", { toolChoiceRequired: true })
    expect(kick!.reason).toBe("narration")
  })

  it("tool_required message mentions /tool-required command", () => {
    const kick = detectKick("some response", { toolChoiceRequired: true })
    expect(kick!.message).toContain("/tool-required")
  })

  it("returns null when toolChoiceRequired is false and content is normal", () => {
    const kick = detectKick("the answer is 42", { toolChoiceRequired: false })
    expect(kick).toBeNull()
  })

  it("returns narration kick for bare Continuing.", () => {
    const kick = detectKick("Continuing.")
    expect(kick).toEqual({ reason: "narration", message: expect.stringContaining("narrated") })
  })

  it("returns narration kick for sentence-final continues.", () => {
    const kick = detectKick("Backlog theatre continues.")
    expect(kick).toEqual({ reason: "narration", message: expect.stringContaining("narrated") })
  })

  it("emits engine.error observability event when a kick is detected", async () => {
    const emitNervesEvent = vi.fn()
    vi.resetModules()
    vi.doMock("../../nerves/runtime", () => ({
      emitNervesEvent,
    }))

    const kicks = await import("../../heart/kicks")
    kicks.detectKick("let me check that")

    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "engine.error",
      component: "engine",
    }))
  })
})
