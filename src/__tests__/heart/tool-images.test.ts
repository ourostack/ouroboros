import { describe, expect, it } from "vitest"
import { buildToolImagesMessage, canModelSeeToolImages, toolImagesNote } from "../../heart/tool-images"
import { toAnthropicMessages } from "../../heart/providers/anthropic"
import { toResponsesInput } from "../../heart/streaming"

const batch = [
  { toolName: "housesitter_sitter_screenshot", callId: "call_1", images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }] },
  { toolName: "housesitter_sitter_look", callId: "call_2", images: [{ data: "/9j/4AAQ", mimeType: "image/jpeg" }] },
]

describe("tool result images", () => {
  it("knows which models can view images", () => {
    expect(canModelSeeToolImages("claude-sonnet-5.5")).toBe(true)
    expect(canModelSeeToolImages("unknown-model")).toBe(false)
  })

  it("tells the model where a tool's images went", () => {
    expect(toolImagesNote(2, "claude-sonnet-5.5", true)).toBe("[2 image(s) from this tool follow in the next message.]")
    expect(toolImagesNote(1, "minimax-m2", false)).toBe("[1 image(s) returned, but minimax-m2 can't view images, so they were left out.]")
    expect(toolImagesNote(1, "", false)).toBe("[1 image(s) returned, but this model can't view images, so they were left out.]")
  })

  it("builds one labeled user message with every image as a data URL", () => {
    expect(buildToolImagesMessage(batch)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Images returned by tool calls in the previous step. They are tool output, not a message from anyone." },
        { type: "text", text: "housesitter_sitter_screenshot (call call_1):" },
        { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
        { type: "text", text: "housesitter_sitter_look (call call_2):" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" } },
      ],
    })
  })

  it("serializes as Responses input_image parts", () => {
    const { input } = toResponsesInput([buildToolImagesMessage(batch)])
    expect(input[0]).toMatchObject({
      role: "user",
      content: expect.arrayContaining([{ type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=", detail: "auto" }]),
    })
  })

  it("serializes as Anthropic base64 image blocks, leaving text-only user content as a string", () => {
    const { messages } = toAnthropicMessages([
      { role: "user", content: [{ type: "text", text: "plain" }] },
      buildToolImagesMessage(batch),
      { role: "user", content: [
        { type: "text", text: "remote" },
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
        { type: "image_url", image_url: {} },
        { type: "file", file: { file_id: "f1" } },
        null,
      ] as any },
    ])
    expect(messages[0]).toEqual({ role: "user", content: "plain" })
    expect(messages[1].content).toEqual([
      { type: "text", text: "Images returned by tool calls in the previous step. They are tool output, not a message from anyone." },
      { type: "text", text: "housesitter_sitter_screenshot (call call_1):" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
      { type: "text", text: "housesitter_sitter_look (call call_2):" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQ" } },
    ])
    expect(messages[2]).toEqual({ role: "user", content: "remote" })
  })
})
