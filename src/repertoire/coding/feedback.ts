import { getAgentName, getAgentRoot } from "../../heart/identity"
import { requestInnerWake } from "../../heart/daemon/socket-client"
import { advanceObligation } from "../../heart/obligations"
import { emitNervesEvent } from "../../nerves/runtime"
import type { CodingSession, CodingSessionUpdate } from "./types"

export interface CodingSessionFeedbackManagerLike {
  subscribe(sessionId: string, listener: (update: CodingSessionUpdate) => void | Promise<void>): () => void
}

export interface CodingFeedbackTarget {
  send(message: string): Promise<void>
}

const TERMINAL_UPDATE_KINDS = new Set<CodingSessionUpdate["kind"]>(["completed", "failed", "killed"])
const OBLIGATION_WAKE_UPDATE_KINDS = new Set<CodingSessionUpdate["kind"]>([
  "waiting_input",
  "stalled",
  "completed",
  "failed",
  "killed",
])
const PULL_REQUEST_NUMBER_PATTERN = /\bPR\s*#(\d+)\b/i
const PULL_REQUEST_URL_PATTERN = /\/pull\/(\d+)(?:\b|\/)?/i

function clip(text: string, maxLength = 280): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxLength) return trimmed
  return `${trimmed.slice(0, maxLength - 3)}...`
}

function isNoiseLine(line: string): boolean {
  return (
    /^-+$/.test(line)
    || /^Reading prompt from stdin/i.test(line)
    || /^OpenAI Codex v/i.test(line)
    || /^workdir:/i.test(line)
    || /^model:/i.test(line)
    || /^provider:/i.test(line)
    || /^approval:/i.test(line)
    || /^sandbox:/i.test(line)
    || /^reasoning effort:/i.test(line)
    || /^reasoning summaries:/i.test(line)
    || /^session id:/i.test(line)
    || /^mcp startup:/i.test(line)
    || /^tokens used$/i.test(line)
    || /^\d{1,3}(,\d{3})*$/.test(line)
    || /^\d{4}-\d{2}-\d{2}T.*\bWARN\b/.test(line)
    || line === "user"
    || line === "codex"
  )
}

function lastMeaningfulLine(text: string | undefined): string | null {
  if (!text) return null
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isNoiseLine(line))
  if (lines.length === 0) return null
  return clip(lines.at(-1)!)
}

function formatSessionLabel(session: CodingSession): string {
  const origin = session.originSession
    ? ` for ${session.originSession.channel}/${session.originSession.key}`
    : ""
  return `${session.runner} ${session.id}${origin}`
}

function extractPullRequestLabel(snippet: string | null): string | null {
  if (!snippet) return null
  const numberMatch = snippet.match(PULL_REQUEST_NUMBER_PATTERN)
  if (numberMatch) return `PR #${numberMatch[1]}`
  const urlMatch = snippet.match(PULL_REQUEST_URL_PATTERN)
  if (urlMatch) return `PR #${urlMatch[1]}`
  return null
}

function isMergedPullRequestSnippet(snippet: string): boolean {
  return /\bmerged\b/i.test(snippet) || /\blanded\b/i.test(snippet)
}

interface ObligationMilestone {
  status?: "investigating" | "waiting_for_merge" | "updating_runtime"
  currentSurface?: { kind: "coding" | "merge" | "runtime"; label: string }
  currentArtifact?: string
  nextAction?: string
}

