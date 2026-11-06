import type { ActiveWorkFrame } from "./active-work"
import type { InnerJob } from "./daemon/thoughts"
import { isOpenObligationStatus, type Obligation } from "../arc/obligations"
import { emitNervesEvent } from "../nerves/runtime"

export interface AwaitingCommitment {
  name: string
  condition: string
  checkedCount: number
  lastCheckedAt: string | null
  lastObservation: string | null
}

export interface CommitmentsFrame {
  committedTo: string[]
  completionCriteria: string[]
  safeToIgnore: string[]
  /** Optional in the type for backward-compat with hand-constructed frames; deriveCommitments always populates it. */
  awaiting?: AwaitingCommitment[]
}

function describeActiveObligation(obligation: Obligation): string {
  if (obligation.status === "pending") {
    return `i owe ${obligation.origin.friendId}: ${obligation.content}`
  }

  const surface = obligation.currentSurface?.label
  const statusText = obligation.status.replaceAll("_", " ")
  if (surface) {
    return `i owe ${obligation.origin.friendId}: ${obligation.content} (${statusText} in ${surface})`
  }
  return `i owe ${obligation.origin.friendId}: ${obligation.content} (${statusText})`
}

export function deriveCommitments(
  activeWorkFrame: ActiveWorkFrame,
  innerJob: InnerJob,
  pendingObligations?: Obligation[],
  pendingAwaits?: AwaitingCommitment[],
): CommitmentsFrame {
  const committedTo: string[] = []
  const completionCriteria: string[] = []
  const safeToIgnore: string[] = []
  const awaiting: AwaitingCommitment[] = pendingAwaits ? [...pendingAwaits] : []

  // Persistent obligations from the obligation store
  // Sort by status priority: investigating/waiting/updating before pending
  if (pendingObligations && pendingObligations.length > 0) {
    const sorted = [...pendingObligations].sort((a, b) => {
      const advancedA = a.status !== "pending" && a.status !== "fulfilled" ? 0 : 1
      const advancedB = b.status !== "pending" && b.status !== "fulfilled" ? 0 : 1
      return advancedA - advancedB
    })
    let hasAdvancedObligation = false
    for (const ob of sorted) {
      if (!isOpenObligationStatus(ob.status)) continue
      committedTo.push(describeActiveObligation(ob))
      if (ob.status !== "pending") hasAdvancedObligation = true
    }
    completionCriteria.push("fulfill my outstanding obligations")
    if (hasAdvancedObligation) {
      completionCriteria.push("close my active obligation loops")
    }
  }

  // Inner job
  if (innerJob.status === "queued" || innerJob.status === "running") {
    const contentSuffix = innerJob.content ? ` -- ${innerJob.content.slice(0, 60)}` : ""
    committedTo.push(`i'm thinking through something privately${contentSuffix}`)
  } else if (innerJob.status === "surfaced") {
    committedTo.push("i finished thinking about something and need to bring it back")
  }

  // mustResolveBeforeHandoff
  if (activeWorkFrame.mustResolveBeforeHandoff) {
    committedTo.push("i need to finish what i started before moving on")
    completionCriteria.push("resolve the current thread before moving on")
  }

  // Bridges
  for (const bridge of activeWorkFrame.bridges) {
    committedTo.push(`i have shared work: ${bridge.summary || bridge.objective}`)
  }
  if (activeWorkFrame.bridges.length > 0) {
    completionCriteria.push("keep shared work aligned across sessions")
  }

  // Tasks
  for (const taskName of activeWorkFrame.taskPressure?.liveTaskNames ?? []) {
    committedTo.push(`i'm tracking: ${taskName}`)
  }

  // Obligation completion criteria
  if (innerJob.obligationStatus === "pending") {
    const name = innerJob.origin?.friendName ?? innerJob.origin?.friendId ?? "them"
    completionCriteria.push(`bring my answer back to ${name}`)
  }

  // Default completion criteria
  if (completionCriteria.length === 0) {
    completionCriteria.push("just be present in this conversation")
  }

  // Safe to ignore
  if (innerJob.status === "idle" && !(activeWorkFrame.inner?.hasPending)) {
    safeToIgnore.push("no private thinking in progress")
  }
  if (activeWorkFrame.bridges.length === 0) {
    safeToIgnore.push("no shared work to coordinate")
  }
  if ((activeWorkFrame.taskPressure?.liveTaskNames ?? []).length === 0) {
    safeToIgnore.push("no active tasks to track")
  }

  emitNervesEvent({
    component: "engine",
    event: "engine.commitments_derive",
    message: "derived commitments frame",
    meta: { committedCount: committedTo.length, criteriaCount: completionCriteria.length, awaitingCount: awaiting.length },
  })

  return { committedTo, completionCriteria, safeToIgnore, awaiting }
}

function formatRelativeAge(lastCheckedAt: string | null, now: () => Date): string {
  if (!lastCheckedAt) return "never checked"
  const lastMs = new Date(lastCheckedAt).getTime()
  if (!Number.isFinite(lastMs)) return "never checked"
  const elapsedMs = now().getTime() - lastMs
  if (elapsedMs < 60_000) return "<1m ago"
  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function formatCommitments(commitments: CommitmentsFrame, now: () => Date = () => new Date()): string {
  const sections: string[] = []

  if (commitments.committedTo.length === 0) {
    sections.push("i'm not holding anything specific right now. i'm free to be present.")
  } else {
    sections.push("## what i'm holding right now")
    sections.push("")
    sections.push(commitments.committedTo.map((c) => `- ${c}`).join("\n"))
  }

  sections.push("")
  sections.push("## what \"done\" looks like")
  sections.push(commitments.completionCriteria.map((c) => `- ${c}`).join("\n"))

  sections.push("")
  sections.push("## what i can let go of")
  sections.push(commitments.safeToIgnore.map((c) => `- ${c}`).join("\n"))

  const awaiting = commitments.awaiting ?? []
  if (awaiting.length > 0) {
    sections.push("")
    sections.push("## what i'm waiting on")
    for (const a of awaiting) {
      sections.push(`- ${a.name}: ${a.condition}`)
      const obs = a.lastObservation && a.lastObservation.trim().length > 0
        ? `: "${a.lastObservation.trim()}"`
        : ""
      sections.push(`  (checked ${a.checkedCount}x, last ${formatRelativeAge(a.lastCheckedAt, now)}${obs})`)
    }
  }

  return sections.join("\n")
}
