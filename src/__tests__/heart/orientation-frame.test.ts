import { describe, expect, it } from "vitest"
import type OpenAI from "openai"
import {
  buildOrientationFrame,
  extractMessageText,
  renderOrientationFrame,
} from "../../heart/orientation-frame"

describe("orientation frame", () => {
  it("separates current user speech from prior assistant referents", () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "system prompt" },
      {
        role: "assistant",
        content: "I see three directions:\n1. Safe but too small.\n2) Better substrate.\n3. Wild research moonshot.",
      },
      { role: "user", content: "same" },
    ]

    const frame = buildOrientationFrame({ channel: "bluebubbles", messages })

    expect(frame.currentUserSpeech).toEqual(["same"])
    expect(frame.priorAssistantReferents).toEqual([
      { kind: "ordered_list_item", label: "1", text: "Safe but too small." },
      { kind: "ordered_list_item", label: "2", text: "Better substrate." },
      { kind: "ordered_list_item", label: "3", text: "Wild research moonshot." },
    ])
    expect(frame.signals).toEqual(expect.arrayContaining(["terse_referent"]))
    expect(frame.actionPolicy).toMatchObject({
      mode: "correction_hold",
      reason: "Current user speech appears referent-dependent; inspect orientation before mutating durable state.",
    })
  })

  it("extracts text from multimodal current user messages and ignores non-text parts", () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "assistant", content: "What changed?" },
      {
        role: "user",
        content: [
          { type: "text", text: "hang on, not that one" },
          { type: "image_url", image_url: { url: "file:///tmp/example.png" } },
        ],
      },
    ]

    const frame = buildOrientationFrame({ channel: "cli", messages })

    expect(frame.currentUserSpeech).toEqual(["hang on, not that one"])
    expect(frame.signals).toEqual(expect.arrayContaining(["correction_marker"]))
    expect(frame.actionPolicy.mode).toBe("correction_hold")
  })

  it("extracts empty text from absent or non-text content", () => {
    expect(extractMessageText(undefined)).toBe("")
    expect(extractMessageText({ role: "user", content: null } as any)).toBe("")
  })

  it("skips malformed multimodal parts while preserving text parts", () => {
    expect(extractMessageText({
      role: "user",
      content: [
        "not a content object",
        { type: "text", text: "keep this" },
      ],
    } as any)).toBe("keep this")
  })

  it("keeps ordinary turns in normal action policy", () => {
    const frame = buildOrientationFrame({
      channel: "cli",
      messages: [
        { role: "assistant", content: "I can do that." },
        { role: "user", content: "please run the tests" },
      ],
    })

    expect(frame.signals).toEqual([])
    expect(frame.actionPolicy).toEqual({ mode: "normal" })
  })

  it("handles a user-only turn without inventing prior referents", () => {
    const frame = buildOrientationFrame({
      channel: "cli",
      messages: [
        { role: "user", content: "please keep going" },
      ],
    })

    expect(frame.currentUserSpeech).toEqual(["please keep going"])
    expect(frame.priorAssistantReferents).toEqual([])
    expect(frame.actionPolicy).toEqual({ mode: "normal" })
  })

  it("caps prior assistant referents at twelve ordered list entries", () => {
    const assistantList = Array.from({ length: 13 }, (_, index) => `${index + 1}. option ${index + 1}`).join("\n")

    const frame = buildOrientationFrame({
      channel: "cli",
      messages: [
        { role: "assistant", content: assistantList },
        { role: "user", content: "12" },
      ],
    })

    expect(frame.priorAssistantReferents).toHaveLength(12)
    expect(frame.priorAssistantReferents.at(-1)).toMatchObject({ label: "12", text: "option 12" })
  })

  it("accepts explicit current user messages when the channel separates them from history", () => {
    const frame = buildOrientationFrame({
      channel: "bluebubbles",
      messages: [
        { role: "assistant", content: "1. Keep minimax\n2. Switch to codex" },
      ],
      currentUserMessages: [
        { role: "user", content: "the first one" },
      ],
    })

    expect(frame.currentUserSpeech).toEqual(["the first one"])
    expect(frame.priorAssistantReferents).toEqual([
      { kind: "ordered_list_item", label: "1", text: "Keep minimax" },
      { kind: "ordered_list_item", label: "2", text: "Switch to codex" },
    ])
    expect(frame.signals).toContain("terse_referent")
  })

  it("renders empty speech and recent lane summaries for orientation-only turns", () => {
    const frame = buildOrientationFrame({
      channel: "bluebubbles",
      messages: [
        { role: "assistant", content: "waiting" },
      ],
      source: {
        kind: "bluebubbles",
        recentLanes: [
          { key: "top_level", label: "", snippet: "latest top-level turn" },
          { key: "thread:THREAD-1", label: "thread:THREAD-1", snippet: "latest thread turn" },
        ],
      },
    })

    const rendered = renderOrientationFrame(frame)

    expect(frame.currentUserSpeech).toEqual([])
    expect(rendered).toContain("- (none)")
    expect(rendered).toContain("- recent lanes:")
    expect(rendered).toContain("  - top_level: latest top-level turn")
    expect(rendered).toContain("  - thread:THREAD-1: latest thread turn")
  })

  it("renders a compact queryable frame", () => {
    const frame = buildOrientationFrame({
      channel: "bluebubbles",
      messages: [
        { role: "assistant", content: "1. Minimax\n2. OpenAI Codex" },
        { role: "user", content: "correct" },
      ],
      source: {
        kind: "bluebubbles",
        lane: "thread",
        defaultReplyTarget: "current_lane",
        threadId: "THREAD-1",
        replyingToText: "the message being corrected",
        repairNotice: "repair kept the attachment visible",
        routingHint: "choose the lane before replying",
      },
    })

    const rendered = renderOrientationFrame(frame)

    expect(rendered).toContain("## orientation frame")
    expect(rendered).toContain("channel: bluebubbles")
    expect(rendered).toContain("action policy: correction_hold")
    expect(rendered).toContain("current user speech:")
    expect(rendered).toContain("- correct")
    expect(rendered).toContain("prior assistant referents:")
    expect(rendered).toContain("1. Minimax")
    expect(rendered).toContain("source:")
    expect(rendered).toContain("lane: thread")
    expect(rendered).toContain("replying to: the message being corrected")
    expect(rendered).toContain("repair notice: repair kept the attachment visible")
    expect(rendered).toContain("routing hint: choose the lane before replying")
  })

  it("renders frames without source metadata", () => {
    const frame = buildOrientationFrame({
      channel: "cli",
      messages: [
        { role: "user", content: "ordinary request" },
      ],
    })

    const rendered = renderOrientationFrame(frame)

    expect(rendered).toContain("channel: cli")
    expect(rendered).not.toContain("source:")
  })
})
