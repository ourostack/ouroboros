import { describe, expect, it } from "vitest"

import {
  readContextLossSentinelView,
  refreshContextLossSentinel,
} from "../../heart/context-loss-sentinel"

function providerVisibility(generatedAt: string) {
  return {
    agentName: "slugger",
    lanes: [
      {
        lane: "outward",
        status: "configured",
        provider: "minimax",
        model: "minimax-text-01",
        source: "agent.json",
        readiness: { status: "ready", checkedAt: generatedAt },
        credential: { status: "present", source: "vault:slugger:providers/outward" },
        warnings: [],
      },
      {
        lane: "inner",
        status: "configured",
        provider: "anthropic",
        model: "claude-opus-4",
        source: "agent.json",
        readiness: { status: "ready", checkedAt: generatedAt },
        credential: { status: "present", source: "vault:slugger:providers/inner" },
        warnings: [],
      },
    ],
  }
}

describe.skipIf(!process.env.SENTINEL_AGENT_ROOT)("child Sentinel refresh", () => {
  it("writes one receipt from a separate process", async () => {
    const agentRoot = process.env.SENTINEL_AGENT_ROOT!
    const receiptId = process.env.SENTINEL_RECEIPT_ID!
    const generatedAt = process.env.SENTINEL_GENERATED_AT!
    const delayBeforeWriteMs = Number(process.env.SENTINEL_DELAY_MS ?? "0")

    await refreshContextLossSentinel("slugger", agentRoot, {
      trigger: process.env.SENTINEL_TRIGGER as any,
      now: () => new Date(generatedAt),
      createReceiptId: () => receiptId,
      providerVisibility: providerVisibility(generatedAt) as any,
      daemonHealthResults: [
        { name: "agent-processes", status: "ok", message: "all managed agents running" },
      ],
      gitStatus: () => ({ ok: true, porcelain: "" }),
      delayBeforeWriteMs,
    })

    expect(readContextLossSentinelView(agentRoot, { limit: 10 }).history.map((entry) => entry.id)).toContain(receiptId)
  })
})
