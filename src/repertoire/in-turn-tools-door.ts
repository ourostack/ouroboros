// The harness's in-turn tools as the Ouro AX X-ray reads them (`xray.ts --tools`): every registered tool with its
// Ouro AX card, and a call answered by the dispatcher's own checks as a typed outcome. A call that passes every check
// is answered without running the tool, so the door never reads, writes or sends anything.
import type OpenAI from "openai"
import { emitNervesEvent } from "../nerves/runtime"
import type { ToolDoorCard } from "./tools-base"
import { preflightToolCall, registeredToolDefinitions } from "./tools"
import { observeTool, ponderTool, restTool, settleTool, speakTool, toolCards as flowCards } from "./tools-flow"
import { typedOutcome, type TypedToolOutcome } from "./tool-error-code"

/** An in-turn tool as tools/list serves it: the function definition the model sees, and its Ouro AX card. */
export interface ListedInTurnTool extends OpenAI.ChatCompletionFunctionTool {
  ax: ToolDoorCard
}

/** The dispatcher's own codes, which any tool can answer before its handler runs. */
export const DISPATCH_ERRORS = [
  { code: "unknown-tool", means: "No tool has that name in this turn.", fix: "Call one the text suggests, or pick one from this turn's tool list." },
  { code: "invalid-arguments", means: "The arguments don't match the tool's parameters, so it didn't run.", fix: "Call it again with the arguments the text names." },
  { code: "not-allowed", means: "The person this turn is for may not use this tool.", fix: "Use a tool this turn offers, or ask the person to do it." },
  { code: "tool-changed", means: "The tool changed or left this turn's tools after it was offered.", fix: "Pick again from the current tool list." },
  { code: "orientation-hold", means: "A correction hold blocks tools that change things until it clears.", fix: "Answer the correction first; read-only tools still work." },
  { code: "guardrail-blocked", means: "A guardrail refused this call; the text says which.", fix: "Do what the text says, such as reading the file before editing it." },
  { code: "commerce-authority-required", means: "A purchase needs a commerce authority token from the person.", fix: "Ask the person to approve the purchase, then call it with the token." },
  { code: "not-run", means: "This X-ray door checked the call but runs no tool.", fix: "Nothing to fix: in a real turn the tool runs." },
] as const

const ENGINE_TOOLS = [settleTool, speakTool, observeTool, restTool, ponderTool]

function card(id: string): ToolDoorCard {
  return flowCards.find((c) => c.id === id)!
}

/** Every in-turn tool the harness registers, with its card: the registered definitions, then the engine's flow tools. */
export function listInTurnTools(): ListedInTurnTool[] {
  const tools = [
    ...registeredToolDefinitions().map((def) => ({ ...def.tool, ax: def.ax })),
    ...ENGINE_TOOLS.map((tool) => ({ ...tool, ax: card(`tool:${tool.function.name}`) })),
  ]
  emitNervesEvent({ component: "tools", event: "tool.door_listed", message: "in-turn tools listed for the X-ray", meta: { count: tools.length } })
  return tools
}

/** A call answered by the dispatcher's checks over every registered tool; one that passes them is not run. */
export async function callInTurnTool(name: string, args: Record<string, string>): Promise<TypedToolOutcome> {
  const selection = { ordinary: registeredToolDefinitions(), engine: ENGINE_TOOLS }
  const prepared = await preflightToolCall(name, args, { toolSelection: selection, signin: async () => undefined })
  const outcome = prepared.kind === "ready"
    ? { state: "refused" as const, text: `${name} passed the dispatcher's checks; this X-ray door runs no tool (code: not-run)`, code: "not-run" }
    : typedOutcome(prepared)
  emitNervesEvent({ component: "tools", event: "tool.door_called", message: "in-turn tool call answered for the X-ray", meta: { name, state: outcome.state } })
  return outcome
}
