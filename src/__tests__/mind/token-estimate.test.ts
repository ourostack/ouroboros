import { describe, it, expect } from "vitest"
import type OpenAI from "openai"
import { IMAGE_PART_ESTIMATED_TOKENS, estimateTokensForMessage, estimateTokensForMessages } from "../../mind/token-estimate"

describe("token estimator", () => {
  it("estimates tokens for simple string content", () => {
    const msg: OpenAI.ChatCompletionMessageParam = { role: "user", content: "abcd" }
    // overhead + ceil((role + content)/4)
    const t = estimateTokensForMessage(msg)
    expect(t).toBeGreaterThan(0)
  })

  it("handles array content parts safely", () => {
    const msg: any = {
      role: "user",
      content: [{ type: "text", text: "hello" }, { type: "text", text: "world" }],
    }
    const t = estimateTokensForMessage(msg)
    expect(t).toBeGreaterThan(0)
  })

  it("counts raw string entries inside array content parts", () => {
    const msg: any = {
      role: "user",
      content: ["hello", { type: "text", text: "world" }],
    }
    expect(estimateTokensForMessage(msg)).toBeGreaterThan(0)
  })

  it("handles opaque content branches (array fallback, object fallback, primitive)", () => {
    const arrayOpaque: any = { role: "user", content: [{ foo: "bar" }] }
    const objectOpaque: any = { role: "user", content: { foo: "bar" } }
    const primitive: any = { role: "user", content: 42 }

    expect(estimateTokensForMessage(arrayOpaque)).toBeGreaterThan(0)
    expect(estimateTokensForMessage(objectOpaque)).toBeGreaterThan(0)
    expect(estimateTokensForMessage(primitive)).toBeGreaterThan(0)
  })

  it("includes assistant tool_calls (name + args) in estimation", () => {
    const msg: any = {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" },
        },
      ],
    }
    const base: any = { role: "assistant", content: "" }
    expect(estimateTokensForMessage(msg)).toBeGreaterThan(estimateTokensForMessage(base))
  })

  it("includes non-string tool arguments by stringifying objects", () => {
    const withObjectArgs: any = {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_obj",
          type: "function",
          function: { name: "read_file", arguments: { path: "README.md" } },
        },
      ],
    }
    const withoutArgs: any = {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_obj",
          type: "function",
          function: { name: "read_file" },
        },
      ],
    }
    expect(estimateTokensForMessage(withObjectArgs)).toBeGreaterThan(estimateTokensForMessage(withoutArgs))
  })

  it("includes tool_call_id + content for tool messages", () => {
    const msg: any = { role: "tool", tool_call_id: "call_1", content: "result" }
    const base: any = { role: "tool", content: "result" }
    expect(estimateTokensForMessage(msg)).toBeGreaterThan(estimateTokensForMessage(base))
  })

  it("sums messages", () => {
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]
    expect(estimateTokensForMessages(msgs)).toBe(
      estimateTokensForMessage(msgs[0]) + estimateTokensForMessage(msgs[1]),
    )
  })

  it("returns overhead when unexpected getters throw", () => {
    const msg = {
      role: "user",
      get content() {
        throw new Error("boom")
      },
    } as any

    expect(estimateTokensForMessage(msg)).toBe(10)
  })

  it("handles non-Error throws in fallback path", () => {
    const msg = {
      role: "user",
      get content() {
        throw "boom"
      },
    } as any

    expect(estimateTokensForMessage(msg)).toBe(10)
  })

  it("swallows stringify errors from circular values", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const msg: any = { role: "user", content: circular }
    expect(estimateTokensForMessage(msg)).toBeGreaterThan(0)
  })

  it("covers mixed content/tool-call branch variants", () => {
    const msg: any = {
      role: 123, // non-string role branch
      name: "worker", // name metadata branch
      tool_call_id: "call_99",
      content: [
        null, // !part branch
        7, // non-object array-part branch
        { content: "inline-content" }, // object part with content field
        { name: "inline-name" }, // object part with name field
      ],
      tool_calls: [
        null, // non-object tool call branch
        { id: 99, type: 88 }, // id/type non-string branches
        { id: "call_a", type: "function" }, // missing function branch
        { id: "call_b", type: "function", function: {} }, // function.name non-string branch
        { id: "call_c", type: "function", function: { name: "shell", arguments: "{}" } },
      ],
    }

    expect(estimateTokensForMessage(msg)).toBeGreaterThan(0)
  })

  it("handles object content with text and content keys", () => {
    const textObject: any = { role: "user", content: { text: "hello" } }
    const contentObject: any = { role: "user", content: { content: "world" } }

    expect(estimateTokensForMessage(textObject)).toBeGreaterThan(0)
    expect(estimateTokensForMessage(contentObject)).toBeGreaterThan(0)
  })
  it("counts each image part as a fixed cost, after text too, whatever its base64 size", () => {
    const withImage = (base64Chars: number): any => ({
      role: "user",
      content: [
        { type: "text", text: "abcd" },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${"A".repeat(base64Chars)}` } },
      ],
    })
    const textOnly: any = { role: "user", content: [{ type: "text", text: "abcd" }] }

    expect(estimateTokensForMessage(withImage(258_000))).toBe(estimateTokensForMessage(withImage(10)))
    expect(estimateTokensForMessage(withImage(258_000)) - estimateTokensForMessage(textOnly)).toBe(IMAGE_PART_ESTIMATED_TOKENS)
  })
})
