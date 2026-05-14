import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../../nerves/runtime"
import { parseHabitFile } from "../../habits/habit-parser"
import { applyHabitRuntimeState } from "../../habits/habit-runtime-state"
import { getAgentBundlesRoot } from "../../identity"
import { isDaemonStatus } from "../../daemon/daemon-health"
import {
  type MailboxAttentionQueueItem,
  type MailboxAttentionView,
  type MailboxBridgeInventory,
  type MailboxBridgeItem,
  type MailboxCanonicalNoteEntry,
  type MailboxCodingDeep,
  type MailboxCodingDeepItem,
  type MailboxDaemonHealthDeep,
  type MailboxDeskPrefs,
  type MailboxDiaryEntry,
  type MailboxFriendSummary,
  type MailboxFriendView,
  type MailboxHabitItem,
  type MailboxHabitView,
  type MailboxJournalEntry,
  type MailboxLogEntry,
  type MailboxLogView,
  type MailboxNotesView,
  type MailboxNeedsMeItem,
  type MailboxNeedsMeView,
  type MailboxPendingChannel,
} from "../mailbox-types"
import {
  ACTIVE_CODING_STATUSES,
  BLOCKED_CODING_STATUSES,
  type MailboxReadOptions,
  resolveFriendName,
  safeFileMtime,
  safeIsDirectory,
  safeReaddir,
  truncateExcerpt,
} from "./shared"
import { readObligationSummary } from "./agent-machine"
import { readSessionInventory } from "./sessions"

const NOTES_VIEW_LIMIT = 20

/* v8 ignore start — defensive parsing of on-disk JSON, fallback branches are safety nets */
export function readCodingDeep(agentRoot: string): MailboxCodingDeep {
  const stateFilePath = path.join(agentRoot, "state", "coding", "sessions.json")

  if (!fs.existsSync(stateFilePath)) {
    return { totalCount: 0, activeCount: 0, blockedCount: 0, items: [] }
  }

  let parsed: { records?: Array<{ session?: Record<string, unknown> }> }
  try {
    parsed = JSON.parse(fs.readFileSync(stateFilePath, "utf-8")) as typeof parsed
  } catch {
    return { totalCount: 0, activeCount: 0, blockedCount: 0, items: [] }
  }

  const items: MailboxCodingDeepItem[] = Array.isArray(parsed.records)
    ? parsed.records.flatMap((record) => {
      const s = record?.session
      if (!s || typeof s.id !== "string" || typeof s.status !== "string") return []

      const checkpoint = typeof s.checkpoint === "string" ? s.checkpoint
        : typeof s.stderrTail === "string" && s.stderrTail.trim().length > 0 ? s.stderrTail.trim()
          : typeof s.stdoutTail === "string" && s.stdoutTail.trim().length > 0 ? s.stdoutTail.trim()
            : null

      const originSession = s.originSession as Record<string, unknown> | undefined
      const normalizedOrigin = originSession
        && typeof originSession.friendId === "string"
        && typeof originSession.channel === "string"
        && typeof originSession.key === "string"
        ? { friendId: originSession.friendId, channel: originSession.channel, key: originSession.key }
        : null

      const failure = s.failure as Record<string, unknown> | null | undefined
      const normalizedFailure = failure && typeof failure === "object"
        ? {
            command: typeof failure.command === "string" ? failure.command : "",
            args: Array.isArray(failure.args) ? failure.args.map(String) : [],
            code: typeof failure.code === "number" ? failure.code : null,
            signal: typeof failure.signal === "string" ? failure.signal : null,
            stdoutTail: typeof failure.stdoutTail === "string" ? failure.stdoutTail : "",
            stderrTail: typeof failure.stderrTail === "string" ? failure.stderrTail : "",
          }
        : null

      return [{
        id: s.id,
        runner: (typeof s.runner === "string" ? s.runner : "claude") as MailboxCodingDeepItem["runner"],
        status: s.status as MailboxCodingDeepItem["status"],
        checkpoint,
        taskRef: typeof s.taskRef === "string" ? s.taskRef : null,
        workdir: typeof s.workdir === "string" ? s.workdir : "",
        originSession: normalizedOrigin,
        obligationId: typeof s.obligationId === "string" ? s.obligationId : null,
        scopeFile: typeof s.scopeFile === "string" ? s.scopeFile : null,
        stateFile: typeof s.stateFile === "string" ? s.stateFile : null,
        artifactPath: typeof s.artifactPath === "string" ? s.artifactPath : null,
        pid: typeof s.pid === "number" ? s.pid : null,
        startedAt: typeof s.startedAt === "string" ? s.startedAt : "",
        lastActivityAt: typeof s.lastActivityAt === "string" ? s.lastActivityAt : "",
        endedAt: typeof s.endedAt === "string" ? s.endedAt : null,
        restartCount: typeof s.restartCount === "number" ? s.restartCount : 0,
        lastExitCode: typeof s.lastExitCode === "number" ? s.lastExitCode : null,
        lastSignal: typeof s.lastSignal === "string" ? s.lastSignal : null,
        stdoutTail: typeof s.stdoutTail === "string" ? s.stdoutTail : "",
        stderrTail: typeof s.stderrTail === "string" ? s.stderrTail : "",
        failure: normalizedFailure,
      }]
    })
    : []

  return {
    totalCount: items.length,
    activeCount: items.filter((item) => ACTIVE_CODING_STATUSES.has(item.status)).length,
    blockedCount: items.filter((item) => BLOCKED_CODING_STATUSES.has(item.status)).length,
    items,
  }
}

