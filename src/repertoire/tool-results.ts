import { emitNervesEvent } from "../nerves/runtime"

export type ToolFrictionKind =
  | "input_error"
  | "local_repair"
  | "systemic_harness_bug"
  | "external_blocker"

export type ToolRecoverability = "retryable" | "transformable" | "blocked"

export type ToolSuggestedNextAction =
  | {
      kind: "tool"
      tool: string
      reason: string
      args?: Record<string, string>
    }
  | {
      kind: "message"
      message: string
    }

export interface ToolFrictionEnvelope {
  kind: ToolFrictionKind
  recoverability: ToolRecoverability
  summary: string
  signature?: string
  suggested_next_actions: ToolSuggestedNextAction[]
}

function emitToolResultEvent(
  event: string,
  meta: Record<string, unknown>,
  level: "info" | "warn" = "info",
): void {
  emitNervesEvent({
    level,
    component: "tools",
    event,
    message: "tool returned structured result",
    meta,
  })
}

export function okToolResult<T>(tool: string, data: T): string {
  emitToolResultEvent("tool.structured_ok", { tool })
  return JSON.stringify({ ok: true, tool, data }, null, 2)
}

export function frictionToolResult(tool: string, friction: ToolFrictionEnvelope): string {
  emitToolResultEvent(
    "tool.structured_friction",
    {
      tool,
      kind: friction.kind,
      recoverability: friction.recoverability,
      signature: friction.signature,
    },
    "warn",
  )
  return JSON.stringify({ ok: false, tool, friction }, null, 2)
}
