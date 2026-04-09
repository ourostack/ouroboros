import * as fs from "node:fs"
import * as path from "node:path"
import { sanitizeKey } from "../../heart/config"
import { getAgentRoot } from "../../heart/identity"
import { emitNervesEvent } from "../../nerves/runtime"
import type { BlueBubblesNormalizedMessage } from "./model"

export type BlueBubblesInboundSource = "webhook" | "mutation-recovery" | "recovery-bootstrap"

type BlueBubblesInboundLogEntry = {
  recordedAt: string
  messageGuid: string
  chatGuid: string | null
  chatIdentifier: string | null
  sessionKey: string
  textForAgent: string
  source: BlueBubblesInboundSource
}

export function getBlueBubblesInboundLogPath(agentName: string, sessionKey: string): string {
  return path.join(
    getAgentRoot(agentName),
    "state",
    "senses",
    "bluebubbles",
    "inbound",
    `${sanitizeKey(sessionKey)}.ndjson`,
  )
}

function readEntries(filePath: string): BlueBubblesInboundLogEntry[] {
  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BlueBubblesInboundLogEntry)
      .filter((entry) => typeof entry.messageGuid === "string" && typeof entry.sessionKey === "string")
  } catch {
    return []
  }
}

export function hasRecordedBlueBubblesInbound(
  agentName: string,
  sessionKey: string,
  messageGuid: string,
): boolean {
  if (!messageGuid.trim()) return false
  const filePath = getBlueBubblesInboundLogPath(agentName, sessionKey)
  return readEntries(filePath).some((entry) => entry.messageGuid === messageGuid)
}

export function recordBlueBubblesInbound(
  agentName: string,
  event: BlueBubblesNormalizedMessage,
  source: BlueBubblesInboundSource,
): string {
  const filePath = getBlueBubblesInboundLogPath(agentName, event.chat.sessionKey)
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    if (event.messageGuid.trim() && readEntries(filePath).some((entry) => entry.messageGuid === event.messageGuid)) {
      return filePath
    }
    fs.appendFileSync(
      filePath,
      JSON.stringify({
        recordedAt: new Date(event.timestamp).toISOString(),
        messageGuid: event.messageGuid,
        chatGuid: event.chat.chatGuid ?? null,
        chatIdentifier: event.chat.chatIdentifier ?? null,
        sessionKey: event.chat.sessionKey,
        textForAgent: event.textForAgent,
        source,
      } satisfies BlueBubblesInboundLogEntry) + "\n",
      "utf-8",
    )
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_inbound_log_error",
      message: "failed to record bluebubbles inbound sidecar log",
      meta: {
        agentName,
        messageGuid: event.messageGuid,
        sessionKey: event.chat.sessionKey,
        reason: error instanceof Error ? error.message : String(error),
      },
    })
    return filePath
  }

  emitNervesEvent({
    level: "warn",
    component: "senses",
    event: "senses.bluebubbles_inbound_logged",
    message: "recorded bluebubbles inbound message to sidecar log",
    meta: {
      agentName,
      messageGuid: event.messageGuid,
      sessionKey: event.chat.sessionKey,
      source,
      path: filePath,
    },
  })

  return filePath
}
