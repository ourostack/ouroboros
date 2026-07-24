import { emitNervesEvent } from "../../nerves/runtime"
import type { HabitExecutionAdapter } from "./habit-execution"
import { HabitExecutionRegistry } from "./habit-execution-registry"

export function createPackagedHabitExecutionRegistry(input: {
  agentTurn: HabitExecutionAdapter<unknown>
  mcpTool: HabitExecutionAdapter<unknown>
}): HabitExecutionRegistry {
  if (input.agentTurn.id !== "agent-turn" || input.agentTurn.version !== 1) {
    throw new Error("Packaged agent-turn dependency must be agent-turn@1")
  }
  if (input.mcpTool.id !== "mcp-tool" || input.mcpTool.version !== 1) {
    throw new Error("Packaged MCP dependency must be mcp-tool@1")
  }
  const registry = new HabitExecutionRegistry()
  registry.register(input.agentTurn)
  registry.register(input.mcpTool)
  emitNervesEvent({
    component: "heart",
    event: "heart.packaged_habit_adapters_composed",
    message: "composed packaged generic habit adapters",
    meta: { count: registry.keys().length },
  })
  return registry
}