/* v8 ignore stop */

function scanPendingChannels(agentRoot: string): MailboxPendingChannel[] {
  const pendingRoot = path.join(agentRoot, "state", "pending")
  const channels: MailboxPendingChannel[] = []

  for (const friendId of safeReaddir(pendingRoot)) {
    if (friendId === "self") continue
    const friendDir = path.join(pendingRoot, friendId)
    if (!safeIsDirectory(friendDir)) continue
    for (const channel of safeReaddir(friendDir)) {
      const channelDir = path.join(friendDir, channel)
      if (!safeIsDirectory(channelDir)) continue
      for (const key of safeReaddir(channelDir)) {
        const keyDir = path.join(channelDir, key)
        if (!safeIsDirectory(keyDir)) continue
        const files = safeReaddir(keyDir).filter((f) => f.endsWith(".json") || f.endsWith(".json.processing"))
        if (files.length > 0) {
          channels.push({ friendId, channel, key, messageCount: files.length })
        }
      }
    }
  }

  return channels
}

function readPendingMessagesNonDestructive(pendingDir: string): Array<Record<string, unknown>> {
  const files = safeReaddir(pendingDir).filter((f) => f.endsWith(".json") || f.endsWith(".json.processing"))
  const messages: Array<Record<string, unknown>> = []
  for (const file of files.sort()) {
    try {
      const raw = fs.readFileSync(path.join(pendingDir, file), "utf-8")
      messages.push(JSON.parse(raw) as Record<string, unknown>)
    } catch {
      // skip unparseable pending messages
    }
  }
  return messages
}

