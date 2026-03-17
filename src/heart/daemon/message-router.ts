import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentMessagesRoot } from "../identity"

export interface RoutedMessage {
  id: string
  from: string
  to: string
  content: string
  queuedAt: string
  priority: string
  sessionId?: string
  taskRef?: string
}

export interface FileMessageRouterOptions {
  baseDir?: string
  now?: () => string
}

function messageId(nowIso: string): string {
  return `msg-${nowIso.replace(/[^0-9]/g, "")}`
}

export class FileMessageRouter {
  private readonly baseDir: string
  private readonly now: () => string

  constructor(options: FileMessageRouterOptions = {}) {
    this.baseDir = options.baseDir ?? getAgentMessagesRoot()
    this.now = options.now ?? (() => new Date().toISOString())
    fs.mkdirSync(this.baseDir, { recursive: true })
  }

  async send(input: {
    from: string
    to: string
    content: string
    priority?: string
    sessionId?: string
    taskRef?: string
  }): Promise<{ id: string; queuedAt: string }> {
    const queuedAt = this.now()
    const id = messageId(queuedAt)
    const message: RoutedMessage = {
      id,
      from: input.from,
      to: input.to,
      content: input.content,
      queuedAt,
      priority: input.priority ?? "normal",
      sessionId: input.sessionId,
      taskRef: input.taskRef,
    }

    const inboxPath = this.inboxPath(input.to)
    fs.appendFileSync(inboxPath, `${JSON.stringify(message)}\n`, "utf-8")
    emitNervesEvent({
      component: "daemon",
      event: "daemon.message_queued",
      message: "queued inter-agent message",
      meta: { id, from: input.from, to: input.to },
    })
    return { id, queuedAt }
  }

  pollInbox(agent: string): RoutedMessage[] {
    const inboxPath = this.inboxPath(agent)
    if (!fs.existsSync(inboxPath)) return []

    const raw = fs.readFileSync(inboxPath, "utf-8")

    const messages: RoutedMessage[] = []
    const unparsed: string[] = []
    for (const line of raw.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        messages.push(JSON.parse(trimmed) as RoutedMessage)
      } catch {
        unparsed.push(trimmed)
      }
    }
    // Only clear inbox after parsing; preserve lines that failed to parse.
    fs.writeFileSync(inboxPath, unparsed.length > 0 ? unparsed.map((l) => `${l}\n`).join("") : "", "utf-8")

    emitNervesEvent({
      component: "daemon",
      event: "daemon.message_polled",
      message: "polled inter-agent inbox",
      meta: { agent, messageCount: messages.length },
    })
    return messages
  }

  private inboxPath(agent: string): string {
    return path.join(this.baseDir, `${agent}-inbox.jsonl`)
  }
}
