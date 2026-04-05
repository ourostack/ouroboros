import * as fs from "node:fs"
import * as path from "node:path"
import type { BlueBubblesNormalizedMutation } from "./model"
import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentRoot } from "../../heart/identity"
import { sanitizeKey } from "../../heart/config"

export interface BlueBubblesMutationLogEntry {
  recordedAt: string
  eventType: string
  mutationType: string
  messageGuid: string
  targetMessageGuid: string | null
  chatGuid: string | null
  chatIdentifier: string | null
  sessionKey: string
  shouldNotifyAgent: boolean
  textForAgent: string
  fromMe: boolean
}

export function getBlueBubblesMutationLogPath(agentName: string, sessionKey: string): string {
  return path.join(
    getAgentRoot(agentName),
    "state",
    "senses",
    "bluebubbles",
    "mutations",
    `${sanitizeKey(sessionKey)}.ndjson`,
  )
}

export function recordBlueBubblesMutation(agentName: string, event: BlueBubblesNormalizedMutation): string {
  const filePath = getBlueBubblesMutationLogPath(agentName, event.chat.sessionKey)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.appendFileSync(
    filePath,
    JSON.stringify({
      recordedAt: new Date(event.timestamp).toISOString(),
      eventType: event.eventType,
      mutationType: event.mutationType,
      messageGuid: event.messageGuid,
      targetMessageGuid: event.targetMessageGuid ?? null,
      chatGuid: event.chat.chatGuid ?? null,
      chatIdentifier: event.chat.chatIdentifier ?? null,
      sessionKey: event.chat.sessionKey,
      shouldNotifyAgent: event.shouldNotifyAgent,
      textForAgent: event.textForAgent,
      fromMe: event.fromMe,
    } satisfies BlueBubblesMutationLogEntry) + "\n",
    "utf-8",
  )

  emitNervesEvent({
    component: "senses",
    event: "senses.bluebubbles_mutation_logged",
    message: "recorded bluebubbles mutation to sidecar log",
    meta: {
      agentName,
      mutationType: event.mutationType,
      messageGuid: event.messageGuid,
      path: filePath,
    },
  })

  return filePath
}

export function listBlueBubblesRecoveryCandidates(agentName: string): BlueBubblesMutationLogEntry[] {
  const rootDir = path.join(getAgentRoot(agentName), "state", "senses", "bluebubbles", "mutations")
  let files: string[]
  try {
    files = fs.readdirSync(rootDir)
  } catch {
    return []
  }

  const deduped = new Map<string, BlueBubblesMutationLogEntry>()
  for (const file of files.filter((entry) => entry.endsWith(".ndjson")).sort()) {
    const filePath = path.join(rootDir, file)
    let raw = ""
    try {
      raw = fs.readFileSync(filePath, "utf-8")
    } catch {
      continue
    }

    for (const line of raw.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const entry = JSON.parse(trimmed) as BlueBubblesMutationLogEntry
        if (
          typeof entry.messageGuid !== "string"
          || !entry.messageGuid.trim()
          || entry.fromMe
          || entry.shouldNotifyAgent
          || (entry.mutationType !== "read" && entry.mutationType !== "delivery")
        ) {
          continue
        }
        deduped.set(entry.messageGuid, entry)
      } catch {
        // ignore malformed recovery candidates
      }
    }
  }

  return [...deduped.values()].sort((left, right) => left.recordedAt.localeCompare(right.recordedAt))
}
