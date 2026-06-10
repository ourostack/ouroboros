import { describe, expect, it } from "vitest"

import {
  readContextLossSentinelView,
  refreshContextLossSentinel,
} from "../../heart/context-loss-sentinel"

function providerVisibility(generatedAt: string) {
  const scenario = process.env.SENTINEL_PROVIDER_SCENARIO ?? "ready"
  const outward = configuredLane("outward", generatedAt)
  const inner = configuredLane("inner", generatedAt)

  if (scenario === "outward_failed") {
    outward.readiness = { status: "failed", checkedAt: generatedAt, error: "MiniMax 503", attempts: 2 }
  } else if (scenario === "inner_missing") {
    inner.credential = {
      status: "missing",
      repairCommand: "ouro auth --agent slugger --provider anthropic",
    }
  } else if (scenario === "unknown_readiness") {
    outward.readiness = { status: "unknown", reason: "fresh process has no provider readiness cache" }
  } else if (scenario === "stale_with_evidence") {
    outward.readiness = { status: "stale", checkedAt: "2026-06-08T19:00:00.000Z", reason: "persisted readiness expired" }
  } else if (scenario === "stale_without_evidence") {
    outward.readiness = { status: "stale" }
  }

  return {
    agentName: "slugger",
    lanes: [outward, inner],
  }
}

function configuredLane(lane: "outward" | "inner", generatedAt: string) {
  return {
    lane,
    status: "configured",
    provider: lane === "outward" ? "minimax" : "anthropic",
    model: lane === "outward" ? "minimax-text-01" : "claude-opus-4",
    source: "agent.json",
    readiness: { status: "ready", checkedAt: generatedAt },
    credential: { status: "present", source: `vault:slugger:providers/${lane}`, revision: `rev-${lane}` },
    warnings: [],
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
