import { describe, expect, it } from "vitest"
import { classifyBlueBubblesReaction } from "../../../senses/bluebubbles/reaction-policy"

describe("classifyBlueBubblesReaction", () => {
  it.each([
    {
      name: "self before action and value",
      input: {
        fromMe: true,
        action: "remove",
        canonicalValue: "custom",
      },
      expected: { route: "capture_only", outcome: "ignored_self" },
    },
    {
      name: "removal before value",
      input: {
        fromMe: false,
        action: "remove",
        canonicalValue: "question",
      },
      expected: { route: "capture_only", outcome: "capture_only_removal" },
    },
    {
      name: "positive addition",
      input: {
        fromMe: false,
        action: "add",
        canonicalValue: "love",
      },
      expected: { route: "capture_only", outcome: "capture_only_positive" },
    },
    {
      name: "custom addition",
      input: {
        fromMe: false,
        action: "add",
        canonicalValue: "custom",
      },
      expected: { route: "capture_only", outcome: "capture_only_custom" },
    },
    {
      name: "unknown addition",
      input: {
        fromMe: false,
        action: "add",
        canonicalValue: "unknown",
      },
      expected: { route: "capture_only", outcome: "capture_only_unknown" },
    },
    {
      name: "negative addition",
      input: {
        fromMe: false,
        action: "add",
        canonicalValue: "dislike",
      },
      expected: { route: "capture_only", outcome: "capture_only_negative" },
    },
    {
      name: "question addition",
      input: {
        fromMe: false,
        action: "add",
        canonicalValue: "question",
      },
      expected: { route: "capture_only", outcome: "capture_only_question" },
    },
  ] as const)("routes $name in fixed precedence", ({ input, expected }) => {
    expect(classifyBlueBubblesReaction(input)).toEqual(expected)
  })
})