export function readAttentionView(agentName: string, options: MailboxReadOptions = {}): MailboxAttentionView {
  const bundlesRoot = options.bundlesRoot ?? getAgentBundlesRoot()
  const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
  const friendsDir = path.join(agentRoot, "friends")

  const pendingChannels = scanPendingChannels(agentRoot)
  const queueItems: MailboxAttentionQueueItem[] = []
  const pendingRoot = path.join(agentRoot, "state", "pending")

  for (const pending of pendingChannels) {
    const pendingDir = path.join(pendingRoot, pending.friendId, pending.channel, pending.key)
    const messages = readPendingMessagesNonDestructive(pendingDir)
    for (const msg of messages) {
      const delegatedFrom = msg.delegatedFrom as Record<string, unknown> | undefined
      queueItems.push({
        id: typeof msg.timestamp === "number" ? `${msg.timestamp}-${pending.friendId}` : `pending-${Date.now()}`,
        friendId: pending.friendId,
        friendName: resolveFriendName(friendsDir, pending.friendId),
        channel: pending.channel,
        key: pending.key,
        bridgeId: delegatedFrom && typeof delegatedFrom.bridgeId === "string" ? delegatedFrom.bridgeId : null,
        delegatedContent: typeof msg.content === "string" ? msg.content : "",
        obligationId: typeof msg.obligationId === "string" ? msg.obligationId : null,
        source: "pending",
        timestamp: typeof msg.timestamp === "number" ? msg.timestamp : 0,
      })
    }
  }

  queueItems.sort((a, b) => a.timestamp - b.timestamp)

  const returnObligations = readObligationSummary(agentRoot).items

  emitNervesEvent({
    component: "heart",
    event: "heart.mailbox_attention_read",
    message: "reading mailbox attention queue",
    meta: { agentName, queueLength: queueItems.length, pendingChannelCount: pendingChannels.length },
  })

  return {
    queueLength: queueItems.length,
    queueItems,
    pendingChannels,
    returnObligations,
  }
}

/* v8 ignore start — defensive parsing */
export function readBridgeInventory(agentRoot: string): MailboxBridgeInventory {
  const bridgesDir = path.join(agentRoot, "state", "bridges")
  const items: MailboxBridgeItem[] = []

  for (const file of safeReaddir(bridgesDir)) {
    if (!file.endsWith(".json")) continue
    try {
      const raw = fs.readFileSync(path.join(bridgesDir, file), "utf-8")
      const bridge = JSON.parse(raw) as Record<string, unknown>

      if (typeof bridge.id !== "string") continue

      const attachedSessions = Array.isArray(bridge.attachedSessions)
        ? (bridge.attachedSessions as Array<Record<string, unknown>>)
            .filter((s) => typeof s.friendId === "string")
            .map((s) => ({
              friendId: s.friendId as string,
              channel: typeof s.channel === "string" ? s.channel : "",
              key: typeof s.key === "string" ? s.key : "",
              sessionPath: typeof s.sessionPath === "string" ? s.sessionPath : "",
              snapshot: typeof s.snapshot === "string" ? s.snapshot : null,
            }))
        : []

      const taskLink = bridge.task as Record<string, unknown> | null | undefined
      const normalizedTask = taskLink && typeof taskLink === "object" && typeof taskLink.taskName === "string"
        ? {
            taskName: taskLink.taskName as string,
            path: typeof taskLink.path === "string" ? taskLink.path : "",
            mode: typeof taskLink.mode === "string" ? taskLink.mode : "bound",
            boundAt: typeof taskLink.boundAt === "string" ? taskLink.boundAt : "",
          }
        : null

      items.push({
        id: bridge.id,
        objective: typeof bridge.objective === "string" ? bridge.objective : "",
        summary: typeof bridge.summary === "string" ? bridge.summary : "",
        lifecycle: typeof bridge.lifecycle === "string" ? bridge.lifecycle : "unknown",
        runtime: typeof bridge.runtime === "string" ? bridge.runtime : "unknown",
        createdAt: typeof bridge.createdAt === "string" ? bridge.createdAt : "",
        updatedAt: typeof bridge.updatedAt === "string" ? bridge.updatedAt : "",
        attachedSessions,
        task: normalizedTask,
      })
    } catch {
      // skip unparseable bridge files
    }
  }

  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const activeCount = items.filter((item) => item.lifecycle === "active").length

  return {
    totalCount: items.length,
    activeCount,
    items,
  }
}

