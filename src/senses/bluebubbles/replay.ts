import { renderAttachmentBlock } from "../../heart/attachments/render"
import { buildBlueBubblesAttachmentRecord } from "../../heart/attachments/sources/bluebubbles"
import { loadOrCreateMachineIdentity } from "../../heart/machine-identity"
import { resetIdentity, setAgentName } from "../../heart/identity"
import { refreshMachineRuntimeCredentialConfig } from "../../heart/runtime-credentials"
import { emitNervesEvent } from "../../nerves/runtime"
import { createBlueBubblesClient, type BlueBubblesClient } from "./client"
import { normalizeBlueBubblesEvent, type BlueBubblesNormalizedEvent } from "./model"

export interface ReplayBlueBubblesMessageParams {
  agentName: string
  messageGuid: string
  eventType?: "new-message" | "updated-message"
}

export interface BlueBubblesReplayResult {
  probe: {
    agentName: string
    messageGuid: string
    eventType: "new-message" | "updated-message"
  }
  event: BlueBubblesNormalizedEvent
  attachmentIds: string[]
  attachmentBlock: string
  hint?: string
}

interface BlueBubblesReplayDeps {
  createClient?: () => BlueBubblesClient
  normalizeEvent?: typeof normalizeBlueBubblesEvent
  setAgentName?: typeof setAgentName
  resetIdentity?: typeof resetIdentity
  loadMachineId?: () => string
  refreshMachineRuntimeConfig?: typeof refreshMachineRuntimeCredentialConfig
}

function buildReplayHint(
  probeEventType: "new-message" | "updated-message",
  event: BlueBubblesNormalizedEvent,
): string | undefined {
  if (
    probeEventType === "updated-message"
    && event.kind === "mutation"
    && (event.mutationType === "read" || event.mutationType === "delivery")
  ) {
    return "replay resolved to a state-only mutation; rerun with --event-type new-message to inspect the original message payload."
  }
  return undefined
}

export async function replayBlueBubblesMessage(
  params: ReplayBlueBubblesMessageParams,
  deps: BlueBubblesReplayDeps = {},
): Promise<BlueBubblesReplayResult> {
  const agentName = params.agentName.trim()
  const messageGuid = params.messageGuid.trim()
  const eventType = params.eventType ?? "new-message"
  if (!agentName) {
    throw new Error("bluebubbles replay requires agentName")
  }
  if (!messageGuid) {
    throw new Error("bluebubbles replay requires messageGuid")
  }

  const setReplayAgentName = deps.setAgentName ?? setAgentName
  const resetReplayIdentity = deps.resetIdentity ?? resetIdentity
  const normalizeEvent = deps.normalizeEvent ?? normalizeBlueBubblesEvent
  const loadMachineId = deps.loadMachineId ?? (() => loadOrCreateMachineIdentity().machineId)
  const refreshMachineRuntimeConfig = deps.refreshMachineRuntimeConfig ?? refreshMachineRuntimeCredentialConfig

  emitNervesEvent({
    component: "senses",
    event: "senses.bluebubbles_replay_start",
    message: "starting bluebubbles historical replay",
    meta: {
      agentName,
      messageGuid,
      eventType,
    },
  })

  setReplayAgentName(agentName)

  try {
    if (!deps.createClient) {
      const machineId = loadMachineId()
      await refreshMachineRuntimeConfig(agentName, machineId, { preserveCachedOnFailure: true })
    }
    const client = deps.createClient ? deps.createClient() : createBlueBubblesClient()
    const probe = normalizeEvent({
      type: eventType,
      data: {
        guid: messageGuid,
        hasPayloadData: true,
      },
    })
    const event = await client.repairEvent(probe)
    const attachmentRecords = event.kind === "message"
      ? event.attachments
        .filter((attachment) => typeof attachment.guid === "string" && attachment.guid.trim().length > 0)
        .map((attachment) => buildBlueBubblesAttachmentRecord(attachment))
      : []
    const result: BlueBubblesReplayResult = {
      probe: {
        agentName,
        messageGuid,
        eventType,
      },
      event,
      attachmentIds: attachmentRecords.map((attachment) => attachment.id),
      attachmentBlock: renderAttachmentBlock(attachmentRecords),
      ...(buildReplayHint(eventType, event) ? { hint: buildReplayHint(eventType, event) } : {}),
    }

    emitNervesEvent({
      component: "senses",
      event: "senses.bluebubbles_replay_end",
      message: "completed bluebubbles historical replay",
      meta: {
        agentName,
        messageGuid,
        eventType,
        kind: event.kind,
        attachmentCount: attachmentRecords.length,
      },
    })

    return result
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_replay_error",
      message: "bluebubbles historical replay failed",
      meta: {
        agentName,
        messageGuid,
        eventType,
        reason: error instanceof Error ? error.message : String(error),
      },
    })
    throw error
  } finally {
    resetReplayIdentity()
  }
}

export function formatBlueBubblesReplayText(result: BlueBubblesReplayResult): string {
  const lines = [
    `probe: ${result.probe.eventType}`,
    `agent: ${result.probe.agentName}`,
    `message_guid: ${result.probe.messageGuid}`,
    `result_kind: ${result.event.kind}`,
    `session: ${result.event.chat.sessionKey}`,
  ]

  if (result.event.kind === "mutation") {
    lines.push(`mutation_type: ${result.event.mutationType}`)
  }

  if (result.event.kind === "message" && result.event.inputPartsForAgent?.length) {
    lines.push(`input_parts_for_agent: ${result.event.inputPartsForAgent.length}`)
  }

  if (result.event.repairNotice?.trim()) {
    lines.push(`repair_notice: ${result.event.repairNotice.trim()}`)
  }

  if (result.attachmentBlock && !result.event.textForAgent.includes(result.attachmentBlock)) {
    lines.push(result.attachmentBlock)
  }

  lines.push("[text_for_agent]")
  lines.push(result.event.textForAgent || "(empty)")

  if (result.hint) {
    lines.push("[hint]")
    lines.push(result.hint)
  }

  return lines.join("\n")
}
