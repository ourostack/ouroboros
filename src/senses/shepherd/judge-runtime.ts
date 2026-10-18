import { getProviderRuntime, type ProviderRuntime } from "../../heart/core"

export async function getShepherdJudgeRuntime(owner: { agentName: string; agentRoot: string }): Promise<ProviderRuntime> {
  return getProviderRuntime("agent", owner)
}