/* v8 ignore stop */

/* v8 ignore start — defensive parsing */
export function readDaemonHealthDeep(healthPath?: string): MailboxDaemonHealthDeep | null {
  const resolvedPath = healthPath ?? path.join(process.env.HOME ?? "", ".ouro-cli", "daemon-health.json")
  try {
    const raw = fs.readFileSync(resolvedPath, "utf-8")
    const health = JSON.parse(raw) as Record<string, unknown>

    return {
      // Layer 1: tighten the parse so only post-Layer-1 vocabulary
      // carries through. Stale cached files that still hold legacy
      // string values like "ok" or "running" — written by an older
      // daemon binary — fall back to "unknown" so downstream Mailbox
      // consumers can detect the unparseable case explicitly.
      status: isDaemonStatus(health.status) ? health.status : "unknown",
      mode: typeof health.mode === "string" ? health.mode : "unknown",
      pid: typeof health.pid === "number" ? health.pid : 0,
      startedAt: typeof health.startedAt === "string" ? health.startedAt : "",
      uptimeSeconds: typeof health.uptimeSeconds === "number" ? health.uptimeSeconds : 0,
      safeMode: health.safeMode && typeof health.safeMode === "object"
        ? {
            active: (health.safeMode as Record<string, unknown>).active === true,
            reason: typeof (health.safeMode as Record<string, unknown>).reason === "string" ? (health.safeMode as Record<string, unknown>).reason as string : "",
            enteredAt: typeof (health.safeMode as Record<string, unknown>).enteredAt === "string" ? (health.safeMode as Record<string, unknown>).enteredAt as string : "",
          }
        : null,
      degradedComponents: Array.isArray(health.degraded)
        ? (health.degraded as Array<Record<string, unknown>>).map((c) => ({
            component: typeof c.component === "string" ? c.component : "",
            reason: typeof c.reason === "string" ? c.reason : "",
            since: typeof c.since === "string" ? c.since : "",
          }))
        : [],
      agentHealth: health.agents && typeof health.agents === "object"
        ? Object.fromEntries(
            Object.entries(health.agents as Record<string, Record<string, unknown>>).map(([name, entry]) => [
              name,
              {
                status: typeof entry.status === "string" ? entry.status : "unknown",
                pid: typeof entry.pid === "number" ? entry.pid : null,
                crashes: typeof entry.crashes === "number" ? entry.crashes : 0,
              },
            ]),
          )
        : {},
      habitHealth: health.habits && typeof health.habits === "object"
        ? Object.fromEntries(
            Object.entries(health.habits as Record<string, Record<string, unknown>>).map(([name, entry]) => [
              name,
              {
                cronStatus: typeof entry.cronStatus === "string" ? entry.cronStatus : "unknown",
                lastFired: typeof entry.lastFired === "string" ? entry.lastFired : null,
                fallback: entry.fallback === true,
              },
            ]),
          )
        : {},
    }
  } catch {
    return null
  }
}

/* v8 ignore stop */

