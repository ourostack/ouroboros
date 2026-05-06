import { describe, expect, it } from "vitest"
import { parseRepairProposals } from "../../../heart/daemon/agentic-repair"

/**
 * Layer 3 — parse RepairGuide LLM output into typed `RepairAction` entries.
 *
 * Strategy: the persona content (SOUL.md) instructs the model to emit a
 * `\`\`\`json` block. The parser extracts the first JSON block and walks
 * `proposal.actions[]`, keeping only entries whose `kind` is a known
 * `RepairActionKind`. Unknown kinds are dropped with a warning. If no JSON
 * can be extracted, the entire raw output becomes `fallbackBlob` (today's
 * pre-RepairGuide text-blob behavior is preserved).
 */
describe("parseRepairProposals", () => {
  it("extracts a typed vault-unlock action from a single JSON block", () => {
    const llm = [
      "Here is my analysis.",
      "",
      "```json",
      JSON.stringify({
        actions: [
          {
            kind: "vault-unlock",
            agent: "slugger",
            provider: "anthropic",
            reason: "credential expired",
          },
        ],
      }),
      "```",
      "",
      "Try the action above.",
    ].join("\n")

    const result = parseRepairProposals(llm)
    expect(result.actions).toHaveLength(1)
    expect(result.actions[0].kind).toBe("vault-unlock")
    expect(result.warnings).toEqual([])
    expect(result.fallbackBlob).toBeUndefined()
  })

  it("drops actions with unknown kinds and adds a warning", () => {
    const llm = [
      "```json",
      JSON.stringify({
        actions: [
          { kind: "vault-unlock", agent: "a", provider: "anthropic", reason: "expired" },
          { kind: "exotic-fix", agent: "a", reason: "n/a" },
        ],
      }),
      "```",
    ].join("\n")

    const result = parseRepairProposals(llm)
    expect(result.actions).toHaveLength(1)
    expect(result.actions[0].kind).toBe("vault-unlock")
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain("exotic-fix")
  })

  it("falls back to the raw blob when output is entirely unparseable", () => {
    const llm = "this is just prose with no JSON block"

    const result = parseRepairProposals(llm)
    expect(result.actions).toEqual([])
    expect(result.fallbackBlob).toBe(llm)
  })

  it("falls back to raw blob when JSON block is malformed", () => {
    const llm = "```json\n{ this is broken JSON \n```"

    const result = parseRepairProposals(llm)
    expect(result.actions).toEqual([])
    expect(result.fallbackBlob).toBe(llm)
  })

  it("parses multiple actions from a single proposal", () => {
    const llm = [
      "```json",
      JSON.stringify({
        actions: [
          { kind: "vault-unlock", agent: "a", provider: "anthropic", reason: "r1" },
          { kind: "provider-retry", agent: "b", reason: "transient" },
          { kind: "provider-use", agent: "c", provider: "openai", reason: "selection mismatch" },
        ],
      }),
      "```",
    ].join("\n")

    const result = parseRepairProposals(llm)
    expect(result.actions).toHaveLength(3)
    expect(result.actions.map((a) => a.kind)).toEqual([
      "vault-unlock",
      "provider-retry",
      "provider-use",
    ])
    expect(result.warnings).toEqual([])
  })

  it("accepts every kind in the typed RepairAction catalog", () => {
    const kinds = [
      "vault-create",
      "vault-unlock",
      "vault-replace",
      "vault-recover",
      "provider-auth",
      "provider-retry",
      "provider-use",
    ]
    const llm = [
      "```json",
      JSON.stringify({
        actions: kinds.map((kind) => ({
          kind,
          agent: "a",
          provider: "anthropic",
          reason: `r-${kind}`,
        })),
      }),
      "```",
    ].join("\n")

    const result = parseRepairProposals(llm)
    expect(result.actions).toHaveLength(kinds.length)
    expect(result.actions.map((a) => a.kind)).toEqual(kinds)
    expect(result.warnings).toEqual([])
  })

  it("returns no actions when JSON parses but actions array is missing", () => {
    const llm = [
      "```json",
      JSON.stringify({ notes: ["nothing actionable"] }),
      "```",
    ].join("\n")

    const result = parseRepairProposals(llm)
    expect(result.actions).toEqual([])
    expect(result.fallbackBlob).toBeUndefined()
  })

  it("returns no actions when actions field is not an array", () => {
    const llm = [
      "```json",
      JSON.stringify({ actions: "not-an-array" }),
      "```",
    ].join("\n")

    const result = parseRepairProposals(llm)
    expect(result.actions).toEqual([])
  })

  it("drops action entries that are not objects", () => {
    const llm = [
      "```json",
      JSON.stringify({
        actions: [
          "string-not-object",
          null,
          { kind: "vault-unlock", agent: "a", provider: "anthropic" },
        ],
      }),
      "```",
    ].join("\n")

    const result = parseRepairProposals(llm)
    expect(result.actions).toHaveLength(1)
    expect(result.actions[0].kind).toBe("vault-unlock")
    expect(result.warnings.length).toBeGreaterThanOrEqual(2)
  })

  it("drops action entries missing the kind field", () => {
    const llm = [
      "```json",
      JSON.stringify({
        actions: [
          { agent: "a", reason: "no kind here" },
          { kind: "vault-unlock", agent: "a", provider: "anthropic" },
        ],
      }),
      "```",
    ].join("\n")

    const result = parseRepairProposals(llm)
    expect(result.actions).toHaveLength(1)
    expect(result.warnings).toHaveLength(1)
  })

  it("parses bare JSON object without a fenced block", () => {
    const llm = `prelude prose ${JSON.stringify({
      actions: [
        { kind: "provider-retry", agent: "a", reason: "transient" },
      ],
    })} trailing prose`

    const result = parseRepairProposals(llm)
    expect(result.actions).toHaveLength(1)
    expect(result.actions[0].kind).toBe("provider-retry")
  })

  it("returns no actions when JSON parses to a non-object (e.g., array)", () => {
    const llm = "```json\n[1, 2, 3]\n```"

    const result = parseRepairProposals(llm)
    expect(result.actions).toEqual([])
    expect(result.fallbackBlob).toBeUndefined()
  })

  it("backfills agent label when entry omits agent field", () => {
    const llm = [
      "```json",
      JSON.stringify({
        actions: [{ kind: "vault-unlock", reason: "expired" }],
      }),
      "```",
    ].join("\n")

    const result = parseRepairProposals(llm)
    expect(result.actions).toHaveLength(1)
    expect(result.actions[0].label).toContain("(unknown agent)")
  })

  it("backfills provider on provider-auth when entry omits provider field", () => {
    const llm = [
      "```json",
      JSON.stringify({
        actions: [{ kind: "provider-auth", agent: "a", reason: "auth" }],
      }),
      "```",
    ].join("\n")

    const result = parseRepairProposals(llm)
    expect(result.actions).toHaveLength(1)
    const action = result.actions[0]
    expect(action.kind).toBe("provider-auth")
    if (action.kind === "provider-auth") {
      expect(action.provider).toBe("anthropic")
    }
  })

  it("passes through valid lane on provider-use action", () => {
    const llm = [
      "```json",
      JSON.stringify({
        actions: [
          { kind: "provider-use", agent: "a", reason: "selection mismatch", lane: "inner" },
          { kind: "provider-use", agent: "b", reason: "selection mismatch", lane: "outward" },
        ],
      }),
      "```",
    ].join("\n")

    const result = parseRepairProposals(llm)
    expect(result.actions).toHaveLength(2)
    const inner = result.actions[0]
    const outward = result.actions[1]
    if (inner.kind === "provider-use") expect(inner.lane).toBe("inner")
    if (outward.kind === "provider-use") expect(outward.lane).toBe("outward")
  })

  it("ignores invalid lane on provider-use action", () => {
    const llm = [
      "```json",
      JSON.stringify({
        actions: [
          { kind: "provider-use", agent: "a", reason: "selection mismatch", lane: "totally-bogus" },
        ],
      }),
      "```",
    ].join("\n")

    const result = parseRepairProposals(llm)
    const action = result.actions[0]
    expect(action.kind).toBe("provider-use")
    if (action.kind === "provider-use") {
      expect(action.lane).toBeUndefined()
    }
  })

  it("backfills reason when entry omits reason field", () => {
    const llm = [
      "```json",
      JSON.stringify({
        actions: [{ kind: "vault-unlock", agent: "a" }],
      }),
      "```",
    ].join("\n")

    const result = parseRepairProposals(llm)
    expect(result.actions[0].command).toContain("(no reason given)")
  })

  it("populates a default label/command on each parsed action", () => {
    // The typed RepairAction shape requires label/command/actor — the parser
    // backfills sensible defaults so the action plugs into the existing
    // interactive-repair surface without further massaging.
    const llm = [
      "```json",
      JSON.stringify({
        actions: [
          { kind: "vault-unlock", agent: "slugger", provider: "anthropic", reason: "expired" },
        ],
      }),
      "```",
    ].join("\n")

    const result = parseRepairProposals(llm)
    expect(result.actions[0].label).toBeDefined()
    expect(result.actions[0].label.length).toBeGreaterThan(0)
    expect(result.actions[0].command).toBeDefined()
    expect(result.actions[0].actor).toBeDefined()
  })
})
