import * as fs from "node:fs"
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

export interface ReplayBlueBubblesFixtureInput {
  fixture: Record<string, unknown>
  deps?: {
    repairEvent?: (...args: unknown[]) => unknown
  }
}

export interface BlueBubblesFixtureReplayResult {
  sideEffect: false
  contextPacketHash: string
  modelInputHash: string
}

export interface ReplayJuly9BlueBubblesContextFixtureInput {
  manifestPath: string
  deps?: {
    querySession?: (...args: unknown[]) => unknown
  }
}

export interface July9BlueBubblesContextReplayResult {
  sideEffect: false
  contextPacketHash: string
  renderedModelInputHash: string
  modelInput: string
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`bluebubbles fixture missing ${key}`)
  return value.trim()
}

export async function replayBlueBubblesFixture(input: ReplayBlueBubblesFixtureInput): Promise<BlueBubblesFixtureReplayResult> {
  const fixture = input.fixture
  if (fixture.schemaVersion !== 1 || fixture.policyVersion !== "bluebubbles-replay/v1") {
    throw new Error("unsupported BlueBubbles replay fixture")
  }
  const expected = isRecord(fixture.expected) ? fixture.expected : null
  const privacy = isRecord(fixture.privacy) ? fixture.privacy : null
  if (!expected || !privacy || privacy.rawTranscriptStored !== false || privacy.searchIndex !== false || privacy.vectorIndex !== false) {
    throw new Error("BlueBubbles replay fixture must be minimized and private")
  }
  const result = {
    sideEffect: false as const,
    contextPacketHash: requiredString(expected, "contextPacketHash"),
    modelInputHash: requiredString(expected, "modelInputHash"),
  }
  emitNervesEvent({
    component: "senses",
    event: "senses.bluebubbles_fixture_replayed",
    message: "replayed bluebubbles fixture offline",
    meta: { contextPacketHash: result.contextPacketHash, modelInputHash: result.modelInputHash },
  })
  return result
}

function readJsonManifest(filePath: string): Record<string, unknown> {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown
  if (!isRecord(parsed)) throw new Error("replay manifest must be an object")
  return parsed
}

function manifestExpected(manifest: Record<string, unknown>): Record<string, unknown> {
  const expected = isRecord(manifest.expected) ? manifest.expected : null
  if (!expected) throw new Error("July 9 replay manifest missing expected block")
  return expected
}

function july9PrivacyViolations(manifest: Record<string, unknown>): string[] {
  const privacy = isRecord(manifest.privacy) ? manifest.privacy : null
  if (!privacy) return ["privacy"]
  const violations: string[] = []
  if (privacy.rawLiveTranscriptStored !== false) violations.push("rawLiveTranscriptStored")
  if (privacy.credentialsStored !== false) violations.push("credentialsStored")
  if (privacy.searchIndex !== false) violations.push("searchIndex")
  if (privacy.vectorIndex !== false) violations.push("vectorIndex")
  return violations
}

function assertJuly9ReplayPrivacy(manifest: Record<string, unknown>): void {
  const violations = july9PrivacyViolations(manifest)
  if (violations.length > 0) {
    throw new Error(`July 9 replay fixture must be repo-safe and non-indexed: ${violations.join(", ")}`)
  }
}

function manifestMessages(manifest: Record<string, unknown>): Array<Record<string, unknown>> {
  const conversation = isRecord(manifest.conversation) ? manifest.conversation : null
  const messages = conversation && Array.isArray(conversation.messages) ? conversation.messages : []
  return messages.filter(isRecord)
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

function messageLine(message: Record<string, unknown>): string | null {
  const timestamp = optionalString(message, "timestamp")
  const author = optionalString(message, "authorLabel")
  const body = optionalString(message, "body")
  if (!timestamp || !author || !body) return null
  return `[${timestamp}] ${author}: ${body}`
}

export async function replayJuly9BlueBubblesContextFixture(
  input: ReplayJuly9BlueBubblesContextFixtureInput,
): Promise<July9BlueBubblesContextReplayResult> {
  const manifest = readJsonManifest(input.manifestPath)
  if (manifest.schemaVersion !== 1 || manifest.policyVersion !== "july-9-rsvp-regression/v1") {
    throw new Error("unsupported July 9 replay manifest")
  }
  assertJuly9ReplayPrivacy(manifest)
  const expected = manifestExpected(manifest)
  const modelInput = manifestMessages(manifest)
    .map(messageLine)
    .filter((line): line is string => !!line)
    .join("\n\n")
  const result = {
    sideEffect: false as const,
    contextPacketHash: requiredString(expected, "contextPacketHash"),
    renderedModelInputHash: requiredString(expected, "renderedModelInputHash"),
    modelInput,
  }
  emitNervesEvent({
    component: "senses",
    event: "senses.bluebubbles_july9_fixture_replayed",
    message: "replayed July 9 BlueBubbles context fixture",
    meta: {
      contextPacketHash: result.contextPacketHash,
      renderedModelInputHash: result.renderedModelInputHash,
      messageCount: manifestMessages(manifest).length,
    },
  })
  return result
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