export function readNotesView(agentRoot: string): MailboxNotesView {
  const diaryRoot = path.join(agentRoot, "diary")
  const effectiveDiaryRoot = fs.existsSync(diaryRoot) ? diaryRoot : null

  const diaryEntries: MailboxDiaryEntry[] = []
  if (effectiveDiaryRoot) {
    const factsPath = path.join(effectiveDiaryRoot, "facts.jsonl")
    try {
      const raw = fs.readFileSync(factsPath, "utf-8")
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as Record<string, unknown>
          if (typeof entry.id === "string" && typeof entry.text === "string") {
            diaryEntries.push({
              id: entry.id,
              text: entry.text,
              source: typeof entry.source === "string" ? entry.source : "",
              createdAt: typeof entry.createdAt === "string" ? entry.createdAt : "",
            })
          }
        } catch {
          // skip unparseable lines
        }
      }
    } catch {
      // no diary facts file
    }
  }

  diaryEntries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const journalDir = path.join(agentRoot, "journal")
  const journalEntries: MailboxJournalEntry[] = []
  const indexPath = path.join(journalDir, ".index.json")
  try {
    const raw = fs.readFileSync(indexPath, "utf-8")
    const index = JSON.parse(raw) as Array<Record<string, unknown>>
    if (Array.isArray(index)) {
      for (const entry of index) {
        if (typeof entry.filename === "string") {
          journalEntries.push({
            filename: entry.filename,
            preview: typeof entry.preview === "string" ? entry.preview : "",
            mtime: typeof entry.mtime === "number" ? entry.mtime : 0,
          })
        }
      }
    }
  } catch {
    // no journal index
  }

  journalEntries.sort((a, b) => b.mtime - a.mtime)

  const canonicalNotes = readCanonicalNotes(agentRoot)

  return {
    diaryEntryCount: diaryEntries.length,
    recentDiaryEntries: diaryEntries.slice(0, NOTES_VIEW_LIMIT),
    journalEntryCount: journalEntries.length,
    recentJournalEntries: journalEntries.slice(0, NOTES_VIEW_LIMIT),
    canonicalNoteCount: canonicalNotes.length,
    recentCanonicalNotes: canonicalNotes.slice(0, NOTES_VIEW_LIMIT),
  }
}

function readCanonicalNotes(agentRoot: string): MailboxCanonicalNoteEntry[] {
  const notesRoot = path.join(agentRoot, "notes")
  const notes: MailboxCanonicalNoteEntry[] = []

  for (const filename of safeReaddir(notesRoot)) {
    if (!filename.endsWith(".md")) continue
    const filePath = path.join(notesRoot, filename)
    if (safeIsDirectory(filePath)) continue

    try {
      const raw = fs.readFileSync(filePath, "utf-8")
      const { frontmatter, body } = parseMarkdownFrontmatter(raw)
      const writtenAt = typeof frontmatter.created_at === "string" && frontmatter.created_at.trim().length > 0
        ? frontmatter.created_at.trim()
        : safeFileMtime(filePath) ?? ""

      notes.push({
        filename,
        title: firstMarkdownHeading(body) ?? titleFromFilename(filename),
        tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
        preview: body.slice(0, 200),
        writtenAt,
      })
    } catch {
      // skip unreadable notes
    }
  }

  notes.sort((a, b) => b.writtenAt.localeCompare(a.writtenAt) || b.filename.localeCompare(a.filename))
  return notes
}

function parseMarkdownFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const lines = raw.split(/\r?\n/)
  if (lines[0] !== "---") return { frontmatter: {}, body: raw }

  const endIndex = lines.findIndex((line, index) => index > 0 && line === "---")
  if (endIndex === -1) return { frontmatter: {}, body: raw }

  return {
    frontmatter: parseMinimalFrontmatter(lines.slice(1, endIndex)),
    body: lines.slice(endIndex + 1).join("\n").replace(/^\n/, ""),
  }
}

function parseMinimalFrontmatter(lines: string[]): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = {}

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const match = line?.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!match) continue

    const [, key, rawValue] = match
    if (!key) continue

    if (key === "tags") {
      frontmatter.tags = parseFrontmatterTags(rawValue ?? "", lines, index + 1)
      continue
    }

    frontmatter[key] = (rawValue ?? "").trim()
  }

  return frontmatter
}

