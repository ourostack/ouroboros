// Provider replay-rejection regression bundle.
//
// This file exists as a documentation index for "session shapes that
// providers have rejected on replay." Each test describes a real bug that
// hit live runtime, the PR that fixed it, and the runbook entry. When a
// future debugger sees a 4xx from a provider on what looks like a valid
// turn, they should grep here first — there's a decent chance the shape
// was already encountered, fixed, and locked down.
//
// All tests run against `sanitizeProviderMessages` (the load-time repair
// pass) and assert the post-sanitize shape no longer triggers the
// original rejection class. Each test cites the PR number + the
// `docs/known-issues-and-recovery.md` entry.
//
// New entries: when you encounter a NEW provider replay rejection, add a
// fixture here BEFORE writing the fix. The pre-fix test should fail; the
// post-fix test should pass. That's the empirical proof the fix works.

import { describe, expect, it } from "vitest"
import type OpenAI from "openai"
import { sanitizeProviderMessages } from "../../heart/session-events"

describe("provider replay-rejection regressions", () => {
  describe("MiniMax-M2.7: inline <think> + tool_calls in same assistant message", () => {
    // Bug: MiniMax-M2.7 sometimes emits an assistant turn with both inline
    // `<think>...</think>` reasoning AND tool_calls. When that combination
    // is replayed in a subsequent turn, MiniMax rejects with HTTP 400
    // error 2013 ("tool result's tool id not found").
    //
    // Fix: PR #612 (alpha.492) — strip inline reasoning at persist time
    // (preserve original on `_inline_reasoning` for audit) AND at load
    // time (self-heal existing sessions) via `repairInlineReasoningOnReplay`.
    //
    // Runbook: docs/known-issues-and-recovery.md → "Slugger only produces
    // <think> content with no answer" — first matched bug.
    //
    // AX rule: the synthetic tool-result inserted by repair tells the
    // agent specifically what happened ("inline reasoning was stripped,
    // your reasoning trace is preserved out-of-band, retry the tool call
    // if the work needs to be done") — never silent-strip.
    it("strips <think> from assistant content when assistant also has tool_calls", () => {
      const sanitized = sanitizeProviderMessages([
        { role: "user", content: "what's up?" },
        {
          role: "assistant",
          content: "<think>turning the question over...</think>",
          tool_calls: [{ id: "call_xyz", type: "function" as const, function: { name: "settle", arguments: "{\"answer\":\"ok\"}" } }],
        },
      ])
      const assistant = sanitized.find((m) => m.role === "assistant") as OpenAI.ChatCompletionAssistantMessageParam
      const content = typeof assistant.content === "string" ? assistant.content : ""
      expect(content).not.toContain("<think>")
      // The tool_call survives so subsequent replays can match the tool result.
      expect(assistant.tool_calls).toHaveLength(1)
    })

    it("produces an explanatory synthetic tool-result for the affected tool_call_id", () => {
      // The agent must see what happened. The synthetic message names the
      // cause (provider rejection of think+tool_calls) and the action
      // (retry the tool call if the work isn't done).
      const sanitized = sanitizeProviderMessages([
        { role: "user", content: "earlier message" },
        {
          role: "assistant",
          content: "<think>reasoning the model needed to do</think>",
          tool_calls: [{ id: "call_abc", type: "function" as const, function: { name: "settle", arguments: "{\"answer\":\"ok\"}" } }],
        },
        // Note: no tool_result for call_abc — the original was lost when
        // the API rejected the previous turn's replay
        { role: "user", content: "newer message" },
      ])
      const synthetic = sanitized.find((m) => m.role === "tool" && (m as OpenAI.ChatCompletionToolMessageParam).tool_call_id === "call_abc") as OpenAI.ChatCompletionToolMessageParam
      expect(synthetic).toBeDefined()
      expect(synthetic.content).toContain("inline `<think>")
      expect(synthetic.content).toContain("retry the tool call")
    })
  })

  describe("MiniMax-M2.7: tool_call_id reused across turns + misordered after pruning", () => {
    // Bug: MiniMax-M2.7 reuses canonical tool_call_ids
    // (call_function_<hash>_1) when the same function gets called across
    // turns. After session pruning, a synthetic tool-result for an older
    // (now-pruned) tool_call could end up referencing an id that a NEWER
    // assistant message also uses — but the tool result appears BEFORE
    // its matching assistant. MiniMax rejects: tool_call_id is "found" in
    // the conversation (in a later position), but the tool result has no
    // preceding assistant tool_call to match against.
    //
    // Fix: PR #613 (alpha.493) — position-aware orphan detection in BOTH
    // `repairToolCallSequences` (session-events.ts) AND
    // `repairOrphanedToolCalls` (core.ts). Walk in order, accumulate
    // seenCallIds as each assistant is encountered, drop tool results
    // whose id hasn't been defined yet at that position.
    //
    // Runbook: docs/known-issues-and-recovery.md → same entry as #612,
    // listed as the third layer of the chain.
    it("removes a tool result that appears BEFORE its matching assistant tool_call", () => {
      const sanitized = sanitizeProviderMessages([
        { role: "user", content: "early" },
        // Misplaced: tool result for call_xyz_1 references an id no
        // assistant has defined yet at this position
        { role: "tool", content: "stale orphan from a pruned tool_call", tool_call_id: "call_xyz_1" } as OpenAI.ChatCompletionToolMessageParam,
        { role: "user", content: "middle" },
        // The assistant that defines call_xyz_1 — only NOW
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_xyz_1", type: "function" as const, function: { name: "settle", arguments: "{\"answer\":\"ok\"}" } }],
        },
        // Correctly-ordered following tool result — survives
        { role: "tool", content: "(delivered)", tool_call_id: "call_xyz_1" } as OpenAI.ChatCompletionToolMessageParam,
      ])
      const tools = sanitized.filter((m) => m.role === "tool") as OpenAI.ChatCompletionToolMessageParam[]
      expect(tools.find((m) => m.content === "stale orphan from a pruned tool_call")).toBeUndefined()
      expect(tools.find((m) => m.content === "(delivered)")).toBeDefined()

      // Order invariant: assistant comes before its tool_result.
      const assistantIdx = sanitized.findIndex((m) => m.role === "assistant" && (m as OpenAI.ChatCompletionAssistantMessageParam).tool_calls)
      const toolIdx = sanitized.findIndex((m) => m.role === "tool" && (m as OpenAI.ChatCompletionToolMessageParam).content === "(delivered)")
      expect(assistantIdx).toBeLessThan(toolIdx)
    })
  })

  describe("event-id collision after pruning (sequence reuse)", () => {
    // Bug: events.length + 1 was used for new event sequences, but after
    // event pruning leaves gaps (events at sequences [1, 3, 5, 8, 9]),
    // length is 5 → next event would be sequence 6 → collides with the
    // pruned-and-replayed event 6 if it shows up.
    //
    // Fix: PR #607 + #610 (alpha.485, alpha.488) — use
    // `nextEventSequence(events)` which reduces over actual sequences and
    // returns max+1. The dedup-on-load (also from #607) then catches any
    // residual collision via last-occurrence-wins.
    //
    // This is event-id integrity, not provider replay rejection. Listed
    // here because event-id collisions can break provider replay
    // indirectly when dedup drops the wrong copy of a tool_call+result
    // pair. Cross-reference for completeness.
    it("(see session-events.test.ts → 'duplicate-event-id self-healing' suite)", () => {
      // Listed for cross-reference. The actual regression coverage lives
      // in src/__tests__/heart/session-events.test.ts — this stub keeps
      // the bug class visible in the replay-regression index even when
      // the fix isn't replay-shaped.
      expect(true).toBe(true)
    })
  })

  describe("future entries: how to add a regression here", () => {
    // When you find a new provider replay rejection:
    //
    // 1. Capture the failing session shape from the daemon log.
    // 2. Reduce it to the minimum reproducer.
    // 3. Write the test BEFORE the fix — it should fail with the current
    //    sanitize behavior.
    // 4. Land the fix in `sanitizeProviderMessages` (or the appropriate
    //    repair function in core.ts / session-events.ts).
    // 5. Verify the test now passes and add a brief docstring naming the
    //    PR and runbook entry.
    //
    // The AX rule: any session repair must produce a signal the agent
    // can read and act on. The synthetic tool-result message is the
    // canonical place to surface "what just happened" — see
    // `buildSyntheticToolResultMessage` in session-events.ts.
    it("placeholder: keep this describe block as documentation", () => {
      expect(true).toBe(true)
    })
  })
})
