export const HARNESS_BOOTSTRAP_PHASES = ["bundle", "psyche", "private-runtime"] as const

export type HarnessBootstrapPhase = (typeof HARNESS_BOOTSTRAP_PHASES)[number]

export interface HarnessToolCall {
  tool: string
  input: Record<string, unknown>
  rationale: string
}

export interface HarnessToolResult {
  tool: string
  success: boolean
  output: string
  meta?: Record<string, unknown>
}

export interface HarnessToolSurface {
  readonly availableTools: readonly string[]
  invoke(call: HarnessToolCall): Promise<HarnessToolResult>
}

export interface HarnessBootstrapStep {
  phase: HarnessBootstrapPhase
  sourcePath: string
  required: boolean
}

export interface HarnessBootstrapPlan {
  steps: HarnessBootstrapStep[]
}
