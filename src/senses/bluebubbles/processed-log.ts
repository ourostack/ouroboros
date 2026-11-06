import * as fs from "node:fs"
import * as path from "node:path"
import { sanitizeKey } from "../../heart/config"
import { getAgentRoot } from "../../heart/identity"
import { emitNervesEvent } from "../../nerves/runtime"
import type { BlueBubblesInboundSource } from "./inbound-log"
import type { BlueBubblesNormalizedMessage } from "./model"

export type BlueBubblesProcessedOutcome =
  | "turn-complete"
  | "trust-gated"
  | "session-bootstrap"

type BlueBubblesProcessedLogEntry = {
  recordedAt: string
  messageGuid: string
  sessionKey: string
  source: BlueBubblesInboundSource
  outcome: BlueBubblesProcessedOutcome
}

export function getBlueBubblesProcessedLogPath(agentName: string, sessionKey: string): string {
  return path.join(
    getAgentRoot(agentName),
    "state",
    "senses",
    "bluebubbles",
    "processed",
    `${sanitizeKey(sessionKey)}.ndjson`,
  )
}

function readEntries(filePath: string): BlueBubblesProcessedLogEntry[] {
  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BlueBubblesProcessedLogEntry)
      .filter((entry) => typeof entry.messageGuid === "string" && typeof entry.sessionKey === "string")
  } catch {
    return []
  }
}

export function hasProcessedBlueBubblesMessage(
  agentName: string,
  sessionKey: string,
  messageGuid: string,
): boolean {
  if (!messageGuid.trim()) return false
  const filePath = getBlueBubblesProcessedLogPath(agentName, sessionKey)
  return readEntries(filePath).some((entry) => entry.messageGuid === messageGuid)
}

export function recordProcessedBlueBubblesMessage(
  agentName: string,
  event: BlueBubblesNormalizedMessage,
  source: BlueBubblesInboundSource,
  outcome: BlueBubblesProcessedOutcome,
): string {
  const filePath = getBlueBubblesProcessedLogPath(agentName, event.chat.sessionKey)
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    if (event.messageGuid.trim() && readEntries(filePath).some((entry) => entry.messageGuid === event.messageGuid)) {
      return filePath
    }
    fs.appendFileSync(
      filePath,
      JSON.stringify({
        recordedAt: new Date().toISOString(),
        messageGuid: event.messageGuid,
        sessionKey: event.chat.sessionKey,
        source,
        outcome,
      } satisfies BlueBubblesProcessedLogEntry) + "\n",
      "utf-8",
    )
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_processed_log_error",
      message: "failed to record bluebubbles processed sidecar log",
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
    component: "senses",
    event: "senses.bluebubbles_processed_logged",
    message: "recorded handled bluebubbles message to processed sidecar log",
    meta: {
      agentName,
      messageGuid: event.messageGuid,
      sessionKey: event.chat.sessionKey,
      source,
      outcome,
      path: filePath,
    },
  })

  return filePath
}
