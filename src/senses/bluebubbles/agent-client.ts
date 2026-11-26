// A BlueBubbles client for a named agent, built from outside that agent's sense process: the daemon delivering a
// letter, or an `ouro rsvp` command. Its settings come from the agent's machine runtime config in the vault (held in
// process memory once read), and its host check uses the agent's declared iMessage host account.
import * as os from "os"
import * as path from "path"
import type { ServerMessage } from "../../heart/letters/answer-reader"
import type { BlueBubblesChannelConfig, BlueBubblesConfig } from "../../heart/config"
import { loadAgentConfig } from "../../heart/identity"
import { loadOrCreateMachineIdentity } from "../../heart/machine-identity"
import {
  readMachineRuntimeCredentialConfig,
  refreshMachineRuntimeCredentialConfig,
  type RuntimeCredentialConfigReadResult,
} from "../../heart/runtime-credentials"
import { emitNervesEvent } from "../../nerves/runtime"
import { BlueBubblesSendError, createBlueBubblesClient, type BlueBubblesClient, type BlueBubblesClientHostOptions } from "./client"
import { OURO_LETTER_SEND } from "./letter-guard"
import type { BlueBubblesChatRef } from "./model"
import { imessageHostTrust, type IMessageHostTrust } from "./host-trust"
import { blueBubblesUrlTrust, type BlueBubblesUrlTrust } from "./url-trust"

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

/** A one-to-one chat with a handle, addressed by the handle alone; the client finds the existing chat for it. */
export function chatWithHandle(handle: string): BlueBubblesChatRef {
  return { chatIdentifier: handle, isGroup: false, sessionKey: `chat_identifier:${handle}`, sendTarget: { kind: "chat_identifier", value: handle }, participantHandles: [] }
}

/**
 * Sends a letter Ouro rendered to the handle's chat as the agent, and says where it landed. A server that names no
 * chat or message leaves those blank rather than failing a send that went out.
 */
export async function sendLetterByBlueBubbles(
  request: { agent: string; handle: string; text: string },
  agentRoot: string,
  clientFor: (agent: string, agentRoot: string) => Promise<BlueBubblesClient> = blueBubblesClientForAgent,
): Promise<{ channel: string; key: string; messageId: string }> {
  const client = await clientFor(request.agent, agentRoot)
  let sent: Awaited<ReturnType<BlueBubblesClient["sendText"]>>
  try {
    sent = await client.sendText({ chat: chatWithHandle(request.handle), text: request.text, mark: OURO_LETTER_SEND })
  } catch (error) {
    // A chat that doesn't exist yet can't be found by its handle; say what the person does about it.
    if (error instanceof BlueBubblesSendError && error.errorCode === "chat_unresolved") {
      throw new BlueBubblesSendError({ message: `no chat with ${request.handle} exists yet; the person messages the agent once from that handle first`, httpStatus: null, errorCode: "chat_unresolved", transportInvoked: false, cause: error })
    }
    throw error
  }
  emitNervesEvent({ component: "senses", event: "senses.bluebubbles_letter_sent", message: "a letter was sent to its person's chat", meta: { agent: request.agent, hasMessageId: Boolean(sent.messageGuid) } })
  return { channel: "bluebubbles", key: sent.chatGuid ?? "", messageId: sent.messageGuid ?? "" }
}

/** The daemon's letter sender: each agent's letters go out through that agent's own bundle and settings. */
export function letterChatSender(bundlesRoot: string, clientFor?: (agent: string, agentRoot: string) => Promise<BlueBubblesClient>) {
  return (request: { agent: string; handle: string; text: string }) => sendLetterByBlueBubbles(request, path.join(bundlesRoot, `${request.agent}.ouro`), clientFor)
}

/** Where the daemon reads a person's answer from: the agent's own BlueBubbles server, and how far it is trusted. */
export interface LetterAnswerSource {
  trust: BlueBubblesUrlTrust
  /** `separate` only when the daemon runs under the agent's declared host account (host-trust.ts). */
  hostTrust: IMessageHostTrust
  getServerMessage(messageGuid: string): Promise<ServerMessage | null>
}

export function letterAnswerSource(
  bundlesRoot: string,
  deps: { clientFor?: (agent: string, agentRoot: string) => Promise<BlueBubblesClient>; daemonUser?: () => string; hostUsername?: (agent: string, agentRoot: string) => string | undefined } = {},
): (agent: string) => Promise<LetterAnswerSource> {
  return async (agent) => {
    const agentRoot = path.join(bundlesRoot, `${agent}.ouro`)
    const settings = blueBubblesSettings(await agentMachineRuntimeConfig(agent))
    const client = await (deps.clientFor ?? blueBubblesClientForAgent)(agent, agentRoot)
    const daemonUser = (deps.daemonUser ?? (() => os.userInfo().username))()
    const hostUsername = (deps.hostUsername ?? ((name, root) => agentHostOptions(name, root).hostUsername))(agent, agentRoot)
    return {
      trust: blueBubblesUrlTrust(settings.config.serverUrl),
      hostTrust: imessageHostTrust(hostUsername, daemonUser),
      getServerMessage: async (messageGuid) => {
        if (!client.getServerMessage) throw new Error("this BlueBubbles client can't fetch a message's own record")
        return client.getServerMessage(messageGuid)
      },
    }
  }
}
