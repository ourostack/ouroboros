import type { FriendStore } from "../mind/friends/store"
import type { Channel, FriendRecord } from "../mind/friends/types"
import { recallSession, type SessionRecallOptions } from "./session-recall"
import { listSessionActivity } from "./session-activity"
import { describeTrustContext, type TrustExplanation } from "../mind/friends/trust-explanation"
import { emitNervesEvent } from "../nerves/runtime"

export interface TargetSessionCandidate {
  friendId: string
  friendName: string
  channel: string
  key: string
  sessionPath: string
  snapshot: string
  trust: TrustExplanation
  delivery: {
    mode: "deliver_now" | "queue_only" | "blocked"
    reason: string
  }
  lastActivityAt: string
  lastActivityMs: number
  activitySource: "friend-facing" | "mtime-fallback"
}

function synthesizeFriendRecord(candidate: {
  friendId: string
  friendName: string
}): FriendRecord {
  return {
    id: candidate.friendId,
    name: candidate.friendName,
    role: "stranger",
    trustLevel: "stranger",
    connections: [],
    externalIds: [],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    schemaVersion: 1,
  }
}

function deliveryPriority(mode: TargetSessionCandidate["delivery"]["mode"]): number {
  if (mode === "deliver_now") return 0
  if (mode === "queue_only") return 1
  return 2
}

function activityPriority(source: TargetSessionCandidate["activitySource"]): number {
  return source === "friend-facing" ? 0 : 1
}

function describeDelivery(candidate: { channel: string; trust: TrustExplanation }): TargetSessionCandidate["delivery"] {
  if (candidate.channel !== "bluebubbles" && candidate.channel !== "teams") {
    return { mode: "blocked", reason: "this channel does not support proactive outward delivery yet" }
  }

  if (candidate.trust.level === "family" || candidate.trust.level === "friend") {
    return { mode: "deliver_now", reason: "directly trusted target on a proactive-delivery channel" }
  }

  return { mode: "queue_only", reason: "visible as a live chat, but immediate delivery still needs explicit cross-chat authorization" }
}

export async function listTargetSessionCandidates(input: {
  sessionsDir: string
  friendsDir: string
  agentName: string
  currentSession?: { friendId: string; channel: string; key: string } | null
  friendStore: FriendStore
  summarize?: SessionRecallOptions["summarize"]
}): Promise<TargetSessionCandidate[]> {
  emitNervesEvent({
    component: "engine",
    event: "engine.target_resolution_start",
    message: "listing live target session candidates",
    meta: {
      sessionsDir: input.sessionsDir,
      currentSession: input.currentSession
        ? `${input.currentSession.friendId}/${input.currentSession.channel}/${input.currentSession.key}`
        : null,
    },
  })

  const activity = listSessionActivity({
    sessionsDir: input.sessionsDir,
    friendsDir: input.friendsDir,
    agentName: input.agentName,
    currentSession: input.currentSession ?? null,
  }).filter((entry) => entry.channel !== "inner")

  const candidates: TargetSessionCandidate[] = []

  for (const entry of activity) {
    const friend = await input.friendStore.get(entry.friendId) ?? synthesizeFriendRecord(entry)
    const trust = describeTrustContext({
      friend,
      channel: entry.channel as Channel,
    })
    const recall = await recallSession({
      sessionPath: entry.sessionPath,
      friendId: entry.friendId,
      channel: entry.channel,
      key: entry.key,
      messageCount: 6,
      summarize: input.summarize,
      trustLevel: trust.level,
    })
    const snapshot = recall.kind === "ok"
      ? recall.snapshot
      : recall.kind === "empty"
        ? "recent focus: no recent visible messages"
        : "recent focus: session transcript unavailable"
    const delivery = describeDelivery({
      channel: entry.channel,
      trust,
    })

    candidates.push({
      friendId: entry.friendId,
      friendName: entry.friendName,
      channel: entry.channel,
      key: entry.key,
      sessionPath: entry.sessionPath,
      snapshot,
      trust,
      delivery,
      lastActivityAt: entry.lastActivityAt,
      lastActivityMs: entry.lastActivityMs,
      activitySource: entry.activitySource,
    })
  }

  return candidates.sort((a, b) => {
    const deliveryDiff = deliveryPriority(a.delivery.mode) - deliveryPriority(b.delivery.mode)
    if (deliveryDiff !== 0) return deliveryDiff
    const sourceDiff = activityPriority(a.activitySource) - activityPriority(b.activitySource)
    if (sourceDiff !== 0) return sourceDiff
    return b.lastActivityMs - a.lastActivityMs
  })
}

export function formatTargetSessionCandidates(candidates: TargetSessionCandidate[]): string {
  if (candidates.length === 0) return ""

  const lines = ["## candidate target chats"]
  for (const candidate of candidates) {
    lines.push(`- ${candidate.friendName} [${candidate.friendId}] via ${candidate.channel}/${candidate.key}`)
    lines.push(`  trust: ${candidate.trust.level} (${candidate.trust.basis}) — ${candidate.trust.summary}`)
    lines.push(`  delivery: ${candidate.delivery.mode} — ${candidate.delivery.reason}`)
    lines.push(`  snapshot: ${candidate.snapshot}`)
  }
  return lines.join("\n")
}
