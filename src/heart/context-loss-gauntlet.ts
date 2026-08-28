import * as fs from "fs"
import * as path from "path"
import { readFlightRecorderResume, type FlightRecorderResume } from "../arc/flight-recorder"
import { resolveDeskRecordPaths } from "../mind/record-paths"
import { emitNervesEvent } from "../nerves/runtime"
import {
  buildWorkCard,
  type BuildWorkCardOptions,
  type WorkCard,
  type WorkCardSource,
} from "./work-card"

export type ContextLossGauntletStatus = "pass" | "warn" | "fail" | "not_applicable"
export type ContextLossGauntletVerdict = "ready" | "watch" | "blocked"

export interface ContextLossGauntletCheck {
  id:
    | "current_ask"
    | "next_safe_action"
    | "stale_guard"
    | "obligations_visible"
    | "return_routes_visible"
    | "blockers_surface"
    | "desk_record_ready"
    | "source_provenance"
  label: string
  status: ContextLossGauntletStatus
  score: number
  maxScore: number
  detail: string
  evidence: WorkCardSource[]
}

export interface ContextLossGauntletReport {
  schemaVersion: 1
  agent: string
  generatedAt: string
  verdict: ContextLossGauntletVerdict
  summary: string
  score: {
    earned: number
    possible: number
    percentage: number
  }
  currentAsk: WorkCard["currentAsk"]
  nextAction: WorkCard["nextAction"]
  counts: WorkCard["counts"]
  checks: ContextLossGauntletCheck[]
  workCard: WorkCard
}

function makeCheck(input: ContextLossGauntletCheck): ContextLossGauntletCheck {
  return input
}

function flightRecorderEvidence(card: WorkCard): WorkCardSource[] {
  return card.sources.filter((source) => source.kind === "flight_recorder").slice(0, 1)
}

function currentAskCheck(card: WorkCard): ContextLossGauntletCheck {
  const evidence = flightRecorderEvidence(card)
  if (!card.currentAsk.available) {
    return makeCheck({
      id: "current_ask",
      label: "Current ask",
      status: "fail",
      score: 0,
      maxScore: 15,
      detail: "No durable current ask is available after context loss.",
      evidence,
    })
  }
  if (card.currentAsk.confidence !== "current") {
    return makeCheck({
      id: "current_ask",
      label: "Current ask",
      status: "warn",
      score: 10,
      maxScore: 15,
      detail: `Current ask is available but marked ${card.currentAsk.confidence}.`,
      evidence,
    })
  }
  return makeCheck({
    id: "current_ask",
    label: "Current ask",
    status: "pass",
    score: 15,
    maxScore: 15,
    detail: "Current ask is preserved in the flight recorder.",
    evidence,
  })
}

function isSettledTurnWait(resume: FlightRecorderResume): boolean {
  return resume.hasCompleteState
    && resume.recorderHealth.status === "ok"
    && resume.blockedBecause.length === 1
    && resume.blockedBecause[0] === "turn outcome settled; wait for new input before acting"
    && resume.nextSafeAction.value === "inspect the latest session and wait for new input before acting"
}

function nextSafeActionCheck(card: WorkCard, resume: FlightRecorderResume): ContextLossGauntletCheck {
  const evidence = card.nextAction.source ? [card.nextAction.source] : []
  if (isSettledTurnWait(resume)) {
    return makeCheck({
      id: "next_safe_action",
      label: "Next safe action",
      status: "pass",
      score: 20,
      maxScore: 20,
      detail: "idle: turn is settled and waiting for new input.",
      evidence: flightRecorderEvidence(card),
    })
  }
  if (card.nextAction.actor === "unknown") {
    return makeCheck({
      id: "next_safe_action",
      label: "Next safe action",
      status: "fail",
      score: 0,
      maxScore: 20,
      detail: card.nextAction.summary,
      evidence,
    })
  }
  return makeCheck({
    id: "next_safe_action",
    label: "Next safe action",
    status: "pass",
    score: 20,
    maxScore: 20,
    detail: `${card.nextAction.actor}: ${card.nextAction.summary}`,
    evidence,
  })
}

