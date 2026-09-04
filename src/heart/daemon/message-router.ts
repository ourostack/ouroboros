import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { getOuroCliHome } from "../versioning/ouro-version-manager"

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
  homeDir?: string
  now?: () => string
  maxMessagesPerInbox?: number
}

export function getDaemonMessageRouterDir(homeDir?: string): string {
  return path.join(getOuroCliHome(homeDir), "daemon", "messages")
}

function messageId(nowIso: string, sequence: number): string {
  const base = `msg-${nowIso.replace(/[^0-9]/g, "")}`
  return sequence === 1 ? base : `${base}-${sequence}`
}

export class FileMessageRouter {
  private readonly baseDir: string
  private readonly now: () => string
  private readonly maxMessagesPerInbox: number
  private readonly messageIdSequences = new Map<string, number>()

  constructor(options: FileMessageRouterOptions = {}) {
    this.baseDir = options.baseDir ?? getDaemonMessageRouterDir(options.homeDir)
    this.now = options.now ?? (() => new Date().toISOString())
    this.maxMessagesPerInbox = Math.max(1, Math.floor(options.maxMessagesPerInbox ?? 1000))
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
    const sequence = (this.messageIdSequences.get(queuedAt) ?? 0) + 1
    this.messageIdSequences.set(queuedAt, sequence)
    const id = messageId(queuedAt, sequence)
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
    this.trimInbox(inboxPath)
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

  peekInbox(agent: string): RoutedMessage[] {
    const inboxPath = this.inboxPath(agent)
    if (!fs.existsSync(inboxPath)) return []

    const messages: RoutedMessage[] = []
    const raw = fs.readFileSync(inboxPath, "utf-8")
    for (const line of raw.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        messages.push(JSON.parse(trimmed) as RoutedMessage)
      } catch {
        // Preserve pollInbox semantics: malformed lines stay untouched and
        // invisible to callers that need valid routed messages.
      }
    }
    return messages
  }

  private inboxPath(agent: string): string {
    return path.join(this.baseDir, `${agent}-inbox.jsonl`)
  }

  private trimInbox(inboxPath: string): void {
    const raw = fs.readFileSync(inboxPath, "utf-8")
    const entries = raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          JSON.parse(line) as RoutedMessage
          return { line, valid: true }
        } catch {
          return { line, valid: false }
        }
      })
    const validCount = entries.filter((entry) => entry.valid).length
    if (validCount <= this.maxMessagesPerInbox) return

    let validSeen = 0
    const keepAfterValidIndex = validCount - this.maxMessagesPerInbox
    const kept = entries
      .filter((entry) => {
        if (!entry.valid) return true
        validSeen += 1
        return validSeen > keepAfterValidIndex
      })
      .map((entry) => entry.line)
    fs.writeFileSync(inboxPath, `${kept.join("\n")}\n`, "utf-8")
  }
}
