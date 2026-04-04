/**
 * TurnContext: a single pre-read snapshot of all state sources needed
 * by the inbound-turn pipeline and prompt assembly.
 *
 * Before this module existed, pipeline.ts read ~10 state sources inline
 * and prompt.ts did several ad-hoc filesystem reads. This centralizes
 * all reads into one place so the rest of the turn is pure derivation.
 */

import type { BridgeRecord } from "./bridges/store"
import type { CodingSession } from "../repertoire/coding/types"
import type { Obligation, ReturnObligation } from "./obligations"
import type { SessionActivityRecord } from "./session-activity"
import type { TargetSessionCandidate } from "./target-resolution"
import type { BoardResult } from "../repertoire/tasks/types"
import type { InnerJob } from "./daemon/thoughts"
import type { SyncConfig } from "./config"
import type { DaemonHealthState } from "./daemon/daemon-health"
import type { BundleMeta } from "../mind/bundle-manifest"
import type { JournalFileEntry } from "../mind/prompt"
import type { Channel } from "../mind/friends/types"

import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"
import { createBridgeManager } from "./bridges/manager"
import { getAgentName, getAgentRoot, getAgentSecretsPath, loadAgentConfig, type SenseName } from "./identity"
import { getTaskModule } from "../repertoire/tasks"
import { getCodingSessionManager } from "../repertoire/coding"
import { listSessionActivity } from "./session-activity"
import { readInnerDialogRawData, deriveInnerDialogStatus, deriveInnerJob, getInnerDialogSessionPath } from "./daemon/thoughts"
import { getInnerDialogPendingDir } from "../mind/pending"
import { readPendingObligations, listActiveReturnObligations } from "./obligations"
import { listTargetSessionCandidates } from "./target-resolution"
import { readRecentEpisodes, type EpisodeRecord } from "../mind/episodes"
import { readActiveCares, type CareRecord } from "./cares"
import { getSyncConfig } from "./config"
import { readHealth, getDefaultHealthPath } from "./daemon/daemon-health"
import { readJournalFiles } from "../mind/prompt"
import type { FriendStore } from "../mind/friends/store"
import type { CodingSessionStatus } from "../repertoire/coding/types"

// ── TurnContext: the raw state snapshot ─────────────────────────────

export interface InnerWorkState {
  status: "idle" | "running"
  hasPending: boolean
  origin?: { friendId: string; channel: string; key: string }
  contentSnippet?: string
  obligationPending?: boolean
  job: InnerJob
}

export interface TurnContext {
  /** Active bridges for the current session. */
  activeBridges: BridgeRecord[]
  /** Recent session activity (excluding current session). */
  sessionActivity: SessionActivityRecord[]
  /** Candidate sessions for send_message targeting. */
  targetCandidates: TargetSessionCandidate[]
  /** Pending obligations from the obligations store. */
  pendingObligations: Obligation[]
  /** Live coding sessions owned by the current session. */
  codingSessions: CodingSession[]
  /** Live coding sessions owned by other sessions. */
  otherCodingSessions: CodingSession[]
  /** Inner dialog work state. */
  innerWorkState: InnerWorkState
  /** Task board snapshot. */
  taskBoard: BoardResult
  /** Active return obligations. */
  returnObligations: ReturnObligation[]
  /** Recent episodes for continuity. */
  recentEpisodes: EpisodeRecord[]
  /** Active cares for continuity. */
  activeCares: CareRecord[]
  /** Sync config (opt-in). */
  syncConfig: SyncConfig
  /** Sync failure message if pre-turn pull failed. */
  syncFailure: string | undefined

  // ── Prompt-assembly pre-reads ─────────────────────────────────────

  /** Whether the daemon socket exists. */
  daemonRunning: boolean
  /** Sense availability status lines for the prompt. */
  senseStatusLines: string[]
  /** Bundle metadata from bundle-meta.json. */
  bundleMeta: BundleMeta | null
  /** Daemon health state for rhythm status. */
  daemonHealth: DaemonHealthState | null
  /** Journal file entries for inner-channel prompt. */
  journalFiles: JournalFileEntry[]
}

// ── Inputs ──────────────────────────────────────────────────────────

export interface BuildTurnContextInput {
  currentSession: {
    friendId: string
    channel: Channel
    key: string
    sessionPath: string
  }
  channel: Channel
  friendStore: FriendStore
}

// ── Helpers ─────────────────────────────────────────────────────────

