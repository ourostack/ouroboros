import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../../nerves/runtime"
import { readActiveCares } from "../../../arc/cares"
import { readRecentEpisodes } from "../../../arc/episodes"
import { isOpenObligation, readObligations } from "../../../arc/obligations"
import { readPeerPresence, readPresence } from "../../../arc/presence"
import { scanTasks } from "../../../repertoire/tasks/scanner"
import { detectActiveWorkChanges, formatActiveWorkChanges, type ActiveWorkSnapshot } from "../../active-work"
import { listSessionActivity } from "../../session-activity"
import { readObligationSummary } from "./agent-machine"
import {
  type MailboxChangesView,
  type MailboxContinuityView,
  type MailboxNoteDecision,
  type MailboxNoteDecisionView,
  type MailboxObligationDetailItem,
  type MailboxObligationDetailView,
  type MailboxOrientationView,
  type MailboxSelfFixStep,
  type MailboxSelfFixView,
} from "../mailbox-types"

function sortOpenObligations(obligations: ReturnType<typeof readObligations>) {
  const statusPriority: Record<string, number> = {
    returning: 0,
    collaborating: 1,
    in_progress: 2,
    delegated: 3,
    accepted: 4,
    pending: 5,
  }

  return obligations
    .map((obligation) => ({
      obligation,
      priority: statusPriority[obligation.status] ?? 99,
      updatedMs: new Date(obligation.updatedAt ?? obligation.createdAt).getTime(),
    }))
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority
      return b.updatedMs - a.updatedMs
    })
    .map((entry) => entry.obligation)
}

export function readMailboxContinuity(agentRoot: string, agentName: string): MailboxContinuityView {
  const self = readPresence(agentRoot, agentName)
  const peers = readPeerPresence(agentRoot)
  const cares = readActiveCares(agentRoot)
  const episodes = readRecentEpisodes(agentRoot, { limit: 10 })

  emitNervesEvent({
    component: "heart",
    event: "heart.mailbox_continuity_read",
    message: `mailbox continuity: ${cares.length} cares, ${episodes.length} episodes`,
    meta: { careCount: cares.length, episodeCount: episodes.length, hasSelf: self != null, peerCount: peers.length },
  })

  return {
    presence: { self, peers },
    cares: {
      activeCount: cares.length,
      items: cares.map((c) => ({
        id: c.id,
        label: c.label,
        status: c.status,
        salience: c.salience,
      })),
    },
    episodes: {
      recentCount: episodes.length,
      items: episodes.map((ep) => ({
        id: ep.id,
        kind: ep.kind,
        summary: ep.summary,
        timestamp: ep.timestamp,
      })),
    },
  }
}

export function readOrientationView(agentRoot: string, agentName: string): MailboxOrientationView {
  let obligations: ReturnType<typeof readObligations> = []
  try {
    obligations = readObligations(agentRoot)
  } catch {
    obligations = []
  }
  const openObligations = obligations.filter(isOpenObligation)
  const sorted = sortOpenObligations(openObligations)
  const primary = sorted[0] ?? null

  let sessions: ReturnType<typeof listSessionActivity> = []
  try {
    sessions = listSessionActivity({
      sessionsDir: path.join(agentRoot, "state", "sessions"),
      friendsDir: path.join(agentRoot, "friends"),
      agentName,
    })
  } catch {
    sessions = []
  }
  const sortedSessions = [...sessions].sort((a, b) => b.lastActivityMs - a.lastActivityMs)

  const currentSession = sortedSessions.length > 0
    ? {
        friendId: sortedSessions[0]!.friendId,
        channel: sortedSessions[0]!.channel,
        key: sortedSessions[0]!.key,
        lastActivityAt: sortedSessions[0]!.lastActivityAt,
      }
    : null

  const otherActiveSessions = sortedSessions.slice(1).map((s) => ({
    friendId: s.friendId,
    friendName: s.friendName,
    channel: s.channel,
    key: s.key,
    lastActivityAt: s.lastActivityAt,
  }))

  const parts: string[] = []
  if (primary) parts.push(primary.content)
  if (openObligations.length > 1) parts.push(`${openObligations.length} open obligations`)
  if (sessions.length > 0) parts.push(`${sessions.length} active sessions`)
  const centerOfGravity = parts.length > 0 ? parts.join(" | ") : "idle"

  const primaryObligation = primary
    ? {
        id: primary.id,
        content: primary.content,
        status: primary.status,
        nextAction: primary.nextAction ?? null,
        waitingOn: primary.meaning?.waitingOn?.detail ?? null,
      }
    : null

  emitNervesEvent({
    component: "heart",
    event: "heart.mailbox_orientation_read",
    message: `mailbox orientation: ${openObligations.length} obligations, ${sessions.length} sessions`,
    meta: { obligationCount: openObligations.length, sessionCount: sessions.length, primaryId: primary?.id ?? null },
  })

  return {
    currentSession,
    centerOfGravity,
    primaryObligation,
    resumeHandle: null,
    otherActiveSessions,
    rawState: null,
  }
}