function staleGuardCheck(resume: FlightRecorderResume, card: WorkCard): ContextLossGauntletCheck {
  const evidence = flightRecorderEvidence(card)
  if (resume.canContinue && resume.hasCompleteState && resume.recorderHealth.status === "ok" && resume.blockedBecause.length === 0) {
    return makeCheck({
      id: "stale_guard",
      label: "Stale-state guard",
      status: "pass",
      score: 15,
      maxScore: 15,
      detail: "Flight recorder permits continuation with complete state.",
      evidence,
    })
  }
  if (isSettledTurnWait(resume)) {
    return makeCheck({
      id: "stale_guard",
      label: "Stale-state guard",
      status: "pass",
      score: 15,
      maxScore: 15,
      detail: "Flight recorder has complete settled-turn state and is safely waiting for new input.",
      evidence,
    })
  }
  const reasons = [
    "canContinue is false",
    ...(!resume.hasCompleteState ? ["incomplete resume state"] : []),
    ...(resume.recorderHealth.status !== "ok" ? [`recorder health is ${resume.recorderHealth.status}`] : []),
    ...(resume.blockedBecause.length > 0 ? resume.blockedBecause : []),
  ]
  return makeCheck({
    id: "stale_guard",
    label: "Stale-state guard",
    status: "fail",
    score: 0,
    maxScore: 15,
    detail: `Flight recorder says continuation is unsafe: ${reasons.join("; ")}.`,
    evidence,
  })
}

function obligationsCheck(card: WorkCard): ContextLossGauntletCheck {
  if (card.counts.owed === 0) {
    return makeCheck({
      id: "obligations_visible",
      label: "Obligations",
      status: "not_applicable",
      score: 0,
      maxScore: 0,
      detail: "No owed obligations are active.",
      evidence: [],
    })
  }
  const evidence = card.owed.map((item) => item.source)
  return makeCheck({
    id: "obligations_visible",
    label: "Obligations",
    status: "pass",
    score: 10,
    maxScore: 10,
    detail: `${card.counts.owed} owed obligation(s) have source locators.`,
    evidence,
  })
}

function returnRoutesCheck(card: WorkCard): ContextLossGauntletCheck {
  if (card.counts.returnObligations === 0) {
    return makeCheck({
      id: "return_routes_visible",
      label: "Return routes",
      status: "not_applicable",
      score: 0,
      maxScore: 0,
      detail: "No active return obligations are queued.",
      evidence: [],
    })
  }
  const evidence = card.returnObligations.map((item) => item.source)
  return makeCheck({
    id: "return_routes_visible",
    label: "Return routes",
    status: "pass",
    score: 10,
    maxScore: 10,
    detail: `${card.counts.returnObligations} return route(s) are visible.`,
    evidence,
  })
}

function blockersCheck(card: WorkCard): ContextLossGauntletCheck {
  if (card.counts.waitingOnHuman === 0) {
    return makeCheck({
      id: "blockers_surface",
      label: "Blockers",
      status: "not_applicable",
      score: 0,
      maxScore: 0,
      detail: "No waiting or blocked work is active.",
      evidence: [],
    })
  }
  const evidence = card.waitingOnOthers.map((item) => item.source)
  return makeCheck({
    id: "blockers_surface",
    label: "Blockers",
    status: "pass",
    score: 10,
    maxScore: 10,
    detail: "Waiting work controls the next action.",
    evidence,
  })
}

function deskRecordCheck(agentRoot: string): ContextLossGauntletCheck {
  const recordPaths = resolveDeskRecordPaths(agentRoot)
  const requiredPaths = [
    recordPaths.recordRoot,
    recordPaths.diaryRoot,
    recordPaths.diaryDailyDir,
    recordPaths.notesRoot,
    recordPaths.factsPath,
    recordPaths.entitiesPath,
  ]
  const missing = requiredPaths
    .filter((entry) => !fs.existsSync(entry))
    .map((entry) => path.relative(agentRoot, entry))
  const legacyRoots = ["journal", "diary"]
    .map((entry) => path.join(agentRoot, entry))
    .filter((entry) => fs.existsSync(entry))
    .map((entry) => path.relative(agentRoot, entry))

  if (legacyRoots.length > 0) {
    return makeCheck({
      id: "desk_record_ready",
      label: "Desk record",
      status: "fail",
      score: 0,
      maxScore: 10,
      detail: `Legacy active record root(s) still exist: ${legacyRoots.join(", ")}.`,
      evidence: [],
    })
  }
  if (missing.length > 0) {
    return makeCheck({
      id: "desk_record_ready",
      label: "Desk record",
      status: "warn",
      score: 5,
      maxScore: 10,
      detail: `Canonical Desk record scaffold is incomplete: ${missing.join(", ")}.`,
      evidence: [],
    })
  }
  return makeCheck({
    id: "desk_record_ready",
    label: "Desk record",
    status: "pass",
    score: 10,
    maxScore: 10,
    detail: "Canonical Desk record scaffold is present and no legacy record roots are active.",
    evidence: [],
  })
}

