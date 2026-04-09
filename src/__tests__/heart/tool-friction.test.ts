import { describe, expect, it } from "vitest"

import { frictionToolResult } from "../../repertoire/tool-results"
import { createToolFrictionLedger, rewriteToolResultForModel } from "../../heart/tool-friction"

function parse(result: string): any {
  return JSON.parse(result)
}

describe("tool friction ledger", () => {
  it("leaves unstructured or non-friction results untouched", () => {
    const ledger = createToolFrictionLedger()
    const ok = JSON.stringify({ ok: true, tool: "describe_image", data: {} })

    expect(rewriteToolResultForModel("describe_image", "not json", ledger)).toBe("not json")
    expect(rewriteToolResultForModel("describe_image", ok, ledger)).toBe(ok)
  })

  it("preserves the first structured local-repair result", () => {
    const ledger = createToolFrictionLedger()

    const result = rewriteToolResultForModel(
      "describe_image",
      frictionToolResult("describe_image", {
        kind: "local_repair",
        recoverability: "transformable",
        summary: "The source image needs conversion before VLM can use it.",
        signature: "describe_image:image/tiff:oversize",
        suggested_next_actions: [{ kind: "tool", tool: "materialize_attachment", reason: "Need original bytes" }],
      }),
      ledger,
    )

    expect(parse(result).friction.kind).toBe("local_repair")
  })

  it("escalates repeated identical friction into systemic_harness_bug", () => {
    const ledger = createToolFrictionLedger()
    const original = frictionToolResult("describe_image", {
      kind: "local_repair",
      recoverability: "transformable",
      summary: "The source image needs conversion before VLM can use it.",
      signature: "describe_image:image/tiff:oversize",
      suggested_next_actions: [{ kind: "tool", tool: "materialize_attachment", reason: "Need original bytes" }],
    })

    rewriteToolResultForModel("describe_image", original, ledger)
    const escalated = rewriteToolResultForModel("describe_image", original, ledger)
    const parsed = parse(escalated)

    expect(parsed.friction.kind).toBe("systemic_harness_bug")
    expect(parsed.friction.summary).toContain("harness")
    expect(parsed.friction.suggested_next_actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "tool", tool: "ponder" }),
      ]),
    )
  })

  it("does not re-escalate results already marked systemic", () => {
    const ledger = createToolFrictionLedger()
    const original = frictionToolResult("describe_image", {
      kind: "systemic_harness_bug",
      recoverability: "transformable",
      summary: "The harness needs a shared normalizer.",
      signature: "describe_image:image/tiff:oversize",
      suggested_next_actions: [],
    })

    const rewritten = rewriteToolResultForModel("describe_image", original, ledger)
    expect(parse(rewritten).friction.kind).toBe("systemic_harness_bug")
  })
})