export function readObligationDetailView(agentRoot: string): MailboxObligationDetailView {
  let obligations: ReturnType<typeof readObligations> = []
  try {
    obligations = readObligations(agentRoot)
  } catch {
    obligations = []
  }
  const openObligations = obligations.filter(isOpenObligation)
  const sorted = sortOpenObligations(openObligations)
  const primary = sorted[0] ?? null
  const normalizedSummary = new Map(
    readObligationSummary(agentRoot).items.map((item) => [item.id, item.currentSurface] as const),
  )

  const items: MailboxObligationDetailItem[] = openObligations.map((ob) => ({
    id: ob.id,
    status: ob.status,
    content: ob.content,
    updatedAt: ob.updatedAt ?? ob.createdAt,
    nextAction: ob.nextAction ?? null,
    origin: ob.origin ?? null,
    currentSurface: normalizedSummary.has(ob.id)
      ? (normalizedSummary.get(ob.id) ?? null)
      : (ob.currentSurface ? { kind: ob.currentSurface.kind, label: ob.currentSurface.label } : null),
    meaning: ob.meaning ? { waitingOn: ob.meaning.waitingOn?.detail ?? null } : null,
    isPrimary: ob.id === primary!.id,
  }))

  let primarySelectionReason: string | null = null
  if (primary) {
    if (primary.status !== "pending") {
      primarySelectionReason = `most advanced status: ${primary.status}`
    } else {
      primarySelectionReason = "most recent pending"
    }
  }

  emitNervesEvent({
    component: "heart",
    event: "heart.mailbox_obligations_read",
    message: `mailbox obligations: ${openObligations.length} open`,
    meta: { openCount: openObligations.length, primaryId: primary?.id ?? null },
  })

  return {
    openCount: openObligations.length,
    primaryId: primary?.id ?? null,
    primarySelectionReason,
    items,
  }
}

export function readChangesView(agentRoot: string): MailboxChangesView {
  const snapshotPath = path.join(agentRoot, "state", "mailbox", "active-work-snapshot.json")
  const legacySnapshotPath = path.join(agentRoot, "state", "outlook", "active-work-snapshot.json")

  let previous: ActiveWorkSnapshot | null = null
  try {
    const raw = fs.readFileSync(fs.existsSync(snapshotPath) ? snapshotPath : legacySnapshotPath, "utf-8")
    previous = JSON.parse(raw) as ActiveWorkSnapshot
    if (!previous.obligationSnapshots || !previous.codingSnapshots) previous = null
  } catch {
    previous = null
  }

  let obligations: ReturnType<typeof readObligations> = []
  try { obligations = readObligations(agentRoot) } catch { obligations = [] }
  const openObligations = obligations.filter(isOpenObligation)

  const current: ActiveWorkSnapshot = {
    obligationSnapshots: openObligations.map((ob) => ({
      id: ob.id,
      status: ob.status,
      artifact: ob.currentArtifact?.trim() || null,
      nextAction: ob.nextAction?.trim() || null,
    })),
    codingSnapshots: [],
    timestamp: new Date().toISOString(),
  }

  try {
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true })
    fs.writeFileSync(snapshotPath, JSON.stringify(current, null, 2) + "\n", "utf-8")
  } catch {
    // Best effort
  }

  if (!previous) {
    return { changeCount: 0, items: [], snapshotAge: null, formatted: "" }
  }

  const changes = detectActiveWorkChanges(previous, current)
  const formatted = formatActiveWorkChanges(changes)

  emitNervesEvent({
    component: "heart",
    event: "heart.mailbox_changes_read",
    message: `mailbox changes: ${changes.length} detected`,
    meta: { changeCount: changes.length, snapshotAge: previous.timestamp },
  })

  return {
    changeCount: changes.length,
    items: changes.map((c) => ({ kind: c.kind, id: c.id, from: c.from, to: c.to, summary: c.summary })),
    snapshotAge: previous.timestamp,
    formatted,
  }
}

export function readSelfFixView(agentRoot: string): MailboxSelfFixView {
  let tasks: { name: string; title: string; status: string }[] = []
  try {
    const scanned = scanTasks(path.join(agentRoot, "tasks"))
    tasks = scanned.tasks.map((t) => ({ name: t.name, title: t.title, status: t.status }))
  } catch {
    tasks = []
  }

  const selfFixTasks = tasks.filter((t) => t.title.toLowerCase().includes("fix"))

  if (selfFixTasks.length === 0) {
    return { active: false, currentStep: null, steps: [] }
  }

  const steps: MailboxSelfFixStep[] = selfFixTasks.map((t) => ({
    label: t.title,
    status: t.status === "done" ? "done" : t.status === "processing" ? "active" : "pending",
    detail: `task ${t.name}: ${t.status}`,
  }))

  const activeStep = steps.find((s) => s.status === "active")

  emitNervesEvent({
    component: "heart",
    event: "heart.mailbox_selffix_read",
    message: `mailbox self-fix: ${selfFixTasks.length} tasks`,
    meta: { taskCount: selfFixTasks.length, active: !!activeStep },
  })

  return {
    active: !!activeStep,
    currentStep: activeStep?.label ?? null,
    steps,
  }
}

export function readNoteDecisionView(agentRoot: string, limit = 50): MailboxNoteDecisionView {
  const logPath = path.join(agentRoot, "state", "mailbox", "note-decisions.jsonl")
  const legacyLogPath = path.join(agentRoot, "state", "outlook", "note-decisions.jsonl")

  let lines: string[] = []
  try {
    const raw = fs.readFileSync(fs.existsSync(logPath) ? logPath : legacyLogPath, "utf-8")
    lines = raw.split("\n").filter((l) => l.trim().length > 0)
  } catch {
    return { totalCount: 0, items: [] }
  }

  const items: MailboxNoteDecision[] = []
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as MailboxNoteDecision
      if (parsed.kind && parsed.decision && parsed.timestamp) {
        items.push(parsed)
      }
    } catch {
      // Skip malformed lines
    }
  }

  items.reverse()
  const limited = items.slice(0, limit)

  return { totalCount: items.length, items: limited }
}