function sourceProvenanceCheck(card: WorkCard): ContextLossGauntletCheck {
  const evidence = card.sources
  if (card.degraded.issues.length > 0) {
    return makeCheck({
      id: "source_provenance",
      label: "Source provenance",
      status: "fail",
      score: 0,
      maxScore: 15,
      detail: `${card.degraded.issues.length} Work Card source issue(s) are present.`,
      evidence,
    })
  }
  return makeCheck({
    id: "source_provenance",
    label: "Source provenance",
    status: "pass",
    score: 15,
    maxScore: 15,
    detail: "Work Card source locators are intact.",
    evidence,
  })
}

function summarize(verdict: ContextLossGauntletVerdict): string {
  if (verdict === "ready") return "ready: durable Arc, flight recorder, and Desk state can carry context-loss recovery"
  if (verdict === "watch") return "watch: recovery is possible, but warnings need attention"
  return "blocked: context-loss recovery would lose or mislead the agent"
}

export function runContextLossGauntlet(
  agentName: string,
  agentRoot: string,
  options: BuildWorkCardOptions = {},
): ContextLossGauntletReport {
  const flightRecorderResume = options.flightRecorderResume ?? readFlightRecorderResume(agentRoot)
  const card = buildWorkCard(agentName, agentRoot, { ...options, flightRecorderResume })
  const generatedAt = (options.now ?? (() => new Date()))().toISOString()
  const checks = [
    currentAskCheck(card),
    nextSafeActionCheck(card, flightRecorderResume),
    staleGuardCheck(flightRecorderResume, card),
    obligationsCheck(card),
    returnRoutesCheck(card),
    blockersCheck(card),
    deskRecordCheck(agentRoot),
    sourceProvenanceCheck(card),
  ]
  const earned = checks.reduce((sum, check) => sum + check.score, 0)
  const possible = checks.reduce((sum, check) => sum + check.maxScore, 0)
  const percentage = Math.round((earned / possible) * 100)
  const verdict: ContextLossGauntletVerdict = checks.some((check) => check.status === "fail")
    ? "blocked"
    : checks.some((check) => check.status === "warn")
      ? "watch"
      : "ready"
  const report: ContextLossGauntletReport = {
    schemaVersion: 1,
    agent: card.agent,
    generatedAt,
    verdict,
    summary: summarize(verdict),
    score: { earned, possible, percentage },
    currentAsk: card.currentAsk,
    nextAction: card.nextAction,
    counts: card.counts,
    checks,
    workCard: card,
  }

  emitNervesEvent({
    component: "engine",
    event: "engine.context_loss_gauntlet_ran",
    message: "context-loss gauntlet scored durable recovery state",
    meta: {
      agent: card.agent,
      verdict: report.verdict,
      scorePercentage: report.score.percentage,
      failedChecks: report.checks.filter((check) => check.status === "fail").map((check) => check.id),
      warnedChecks: report.checks.filter((check) => check.status === "warn").map((check) => check.id),
    },
  })

  return report
}

function statusToken(status: ContextLossGauntletStatus): string {
  if (status === "not_applicable") return "N/A"
  return status.toUpperCase()
}

export function formatContextLossGauntletText(report: ContextLossGauntletReport): string {
  return [
    `Context-loss gauntlet - ${report.agent}`,
    `generated: ${report.generatedAt}`,
    `verdict: ${report.verdict} (${report.score.earned}/${report.score.possible}, ${report.score.percentage}%)`,
    `summary: ${report.summary}`,
    "",
    "Recovery",
    report.currentAsk.available
      ? `  current ask: ${report.currentAsk.value} (${report.currentAsk.confidence})`
      : `  current ask: unavailable (${report.currentAsk.source})`,
    `  next action: ${report.nextAction.actor}: ${report.nextAction.summary}`,
    "",
    "Checks",
    ...report.checks.map((check) => `  - ${statusToken(check.status)} ${check.id}: ${check.detail}`),
  ].join("\n").trim()
}
