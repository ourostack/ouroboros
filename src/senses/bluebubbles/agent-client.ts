// A BlueBubbles client for a named agent, built from outside that agent's sense process: the daemon delivering a
// letter, or an `ouro rsvp` command. Its settings come from the agent's machine runtime config in the vault (held in
// process memory once read), and its host check uses the agent's declared iMessage host account.
import type { BlueBubblesChannelConfig, BlueBubblesConfig } from "../../heart/config"
import { loadAgentConfig } from "../../heart/identity"
import { loadOrCreateMachineIdentity } from "../../heart/machine-identity"
import {
  readMachineRuntimeCredentialConfig,
  refreshMachineRuntimeCredentialConfig,
  type RuntimeCredentialConfigReadResult,
} from "../../heart/runtime-credentials"
import { emitNervesEvent } from "../../nerves/runtime"
import { createBlueBubblesClient, type BlueBubblesClient, type BlueBubblesClientHostOptions } from "./client"

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function record(parent: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = parent[key]
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function numberField(parent: Record<string, unknown> | null, key: string, fallback: number): number {
  const value = parent?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function stringList(parent: Record<string, unknown> | null, key: string): string[] {
  const value = parent?.[key]
  if (!Array.isArray(value)) return []
  return value.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean)
}

/** The agent's machine runtime config: the cached copy, or a fresh read from the vault when none is cached. */
export async function agentMachineRuntimeConfig(agent: string): Promise<RuntimeCredentialConfigReadResult> {
  const cached = readMachineRuntimeCredentialConfig(agent)
  return cached.ok ? cached : refreshMachineRuntimeCredentialConfig(agent, loadOrCreateMachineIdentity().machineId, { preserveCachedOnFailure: true })
}

/** The client and channel settings in a machine runtime config, or an error that names the command that fixes it. */
export function blueBubblesSettings(
  machineRuntimeConfig: RuntimeCredentialConfigReadResult,
  accountIdFallback = "default",
): { config: BlueBubblesConfig; channelConfig: BlueBubblesChannelConfig } {
  if (!machineRuntimeConfig.ok) {
    throw new Error(`BlueBubbles runtime config unavailable at ${machineRuntimeConfig.itemPath}: ${machineRuntimeConfig.error}`)
  }
  const bluebubbles = record(machineRuntimeConfig.config, "bluebubbles")
  const channel = record(machineRuntimeConfig.config, "bluebubblesChannel")
  const serverUrl = text(bluebubbles?.serverUrl)
  const password = text(bluebubbles?.password)
  if (!serverUrl) throw new Error("bluebubbles.serverUrl is required in this machine's agent-vault runtime config. Run `ouro connect bluebubbles --agent <agent>`.")
  if (!password) throw new Error("bluebubbles.password is required in this machine's agent-vault runtime config. Run `ouro connect bluebubbles --agent <agent>`.")
  return {
    config: { serverUrl, password, accountId: text(bluebubbles?.accountId) || accountIdFallback, ownHandles: stringList(bluebubbles, "ownHandles") },
    channelConfig: {
      port: numberField(channel, "port", 18790),
      webhookPath: text(channel?.webhookPath) || "/bluebubbles-webhook",
      requestTimeoutMs: numberField(channel, "requestTimeoutMs", 30_000),
    },
  }
}

/** The host check's inputs for an agent: its name, bundle and declared iMessage host account, when agent.json reads. */
export function agentHostOptions(agent: string, agentRoot: string): BlueBubblesClientHostOptions {
  try {
    return { agent, agentRoot, hostUsername: loadAgentConfig({ agentName: agent, agentRoot }).senses?.bluebubbles.hostUsername }
  } catch {
    return { agent, agentRoot, hostUsername: undefined }
  }
}

/** A BlueBubbles client acting as the agent's Apple ID, from the agent's own settings. */
export async function blueBubblesClientForAgent(agent: string, agentRoot: string): Promise<BlueBubblesClient> {
  const settings = blueBubblesSettings(await agentMachineRuntimeConfig(agent))
  emitNervesEvent({ component: "senses", event: "senses.bluebubbles_agent_client", message: "bluebubbles client built for an agent outside its sense", meta: { agent } })
  return createBlueBubblesClient(settings.config, settings.channelConfig, agentHostOptions(agent, agentRoot))
}
