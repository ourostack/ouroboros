import * as fs from "node:fs"
import * as path from "node:path"
import type { BlueBubblesNormalizedMutation } from "./bluebubbles-model"
import { emitNervesEvent } from "../nerves/runtime"
import { getAgentRoot } from "../heart/identity"
import { sanitizeKey } from "../heart/config"

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
    }) + "\n",
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
