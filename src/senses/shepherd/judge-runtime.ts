import { createProviderRegistry, getProviderRuntime, type ProviderRuntime } from "../../heart/core"
import { loadAgentConfig } from "../../heart/identity"
import { readProviderCredentialRecord } from "../../heart/provider-credentials"
import { emitNervesEvent } from "../../nerves/runtime"
import { redactSecrets } from "./redact"

export const SHEPHERD_GITHUB_COPILOT_MODEL = "claude-haiku-5.5"

/** A fresh tool-free judge runtime; never changes or shares the agent's conversation state. */
export async function getShepherdJudgeRuntime(owner: { agentName: string; agentRoot: string }): Promise<ProviderRuntime> {
  const { provider } = loadAgentConfig(owner).agentFacing
  if (provider !== "github-copilot") return getProviderRuntime("agent", owner)
  const model = SHEPHERD_GITHUB_COPILOT_MODEL
  try {
    const credential = await readProviderCredentialRecord(owner.agentName, provider)
    if (!credential.ok) throw new Error([
      `Shepherd provider ${provider} (${model}) has no credentials for ${owner.agentName}.`,
      credential.error, `Run \`ouro auth --agent ${owner.agentName} --provider ${provider}\`.`,
    ].join("\n"))
    const runtime = createProviderRegistry().resolve(provider, model, credential.record)
    if (!runtime) throw new Error("Shepherd provider runtime could not be initialized.")
    return runtime
  } catch (error) {
    emitNervesEvent({ level: "error", event: "engine.provider_init_error", component: "engine",
      message: redactSecrets(String(error)), meta: { facing: "agent", purpose: "shepherd", provider, model } })
    throw error instanceof Error ? error : new Error(String(error))
  }
}