const DAEMON_SOCKET_PATH = "/tmp/ouroboros-daemon.sock"

function isLiveCodingSessionStatus(status: CodingSessionStatus): boolean {
  return status === "spawning"
    || status === "running"
    || status === "waiting_input"
    || status === "stalled"
}

function emptyTaskBoard(): BoardResult {
  return {
    compact: "",
    full: "",
    byStatus: {
      drafting: [],
      processing: [],
      validating: [],
      collaborating: [],
      paused: [],
      blocked: [],
      done: [],
      cancelled: [],
    },
    issues: [],
    actionRequired: [],
    unresolvedDependencies: [],
    activeSessions: [],
    activeBridges: [],
  }
}

function readInnerWorkState(): InnerWorkState {
  const defaultJob: InnerJob = {
    status: "idle" as const,
    content: null,
    origin: null,
    mode: "reflect" as const,
    obligationStatus: null,
    surfacedResult: null,
    queuedAt: null,
    startedAt: null,
    surfacedAt: null,
  }
  try {
    const agentRoot = getAgentRoot()
    const pendingDir = getInnerDialogPendingDir(getAgentName())
    const sessionPath = getInnerDialogSessionPath(agentRoot)
    const { pendingMessages, turns, runtimeState } = readInnerDialogRawData(sessionPath, pendingDir)
    const dialogStatus = deriveInnerDialogStatus(pendingMessages, turns, runtimeState)
    const job = deriveInnerJob(pendingMessages, turns, runtimeState)
    const storeObligationPending = readPendingObligations(agentRoot).length > 0
    return {
      status: dialogStatus.processing === "started" ? "running" : "idle",
      hasPending: dialogStatus.queue !== "clear",
      origin: dialogStatus.origin,
      contentSnippet: dialogStatus.contentSnippet,
      obligationPending: dialogStatus.obligationPending || storeObligationPending,
      job,
    }
  } catch {
    return {
      status: "idle",
      hasPending: false,
      job: defaultJob,
    }
  }
}

function checkDaemonRunning(): boolean {
  try {
    return fs.existsSync(DAEMON_SOCKET_PATH)
  } catch {
    return false
  }
}

function hasTextField(record: Record<string, unknown> | undefined, key: string): boolean {
  return typeof record?.[key] === "string" && (record[key] as string).trim().length > 0
}

function readSenseStatusLines(): string[] {
  const config = loadAgentConfig()
  const senses = config.senses ?? {
    cli: { enabled: true },
    teams: { enabled: false },
    bluebubbles: { enabled: false },
  }
  let payload: Record<string, unknown> = {}
  try {
    const raw = fs.readFileSync(getAgentSecretsPath(), "utf-8")
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>
    }
  } catch {
    payload = {}
  }

  const teams = payload.teams as Record<string, unknown> | undefined
  const bluebubbles = payload.bluebubbles as Record<string, unknown> | undefined
  const configured: Record<SenseName, boolean> = {
    cli: true,
    teams: hasTextField(teams, "clientId") && hasTextField(teams, "clientSecret") && hasTextField(teams, "tenantId"),
    bluebubbles: hasTextField(bluebubbles, "serverUrl") && hasTextField(bluebubbles, "password"),
  }

  const rows: Array<{ label: string; status: string }> = [
    { label: "CLI", status: "interactive" },
    {
      label: "Teams",
      status: !senses.teams.enabled ? "disabled" : configured.teams ? "ready" : "needs_config",
    },
    {
      label: "BlueBubbles",
      status: !senses.bluebubbles.enabled ? "disabled" : configured.bluebubbles ? "ready" : "needs_config",
    },
  ]

  return rows.map((row) => `- ${row.label}: ${row.status}`)
}

function readBundleMetaFile(): BundleMeta | null {
  try {
    const metaPath = path.join(getAgentRoot(), "bundle-meta.json")
    const raw = fs.readFileSync(metaPath, "utf-8")
    return JSON.parse(raw) as BundleMeta
  } catch {
    return null
  }
}

// ── Builder ─────────────────────────────────────────────────────────