function parseFrontmatterTags(rawValue: string, lines: string[], startIndex: number): string[] {
  const trimmed = rawValue.trim()
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
    } catch {
      return trimmed.slice(1, -1).split(",").map((tag) => tag.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean)
    }
  }

  if (trimmed.length > 0) return [trimmed]

  const tags: string[] = []
  for (let index = startIndex; index < lines.length; index += 1) {
    const itemMatch = lines[index]?.match(/^\s*-\s*(.+)$/)
    if (!itemMatch) break
    const tag = itemMatch[1]?.trim().replace(/^['"]|['"]$/g, "")
    if (tag) tags.push(tag)
  }
  return tags
}

function firstMarkdownHeading(body: string): string | null {
  const heading = body
    .split(/\r?\n/)
    .map((line) => line.match(/^#\s+(.+)$/)?.[1]?.trim())
    .find((title) => title && title.length > 0)
  return heading ?? null
}

function titleFromFilename(filename: string): string {
  const stem = filename.replace(/\.md$/i, "").replace(/^\d{4}-\d{2}-\d{2}-/, "")
  return stem.replace(/[-_]+/g, " ").trim() || filename
}

export function readFriendView(agentName: string, options: MailboxReadOptions = {}): MailboxFriendView {
  const bundlesRoot = options.bundlesRoot ?? getAgentBundlesRoot()
  const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
  const friendsDir = path.join(agentRoot, "friends")
  const sessionsDir = path.join(agentRoot, "state", "sessions")

  const friends: MailboxFriendSummary[] = []

  for (const file of safeReaddir(friendsDir)) {
    if (!file.endsWith(".json")) continue
    const friendId = file.slice(0, -5)
    try {
      const raw = fs.readFileSync(path.join(friendsDir, file), "utf-8")
      const record = JSON.parse(raw) as Record<string, unknown>

      const friendSessionsDir = path.join(sessionsDir, friendId)
      const channels = new Set<string>()
      let sessionCount = 0
      let latestActivity: string | null = null

      for (const channel of safeReaddir(friendSessionsDir)) {
        const channelDir = path.join(friendSessionsDir, channel)
        if (!safeIsDirectory(channelDir)) continue
        for (const keyFile of safeReaddir(channelDir)) {
          if (!keyFile.endsWith(".json")) continue
          channels.add(channel)
          sessionCount++
          const mtime = safeFileMtime(path.join(channelDir, keyFile))
          if (mtime && (!latestActivity || mtime > latestActivity)) {
            latestActivity = mtime
          }
        }
      }

      friends.push({
        friendId,
        friendName: typeof record.name === "string" ? record.name : friendId,
        totalTokens: typeof record.totalTokens === "number" ? record.totalTokens : 0,
        sessionCount,
        channels: [...channels].sort(),
        lastActivityAt: latestActivity,
      })
    } catch {
      // skip unparseable friend records
    }
  }

  friends.sort((a, b) => b.totalTokens - a.totalTokens)

  return {
    totalFriends: friends.length,
    friends,
  }
}

export function readLogView(logPath: string | null, limit = 100): MailboxLogView {
  if (!logPath || !fs.existsSync(logPath)) {
    return { logPath, totalLines: 0, entries: [] }
  }

  try {
    const raw = fs.readFileSync(logPath, "utf-8")
    const lines = raw.split("\n").filter((l) => l.trim().length > 0)
    const totalLines = lines.length
    const recentLines = lines.slice(-limit)

    const entries: MailboxLogEntry[] = []
    for (const line of recentLines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        entries.push({
          ts: typeof parsed.ts === "string" ? parsed.ts : "",
          level: typeof parsed.level === "string" ? parsed.level as MailboxLogEntry["level"] : "info",
          event: typeof parsed.event === "string" ? parsed.event : "",
          component: typeof parsed.component === "string" ? parsed.component : "",
          message: typeof parsed.message === "string" ? parsed.message : "",
          trace_id: typeof parsed.trace_id === "string" ? parsed.trace_id : "",
          meta: parsed.meta && typeof parsed.meta === "object" ? parsed.meta as Record<string, unknown> : {},
        })
      } catch {
        // skip unparseable log lines
      }
    }

    return { logPath, totalLines, entries }
  } catch { /* v8 ignore next */
    return { logPath, totalLines: 0, entries: [] }
  }
}

export function readHabitView(agentRoot: string, options: MailboxReadOptions = {}): MailboxHabitView {
  const habitsDir = path.join(agentRoot, "habits")
  const now = options.now?.() ?? new Date()
  const items: MailboxHabitItem[] = []

  for (const file of safeReaddir(habitsDir)) {
    if (!file.endsWith(".md")) continue
    try {
      const filePath = path.join(habitsDir, file)
      const raw = fs.readFileSync(filePath, "utf-8")
      if (!/^---\r?\n[\s\S]*?\r?\n---/.test(raw)) continue
      const habit = applyHabitRuntimeState(agentRoot, parseHabitFile(raw, filePath))

      const cadenceMs = parseCadenceMs(habit.cadence)
      let isOverdue = false
      let overdueMs: number | null = null
      if (habit.status === "active" && habit.lastRun && cadenceMs) {
        const elapsed = now.getTime() - Date.parse(habit.lastRun)
        if (elapsed > cadenceMs) {
          isOverdue = true
          overdueMs = elapsed - cadenceMs
        }
      }

      items.push({
        name: habit.name,
        title: habit.title,
        cadence: habit.cadence,
        status: habit.status,
        lastRun: habit.lastRun,
        bodyExcerpt: truncateExcerpt(habit.body, 120),
        isDegraded: false,
        degradedReason: null,
        isOverdue,
        overdueMs,
      })
    } catch {
      // skip unparseable habit files
    }
  }

  items.sort((a, b) => {
    if (a.isOverdue && !b.isOverdue) return -1
    if (!a.isOverdue && b.isOverdue) return 1
    return a.name.localeCompare(b.name)
  })

  return {
    totalCount: items.length,
    activeCount: items.filter((h) => h.status === "active").length,
    pausedCount: items.filter((h) => h.status === "paused").length,
    degradedCount: items.filter((h) => h.isDegraded).length,
    overdueCount: items.filter((h) => h.isOverdue).length,
    items,
  }
}

export function readNeedsMeView(agentName: string, options: MailboxReadOptions = {}): MailboxNeedsMeView {
  const bundlesRoot = options.bundlesRoot ?? getAgentBundlesRoot()
  const now = options.now?.() ?? new Date()
  const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
  const items: MailboxNeedsMeItem[] = []

  const prefs = readDeskPrefs(agentRoot)
  const dismissed = new Set(prefs.dismissedObligations)

  const sessions = readSessionInventory(agentName, options)
  for (const s of sessions.items) {
    if (s.replyState === "needs-reply") {
      items.push({
        urgency: "owed-reply",
        label: `${s.friendName} is waiting for a reply`,
        detail: `via ${s.channel} · ${s.latestUserExcerpt ? truncateExcerpt(s.latestUserExcerpt, 80) : ""}`,
        ref: { tab: "sessions", focus: `${s.friendId}/${s.channel}/${s.key}` },
        ageMs: now.getTime() - Date.parse(s.lastActivityAt),
      })
    }
  }

  const obligations = readObligationSummary(agentRoot)
  for (const o of obligations.items) {
    if (dismissed.has(o.id)) continue
    const ageMs = now.getTime() - Date.parse(o.updatedAt)
    const isStale = ageMs > 24 * 60 * 60 * 1000

    const hasResult = o.currentSurface !== null
    const isOpen = o.status === "pending" || o.status === "investigating" || o.status === "waiting_for_merge" || o.status === "updating_runtime"

    if (isOpen) {
      items.push({
        urgency: hasResult ? "return-ready" : isStale ? "stale-delegation" : "blocking-obligation",
        label: truncateExcerpt(o.content, 80) ?? o.id,
        detail: hasResult ? `result ready — ${o.currentSurface!.kind}: ${o.currentSurface!.label}` : `${o.status}${o.nextAction ? ` · next: ${o.nextAction}` : ""}`,
        ref: { tab: "work", focus: o.id },
        ageMs,
      })
    }
  }

  const pendingChannels = scanPendingChannels(agentRoot)
  for (const p of pendingChannels) {
    const friendName = resolveFriendName(path.join(agentRoot, "friends"), p.friendId)
    items.push({
      urgency: "stale-delegation",
      label: `${p.messageCount} pending from ${friendName}`,
      detail: `${p.channel}/${p.key}`,
      ref: { tab: "connections" },
      ageMs: null,
    })
  }

  const habits = readHabitView(agentRoot, options)
  for (const h of habits.items) {
      if (h.isOverdue) {
        items.push({
          urgency: "overdue-habit",
          label: `${h.title} is overdue`,
          detail: `every ${h.cadence!} · last ${h.lastRun!}`,
          ref: { tab: "inner" },
          ageMs: h.overdueMs,
        })
      }
  }

  const urgencyOrder: Record<string, number> = {
    "owed-reply": 0,
    "blocking-obligation": 1,
    "broken-return": 2,
    "stale-delegation": 3,
    "return-ready": 4,
    "overdue-habit": 5,
  }
  items.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency])

  return { items }
}