function deriveObligationMilestone(update: CodingSessionUpdate): ObligationMilestone | null {
  const snippet = pickUpdateSnippet(update)
  const pullRequest = extractPullRequestLabel(snippet)

  if (update.kind === "completed" && snippet && pullRequest && isMergedPullRequestSnippet(snippet)) {
    return {
      status: "updating_runtime",
      currentSurface: { kind: "runtime", label: "ouro up" },
      currentArtifact: pullRequest,
      nextAction: "update runtime, verify version/changelog, then re-observe",
    }
  }

  if (update.kind === "completed" && pullRequest) {
    return {
      status: "waiting_for_merge",
      currentSurface: { kind: "merge", label: pullRequest },
      currentArtifact: pullRequest,
      nextAction: `wait for checks, merge ${pullRequest}, then update runtime`,
    }
  }

  if (update.kind === "waiting_input") {
    return {
      status: "investigating",
      currentSurface: { kind: "coding", label: `${update.session.runner} ${update.session.id}` },
      nextAction: `answer ${update.session.runner} ${update.session.id} and continue`,
    }
  }

  if (update.kind === "stalled") {
    return {
      status: "investigating",
      currentSurface: { kind: "coding", label: `${update.session.runner} ${update.session.id}` },
      nextAction: `unstick ${update.session.runner} ${update.session.id} and continue`,
    }
  }

  if (update.kind === "progress" || update.kind === "spawned" || update.kind === "failed" || update.kind === "killed" || update.kind === "completed") {
    return {
      status: "investigating",
      currentSurface: { kind: "coding", label: `${update.session.runner} ${update.session.id}` },
    }
  }

  return null
}

function isSafeProgressSnippet(snippet: string): boolean {
  const normalized = snippet.trim()
  const wordCount = snippet.split(/\s+/).filter(Boolean).length
  return (
    normalized.length <= 80
    && wordCount >= 2
    && wordCount <= 8
    && /[A-Za-z]{3,}/.test(normalized)
    && !normalized.includes(":")
    && !/[{}\[\]();]/.test(normalized)
    && !normalized.startsWith("**")
    && !/^Respond with\b/i.test(normalized)
    && !/^Coding session metadata\b/i.test(normalized)
    && !/^sessionId\b/i.test(normalized)
    && !/^taskRef\b/i.test(normalized)
    && !/^parentAgent\b/i.test(normalized)
  )
}

function pickUpdateSnippet(update: CodingSessionUpdate): string | null {
  const checkpoint = update.session.checkpoint?.trim() || null
  return (
    checkpoint
    ?? lastMeaningfulLine(update.text)
    ?? lastMeaningfulLine(update.session.stderrTail)
    ?? lastMeaningfulLine(update.session.stdoutTail)
  )
}

function renderValue(text: string | undefined): string {
  const trimmed = text?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : "(empty)"
}

function renderPath(text: string | undefined): string {
  return text && text.trim().length > 0 ? text : "(none)"
}

export function formatCodingTail(session: CodingSession): string {
  const stdout = renderValue(session.stdoutTail)
  const stderr = renderValue(session.stderrTail)
  return [
    `sessionId: ${session.id}`,
    `runner: ${session.runner}`,
    `status: ${session.status}`,
    `checkpoint: ${renderValue(session.checkpoint ?? undefined)}`,
    `artifactPath: ${renderPath(session.artifactPath)}`,
    `workdir: ${session.workdir}`,
    "",
    "[stdout]",
    stdout,
    "",
    "[stderr]",
    stderr,
  ].join("\n")
}

function formatUpdateMessage(update: CodingSessionUpdate): string | null {
  const label = formatSessionLabel(update.session)
  const snippet = pickUpdateSnippet(update)

  switch (update.kind) {
    case "progress":
      return snippet && isSafeProgressSnippet(snippet) ? `${label}: ${snippet}` : null
    case "waiting_input":
      return snippet ? `${label} waiting: ${snippet}` : `${label} waiting`
    case "stalled":
      return snippet ? `${label} stalled: ${snippet}` : `${label} stalled`
    case "completed":
      return snippet ? `${label} completed: ${snippet}` : `${label} completed`
    case "failed":
      return snippet ? `${label} failed: ${snippet}` : `${label} failed`
    case "killed":
      return `${label} killed`
    case "spawned":
      return `${label} started`
  }
}

