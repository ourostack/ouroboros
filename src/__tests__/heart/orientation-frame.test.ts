import { describe, expect, it } from "vitest"
import type OpenAI from "openai"
import {
  buildOrientationFrame,
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
  })
})
