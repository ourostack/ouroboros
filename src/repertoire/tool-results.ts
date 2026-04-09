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

export function okToolResult<T>(tool: string, data: T): string {
  emitNervesEvent({
    component: "tools",
    event: "tool.structured_ok",
    message: "tool returned structured result",
    meta: { tool },
  })
  return JSON.stringify({ ok: true, tool, data }, null, 2)
}

export function frictionToolResult(tool: string, friction: ToolFrictionEnvelope): string {
  emitNervesEvent({
    level: "warn",
    component: "tools",
    event: "tool.structured_friction",
    message: "tool returned structured result",
    meta: {
      tool,
      kind: friction.kind,
      recoverability: friction.recoverability,
      signature: friction.signature,
    },
  })
  return JSON.stringify({ ok: false, tool, friction }, null, 2)
}
