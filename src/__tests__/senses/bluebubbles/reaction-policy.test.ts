import { describe, expect, it } from "vitest"
import { classifyBlueBubblesReaction } from "../../../senses/bluebubbles/reaction-policy"

describe("classifyBlueBubblesReaction", () => {
  it.each([
    {
      name: "self before every other predicate",
      input: {
        fromMe: true,
        action: "remove",
        canonicalValue: "custom",
        targetAuthorship: "agent",
        trustedActor: true,
      },
      expected: { route: "capture_only", outcome: "ignored_self" },
    },
    {
      name: "removal before value, target, and trust",
      input: {
        fromMe: false,
        action: "remove",
        canonicalValue: "question",
        targetAuthorship: "agent",
        trustedActor: true,
      },
      expected: { route: "capture_only", outcome: "capture_only_removal" },
    },
    {
      name: "positive addition before target and trust",
      input: {
        fromMe: false,
        action: "add",
        canonicalValue: "love",
        targetAuthorship: "agent",
        trustedActor: true,
      },
      expected: { route: "capture_only", outcome: "capture_only_positive" },
    },
    {
      name: "custom addition before target and trust",
      input: {
        fromMe: false,
        action: "add",
        canonicalValue: "custom",
        targetAuthorship: "agent",
        trustedActor: true,
      },
      expected: { route: "capture_only", outcome: "capture_only_custom" },
    },
    {
      name: "unknown addition before target and trust",
      input: {
        fromMe: false,
        action: "add",
        canonicalValue: "unknown",
        targetAuthorship: "agent",
        trustedActor: true,
      },
      expected: { route: "capture_only", outcome: "capture_only_unknown" },
    },
    {
      name: "negative addition regardless of target and trust",
      input: {
        fromMe: false,
        action: "add",
        canonicalValue: "dislike",
        targetAuthorship: "non_agent_unknown",
        trustedActor: true,
      },
      expected: { route: "capture_only", outcome: "capture_only_negative" },
    },
    {
      name: "question addition regardless of missing target authorship",
      input: {
        fromMe: false,
        action: "add",
        canonicalValue: "question",
        targetAuthorship: null,
        trustedActor: true,
      },
      expected: { route: "capture_only", outcome: "capture_only_question" },
    },
    {
      name: "untrusted negative direct actor",
      input: {
        fromMe: false,
        action: "add",
        canonicalValue: "dislike",
        targetAuthorship: "agent",
        trustedActor: false,
      },
      expected: { route: "capture_only", outcome: "capture_only_negative" },
    },
    {
      name: "question without trust lookup",
      input: {
        fromMe: false,
        action: "add",
        canonicalValue: "question",
        targetAuthorship: "agent",
      },
      expected: { route: "capture_only", outcome: "capture_only_question" },
    },
    {
      name: "trusted negative feedback remains quiet",
      input: {
        fromMe: false,
        action: "add",
        canonicalValue: "dislike",
        targetAuthorship: "agent",
        trustedActor: true,
      },
      expected: { route: "capture_only", outcome: "capture_only_negative" },
    },
  ] as const)("routes $name in fixed precedence", ({ input, expected }) => {
    expect(classifyBlueBubblesReaction(input)).toEqual(expected)
  })
})
