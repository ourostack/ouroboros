import { emitNervesEvent } from "../nerves/runtime"
import { frictionToolResult, type ToolFrictionEnvelope } from "../repertoire/tool-results"

export interface ToolFrictionLedger {
  signatures: Map<string, number>
}

export function createToolFrictionLedger(): ToolFrictionLedger {
  return { signatures: new Map<string, number>() }
}

function parseFrictionResult(result: string): { tool: string; friction: ToolFrictionEnvelope } | null {
  try {
    const parsed = JSON.parse(result) as {
      ok?: boolean
      tool?: string
      friction?: ToolFrictionEnvelope
    }
    if (parsed.ok !== false || !parsed.tool || !parsed.friction || typeof parsed.friction !== "object") {
      return null
    }
    return { tool: parsed.tool, friction: parsed.friction }
  } catch {
    return null
  }
}

export function rewriteToolResultForModel(
  tool: string,
  result: string,
  ledger: ToolFrictionLedger,
): string {
  const parsed = parseFrictionResult(result)
  if (!parsed?.friction.signature) return result

  const seen = ledger.signatures.get(parsed.friction.signature) ?? 0
  ledger.signatures.set(parsed.friction.signature, seen + 1)

  if (seen === 0 || parsed.friction.kind === "systemic_harness_bug") {
    return result
  }

  const escalated: ToolFrictionEnvelope = {
    ...parsed.friction,
    kind: "systemic_harness_bug",
    summary: `${parsed.friction.summary} This looks like a harness-level gap now, not just a one-off repair.`,
    suggested_next_actions: [
      ...parsed.friction.suggested_next_actions,
      {
        kind: "tool",
        tool: "ponder",
        reason: "Create a harness_friction packet before asking the user to retry again.",
      },
    ],
  }

  emitNervesEvent({
    component: "engine",
    event: "engine.tool_friction_escalated",
    message: "tool friction escalated to harness bug",
    meta: {
      tool,
      signature: parsed.friction.signature,
      priorOccurrences: seen,
    },
  })

  return frictionToolResult(tool, escalated)
}