export async function buildTurnContext(input: BuildTurnContextInput): Promise<TurnContext> {
  const agentRoot = getAgentRoot()
  const agentName = getAgentName()

  // Sync config
  let syncConfig: SyncConfig = { enabled: false, remote: "origin" }
  try { syncConfig = getSyncConfig() } catch { /* config not available */ }

  // Bridges
  const activeBridges = createBridgeManager().findBridgesForSession({
    friendId: input.currentSession.friendId,
    channel: input.currentSession.channel,
    key: input.currentSession.key,
  })

  // Session activity
  let sessionActivity: SessionActivityRecord[] = []
  try {
    sessionActivity = listSessionActivity({
      sessionsDir: `${agentRoot}/state/sessions`,
      friendsDir: `${agentRoot}/friends`,
      agentName,
      currentSession: {
        friendId: input.currentSession.friendId,
        channel: input.currentSession.channel,
        key: input.currentSession.key,
      },
    })
  } catch {
    sessionActivity = []
  }

  // Target candidates
  let targetCandidates: Awaited<ReturnType<typeof listTargetSessionCandidates>> = []
  try {
    if (input.channel !== "inner") {
      targetCandidates = await listTargetSessionCandidates({
        sessionsDir: `${agentRoot}/state/sessions`,
        friendsDir: `${agentRoot}/friends`,
        agentName,
        currentSession: {
          friendId: input.currentSession.friendId,
          channel: input.currentSession.channel,
          key: input.currentSession.key,
        },
        friendStore: input.friendStore,
      })
    }
  } catch {
    targetCandidates = []
  }

  // Pending obligations
  let pendingObligations: Obligation[] = []
  try {
    pendingObligations = readPendingObligations(agentRoot)
  } catch {
    pendingObligations = []
  }

  // Coding sessions
  let codingSessions: CodingSession[] = []
  let otherCodingSessions: CodingSession[] = []
  try {
    const liveCodingSessions = getCodingSessionManager()
      .listSessions()
      .filter((session) => isLiveCodingSessionStatus(session.status) && Boolean(session.originSession))
    codingSessions = liveCodingSessions.filter((session) =>
      session.originSession?.friendId === input.currentSession.friendId
      && session.originSession.channel === input.currentSession.channel
      && session.originSession.key === input.currentSession.key,
    )
    otherCodingSessions = liveCodingSessions.filter((session) =>
      !(
        session.originSession?.friendId === input.currentSession.friendId
        && session.originSession.channel === input.currentSession.channel
        && session.originSession.key === input.currentSession.key
      ),
    )
  } catch {
    codingSessions = []
    otherCodingSessions = []
  }

  // Inner work state
  const innerWorkState = readInnerWorkState()

  // Task board
  let taskBoard: BoardResult
  try {
    taskBoard = getTaskModule().getBoard()
  } catch {
    taskBoard = emptyTaskBoard()
  }

  // Return obligations
  let returnObligations: ReturnObligation[] = []
  try {
    returnObligations = listActiveReturnObligations(agentName)
  } catch {
    returnObligations = []
  }

  // Recent episodes
  const recentEpisodes = readRecentEpisodes(agentRoot, { limit: 20 })

  // Active cares
  const activeCares = readActiveCares(agentRoot)

  // ── Prompt-assembly pre-reads ──────────────────────────────────────

  const daemonRunning = checkDaemonRunning()

  let senseStatusLines: string[] = []
  try {
    senseStatusLines = readSenseStatusLines()
  } catch {
    senseStatusLines = []
  }

  const bundleMeta = readBundleMetaFile()

  let daemonHealth: DaemonHealthState | null = null
  try {
    daemonHealth = readHealth(getDefaultHealthPath())
  } catch {
    daemonHealth = null
  }

  let journalFiles: JournalFileEntry[] = []
  try {
    const journalDir = path.join(agentRoot, "journal")
    journalFiles = readJournalFiles(journalDir)
  } catch {
    journalFiles = []
  }

  emitNervesEvent({
    component: "senses",
    event: "senses.turn_context_built",
    message: "turn context snapshot assembled",
    meta: {
      channel: input.channel,
      obligationCount: pendingObligations.length,
      bridgeCount: activeBridges.length,
      codingSessionCount: codingSessions.length,
      episodeCount: recentEpisodes.length,
    },
  })

  return {
    activeBridges,
    sessionActivity,
    targetCandidates,
    pendingObligations,
    codingSessions,
    otherCodingSessions,
    innerWorkState,
    taskBoard,
    returnObligations,
    recentEpisodes,
    activeCares,
    syncConfig,
    syncFailure: undefined, // Set by pipeline after preTurnPull
    daemonRunning,
    senseStatusLines,
    bundleMeta,
    daemonHealth,
    journalFiles,
  }
}