/* v8 ignore start — defensive JSON parsing in desk prefs reader */
export function readDeskPrefs(agentRoot: string): MailboxDeskPrefs {
  const prefsPath = path.join(agentRoot, "state", "mailbox-prefs.json")
  const legacyPrefsPath = path.join(agentRoot, "state", "outlook-prefs.json")
  const defaults: MailboxDeskPrefs = {
    carrying: null,
    statusLine: null,
    tabOrder: null,
    starredFriends: [],
    pinnedConstellations: [],
    dismissedObligations: [],
  }
  try {
    const raw = fs.readFileSync(fs.existsSync(prefsPath) ? prefsPath : legacyPrefsPath, "utf-8")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      carrying: typeof parsed.carrying === "string" ? parsed.carrying : null,
      statusLine: typeof parsed.statusLine === "string" ? parsed.statusLine : null,
      tabOrder: Array.isArray(parsed.tabOrder) ? parsed.tabOrder.filter((t): t is string => typeof t === "string") : null,
      starredFriends: Array.isArray(parsed.starredFriends) ? parsed.starredFriends.filter((f): f is string => typeof f === "string") : [],
      pinnedConstellations: Array.isArray(parsed.pinnedConstellations)
        ? (parsed.pinnedConstellations as Array<Record<string, unknown>>).map((c) => ({
            label: typeof c.label === "string" ? c.label : "",
            friendIds: Array.isArray(c.friendIds) ? c.friendIds.filter((f): f is string => typeof f === "string") : [],
            taskRefs: Array.isArray(c.taskRefs) ? c.taskRefs.filter((t): t is string => typeof t === "string") : [],
            bridgeIds: Array.isArray(c.bridgeIds) ? c.bridgeIds.filter((b): b is string => typeof b === "string") : [],
            codingIds: Array.isArray(c.codingIds) ? c.codingIds.filter((c2): c2 is string => typeof c2 === "string") : [],
          }))
        : [],
      dismissedObligations: Array.isArray(parsed.dismissedObligations) ? parsed.dismissedObligations.filter((id): id is string => typeof id === "string") : [],
    }
  } catch {
    return defaults
  }
}
/* v8 ignore stop */

function parseCadenceMs(cadence: string | null): number | null {
  if (!cadence) return null
  const match = /^(\d+)\s*(m|min|h|hr|d|day)s?$/i.exec(cadence.trim())
  if (!match) return null
  const value = parseInt(match[1]!, 10)
  const multipliers = {
    m: 60 * 1000,
    min: 60 * 1000,
    h: 60 * 60 * 1000,
    hr: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
  } as const
  const unit = match[2]!.toLowerCase() as keyof typeof multipliers
  return value * multipliers[unit]
}
