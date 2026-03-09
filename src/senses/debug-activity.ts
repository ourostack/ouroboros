import { formatError, formatToolResult } from "../mind/format"
import { pickPhrase } from "../mind/phrases"
import { emitNervesEvent } from "../nerves/runtime"

export interface DebugActivityTransport {
  sendStatus(text: string): Promise<string | undefined>
  editStatus(messageGuid: string, text: string): Promise<void>
  setTyping(active: boolean): Promise<void>
}

export interface DebugActivityOptions {
  thinkingPhrases: readonly string[]
  followupPhrases: readonly string[]
  transport: DebugActivityTransport
  onTransportError?: (operation: string, error: unknown) => void
}

export interface DebugActivityController {
  onModelStart(): void
  onToolStart(name: string, args: Record<string, string>): void
  onToolEnd(name: string, summary: string, success: boolean): void
  onTextChunk(text: string): void
  onError(error: Error): void
  drain(): Promise<void>
  finish(): Promise<void>
}

export function createDebugActivityController(options: DebugActivityOptions): DebugActivityController {
  let queue = Promise.resolve()
  let statusMessageGuid: string | undefined
  let typingActive = false
  let hadToolRun = false
  let followupShown = false
  let lastPhrase = ""

  function reportTransportError(operation: string, error: unknown): void {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.debug_activity_transport_error",
      message: "debug activity transport failed",
      meta: {
        operation,
        reason: error instanceof Error ? error.message : String(error),
      },
    })
    options.onTransportError?.(operation, error)
  }

  function enqueue(operation: string, task: () => Promise<void>): void {
    queue = queue
      .then(task)
      .catch((error) => {
        reportTransportError(operation, error)
      })
  }

  function nextPhrase(pool: readonly string[]): string {
    const phrase = pickPhrase(pool, lastPhrase)
    lastPhrase = phrase
    return phrase
  }

  function ensureTyping(active: boolean): void {
    if (typingActive === active) {
      return
    }
    typingActive = active
    enqueue(active ? "typing_start" : "typing_stop", async () => {
      await options.transport.setTyping(active)
    })
  }

  function setStatus(text: string): void {
    emitNervesEvent({
      component: "senses",
      event: "senses.debug_activity_update",
      message: "debug activity status updated",
      meta: {
        hasStatusGuid: Boolean(statusMessageGuid),
        textLength: text.length,
      },
    })
    const shouldStartTyping = !typingActive
    if (shouldStartTyping) {
      typingActive = true
    }
    enqueue("status_update", async () => {
      if (statusMessageGuid) {
        await options.transport.editStatus(statusMessageGuid, text)
      } else {
        statusMessageGuid = await options.transport.sendStatus(text)
      }
      if (shouldStartTyping) {
        await options.transport.setTyping(true)
      }
    })
  }

  return {
    onModelStart(): void {
      const pool = hadToolRun ? options.followupPhrases : options.thinkingPhrases
      setStatus(`${nextPhrase(pool)}...`)
    },

    onToolStart(name: string, args: Record<string, string>): void {
      hadToolRun = true
      followupShown = false
      const argSummary = Object.values(args).join(", ")
      const detail = argSummary ? ` (${argSummary})` : ""
      setStatus(`running ${name}${detail}...`)
    },

    onToolEnd(name: string, summary: string, success: boolean): void {
      hadToolRun = true
      followupShown = false
      setStatus(formatToolResult(name, summary, success))
    },

    onTextChunk(text: string): void {
      if (!text || !hadToolRun || followupShown) {
        return
      }
      followupShown = true
      setStatus(`${nextPhrase(options.followupPhrases)}...`)
    },

    onError(error: Error): void {
      setStatus(formatError(error))
      this.finish()
    },

    async drain(): Promise<void> {
      await queue
    },

    async finish(): Promise<void> {
      if (!typingActive) {
        await queue
        return
      }
      ensureTyping(false)
      await queue
    },
  }
}
