import { describe, expect, it } from "vitest"
import type OpenAI from "openai"
import { registerGlobalLogSink } from "../../nerves"
import {
  buildOrientationFrame,
  extractMessageText,
  labelPriorWorkSurface,
  priorWorkInstruction,
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

  it("adds visible delivery tool text after multimodal assistant content", () => {
    expect(extractMessageText({
      role: "assistant",
      content: [
        { type: "text", text: "visible content" },
      ],
      tool_calls: [
        {
          id: "call-settle",
          type: "function",
          function: {
            name: "settle",
            arguments: JSON.stringify({ answer: "visible settle answer" }),
          },
        },
      ],
    } as any)).toBe("visible content\nvisible settle answer")
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

  it("does not treat exact-output wording as a correction by itself", () => {
    const frame = buildOrientationFrame({
      channel: "mcp",
      messages: [
        { role: "user", content: "Think privately, then return exactly one concise sentence with marker AX_LIVE_A." },
      ],
    })

    expect(frame.signals).toEqual([])
    expect(frame.actionPolicy).toEqual({ mode: "normal" })
  })

  it("surfaces the latest structured output for numeric correction referents", () => {
    const frame = buildOrientationFrame({
      channel: "cli",
      messages: [
        { role: "assistant", content: null, tool_calls: [] } as any,
        { role: "tool", content: "(delivered)", tool_call_id: "call-1" } as any,
        { role: "user", content: "no, number 4 will be sorted" },
      ],
      structuredOutputs: [
        {
          schemaVersion: 1,
          id: "structured-evt-000010-1",
          kind: "ordered_list",
          sourceEventId: "evt-000010",
          recordedAt: "2026-05-19T16:12:41.000Z",
          heading: "Gaps:",
          items: [
            { label: "1", text: "Zurich to Basel" },
            { label: "2", text: "Basel to Lugano" },
            { label: "3", text: "Lugano to Milan" },
            { label: "4", text: "La Villa to MXP" },
          ],
        },
      ],
    })

    expect(frame.signals).toEqual(expect.arrayContaining(["correction_marker", "structured_referent"]))
    expect(frame.latestStructuredOutput).toMatchObject({
      id: "structured-evt-000010-1",
      heading: "Gaps:",
      items: [
        { label: "1", text: "Zurich to Basel" },
        { label: "2", text: "Basel to Lugano" },
        { label: "3", text: "Lugano to Milan" },
        { label: "4", text: "La Villa to MXP" },
      ],
    })
    expect(frame.actionPolicy.mode).toBe("correction_hold")
  })

  it("does not invent a structured referent when no structured output exists", () => {
    const frame = buildOrientationFrame({
      channel: "cli",
      messages: [
        { role: "user", content: "number 4" },
      ],
      structuredOutputs: [],
    })

    expect(frame.latestStructuredOutput).toBeUndefined()
    expect(frame.signals).not.toContain("structured_referent")
    expect(frame.actionPolicy).toEqual({ mode: "normal" })
  })

  it("attaches structured output for non-numeric correction turns", () => {
    const frame = buildOrientationFrame({
      channel: "cli",
      messages: [
        { role: "user", content: "hang on, that should be different" },
      ],
      structuredOutputs: [
        {
          schemaVersion: 1,
          id: "structured-evt-correction-1",
          kind: "ordered_list",
          sourceEventId: "evt-correction",
          recordedAt: "2026-05-19T16:12:41.000Z",
          items: [
            { label: "1", text: "Small" },
            { label: "2", text: "Real substrate" },
          ],
        },
      ],
    })

    expect(frame.signals).toContain("correction_marker")
    expect(frame.latestStructuredOutput?.id).toBe("structured-evt-correction-1")
    expect(frame.actionPolicy.mode).toBe("correction_hold")
  })

  it("leaves structured output detached for ordinary turns", () => {
    const frame = buildOrientationFrame({
      channel: "cli",
      messages: [
        { role: "user", content: "please keep going" },
      ],
      structuredOutputs: [
        {
          schemaVersion: 1,
          id: "structured-evt-ordinary-1",
          kind: "ordered_list",
          sourceEventId: "evt-ordinary",
          recordedAt: "2026-05-19T16:12:41.000Z",
          items: [
            { label: "1", text: "Small" },
            { label: "2", text: "Real substrate" },
          ],
        },
      ],
    })

    expect(frame.signals).toEqual([])
    expect(frame.latestStructuredOutput).toBeUndefined()
    expect(frame.actionPolicy).toEqual({ mode: "normal" })
  })

  it("extracts prior assistant referents from settle tool-call answers", () => {
    const frame = buildOrientationFrame({
      channel: "cli",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-settle",
              type: "function",
              function: {
                name: "settle",
                arguments: JSON.stringify({
                  answer: "Options:\n1. Keep current config\n2. Switch outward lane",
                }),
              },
            },
          ],
        } as any,
        { role: "tool", content: "(delivered)", tool_call_id: "call-settle" } as any,
        { role: "user", content: "number 2" },
      ],
    })

    expect(frame.priorAssistantReferents).toEqual([
      { kind: "ordered_list_item", label: "1", text: "Keep current config" },
      { kind: "ordered_list_item", label: "2", text: "Switch outward lane" },
    ])
    expect(frame.signals).toContain("terse_referent")
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

    expect(rendered).toContain("## Current trigger (authoritative)")
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

  it("renders an observed group actor separately from membership-only participants", () => {
    const frame = buildOrientationFrame({
      channel: "bluebubbles",
      messages: [
        { role: "user", content: "Ari: please end the report" },
      ],
      source: {
        kind: "bluebubbles",
        authority: "presentation_only",
        conversationKind: "group",
        event: {
          provider: "bluebubbles",
          kind: "message",
          sourceEventType: "new-message",
          fromMe: false,
        },
        actor: {
          role: "observed_actor",
          provider: "imessage-handle",
          externalId: "ari@example.test",
          displayName: "Ari",
        },
        participants: [
          {
            role: "group_participant_only",
            provider: "imessage-handle",
            externalId: "rachel@example.test",
            displayName: "Rachel",
          },
        ],
      },
    })

    const rendered = renderOrientationFrame(frame)

    expect(frame.source).toMatchObject({ authority: "presentation_only" })
    expect(rendered).toContain("source authority: presentation only; never tool authority")
    expect(rendered).toContain("event: message (new-message; from me: false)")
    expect(rendered).toContain("observed actor: Ari [imessage-handle:ari@example.test]")
    expect(rendered).toContain("group participant only: Rachel [imessage-handle:rachel@example.test]")
    expect(rendered).toContain(
      "participant membership is not evidence that someone spoke, read, requested, or authored a reaction target.",
    )
    expect(rendered).not.toContain("Rachel spoke")
    expect(rendered).not.toContain("Rachel read")
    expect(rendered).not.toContain("Rachel requested")
  })

  it("distinguishes a reaction trigger and its non-agent unknown target from an utterance", () => {
    const frame = buildOrientationFrame({
      channel: "bluebubbles",
      messages: [
        { role: "user", content: "Ari questioned their message: \"status update\"" },
      ],
      currentUserMessages: [
        { role: "user", content: "Ari questioned their message: \"status update\"" },
      ],
      speechKind: "reaction",
      source: {
        kind: "bluebubbles",
        authority: "presentation_only",
        conversationKind: "group",
        event: {
          provider: "bluebubbles",
          kind: "reaction",
          sourceEventType: "updated-message",
          fromMe: false,
        },
        actor: {
          role: "observed_actor",
          provider: "imessage-handle",
          externalId: "ari@example.test",
          displayName: "Ari",
        },
        participants: [
          {
            role: "group_participant_only",
            provider: "imessage-handle",
            externalId: "rachel@example.test",
            displayName: "Rachel",
          },
        ],
        target: {
          messageGuid: "synthetic-target-guid",
          authorship: "non_agent_unknown",
        },
      },
    })

    const rendered = renderOrientationFrame(frame)

    expect(frame.speechKind).toBe("reaction")
    expect(frame.signals).toEqual([])
    expect(rendered).toContain("speech kind: reaction")
    expect(rendered).toContain("event: reaction (updated-message; from me: false)")
    expect(rendered).toContain("target: synthetic-target-guid (authorship: non_agent_unknown)")
    expect(rendered).not.toContain("target author: Rachel")
  })

  it("uses observed external identities when presentation labels are absent or blank", () => {
    const frame = buildOrientationFrame({
      channel: "bluebubbles",
      messages: [{ role: "user", content: "request" }],
      source: {
        kind: "bluebubbles",
        authority: "presentation_only",
        conversationKind: "group",
        event: {
          provider: "bluebubbles",
          kind: "message",
          sourceEventType: "new-message",
          fromMe: false,
        },
        actor: {
          role: "observed_actor",
          provider: "imessage-handle",
          externalId: "actor@example.test",
          displayName: null,
        },
        participants: [{
          role: "group_participant_only",
          provider: "imessage-handle",
          externalId: "participant@example.test",
          displayName: "   ",
        }],
      },
    })

    const rendered = renderOrientationFrame(frame)

    expect(rendered).toContain(
      "observed actor: actor@example.test [imessage-handle:actor@example.test]",
    )
    expect(rendered).toContain(
      "group participant only: participant@example.test [imessage-handle:participant@example.test]",
    )
  })

  it("renders latest structured output when attached", () => {
    const frame = buildOrientationFrame({
      channel: "cli",
      messages: [
        { role: "user", content: "number 2" },
      ],
      structuredOutputs: [
        {
          schemaVersion: 1,
          id: "structured-evt-000020-1",
          kind: "ordered_list",
          sourceEventId: "evt-000020",
          recordedAt: "2026-05-19T16:12:41.000Z",
          heading: "Directions:",
          items: [
            { label: "1", text: "Small" },
            { label: "2", text: "Real substrate" },
          ],
        },
      ],
    })

    const rendered = renderOrientationFrame(frame)

    expect(rendered).toContain("latest structured output: structured-evt-000020-1")
    expect(rendered).toContain("heading: Directions:")
    expect(rendered).toContain("2. Real substrate")
  })

  it("renders latest structured output without inventing a heading", () => {
    const frame = buildOrientationFrame({
      channel: "cli",
      messages: [
        { role: "user", content: "number 2" },
      ],
      structuredOutputs: [
        {
          schemaVersion: 1,
          id: "structured-evt-no-heading-1",
          kind: "ordered_list",
          sourceEventId: "evt-no-heading",
          recordedAt: "2026-05-19T16:12:41.000Z",
          items: [
            { label: "1", text: "Small" },
            { label: "2", text: "Real substrate" },
          ],
        },
      ],
    })

    const rendered = renderOrientationFrame(frame)

    expect(rendered).toContain("latest structured output: structured-evt-no-heading-1")
    expect(rendered).not.toContain("heading:")
    expect(rendered).toContain("2. Real substrate")
  })

  // ── Regression: 2026-07-27 send block ───────────────────────────────────
  // Verbatim from the incident frame (channel mcp, 195 words, 0 referents, no
  // structured output). The only correction match was "actually", in "unless you
  // actually saw evidence" — inside the very instruction that authorised the send.
  // It armed correction_hold and blocked send_message five times with nothing to
  // disambiguate, so the remedy the block named could not be performed.
  const julyIncidentSpeech = [
    "That's genuinely useful — and it changes the picture: the 5 hotel confirmations predate the outage, so you have what you need to answer Ari's actual question. Do that now, please.",
    "",
    'Ari asked on 2026-07-21: "sanity checking that all hotels i booked for my upcoming travel have ac - can you confirm?" Open each of the confirmations you just listed (Ruby Mimi Zurich, Hotel Marthof Basel, LUGANODANTE Lugano, La Villa Mombaruzzo, The Grafton Hotel Dublin) and check specifically for air conditioning — the amenities lines, room description, or any AC/climate/aircon mention. Where the confirmation doesn\'t say, check your notes/facts, and if it\'s still unknown say "unknown" rather than guessing. Do NOT claim a hotel has AC unless you actually saw evidence.',
    "",
    "Then send Ari ONE clean iMessage (ari@mendelow.me) with a short per-hotel rundown — hotel: yes / no / unknown, one line each, plus a one-line note on how you'd confirm the unknowns (e.g. checking the hotel site or emailing them). Keep it text-length and warm. Your iMessage sending is fixed and working, so it should go through. Send it once and confirm delivery — do not retry on error, just report back what happened.",
  ].join("\n")

  it("does not hold a long standalone instruction that merely contains a correction word", () => {
    const frame = buildOrientationFrame({
      channel: "mcp",
      messages: [{ role: "user", content: julyIncidentSpeech }],
    })

    expect(frame.signals).toContain("correction_marker")
    expect(frame.actionPolicy).toEqual({ mode: "normal" })
  })

  it("still holds a long correction when a structured output is the thing to disambiguate", () => {
    const frame = buildOrientationFrame({
      channel: "mcp",
      messages: [{ role: "user", content: julyIncidentSpeech }],
      structuredOutputs: [
        {
          schemaVersion: 1,
          id: "structured-evt-hotels-1",
          kind: "ordered_list",
          sourceEventId: "evt-hotels",
          recordedAt: "2026-07-27T07:24:51.000Z",
          items: [
            { label: "1", text: "Ruby Mimi Zurich" },
            { label: "2", text: "Hotel Marthof Basel" },
          ],
        },
      ],
    })

    expect(frame.priorAssistantReferents).toEqual([])
    expect(frame.actionPolicy).toMatchObject({ mode: "correction_hold", triggeredBy: "actually" })
  })

  it("still holds a long correction when there is a concrete referent to resolve", () => {
    const frame = buildOrientationFrame({
      channel: "cli",
      messages: [
        { role: "assistant", content: "1. Zurich leg\n2. Basel leg" },
        {
          role: "user",
          content: "no, that is the wrong leg — I meant the other one, please redo the itinerary and resend it to the group once you are done",
        },
      ],
    })

    expect(frame.actionPolicy).toMatchObject({
      mode: "correction_hold",
      blockedMutationKinds: ["durable_state_write", "external_side_effect"],
    })
  })

  it("keeps holding a terse ambiguous correction with nothing to inspect", () => {
    const frame = buildOrientationFrame({
      channel: "cli",
      messages: [
        { role: "assistant", content: "Done." },
        { role: "user", content: "no, not that one" },
      ],
    })

    expect(frame.actionPolicy).toMatchObject({
      mode: "correction_hold",
      triggeredBy: "not that",
    })
  })

  it("names a leading 'no' as the trigger when no other marker matched", () => {
    const frame = buildOrientationFrame({
      channel: "cli",
      messages: [
        { role: "assistant", content: "Done." },
        { role: "user", content: "no, use the other lane" },
      ],
    })

    expect(frame.actionPolicy).toMatchObject({ mode: "correction_hold", triggeredBy: "no" })
  })

  it("emits a greppable armed event naming what is blocked and what clears it", () => {
    const events: Array<{ event: string; meta?: Record<string, unknown> }> = []
    const restore = registerGlobalLogSink((entry) => {
      events.push({ event: entry.event, meta: entry.meta })
    })

    try {
      buildOrientationFrame({
        channel: "cli",
        messages: [
          { role: "assistant", content: "1. Keep minimax\n2. Switch to codex" },
          { role: "user", content: "the first one" },
        ],
      })
    } finally {
      restore()
    }

    const armed = events.find((entry) => entry.event === "orientation.correction_hold_armed")
    expect(armed?.meta).toMatchObject({
      channel: "cli",
      speechKind: "utterance",
      signals: ["terse_referent"],
      blockedMutationKinds: ["durable_state_write", "external_side_effect"],
      referentCount: 2,
      speechWordCount: 3,
    })
    expect(String(armed?.meta?.clearedBy)).toContain("orientation_get")
  })

  it("does not emit the armed event for ordinary turns", () => {
    const events: string[] = []
    const restore = registerGlobalLogSink((entry) => {
      events.push(entry.event)
    })

    try {
      buildOrientationFrame({
        channel: "cli",
        messages: [{ role: "user", content: "please run the tests" }],
      })
    } finally {
      restore()
    }

    expect(events).toContain("orientation.frame_built")
    expect(events).not.toContain("orientation.correction_hold_armed")
  })

  // ── Reactions are approval, never corrections ───────────────────────────
  it("never arms a hold from a reaction, even when the quoted message reads like a correction", () => {
    const frame = buildOrientationFrame({
      channel: "bluebubbles",
      speechKind: "reaction",
      messages: [
        { role: "assistant", content: "1. Zurich\n2. Basel" },
      ],
      currentUserMessages: [
        { role: "user", content: 'loved your message: "actually that was the wrong one, hang on"' },
      ],
      structuredOutputs: [
        {
          schemaVersion: 1,
          id: "structured-evt-reaction-1",
          kind: "ordered_list",
          sourceEventId: "evt-reaction",
          recordedAt: "2026-07-27T07:53:25.000Z",
          items: [
            { label: "1", text: "Zurich" },
            { label: "2", text: "Basel" },
          ],
        },
      ],
    })

    expect(frame.signals).toEqual([])
    expect(frame.actionPolicy).toEqual({ mode: "normal" })
    expect(frame.speechKind).toBe("reaction")
  })

  it("does not arm a hold for a terse reaction over prior referents", () => {
    const frame = buildOrientationFrame({
      channel: "bluebubbles",
      speechKind: "reaction",
      messages: [
        { role: "assistant", content: "1. Keep minimax\n2. Switch to codex" },
      ],
      currentUserMessages: [{ role: "user", content: "liked a message: \"correct\"" }],
    })

    expect(frame.actionPolicy).toEqual({ mode: "normal" })
  })

  it("renders the hold remedy and the reaction speech kind", () => {
    const held = renderOrientationFrame(buildOrientationFrame({
      channel: "cli",
      messages: [
        { role: "assistant", content: "1. Minimax\n2. OpenAI Codex" },
        { role: "user", content: "correct" },
      ],
    }))

    expect(held).toContain("policy blocks: durable_state_write, external_side_effect")
    expect(held).toContain("policy clears when: Resolve the referent")
    expect(held).not.toContain("speech kind:")
    expect(held).toContain('policy trigger: correction marker "correct" in current user speech')

    // terse_referent alone has no marker word to name
    const terseOnly = renderOrientationFrame(buildOrientationFrame({
      channel: "cli",
      messages: [
        { role: "assistant", content: "1. Minimax\n2. OpenAI Codex" },
        { role: "user", content: "the first one" },
      ],
    }))

    expect(terseOnly).toContain("action policy: correction_hold")
    expect(terseOnly).not.toContain("policy trigger:")

    const reacted = renderOrientationFrame(buildOrientationFrame({
      channel: "bluebubbles",
      speechKind: "reaction",
      messages: [],
      currentUserMessages: [{ role: "user", content: 'loved your message: "shipped"' }],
    }))

    expect(reacted).toContain("speech kind: reaction")
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

  it("renders the exact prior-work authority labels without guessing from text", () => {
    expect(priorWorkInstruction(false)).toBe("Background only; do not execute.")
    expect(priorWorkInstruction(true)).toBe("Prior work explicitly resumed by the current trigger.")
    expect(labelPriorWorkSurface("", false)).toBe("")
    expect(labelPriorWorkSurface("**Next:** stale action", false)).toBe(
      "**Next:**\nBackground only; do not execute.\nstale action",
    )
    expect(labelPriorWorkSurface("## stale work\ncontinue it", true)).toBe(
      "## stale work\nPrior work explicitly resumed by the current trigger.\ncontinue it",
    )
    expect(labelPriorWorkSurface("**Owed:**", false)).toBe(
      "**Owed:**\nBackground only; do not execute.",
    )
    expect(labelPriorWorkSurface("continue an unheaded stale action", false)).toBe(
      "Background only; do not execute.\ncontinue an unheaded stale action",
    )
  })
})
