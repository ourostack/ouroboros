import type OpenAI from "openai"
import { buildSystem, flattenSystemPrompt } from "./prompt"
import type { BuildSystemOptions, Channel } from "./prompt"
import type { ResolvedContext } from "./friends/types"
import { emitNervesEvent } from "../nerves/runtime"

export async function refreshSystemPrompt(
  messages: OpenAI.ChatCompletionMessageParam[],
  channel: Channel,
  options?: BuildSystemOptions,
  context?: ResolvedContext,
): Promise<void> {
  const newSystem = await buildSystem(channel, options, context)
  const flattened = flattenSystemPrompt(newSystem)

  if (messages.length > 0 && messages[0].role === "system") {
    messages[0] = { role: "system", content: flattened }
  } else {
    messages.unshift({ role: "system", content: flattened })
  }

  emitNervesEvent({
    event: "mind.system_prompt_refreshed",
    component: "mind",
    message: "system prompt refreshed",
    meta: { channel },
  })
}
