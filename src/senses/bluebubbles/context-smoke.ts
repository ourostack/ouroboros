import { loadOrCreateMachineIdentity } from "../../heart/machine-identity"
import { getAgentRoot, resetIdentity, setAgentName } from "../../heart/identity"
import { refreshMachineRuntimeCredentialConfig } from "../../heart/runtime-credentials"
import { emitNervesEvent } from "../../nerves/runtime"
import { writeSenseContextPacket, type SenseContextPacketWriteResult } from "../context-packet-ledger"
import { createBlueBubblesClient, type BlueBubblesClient } from "./client"
import { buildBlueBubblesContextPacket } from "./context-packet"
import { normalizeBlueBubblesEvent, type BlueBubblesNormalizedEvent } from "./model"

export interface SmokeBlueBubblesContextParams {
  agentName: string
  messageGuid: string
  persist?: boolean
}

export interface BlueBubblesContextSmokeResult {
  ok: true
  sideEffect: false | "private-runtime-ledger-write"
  agentName: string
  messageGuid: string
  packetId: string
  contextMessages: number
  renderedMessages: number
  renderedCharacters: number
  omittedMessages: number
  truncatedMessages: number
  ledgerPath?: string
  packetPath?: string
  receiptPath?: string
}

interface BlueBubblesContextSmokeDeps {
  createClient?: () => Pick<BlueBubblesClient, "repairEvent" | "queryRecentMessagesWithMetadata">
  createDefaultClient?: typeof createBlueBubblesClient
  normalizeEvent?: typeof normalizeBlueBubblesEvent
  setAgentName?: typeof setAgentName
  resetIdentity?: typeof resetIdentity
  loadMachineId?: () => string
  refreshMachineRuntimeConfig?: typeof refreshMachineRuntimeCredentialConfig
  getAgentRoot?: typeof getAgentRoot
  writePacket?: typeof writeSenseContextPacket
}

function requireMessageEvent(event: BlueBubblesNormalizedEvent, messageGuid: string): asserts event is Extract<BlueBubblesNormalizedEvent, { kind: "message" }> {
  if (event.kind !== "message") {
    throw new Error(`BlueBubbles context smoke requires a message event; ${messageGuid} repaired to ${event.kind}`)
  }
}

function smokeResult(
  params: {
    agentName: string
    messageGuid: string
    packetId: string
    contextMessages: number
    renderedMessages: number
    renderedCharacters: number
    omittedMessages: number
    truncatedMessages: number
  },
  writeResult?: SenseContextPacketWriteResult,
): BlueBubblesContextSmokeResult {
  return {
    ok: true,
    sideEffect: writeResult ? "private-runtime-ledger-write" : false,
    ...params,
    ...(writeResult ? {
      ledgerPath: writeResult.ledgerPath,
      packetPath: writeResult.packetPath,
      receiptPath: writeResult.receiptPath,
    } : {}),
  }
}

export async function smokeBlueBubblesContext(
  params: SmokeBlueBubblesContextParams,
  deps: BlueBubblesContextSmokeDeps = {},
): Promise<BlueBubblesContextSmokeResult> {
  const agentName = params.agentName.trim()
  const messageGuid = params.messageGuid.trim()
  if (!agentName) throw new Error("bluebubbles context-smoke requires agentName")
  if (!messageGuid) throw new Error("bluebubbles context-smoke requires messageGuid")

  const setSmokeAgentName = deps.setAgentName ?? setAgentName
  const resetSmokeIdentity = deps.resetIdentity ?? resetIdentity
  const normalizeEvent = deps.normalizeEvent ?? normalizeBlueBubblesEvent
  const loadMachineId = deps.loadMachineId ?? (() => loadOrCreateMachineIdentity().machineId)
  const refreshMachineRuntimeConfig = deps.refreshMachineRuntimeConfig ?? refreshMachineRuntimeCredentialConfig
  const resolveAgentRoot = deps.getAgentRoot ?? getAgentRoot
  const writePacket = deps.writePacket ?? writeSenseContextPacket
  const createDefaultClient = deps.createDefaultClient ?? createBlueBubblesClient

  emitNervesEvent({
    component: "senses",
    event: "senses.bluebubbles_context_smoke_start",
    message: "starting bluebubbles context smoke",
    meta: {
      agentName,
      messageGuid,
      persist: params.persist === true,
    },
  })

  setSmokeAgentName(agentName)
  try {
    if (!deps.createClient) {
      const machineId = loadMachineId()
      await refreshMachineRuntimeConfig(agentName, machineId, { preserveCachedOnFailure: true })
    }
    const client = deps.createClient ? deps.createClient() : createDefaultClient()
    const probe = normalizeEvent({
      type: "new-message",
      data: {
        guid: messageGuid,
        hasPayloadData: true,
      },
    })
    const event = await client.repairEvent(probe)
    requireMessageEvent(event, messageGuid)
    const built = await buildBlueBubblesContextPacket({
      agentName,
      client,
      event,
    })
    if (!built) {
      throw new Error(`BlueBubbles context smoke found no same-thread history before ${messageGuid}`)
    }
    const writeResult = params.persist
      ? writePacket(resolveAgentRoot(agentName), built.packet)
      : undefined
    const result = smokeResult({
      agentName,
      messageGuid,
      packetId: built.packet.packetId,
      contextMessages: built.historyCount,
      renderedMessages: built.rendered.stats.renderedMessages,
      renderedCharacters: built.rendered.stats.outputCharacters,
      omittedMessages: built.rendered.stats.omittedMessages,
      truncatedMessages: built.rendered.stats.truncatedMessages,
    }, writeResult)
    emitNervesEvent({
      component: "senses",
      event: "senses.bluebubbles_context_smoke_end",
      message: "completed bluebubbles context smoke",
      meta: {
        agentName,
        messageGuid,
        packetId: result.packetId,
        contextMessages: result.contextMessages,
        sideEffect: result.sideEffect,
      },
    })
    return result
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_context_smoke_error",
      message: "bluebubbles context smoke failed",
      meta: {
        agentName,
        messageGuid,
        reason: error instanceof Error ? error.message : String(error),
      },
    })
    throw error
  } finally {
    resetSmokeIdentity()
  }
}

export function formatBlueBubblesContextSmokeText(result: BlueBubblesContextSmokeResult): string {
  const lines = [
    "bluebubbles context smoke passed",
    `agent: ${result.agentName}`,
    `message_guid: ${result.messageGuid}`,
    `context_messages: ${result.contextMessages}`,
    `packet_id: ${result.packetId}`,
    `rendered_messages: ${result.renderedMessages}`,
    `rendered_characters: ${result.renderedCharacters}`,
    `truncated_messages: ${result.truncatedMessages}`,
    `omitted_messages: ${result.omittedMessages}`,
    `side_effect: ${result.sideEffect}`,
  ]
  if (result.ledgerPath) lines.push(`ledger_path: ${result.ledgerPath}`)
  if (result.packetPath) lines.push(`packet_path: ${result.packetPath}`)
  if (result.receiptPath) lines.push(`receipt_path: ${result.receiptPath}`)
  return lines.join("\n")
}