function formatReportBackMessage(update: CodingSessionUpdate, baseMessage: string | null): string | null {
  if (!baseMessage) return null
  if (!update.session.obligationId || !update.session.originSession) {
    return baseMessage
  }

  const milestone = deriveObligationMilestone(update)
  const extraLines: string[] = []
  if (milestone?.currentArtifact) {
    extraLines.push(`current artifact: ${milestone.currentArtifact}`)
  }
  if (milestone?.nextAction) {
    extraLines.push(`next: ${milestone.nextAction}`)
  }
  return extraLines.length > 0 ? `${baseMessage}\n${extraLines.join("\n")}` : baseMessage
}

function obligationNoteFromUpdate(update: CodingSessionUpdate): string | null {
  const snippet = pickUpdateSnippet(update)
  switch (update.kind) {
    case "spawned":
      return update.session.originSession
        ? `coding session started for ${update.session.originSession.channel}/${update.session.originSession.key}`
        : "coding session started"
    case "progress":
      return snippet ? `coding session progress: ${snippet}` : null
    case "waiting_input":
      return snippet ? `coding session waiting: ${snippet}` : "coding session waiting for input"
    case "stalled":
      return snippet ? `coding session stalled: ${snippet}` : "coding session stalled"
    case "completed":
      return snippet
        ? `coding session completed: ${snippet}; merge/update still pending`
        : "coding session completed; merge/update still pending"
    case "failed":
      return snippet ? `coding session failed: ${snippet}` : "coding session failed"
    case "killed":
      return "coding session killed"
  }
}

function syncObligationFromUpdate(update: CodingSessionUpdate): void {
  const obligationId = update.session.obligationId
  if (!obligationId) return
  const milestone = deriveObligationMilestone(update)
  try {
    advanceObligation(getAgentRoot(), obligationId, {
      status: milestone?.status ?? "investigating",
      currentSurface: milestone?.currentSurface ?? { kind: "coding", label: `${update.session.runner} ${update.session.id}` },
      currentArtifact: milestone?.currentArtifact,
      nextAction: milestone?.nextAction,
      latestNote: obligationNoteFromUpdate(update) ?? undefined,
    })
  } catch {
    // Detached feedback should still reach the human even if obligation sync is unavailable.
  }
}

async function wakeInnerDialogForObligation(update: CodingSessionUpdate): Promise<void> {
  if (!update.session.obligationId || !OBLIGATION_WAKE_UPDATE_KINDS.has(update.kind)) {
    return
  }

  try {
    await requestInnerWake(getAgentName())
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "repertoire",
      event: "repertoire.coding_feedback_wake_error",
      message: "coding feedback wake request failed",
      meta: {
        sessionId: update.session.id,
        kind: update.kind,
        reason: error instanceof Error ? error.message : String(error),
      },
    })
  }
}

export function attachCodingSessionFeedback(
  manager: CodingSessionFeedbackManagerLike,
  session: CodingSession,
  target: CodingFeedbackTarget,
): () => void {
  let lastMessage = ""
  let closed = false
  let unsubscribe: (() => void) | null = null

  const sendMessage = (message: string | null): void => {
    if (closed || !message || message === lastMessage) {
      return
    }
    lastMessage = message
    void Promise.resolve(target.send(message)).catch((error) => {
      emitNervesEvent({
        level: "warn",
        component: "repertoire",
        event: "repertoire.coding_feedback_error",
        message: "coding feedback transport failed",
        meta: {
          sessionId: session.id,
          reason: error instanceof Error ? error.message : String(error),
        },
      })
    })
  }

  const spawnedUpdate = { kind: "spawned", session } as const
  syncObligationFromUpdate(spawnedUpdate)
  sendMessage(formatReportBackMessage(spawnedUpdate, formatUpdateMessage(spawnedUpdate)))
  unsubscribe = manager.subscribe(session.id, async (update) => {
    syncObligationFromUpdate(update)
    sendMessage(formatReportBackMessage(update, formatUpdateMessage(update)))
    await wakeInnerDialogForObligation(update)
    if (TERMINAL_UPDATE_KINDS.has(update.kind)) {
      closed = true
      unsubscribe?.()
    }
  })

  return () => {
    closed = true
    unsubscribe?.()
  }
}
