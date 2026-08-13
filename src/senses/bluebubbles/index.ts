import * as fs from "node:fs"
import * as http from "node:http"
import * as path from "node:path"
import { createHash } from "node:crypto"
import OpenAI from "openai"
import { runAgent, type ChannelCallbacks, createSummarize } from "../../heart/core"
import { getBlueBubblesChannelConfig, getBlueBubblesConfig, sessionPath } from "../../heart/config"
import { getAgentName, getAgentRoot } from "../../heart/identity"
import { recoverRuntimeCwd } from "../../heart/runtime-cwd"
import { withSharedTurnLock } from "../../heart/turn-coordinator"
import {
  loadSession,
  postTurnPersist,
  postTurnTrim,
  saveSession,
  type PostTurnPrepared,
  type SessionContinuityState,
  type UsageData,
} from "../../mind/context"
import { accumulateFriendTokens, upsertGroupContextParticipants, FriendResolver, type FriendResolverParams, FileFriendStore, TRUSTED_LEVELS, type FriendRecord, getChannelCapabilities } from "@ouro.bot/friends"
import { getPendingDir, drainDeferredReturns, drainPending } from "../../mind/pending"
import { buildSystem, flattenSystemPrompt } from "../../mind/prompt"
import { getSharedMcpManager } from "../../repertoire/mcp-manager"
import { emitNervesEvent } from "../../nerves/runtime"
import {
  buildOrientationFrame,
  type OrientationConversationKind,
  type OrientationSource,
} from "../../heart/orientation-frame"
import { getProactiveInternalContentBlockReason, emitProactiveInternalContentBlocked } from "../proactive-content-guard"
import { containsInternalMetaMarkers, emitBluebubblesMetaBlocked } from "../bluebubbles-meta-guard"
import type { BlueBubblesReplyTargetSelection, ToolContext } from "../../repertoire/tools-base"
import {
  BlueBubblesIgnoredEventError,
  describeBlueBubblesReaction,
  normalizeBlueBubblesEvent,
  renderBlueBubblesReactionText,
  type BlueBubblesChatRef,
  type BlueBubblesNormalizedEvent,
  type BlueBubblesNormalizedMessage,
} from "./model"
import { BlueBubblesSendError, createBlueBubblesClient, type BlueBubblesClient } from "./client"
import {
  listRecordedBlueBubblesInbound,
  recordBlueBubblesInbound,
  type BlueBubblesInboundSource,
} from "./inbound-log"
import { listBlueBubblesRecoveryCandidates, recordBlueBubblesMutation } from "./mutation-log"
import { recordProcessedBlueBubblesMessage } from "./processed-log"
import type {
  BlueBubblesSemanticCaptureEvent,
  BlueBubblesSemanticCaptureV1,
} from "../ingress-evidence"
import {
  acquireBlueBubblesSemanticClaim,
  allocateBlueBubblesReactionCoordinate,
  buildBlueBubblesSemanticCapture,
  buildBlueBubblesSemanticIdentity,
  classifyBlueBubblesRecoveryRecord,
  compareBlueBubblesSemanticCaptureOrder,
  initializeBlueBubblesSemanticCutover,
  listPendingBlueBubblesSemanticCaptures,
  releaseBlueBubblesSemanticClaim,
  writeBlueBubblesSemanticCapture,
  writeBlueBubblesSemanticHandled,
  type BlueBubblesSemanticCaptureWriteResult,
  type BlueBubblesSemanticHandledOutcome,
} from "./semantic-receipts"
import { readBlueBubblesRuntimeState, writeBlueBubblesRuntimeState, type BlueBubblesRuntimeState } from "./runtime-state"
import { findObsoleteBlueBubblesThreadSessions } from "./session-cleanup"
import {
  classifyBlueBubblesReaction,
  type BlueBubblesReactionPolicyDecision,
} from "./reaction-policy"
import {
  awaitDeliveryAdmission,
  beginObservationBatch,
  cancel as cancelLatestTurn,
  clearPending,
  finish as finishLatestTurn,
  isDeliveryAdmittedNow,
  isCurrent as isLatestTurnCurrent,
  mergeObservationReservations,
  observationSchedulingKeys,
  promote as promoteLatestTurn,
  reactivateObservation,
  reserveObservation,
  reserveObservationFromBatch,
  type BlueBubblesLatestTurnCapability,
  type BlueBubblesObservationBatch,
  type BlueBubblesObservationReservation,
} from "./latest-turn"
import {
  beginBlueBubblesActiveTurn,
  finishBlueBubblesActiveTurn,
  noteBlueBubblesActiveTurnVisibleActivity,
  snapshotBlueBubblesActiveTurns,
} from "./active-turns"
import { enforceTrustGate } from "../trust-gate"
import { handleInboundTurn, type FailoverState } from "../pipeline"
import { writeSenseContextPacket } from "../context-packet-ledger"
import { buildBlueBubblesContextPacket } from "./context-packet"
import {
  recordAutonomyFailure,
  reserveAutonomyBudget,
  type AutonomyStormInput,
} from "../../heart/autonomy-budget"
import {
  markBlueBubblesOutboundAccepted,
  markBlueBubblesOutboundFailed,
  readBlueBubblesOutboundRecordByIdempotencyKey,
  reserveBlueBubblesOutbound,
  type BlueBubblesAttachmentIdentityInput,
  type BlueBubblesOutboundRecord,
} from "./outbound-state"

const bbFailoverStates = new Map<string, FailoverState>()

interface BlueBubblesSemanticHandlingSlot {
  generation: BlueBubblesSemanticObservationGeneration
  reservation: BlueBubblesObservationReservation
  waiters: Array<(acquisition: BlueBubblesSemanticHandlingAcquisition) => void>
}

interface BlueBubblesSemanticObservationGeneration {
  reservation: BlueBubblesObservationReservation
  retry: boolean
  retainedAtMs: number | null
}

type BlueBubblesSemanticHandlingAcquisition =
  | {
      status: "owner"
      slot: BlueBubblesSemanticHandlingSlot
      reservation: BlueBubblesObservationReservation
      allowSameGenerationRetry: boolean
    }
  | { status: "handled_by_owner" }

const activeSemanticHandlingSlots = new Map<string, BlueBubblesSemanticHandlingSlot>()
const semanticObservationGenerations = new Map<string, BlueBubblesSemanticObservationGeneration>()
const BLUEBUBBLES_VISIBLE_OUTBOUND_STATUSES = new Set<BlueBubblesOutboundRecord["status"]>([
  "accepted",
  "enqueued",
  "local-visible",
  "delivered",
])
export const BLUEBUBBLES_SEMANTIC_GENERATION_RETENTION_MS = 15 * 60_000

export function pruneBlueBubblesSemanticObservationGenerations(nowMs = Date.now()): number {
  let pruned = 0
  for (const [keyHash, generation] of semanticObservationGenerations) {
    if (
      generation.retainedAtMs === null
      || nowMs - generation.retainedAtMs < BLUEBUBBLES_SEMANTIC_GENERATION_RETENTION_MS
    ) continue
    clearPending(generation.reservation)
    semanticObservationGenerations.delete(keyHash)
    pruned += 1
  }
  return pruned
}

function adoptBlueBubblesSemanticObservation(
  keyHash: string,
  observedReservation: BlueBubblesObservationReservation,
  activate: boolean,
): BlueBubblesSemanticObservationGeneration {
  pruneBlueBubblesSemanticObservationGenerations()
  const existing = semanticObservationGenerations.get(keyHash)
  if (!existing) {
    const generation = { reservation: observedReservation, retry: false, retainedAtMs: null }
    semanticObservationGenerations.set(keyHash, generation)
    return generation
  }
  mergeObservationReservations(existing.reservation, observedReservation)
  if (activate) {
    existing.retainedAtMs = null
    reactivateObservation(existing.reservation)
  }
  return existing
}

function suspendBlueBubblesSemanticObservation(
  generation: BlueBubblesSemanticObservationGeneration,
): void {
  generation.retry = true
  generation.retainedAtMs = Date.now()
  reactivateObservation(generation.reservation)
}

function completeBlueBubblesSemanticObservation(
  keyHash: string,
  generation: BlueBubblesSemanticObservationGeneration,
): void {
  clearPending(generation.reservation)
  semanticObservationGenerations.delete(keyHash)
}

async function acquireBlueBubblesSemanticHandlingSlot(
  keyHash: string,
  generation: BlueBubblesSemanticObservationGeneration,
): Promise<BlueBubblesSemanticHandlingAcquisition> {
  const active = activeSemanticHandlingSlots.get(keyHash)
  if (!active) {
    const slot: BlueBubblesSemanticHandlingSlot = {
      generation,
      reservation: generation.reservation,
      waiters: [],
    }
    activeSemanticHandlingSlots.set(keyHash, slot)
    return {
      status: "owner",
      slot,
      reservation: generation.reservation,
      allowSameGenerationRetry: generation.retry,
    }
  }
  return await new Promise<BlueBubblesSemanticHandlingAcquisition>((resolve) => {
    active.waiters.push(resolve)
  })
}

function releaseBlueBubblesSemanticHandlingSlot(
  keyHash: string,
  slot: BlueBubblesSemanticHandlingSlot,
  outcome: "terminal" | "retryable" | "retained",
): void {
  if (outcome === "retryable") {
    slot.generation.retry = true
    const next = slot.waiters.shift()
    if (next) {
      reactivateObservation(slot.reservation)
      next({
        status: "owner",
        slot,
        reservation: slot.reservation,
        allowSameGenerationRetry: true,
      })
      return
    }
  }
  activeSemanticHandlingSlots.delete(keyHash)
  if (outcome === "terminal") {
    completeBlueBubblesSemanticObservation(keyHash, slot.generation)
  } else {
    suspendBlueBubblesSemanticObservation(slot.generation)
  }
  for (const resolve of slot.waiters.splice(0)) {
    resolve({ status: "handled_by_owner" })
  }
}

/**
 * In-flight message tracker.
 *
 * Stores the timestamp (ms) when each (sessionKey, messageGuid) was claimed.
 * Stale entries (older than BB_IN_FLIGHT_MAX_AGE_MS) are treated as expired:
 * `isBlueBubblesMessageInFlight` returns false, and `beginBlueBubblesMessageInFlight`
 * is allowed to replace the stale marker.
 *
 * Rationale: `handleBlueBubblesNormalizedEvent` has many exit paths and a leak
 * on any one of them strands the marker forever (until BB sense process restart),
 * which silently halts forward progress on the recovery queue. A real
 * agent lost BlueBubbles inbound for 12+ hours on 2026-05-11 because of
 * exactly this.
 *
 * The TTL bounds the worst case: a leaked marker self-clears after
 * BB_IN_FLIGHT_MAX_AGE_MS, and the next recovery pass can retry. This is
 * defense-in-depth alongside auditing the explicit `endBlueBubblesMessageInFlight`
 * exit-path calls — the audit is still worthwhile, but the TTL guarantees the
 * class of bug can't wedge the queue indefinitely.
 */
const bbInFlightMessageClaims = new Map<string, number>()

/**
 * In-flight markers expire 50% beyond the longest expected turn (recovery turn
 * timeout = 10 min). 15 min gives normal turns full headroom while preventing
 * a leaked marker from blocking forward progress for hours.
 */
export const BB_IN_FLIGHT_MAX_AGE_MS = 15 * 60_000

export type BlueBubblesFinalTransportResult =
  | { status: "accepted" }
  | { status: "not_invoked"; reason: "closed" | "empty" | "blocked_meta" | "duplicate" | "not_current" | "durable_duplicate" }

type BlueBubblesCallbacks = ChannelCallbacks & {
  flush(options?: { signal?: AbortSignal }): Promise<BlueBubblesFinalTransportResult>
  finish(options?: { timeoutMs?: number }): Promise<void>
  cancelOutbound(reason: "turn_timeout" | "superseded" | "shutdown"): void
}

// ── Near-duplicate outward-text detection ────────────────────────
// Used by createBlueBubblesCallbacks to collapse mid-turn rephrasings of the
// same answer/status into a single delivery. Exposed for direct unit testing
// of the similarity behavior without spinning up the full callbacks closure.

const NEAR_DUPLICATE_JACCARD_THRESHOLD = 0.7
const NEAR_DUPLICATE_MIN_TOKENS = 5

export function tokenizeForDedupe(text: string): Set<string> {
  const matches = text.toLowerCase().match(/[a-z0-9']+/g)
  if (!matches) return new Set()
  return new Set(matches)
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) {
    if (b.has(token)) intersection += 1
  }
  const union = a.size + b.size - intersection
  return intersection / union
}

export interface BlueBubblesHandleResult {
  handled: boolean
  /** Legacy field name: true only when this inbound reached an accepted terminal transport. */
  notifiedAgent: boolean
  kind?: BlueBubblesNormalizedEvent["kind"]
  reason?: "from_me" | "mutation_state_only" | "already_processed" | "ignored" | "autonomy_budget_blocked" | "semantic_claim_timeout" | "superseded" | "turn_timeout" | "delivery_failed" | "no_visible_reply"
}

function blueBubblesMessageKey(sessionKey: string, messageGuid: string): string {
  return `${sessionKey}:${messageGuid.trim()}`
}

function isClaimStale(claimedAtMs: number, nowMs: number = Date.now()): boolean {
  return nowMs - claimedAtMs >= BB_IN_FLIGHT_MAX_AGE_MS
}

/** Internal — exported only so unit tests can exercise the TTL semantics. */
export function isBlueBubblesMessageInFlight(sessionKey: string, messageGuid: string): boolean {
  if (!messageGuid.trim()) return false
  const claimedAtMs = bbInFlightMessageClaims.get(blueBubblesMessageKey(sessionKey, messageGuid))
  if (claimedAtMs === undefined) return false
  return !isClaimStale(claimedAtMs)
}

/** Internal — exported only so unit tests can exercise the TTL semantics. */
export function beginBlueBubblesMessageInFlight(sessionKey: string, messageGuid: string): boolean {
  if (!messageGuid.trim()) return true
  const key = blueBubblesMessageKey(sessionKey, messageGuid)
  const existing = bbInFlightMessageClaims.get(key)
  if (existing !== undefined && !isClaimStale(existing)) return false
  if (existing !== undefined && isClaimStale(existing)) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_in_flight_marker_expired",
      message: "in-flight marker expired by TTL; allowing re-claim",
      meta: {
        sessionKey,
        messageGuid,
        claimAgeMs: Date.now() - existing,
        ttlMs: BB_IN_FLIGHT_MAX_AGE_MS,
      },
    })
  }
  bbInFlightMessageClaims.set(key, Date.now())
  return true
}

/** Internal — exported only so unit tests can exercise the TTL semantics. */
export function endBlueBubblesMessageInFlight(sessionKey: string, messageGuid: string): void {
  bbInFlightMessageClaims.delete(blueBubblesMessageKey(sessionKey, messageGuid))
}

/**
 * Test-only: clear all in-flight markers. Production code must use begin/end pairs.
 * Exported so unit tests can reset cross-test state without resetting modules.
 */
export function __resetBlueBubblesInFlightForTests(): void {
  bbInFlightMessageClaims.clear()
}

interface RuntimeDeps {
  getAgentName: typeof getAgentName
  buildSystem: typeof buildSystem
  runAgent: typeof runAgent
  loadSession: typeof loadSession
  saveSession: typeof saveSession
  postTurnTrim: typeof postTurnTrim
  postTurnPersist: typeof postTurnPersist
  sessionPath: typeof sessionPath
  accumulateFriendTokens: typeof accumulateFriendTokens
  createClient: () => BlueBubblesClient
  recordMutation: typeof recordBlueBubblesMutation
  createFriendStore: () => FileFriendStore
  createFriendResolver: (store: FileFriendStore, params: FriendResolverParams) => FriendResolver
  createServer: typeof http.createServer
  getOwnHandles: () => readonly string[]
  promoteFailoverState: (sessionKey: string, state: FailoverState) => void
  recordProcessed: typeof recordProcessedBlueBubblesMessage
}

export interface BlueBubblesReplyTargetController {
  getReplyToMessageGuid(): string | undefined
  setSelection(selection: BlueBubblesReplyTargetSelection): string
}

export interface ProactiveBlueBubblesSessionSendParams {
  friendId: string
  sessionKey: string
  text: string
  intent?: "generic_outreach" | "explicit_cross_chat"
  authorizingSession?: {
    friendId: string
    channel: string
    key: string
    trustLevel?: string
  }
}

export interface ProactiveBlueBubblesSessionSendResult {
  delivered: boolean
  reason?: "friend_not_found" | "trust_skip" | "missing_target" | "send_error" | "group_blocked" | "internal_content_blocked" | "blocked_meta_content"
}

const defaultDeps: RuntimeDeps = {
  getAgentName,
  buildSystem,
  runAgent,
  loadSession,
  saveSession,
  postTurnTrim,
  postTurnPersist,
  sessionPath,
  accumulateFriendTokens,
  createClient: () => createBlueBubblesClient(),
  recordMutation: recordBlueBubblesMutation,
  createFriendStore: () => new FileFriendStore(path.join(getAgentRoot(), "friends")),
  createFriendResolver: (store, params) => new FriendResolver(store, params),
  createServer: http.createServer,
  getOwnHandles: () => [...getBlueBubblesConfig().ownHandles, ...discoveredOwnHandles],
  promoteFailoverState: (sessionKey, state) => {
    bbFailoverStates.set(sessionKey, structuredClone(state))
  },
  recordProcessed: recordProcessedBlueBubblesMessage,
}

const BLUEBUBBLES_RUNTIME_SYNC_INTERVAL_MS = 30_000
const BLUEBUBBLES_RECOVERY_PASS_DELAY_MS = 1_000
const BLUEBUBBLES_RECOVERY_PASS_INTERVAL_MS = 30_000
const BLUEBUBBLES_LIVE_TURN_TIMEOUT_MS = 2 * 60_000
const BLUEBUBBLES_RECOVERY_TURN_TIMEOUT_MS = 10 * 60_000
const BLUEBUBBLES_LIVE_TURN_STALLED_MS = 90_000
const BLUEBUBBLES_CALLBACK_CLEANUP_TIMEOUT_MS = 2_000
const BLUEBUBBLES_ACTIVITY_OPERATION_TIMEOUT_MS = 20_000
const BLUEBUBBLES_CATCHUP_PAGE_SIZE = 50
const BLUEBUBBLES_CATCHUP_MAX_PAGES = 20
const BLUEBUBBLES_HEALTHY_CATCHUP_OVERLAP_MS = 90_000
const BLUEBUBBLES_RECOVERY_CATCHUP_LOOKBACK_MS = 24 * 60 * 60 * 1000
const BLUEBUBBLES_FIRST_CATCHUP_LOOKBACK_MS = 10 * 60 * 1000

interface BlueBubblesHandleOptions {
  timeoutMs?: number
  autonomyBudgetTrigger?: "recovery"
  semanticRecovery?: boolean
  observationReservation?: BlueBubblesObservationReservation
  lifecycleSignal?: AbortSignal
}

type CurrentBlueBubblesIngressEvidence = NonNullable<ToolContext["currentIngressEvidence"]>

interface CapturedBlueBubblesHandleOptions extends BlueBubblesHandleOptions {
  currentIngressEvidence: CurrentBlueBubblesIngressEvidence
  orientationEvidence: BlueBubblesSemanticCaptureEvent
  orientationConversationKind: OrientationConversationKind
  latestTurnCapability: BlueBubblesLatestTurnCapability
  publishAcceptedReceipt: () => void
}

class BlueBubblesRecoveryTurnTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`bluebubbles recovery turn timed out after ${timeoutMs}ms`)
    this.name = "BlueBubblesRecoveryTurnTimeoutError"
  }
}

class BlueBubblesActivityTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`bluebubbles ${operation} activity timed out after ${timeoutMs}ms`)
    this.name = "BlueBubblesActivityTimeoutError"
  }
}

function withBlueBubblesActivityTimeout<T>(
  operation: string,
  timeoutMs: number,
  controller: AbortController,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  controller.signal.throwIfAborted()
  let removeAbortListener!: () => void
  const aborted = new Promise<never>((_, reject) => {
    const rejectFromAbort = (): void => {
      reject(controller.signal.reason)
    }
    controller.signal.addEventListener("abort", rejectFromAbort, { once: true })
    removeAbortListener = () => controller.signal.removeEventListener("abort", rejectFromAbort)
  })
  return Promise.race([
    Promise.resolve().then(() => task(controller.signal)),
    aborted,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new BlueBubblesActivityTimeoutError(operation, timeoutMs)
        controller.abort(error)
        reject(error)
      }, timeoutMs)
      /* v8 ignore next -- timer handles expose unref only in some runtimes @preserve */
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref()
      }
    }),
  ]).finally(() => {
    removeAbortListener()
    /* v8 ignore next -- timer is assigned unless a callback task throws synchronously; callback tasks are async @preserve */
    if (timer !== null) clearTimeout(timer)
  })
}

async function waitForBlueBubblesCallbackCleanup(
  queue: Promise<void>,
  timeoutMs: number,
  meta: Record<string, unknown>,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null
  let timedOut = false
  await Promise.race([
    queue,
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true
        resolve()
      }, timeoutMs)
      /* v8 ignore next -- timer handles expose unref only in some runtimes @preserve */
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref()
      }
    }),
  ]).finally(() => {
    /* v8 ignore next -- timer is assigned for the cleanup race; null only protects unusual synchronous construction failure @preserve */
    if (timer !== null) clearTimeout(timer)
  })
  if (!timedOut) return true
  emitNervesEvent({
    level: "warn",
    component: "senses",
    event: "senses.bluebubbles_activity_cleanup_timeout",
    message: "bluebubbles callback cleanup timed out; releasing live turn lane",
    meta: { ...meta, timeoutMs },
  })
  return false
}

function resolveFriendParams(event: CanonicalBlueBubblesDirectionObservedMessage): FriendResolverParams {
  if (event.chat.isGroup) {
    return {
      provider: "imessage-handle",
      externalId: `group:${event.chat.chatGuid}`,
      displayName: event.chat.displayName ?? "Unknown Group",
      channel: "bluebubbles",
    }
  }

  return {
    provider: "imessage-handle",
    externalId: event.sender.externalId,
    displayName: event.sender.displayName,
    channel: "bluebubbles",
  }
}

function resolveGroupExternalId(event: CanonicalBlueBubblesDirectionObservedMessage): string {
  return `group:${event.chat.chatGuid}`
}

/**
 * Check if any participant in a group chat is a known family member.
 * Looks up each participant handle in the friend store.
 */
async function checkGroupHasFamilyMember(
  store: FileFriendStore,
  event: CanonicalBlueBubblesDirectionObservedMessage,
): Promise<boolean> {
  if (!event.chat.isGroup) return false
  for (const handle of event.chat.participantHandles) {
    const friend = await store.findByExternalId("imessage-handle", handle)
    if (friend?.trustLevel === "family") return true
  }
  return false
}

/**
 * Check if an acquaintance shares any group chat with a family member.
 * Compares group-prefixed externalIds between the acquaintance and all family members.
 */
async function checkHasExistingGroupWithFamily(
  store: FileFriendStore,
  senderFriend: FriendRecord,
): Promise<boolean> {
  const trustLevel = senderFriend.trustLevel ?? "friend"
  if (trustLevel !== "acquaintance") return false

  const acquaintanceGroups = new Set(
    (senderFriend.externalIds ?? [])
      .filter((eid) => eid.externalId.startsWith("group:"))
      .map((eid) => eid.externalId),
  )
  if (acquaintanceGroups.size === 0) return false

  const allFriends = await (store.listAll?.() ?? Promise.resolve([]))
  for (const friend of allFriends) {
    if (friend.trustLevel !== "family") continue
    const friendGroups = (friend.externalIds ?? [])
      .filter((eid) => eid.externalId.startsWith("group:"))
      .map((eid) => eid.externalId)
    for (const group of friendGroups) {
      if (acquaintanceGroups.has(group)) return true
    }
  }
  return false
}

function extractMessageText(content: OpenAI.ChatCompletionMessageParam["content"] | undefined): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (part && typeof part === "object" && "type" in part && part.type === "text" && typeof part.text === "string") {
        return part.text
      }
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

type HistoricalLaneSummary = {
  label: string
  key: string
  snippet: string
}

function isHistoricalLaneMetadataLine(line: string): boolean {
  return /^\[(conversation scope|recent active lanes|routing control):?/i.test(line)
    || /^- (top_level|thread:[^:]+):/i.test(line)
}

function extractHistoricalLaneSummary(
  messages: OpenAI.ChatCompletionMessageParam[],
): HistoricalLaneSummary[] {
  const seen = new Set<string>()
  const summaries: HistoricalLaneSummary[] = []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== "user") continue
    const text = extractMessageText(message.content)
    if (!text) continue
    const firstLine = text.split("\n")[0].trim()
    const threadMatch = firstLine.match(/thread id: ([^\]|]+)/i)
    const laneKey = threadMatch
      ? `thread:${threadMatch[1].trim()}`
      : /top[-_]level/i.test(firstLine)
        ? "top_level"
        : null
    if (!laneKey || seen.has(laneKey)) continue
    seen.add(laneKey)
    const snippet = text
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !isHistoricalLaneMetadataLine(line))
      ?.slice(0, 80) ?? "(no recent text)"
    summaries.push({
      key: laneKey,
      label: laneKey === "top_level" ? "top_level" : laneKey,
      snippet,
    })
    if (summaries.length >= 5) break
  }
  return summaries
}

function buildBlueBubblesOrientationSource(
  event: BlueBubblesNormalizedMessage,
  existingMessages: OpenAI.ChatCompletionMessageParam[],
  evidence: BlueBubblesSemanticCaptureEvent,
  conversationKind: OrientationConversationKind,
  repliedToText?: string | null,
): OrientationSource {
  const repairNotice = event.repairNotice?.trim()
  const actor = evidence.actor
  const participants = evidence.participants
    .filter((participant) => !(
      participant.provider === actor.provider
      && participant.externalId === actor.externalId
    ))
    .map((participant) => ({
      role: "group_participant_only" as const,
      provider: participant.provider,
      externalId: participant.externalId,
      displayName: participant.displayName,
    }))
  const presentation = {
    authority: "presentation_only" as const,
    conversationKind,
    event: {
      provider: evidence.provider,
      kind: evidence.kind,
      sourceEventType: evidence.sourceEventType,
      fromMe: evidence.fromMe,
    },
    actor: {
      role: "observed_actor" as const,
      provider: actor.provider,
      externalId: actor.externalId,
      displayName: actor.displayName,
    },
    participants,
  }

  const summaries = extractHistoricalLaneSummary(existingMessages)
  const threadId = event.threadOriginatorGuid?.trim() || undefined
  const hasThreadRoute = !!threadId || summaries.some((summary) => summary.key.startsWith("thread:"))
  return {
    kind: "bluebubbles",
    ...presentation,
    lane: threadId ? "thread" : "top_level",
    defaultReplyTarget: threadId ? "current_lane" : "top_level",
    ...(threadId ? { threadId } : {}),
    ...(repliedToText ? { replyingToText: repliedToText } : {}),
    ...(repairNotice ? { repairNotice } : {}),
    ...(summaries.length > 0 ? { recentLanes: summaries } : {}),
    ...(hasThreadRoute
      ? { routingHint: "use bluebubbles_set_reply_target to choose current_lane, top_level, or a listed thread before sending BlueBubbles-specific replies." }
      : {}),
  }
}

function buildInboundText(
  event: BlueBubblesNormalizedMessage,
): string {
  const baseText = event.textForAgent
  if (!event.chat.isGroup) {
    return baseText
  }
  return `${event.sender.displayName}: ${baseText}`
}

function buildInboundContent(
  event: BlueBubblesNormalizedMessage,
): OpenAI.ChatCompletionUserMessageParam["content"] {
  const text = buildInboundText(event)
  if (!event.inputPartsForAgent || event.inputPartsForAgent.length === 0) {
    return text
  }

  return [
    { type: "text", text },
    ...event.inputPartsForAgent,
  ]
}

function sessionLikelyContainsMessage(
  event: BlueBubblesNormalizedMessage,
  existingMessages: OpenAI.ChatCompletionMessageParam[],
): boolean {
  const fragment = event.textForAgent.trim()
  if (!fragment) return false
  return existingMessages.some((message) => {
    if (message.role !== "user") return false
    return extractMessageText(message.content).includes(fragment)
  })
}

function getBlueBubblesContinuityIngressTexts(event: CanonicalBlueBubblesDirectionObservedMessage): string[] {
  const text = event.textForAgent.trim()
  if (text.length > 0) return [text]

  const fallbackText = (event.inputPartsForAgent ?? [])
    .map((part) => {
      if (part.type === "text" && typeof part.text === "string") {
        return part.text.trim()
      }
      return ""
    })
    .filter(Boolean)
    .join("\n")

  return fallbackText ? [fallbackText] : []
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

function timestampIsoForAutonomy(event: BlueBubblesNormalizedEvent): string {
  return Number.isFinite(event.timestamp)
    ? new Date(event.timestamp).toISOString()
    : new Date().toISOString()
}

function blueBubblesAutonomyTarget(event: BlueBubblesNormalizedEvent): Record<string, string | undefined> {
  return {
    messageGuid: event.messageGuid,
    sessionKeyHash: sha256Hex(event.chat.sessionKey),
    chatGuidHash: event.chat.chatGuid ? sha256Hex(event.chat.chatGuid) : undefined,
    chatIdentifierHash: event.chat.chatIdentifier ? sha256Hex(event.chat.chatIdentifier) : undefined,
  }
}

function blueBubblesRecoveryStormInput(
  agentName: string,
  event: BlueBubblesNormalizedEvent,
  source: BlueBubblesInboundSource,
): AutonomyStormInput {
  return {
    agent: agentName,
    triggerType: "recovery",
    sourceKind: "sense",
    senseOrHabit: "bluebubbles",
    provider: "bluebubbles-recovery",
    target: blueBubblesAutonomyTarget(event),
    normalizedErrorName: "BlueBubblesRecoveryError",
    normalizedErrorCode: "RECOVERY_FAILED",
    codeLocation: `senses/bluebubbles/${source}`,
    idempotencyBucket: `bluebubbles-recovery:${source}`,
  }
}

function shouldUseBlueBubblesRecoveryBudget(
  source: BlueBubblesInboundSource,
  options: BlueBubblesHandleOptions,
): boolean {
  return options.autonomyBudgetTrigger === "recovery"
    || source === "mutation-recovery"
    || source === "upstream-catchup"
    || source === "recovery-bootstrap"
}

function shouldCountBlueBubblesRecoveryResultAsSkipped(reason: BlueBubblesHandleResult["reason"]): boolean {
  return reason === "already_processed"
    || reason === "autonomy_budget_blocked"
    || reason === "mutation_state_only"
    || reason === "from_me"
}

function recordBlueBubblesRecoveryFailureForBudget(
  agentName: string,
  event: BlueBubblesNormalizedEvent,
  source: BlueBubblesInboundSource,
): void {
  try {
    recordAutonomyFailure(getAgentRoot(agentName), {
      ...blueBubblesRecoveryStormInput(agentName, event, source),
      occurredAt: timestampIsoForAutonomy(event),
    })
  } catch {
    // Autonomy failure accounting must not turn a recovery error into a broader sense outage.
  }
}

function insertEphemeralContextMessages(
  messages: OpenAI.ChatCompletionMessageParam[],
  contextMessages: OpenAI.ChatCompletionMessageParam[],
  currentUserMessage?: OpenAI.ChatCompletionMessageParam,
): OpenAI.ChatCompletionMessageParam[] {
  if (contextMessages.length === 0) return messages
  const requiredCurrentIndex = currentUserMessage ? messages.indexOf(currentUserMessage) : -1
  const insertionIndex = requiredCurrentIndex >= 0 ? requiredCurrentIndex : Math.max(0, messages.length - 1)
  return [
    ...messages.slice(0, insertionIndex),
    ...contextMessages,
    ...messages.slice(insertionIndex),
  ]
}

interface PreparedBlueBubblesContextMessages {
  messages: OpenAI.ChatCompletionMessageParam[]
  contextPacketIds: string[]
  verifiedPredecessorMessage?: OpenAI.ChatCompletionMessageParam
}

function knownProviderMessageTexts(messages: OpenAI.ChatCompletionMessageParam[]): string[] {
  return messages
    .map((message) => extractMessageText(message.content))
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
}

async function buildBlueBubblesContextMessages(input: {
  agentName: string
  agentRoot: string
  client: BlueBubblesClient
  event: CanonicalBlueBubblesDirectionObservedMessage
  knownMessages: OpenAI.ChatCompletionMessageParam[]
}): Promise<PreparedBlueBubblesContextMessages> {
  const event = input.event
  if (!Number.isFinite(event.timestamp)) return { messages: [], contextPacketIds: [] }
  let result: Awaited<ReturnType<typeof buildBlueBubblesContextPacket>>
  try {
    result = await buildBlueBubblesContextPacket({
      agentName: input.agentName,
      client: input.client,
      event,
      knownMessageTexts: knownProviderMessageTexts(input.knownMessages),
    })
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_context_packet_error",
      message: "failed to build live bluebubbles context packet",
      meta: {
        messageGuid: event.messageGuid,
        reason: error instanceof Error ? error.message : String(error),
      },
    })
    return { messages: [], contextPacketIds: [] }
  }
  if (!result) return { messages: [], contextPacketIds: [] }
  const { packet, optionalRendered, verifiedPredecessorMessage, historyCount } = result
  const prepared = {
    messages: optionalRendered
      ? [{ role: "system" as const, content: optionalRendered.text }]
      : [],
    verifiedPredecessorMessage,
  }
  try {
    writeSenseContextPacket(input.agentRoot, packet)
    emitNervesEvent({
      component: "senses",
      event: "senses.bluebubbles_context_packet_injected",
      message: "injected bluebubbles same-chat context packet",
      meta: {
        packetId: packet.packetId,
        messageGuid: event.messageGuid,
        contextMessages: historyCount,
      },
    })
    return {
      ...prepared,
      contextPacketIds: [packet.packetId],
    }
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_context_packet_error",
      message: "failed to build live bluebubbles context packet",
      meta: {
        messageGuid: event.messageGuid,
        reason: error instanceof Error ? error.message : String(error),
      },
    })
    return { ...prepared, contextPacketIds: [] }
  }
}

function createReplyTargetController(event: CanonicalBlueBubblesDirectionObservedMessage): BlueBubblesReplyTargetController {
  const defaultTargetLabel = event.threadOriginatorGuid?.trim() ? "current_lane" : "top_level"
  let selection: BlueBubblesReplyTargetSelection =
    event.threadOriginatorGuid?.trim()
      ? { target: "current_lane" }
      : { target: "top_level" }

  return {
    getReplyToMessageGuid(): string | undefined {
      if (selection.target === "top_level") return undefined
      if (selection.target === "thread") return selection.threadOriginatorGuid.trim()
      return event.threadOriginatorGuid?.trim() ? event.messageGuid : undefined
    },
    setSelection(next: BlueBubblesReplyTargetSelection): string {
      selection = next
      if (next.target === "top_level") {
        return "bluebubbles reply target override: top_level"
      }
      if (next.target === "thread") {
        return `bluebubbles reply target override: thread:${next.threadOriginatorGuid}`
      }
      return `bluebubbles reply target: using default for this turn (${defaultTargetLabel})`
    },
  }
}

function emitBlueBubblesMarkReadWarning(chat: BlueBubblesChatRef, error: unknown): void {
  emitNervesEvent({
    level: "warn",
    component: "senses",
    event: "senses.bluebubbles_mark_read_error",
    message: "failed to mark bluebubbles chat as read",
    meta: {
      chatGuid: chat.chatGuid ?? null,
      reason: error instanceof Error ? error.message : String(error),
    },
  })
}

export function createBlueBubblesCallbacks(
  client: BlueBubblesClient,
  chat: BlueBubblesChatRef,
  replyTarget: BlueBubblesReplyTargetController,
  isGroupChat: boolean,
  onVisibleActivity?: () => void,
  options: {
    enableActivitySignals?: boolean
    admitOutbound?: () => Promise<boolean>
    isOutboundCurrent?: () => boolean
    isOutboundAdmittedNow?: () => boolean
    onFinalTransportInvoked?: () => void
    onFinalTransportAccepted?: () => void
    durableOutbound?: {
      agentRoot: string
      idempotencyKey: string
      attachment: BlueBubblesAttachmentIdentityInput
    }
  } = {},
): BlueBubblesCallbacks {
  let textBuffer = ""
  let typingActive = false
  let typingCouldBeActive = false
  let queue = Promise.resolve()
  let outboundClosed = false
  let nextCleanupToken = 0
  const activeCleanupTokens = new Set<number>()
  const activeActivityControllers = new Set<AbortController>()
  // Per-turn outward-send dedupe. A single createBlueBubblesCallbacks lifetime
  // serves one inbound turn, so collapsing identical outward bodies inside
  // this closure is scoped tightly: each fresh inbound turn starts with an
  // empty set. Mid-turn settle/proof retry loops historically caused the
  // agent to re-emit the same answer through multiple speak calls and a
  // final flush, surfacing as 4 near-identical iMessages from one ask
  // (2026-05-08 06:18 incident). The guard lets the engine retry harmlessly
  // without duplicating outward delivery to the friend.
  //
  // PR #699 used exact whitespace+case-normalized match. Post-#699 evidence
  // (2026-05-09 05:25 UTC, evt-001814 + evt-001818) showed two answers that
  // start "yep — I looked it up… Assuming you mean AMC's The Audacity…" with
  // substantially the same content but slight rephrasing — the LLM rewrites
  // the same answer on a retry/recovery loop and bypasses an exact-match
  // guard. We now also keep the original token sets so a fuzzy (Jaccard)
  // check catches near-duplicates from the same turn.
  const sentOutwardTextNorms = new Set<string>()
  const sentOutwardTokenSets: Array<Set<string>> = []

  async function canRunOutbound(): Promise<boolean> {
    if (outboundClosed) return false
    if (options.isOutboundCurrent && !options.isOutboundCurrent()) return false
    if (options.admitOutbound && !await options.admitOutbound()) return false
    if (outboundClosed) return false
    if (options.isOutboundCurrent && !options.isOutboundCurrent()) return false
    return true
  }

  function enqueue(
    operation: string,
    task: (signal: AbortSignal) => Promise<void>,
    enqueueOptions: { cleanupToken?: number } = {},
  ): void {
    const cleanupToken = enqueueOptions.cleanupToken
    const controller = new AbortController()
    activeActivityControllers.add(controller)
    queue = queue
      .then(async () => {
        if (cleanupToken === undefined) {
          if (!await canRunOutbound()) return
        } else if (!activeCleanupTokens.has(cleanupToken)) {
          return
        }
        await withBlueBubblesActivityTimeout(
          operation,
          BLUEBUBBLES_ACTIVITY_OPERATION_TIMEOUT_MS,
          controller,
          task,
        )
      })
      .catch((error) => {
        if (controller.signal.aborted && !(error instanceof BlueBubblesActivityTimeoutError)) return
        emitNervesEvent({
          level: "warn",
          component: "senses",
          event: "senses.bluebubbles_activity_error",
          message: "bluebubbles activity transport failed",
          meta: { operation, reason: error instanceof Error ? error.message : String(error) },
        })
      })
      .finally(() => {
        activeActivityControllers.delete(controller)
      })
  }

  function abortActiveActivity(reason: string): void {
    for (const controller of activeActivityControllers) {
      controller.abort(new Error(reason))
    }
  }

  function enqueueTypingStop(): void {
    typingActive = false
    const cleanupToken = ++nextCleanupToken
    activeCleanupTokens.add(cleanupToken)
    enqueue("typing_stop", async (signal) => {
      try {
        await client.setTyping(chat, false, signal)
        typingCouldBeActive = false
      } finally {
        activeCleanupTokens.delete(cleanupToken)
      }
    }, { cleanupToken })
  }

  function startTypingNow(): void {
    /* v8 ignore next -- defensive guard: callers already check typingActive @preserve */
    if (typingActive) return
    /* v8 ignore next -- defensive guard: public callback entrypoints already drop after outbound close @preserve */
    if (outboundClosed) return
    typingActive = true
    typingCouldBeActive = true
    enqueue("typing_start", async (signal) => {
      const [markReadResult, typingResult] = await Promise.allSettled([
        client.markChatRead(chat, signal),
        client.setTyping(chat, true, signal),
      ])
      if (markReadResult.status === "rejected") {
        emitBlueBubblesMarkReadWarning(chat, markReadResult.reason)
      }
      if (typingResult.status === "rejected") {
        throw typingResult.reason
      }
    })
  }

  function recordVisibleActivity(): void {
    onVisibleActivity?.()
  }

  function isDuplicateOutwardText(trimmed: string): boolean {
    const norm = trimmed.replace(/\s+/g, " ").trim().toLowerCase()
    if (sentOutwardTextNorms.has(norm)) return true
    // Fuzzy near-duplicate: when the same answer is rephrased between speak
    // and settle (or across two speak calls in a recovery loop), the exact
    // norm differs but token overlap is very high. We compare against every
    // already-sent body's token set; if any has Jaccard overlap >= the
    // threshold, treat as a duplicate. We require a minimum token count on
    // the new body so single-word replies ("yes", "ok") don't get suppressed
    // against any previous short one with shared tokens.
    const newTokens = tokenizeForDedupe(trimmed)
    if (newTokens.size >= NEAR_DUPLICATE_MIN_TOKENS) {
      for (const prevTokens of sentOutwardTokenSets) {
        if (prevTokens.size < NEAR_DUPLICATE_MIN_TOKENS) continue
        if (jaccardSimilarity(newTokens, prevTokens) >= NEAR_DUPLICATE_JACCARD_THRESHOLD) {
          return true
        }
      }
    }
    sentOutwardTextNorms.add(norm)
    sentOutwardTokenSets.push(newTokens)
    return false
  }

  function emitDuplicateOutwardSuppressed(site: "flushNow" | "flush", messageLength: number): void {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "bluebubbles.duplicate_outward_suppressed",
      message: "suppressed near-identical outward send within single inbound turn",
      meta: {
        site,
        chatGuid: chat.chatGuid ?? null,
        messageLength,
      },
    })
  }

  return {
    settleOutputMode: "retractable_buffer",
    onModelStart(): void {
      if (outboundClosed) return
      if (options.enableActivitySignals !== false && !isGroupChat) startTypingNow()
      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_turn_start",
        message: "bluebubbles turn started",
        meta: { chatGuid: chat.chatGuid ?? null },
      })
    },

    onModelStreamStart(): void {
      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_stream_start",
        message: "bluebubbles non-streaming response started",
        meta: {},
      })
    },

    onTextChunk(text: string): void {
      if (outboundClosed) return
      if (options.enableActivitySignals !== false && isGroupChat && !typingActive) startTypingNow()
      textBuffer += text
    },

    onReasoningChunk(_text: string): void {},

    onToolStart(name: string, _args: Record<string, string>): void {
      if (outboundClosed) return
      // Tool activity is a reply commitment, but iMessage is not a tool-progress
      // console. Keep the human-facing thread quiet until the agent has real
      // text, while preserving native read/typing signals and nerves telemetry
      // for debugging.
      if (options.enableActivitySignals !== false && !typingActive && name !== "observe" && name !== "speak") startTypingNow()
      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_tool_start",
        message: "bluebubbles tool execution started",
        meta: { name },
      })
    },

    onToolEnd(name: string, summary: string, success: boolean): void {
      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_tool_end",
        message: "bluebubbles tool execution completed",
        meta: { name, success, summary },
      })
    },

    onError(error: Error, severity: "transient" | "terminal"): void {
      emitNervesEvent({
        level: severity === "terminal" ? "error" : "warn",
        component: "senses",
        event: "senses.bluebubbles_turn_error",
        message: "bluebubbles turn callback error",
        meta: { severity, reason: error.message },
      })
    },

    onClearText(): void {
      textBuffer = ""
    },

    async flushNow(): Promise<void> {
      if (outboundClosed) {
        textBuffer = ""
        return
      }
      // Contract: throws if delivery fails. We deliberately let `client.sendText`
      // rejections propagate so the engine's speak interception can mark the
      // tool call as failed and tell the agent the message did not reach the
      // friend (rather than silently logging and pretending success).
      const trimmed = textBuffer.trim()
      if (!trimmed) return
      textBuffer = ""
      if (containsInternalMetaMarkers(trimmed)) {
        emitBluebubblesMetaBlocked({
          site: "flushNow",
          message: "bluebubbles speak text blocked: internal meta markers",
          meta: {
            chatGuid: chat.chatGuid ?? null,
            messageLength: trimmed.length,
          },
        })
        return
      }
      if (isDuplicateOutwardText(trimmed)) {
        emitDuplicateOutwardSuppressed("flushNow", trimmed.length)
        return
      }
      if (!await canRunOutbound()) return
      await client.sendText({
        chat,
        text: trimmed,
        replyToMessageGuid: replyTarget.getReplyToMessageGuid(),
      })
      recordVisibleActivity()
      // Note: do NOT call client.setTyping(chat, false) here — the agent is
      // still mid-turn, so the typing indicator stays ACTIVE.
      emitNervesEvent({
        component: "senses",
        event: "bluebubbles.speak_flush",
        message: "bluebubbles flushed mid-turn speak",
        meta: { messageLength: trimmed.length },
      })
    },

    async flush(flushOptions: { signal?: AbortSignal } = {}): Promise<BlueBubblesFinalTransportResult> {
      if (outboundClosed) {
        textBuffer = ""
        await waitForBlueBubblesCallbackCleanup(queue, BLUEBUBBLES_CALLBACK_CLEANUP_TIMEOUT_MS, {
          operation: "flush_after_close",
          chatGuid: chat.chatGuid ?? null,
        })
        return { status: "not_invoked", reason: "closed" }
      }
      await queue
      const trimmed = textBuffer.trim()
      if (!trimmed) {
        if (typingActive) {
          enqueueTypingStop()
          await queue
        }
        return { status: "not_invoked", reason: "empty" }
      }
      textBuffer = ""
      /* v8 ignore next 4 -- branch: typing may already be stopped before flush @preserve */
      if (typingActive) {
        enqueueTypingStop()
        await queue
      }
      if (containsInternalMetaMarkers(trimmed)) {
        emitBluebubblesMetaBlocked({
          site: "flush",
          message: "bluebubbles outbound text blocked: internal meta markers",
          meta: {
            chatGuid: chat.chatGuid ?? null,
            messageLength: trimmed.length,
          },
        })
        return { status: "not_invoked", reason: "blocked_meta" }
      }
      if (isDuplicateOutwardText(trimmed)) {
        emitDuplicateOutwardSuppressed("flush", trimmed.length)
        return { status: "not_invoked", reason: "duplicate" }
      }
      if (!await canRunOutbound()) return { status: "not_invoked", reason: "not_current" }
      const replyToMessageGuid = replyTarget.getReplyToMessageGuid()
      const durableOutbound = options.durableOutbound
      const durableTempGuid = durableOutbound
        ? `ouro-inbound-${createHash("sha256")
            .update(durableOutbound.idempotencyKey)
            .digest("hex")
            .slice(0, 32)}`
        : null
      const boundaryState: {
        durableRecord: BlueBubblesOutboundRecord | null
        denialReason: "not_current" | "durable_duplicate"
      } = { durableRecord: null, denialReason: "not_current" }
      const admitFinalTransport = (): boolean => {
        if (
          outboundClosed
          || (options.isOutboundCurrent && !options.isOutboundCurrent())
          || (options.isOutboundAdmittedNow && !options.isOutboundAdmittedNow())
        ) {
          boundaryState.denialReason = "not_current"
          return false
        }
        if (!durableOutbound || boundaryState.durableRecord) return true
        const reservation = reserveBlueBubblesOutbound({
          agentRoot: durableOutbound.agentRoot,
          idempotencyKey: durableOutbound.idempotencyKey,
          chat,
          attachment: durableOutbound.attachment,
          text: trimmed,
          tempGuid: durableTempGuid!,
          ...(replyToMessageGuid ? { replyToMessageGuid } : {}),
        })
        if (reservation.status !== "reserved") {
          boundaryState.denialReason = "durable_duplicate"
          return false
        }
        boundaryState.durableRecord = reservation.record
        return true
      }

      const markDurableFailure = (error: unknown): void => {
        const durableRecord = boundaryState.durableRecord
        if (!durableRecord || !durableOutbound) return
        try {
          markBlueBubblesOutboundFailed({
            agentRoot: durableOutbound.agentRoot,
            recordId: durableRecord.recordId,
            failedAt: new Date().toISOString(),
            reason: error instanceof Error ? error.message : String(error),
          })
        } catch (stateError) {
          emitNervesEvent({
            level: "error",
            component: "senses",
            event: "senses.bluebubbles_outbound_state_error",
            message: "failed to record bluebubbles outbound transport failure",
            meta: {
              recordId: durableRecord.recordId,
              reason: String(stateError),
            },
          })
        }
      }
      let response: Awaited<ReturnType<BlueBubblesClient["sendText"]>>
      while (true) {
        try {
          flushOptions.signal?.throwIfAborted()
          response = await client.sendText({
            chat,
            text: trimmed,
            replyToMessageGuid,
            ...(durableTempGuid ? { tempGuid: durableTempGuid } : {}),
            ...(flushOptions.signal ? { signal: flushOptions.signal } : {}),
            beforeTransportInvocation: admitFinalTransport,
            onTransportInvocation: options.onFinalTransportInvoked,
          })
          break
        } catch (error) {
          if (
            error instanceof BlueBubblesSendError
            && error.transportInvoked === false
            && error.errorCode === "admission_denied"
          ) {
            if (boundaryState.denialReason === "durable_duplicate") {
              return { status: "not_invoked", reason: "durable_duplicate" }
            }
            // A newer observation may be only a temporary fence (duplicate,
            // audit-only, or otherwise non-promoting). Re-await admission and
            // retry the same durable reservation if this turn remains current.
            if (!await canRunOutbound()) {
              markDurableFailure(error)
              return { status: "not_invoked", reason: "not_current" }
            }
            continue
          }
          markDurableFailure(error)
          throw error
        }
      }
      const durableRecord = boundaryState.durableRecord
      if (durableRecord && durableOutbound) {
        try {
          markBlueBubblesOutboundAccepted({
            agentRoot: durableOutbound.agentRoot,
            recordId: durableRecord.recordId,
            acceptedAt: new Date().toISOString(),
            ...(response.messageGuid ? { messageGuid: response.messageGuid } : {}),
          })
        } catch (stateError) {
          emitNervesEvent({
            level: "error",
            component: "senses",
            event: "senses.bluebubbles_outbound_state_error",
            message: "failed to record accepted bluebubbles outbound transport",
            meta: {
              recordId: durableRecord.recordId,
              reason: String(stateError),
            },
          })
        }
      }
      options.onFinalTransportAccepted?.()
      recordVisibleActivity()
      return { status: "accepted" }
    },

    async finish(options: { timeoutMs?: number } = {}): Promise<void> {
      const cleanupTimeoutMs = options.timeoutMs ?? BLUEBUBBLES_CALLBACK_CLEANUP_TIMEOUT_MS
      const needsTypingStop = typingActive
      if (needsTypingStop) {
        enqueueTypingStop()
      }
      const drained = await waitForBlueBubblesCallbackCleanup(queue, cleanupTimeoutMs, {
        operation: "finish",
        chatGuid: chat.chatGuid ?? null,
      })
      if (!drained) {
        // The queued start/read request may outlive this turn's bounded lane.
        // Invalidate its deferred stop, then issue one stop request now while A
        // still owns the canonical lock so B cannot start typing ahead of it.
        activeCleanupTokens.clear()
        abortActiveActivity("bluebubbles activity superseded by bounded cleanup")
        await waitForBlueBubblesCallbackCleanup(queue, cleanupTimeoutMs, {
          operation: "finish_after_activity_abort",
          chatGuid: chat.chatGuid ?? null,
        })
      }
      if (typingCouldBeActive) {
        const fallbackController = new AbortController()
        try {
          await withBlueBubblesActivityTimeout(
            "typing_stop_fallback",
            cleanupTimeoutMs,
            fallbackController,
            (signal) => client.setTyping(chat, false, signal),
          )
          typingCouldBeActive = false
        } catch (error) {
          emitNervesEvent({
            level: "warn",
            component: "senses",
            event: "senses.bluebubbles_activity_error",
            message: "bluebubbles activity transport failed",
            meta: {
              operation: "typing_stop_fallback",
              reason: error instanceof Error ? error.message : String(error),
            },
          })
        }
      }
      activeCleanupTokens.clear()
    },

    cancelOutbound(reason: "turn_timeout" | "superseded" | "shutdown"): void {
      outboundClosed = true
      textBuffer = ""
      abortActiveActivity(`bluebubbles outbound ${reason}`)
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_outbound_closed",
        message: "bluebubbles outbound callbacks closed for timed-out turn",
        meta: { chatGuid: chat.chatGuid ?? null, reason },
      })
    },
  }
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  let body = ""
  for await (const chunk of req) {
    body += chunk.toString()
  }
  return body
}

function writeJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader("Content-Type", "application/json; charset=utf-8")
  res.end(JSON.stringify(payload))
}

function writeSemanticCaptureFailure(res: http.ServerResponse): void {
  res.statusCode = 503
  res.setHeader("Content-Type", "application/json")
  res.end('{"ok":false,"error":"semantic_capture_failed"}')
}

function isWebhookPasswordValid(url: URL, expectedPassword: string): boolean {
  const provided = url.searchParams.get("password")
  return !provided || provided === expectedPassword
}

function normalizeHandleForSelfMatch(handle: string): string {
  const trimmed = handle.trim().toLowerCase()
  if (!trimmed) return ""
  // Phone-shaped: strip everything but digits so +1 (415) 555-... matches 14155550000.
  if (/[+\d]/.test(trimmed) && !trimmed.includes("@")) {
    const digits = trimmed.replace(/\D/g, "")
    if (digits.length >= 7) return digits
  }
  return trimmed
}

export function isAgentSelfHandle(senderExternalId: string | undefined, ownHandles: readonly string[]): boolean {
  if (!senderExternalId || !senderExternalId.trim()) return false
  const target = normalizeHandleForSelfMatch(senderExternalId)
  /* v8 ignore start -- target is non-empty by construction since senderExternalId was just verified non-whitespace */
  if (!target) return false
  /* v8 ignore stop */
  for (const own of ownHandles) {
    if (normalizeHandleForSelfMatch(own) === target) return true
  }
  return false
}

/**
 * In-memory store of agent iMessage handles auto-discovered from group-chat
 * `event.fromMe === true` events. Bluebubbles can attribute the peer's handle
 * as `event.sender.externalId` on 1:1 outbound messages, so discovery is
 * intentionally limited to the group echo bug that motivated
 * `bluebubbles.ownHandles` originally.
 *
 * Per-process. A daemon restart re-learns from the next outbound. The
 * accompanying nerves event (`senses.bluebubbles_own_handle_discovered`)
 * tells the operator what to add to `bluebubbles.ownHandles` for cross-
 * restart durability.
 */
const discoveredOwnHandles = new Set<string>()

export function getDiscoveredOwnHandles(): readonly string[] {
  return [...discoveredOwnHandles]
}

export function clearDiscoveredOwnHandles(): void {
  discoveredOwnHandles.clear()
}

export function recordDiscoveredOwnHandle(senderExternalId: string | undefined): boolean {
  if (!senderExternalId || !senderExternalId.trim()) return false
  const trimmed = senderExternalId.trim()
  const normalized = normalizeHandleForSelfMatch(trimmed)
  /* v8 ignore next -- defensive: normalizeHandleForSelfMatch only returns falsy for empty input, already guarded above @preserve */
  if (!normalized) return false
  for (const existing of discoveredOwnHandles) {
    if (normalizeHandleForSelfMatch(existing) === normalized) return false
  }
  discoveredOwnHandles.add(trimmed)
  emitNervesEvent({
    level: "info",
    component: "senses",
    event: "senses.bluebubbles_own_handle_discovered",
    message: "captured a new agent-owned bluebubbles handle from an isFromMe outbound — add to bluebubbles.ownHandles for cross-restart durability",
    meta: { handle: trimmed, totalDiscovered: discoveredOwnHandles.size },
  })
  return true
}

function isSelfFriendRecord(friend: FriendRecord | null, agentName: string): boolean {
  if (!friend || friend.kind !== "agent") return false
  const normalizedAgent = agentName.trim().toLowerCase()
  const name = friend.name?.trim().toLowerCase()
  const bundleName = friend.agentMeta?.bundleName?.trim().toLowerCase()
  return name === normalizedAgent || bundleName === normalizedAgent
}

async function shouldFilterAgentSelfHandle(
  event: BlueBubblesNormalizedEvent,
  resolvedDeps: RuntimeDeps,
): Promise<boolean> {
  if (!event.chat.isGroup) return false
  if (!isAgentSelfHandle(event.sender.externalId, resolvedDeps.getOwnHandles())) return false

  const store = resolvedDeps.createFriendStore()
  const knownFriend = await store
    .findByExternalId("imessage-handle", event.sender.externalId)
    .catch(() => null)

  if (knownFriend && !isSelfFriendRecord(knownFriend, resolvedDeps.getAgentName())) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_self_handle_bypassed_known_friend",
      message: "did not filter bluebubbles sender even though it matched ownHandles because it resolves to a known non-self friend",
      meta: {
        messageGuid: event.messageGuid,
        kind: event.kind,
        senderExternalId: event.sender.externalId,
        friendId: knownFriend.id,
      },
    })
    return false
  }

  return true
}

type BlueBubblesDirectionObservedEvent = BlueBubblesNormalizedEvent & { fromMe: boolean }
type BlueBubblesDirectionObservedMessage = BlueBubblesNormalizedMessage & { fromMe: boolean }
type CanonicalBlueBubblesDirectionObservedMessage = BlueBubblesDirectionObservedMessage & {
  chat: BlueBubblesChatRef & {
    chatGuid: string
    sendTarget: { kind: "chat_guid"; value: string }
  }
}

interface BlueBubblesStagedPostTurn {
  sessionPath: string
  prepared: PostTurnPrepared
  usage?: UsageData
  state?: SessionContinuityState
}

interface BlueBubblesStagedTokenPromotion {
  store: Parameters<typeof accumulateFriendTokens>[0]
  friendId: string
  usage?: UsageData
}

interface BlueBubblesTurnStage {
  postTurn?: BlueBubblesStagedPostTurn
  tokens?: BlueBubblesStagedTokenPromotion
  failoverState: FailoverState
}

function createBlueBubblesTurnStage(sessionKey: string): BlueBubblesTurnStage {
  return {
    failoverState: structuredClone(bbFailoverStates.get(sessionKey) ?? { pending: null }),
  }
}

function persistAcceptedBlueBubblesProjection(input: {
  stage: BlueBubblesTurnStage
  deps: RuntimeDeps
  event: CanonicalBlueBubblesDirectionObservedMessage
}): void {
  const { stage, deps, event } = input
  if (stage.postTurn) {
    try {
      deps.postTurnPersist(
        stage.postTurn.sessionPath,
        stage.postTurn.prepared,
        stage.postTurn.usage,
        stage.postTurn.state,
      )
    } catch (error) {
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.bluebubbles_accepted_projection_failed",
        message: "accepted bluebubbles reply could not be projected into canonical session history",
        meta: {
          messageGuid: event.messageGuid,
          sessionKey: event.chat.sessionKey,
          reason: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }
}

function promoteAcceptedBlueBubblesAncillaryState(input: {
  stage: BlueBubblesTurnStage
  deps: RuntimeDeps
  agentName: string
  event: CanonicalBlueBubblesDirectionObservedMessage
  source: BlueBubblesInboundSource
  processedOutcome: "turn-complete" | "trust-gated"
}): void {
  const { stage, deps, agentName, event, source } = input
  try {
    deps.promoteFailoverState(event.chat.sessionKey, stage.failoverState)
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_failover_state_promotion_failed",
      message: "accepted bluebubbles reply could not promote staged failover state",
      meta: {
        messageGuid: event.messageGuid,
        sessionKey: event.chat.sessionKey,
        reason: error instanceof Error ? error.message : String(error),
      },
    })
  }

  if (stage.tokens) {
    const emitTokenPromotionFailure = (error: unknown): void => {
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_token_promotion_failed",
        message: "accepted bluebubbles reply could not promote staged token usage",
        meta: {
          messageGuid: event.messageGuid,
          sessionKey: event.chat.sessionKey,
          reason: error instanceof Error ? error.message : String(error),
        },
      })
    }
    try {
      void deps.accumulateFriendTokens(
        stage.tokens.store,
        stage.tokens.friendId,
        stage.tokens.usage,
      ).catch(emitTokenPromotionFailure)
    } catch (error) {
      emitTokenPromotionFailure(error)
    }
  }

  try {
    deps.recordProcessed(agentName, event, source, input.processedOutcome)
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_processed_promotion_failed",
      message: "accepted bluebubbles reply could not promote processed sidecar state",
      meta: {
        messageGuid: event.messageGuid,
        sessionKey: event.chat.sessionKey,
        reason: error instanceof Error ? error.message : String(error),
      },
    })
  }
}

function hasObservedBlueBubblesDirection(
  event: BlueBubblesNormalizedEvent,
): event is BlueBubblesDirectionObservedEvent {
  return typeof event.fromMe === "boolean"
}

async function handleBlueBubblesNormalizedEvent(
  event: CanonicalBlueBubblesDirectionObservedMessage,
  resolvedDeps: RuntimeDeps,
  source: BlueBubblesInboundSource,
  options: CapturedBlueBubblesHandleOptions,
): Promise<BlueBubblesHandleResult> {
  options.lifecycleSignal?.throwIfAborted()
  const client = resolvedDeps.createClient()
  const agentName = resolvedDeps.getAgentName()
  recoverRuntimeCwd()

  let activeTurnId: string | null = null

  if (shouldUseBlueBubblesRecoveryBudget(source, options)) {
    const decision = reserveAutonomyBudget(getAgentRoot(agentName), {
      agent: agentName,
      triggerType: "recovery",
      sourceKind: "sense",
      senseOrHabit: "bluebubbles",
      target: blueBubblesAutonomyTarget(event),
      idempotencyKey: `bluebubbles-recovery:${source}:${event.messageGuid}`,
      now: timestampIsoForAutonomy(event),
      storm: blueBubblesRecoveryStormInput(agentName, event, source),
    })
    if (!decision.allowed) {
      return { handled: true, notifiedAgent: false, kind: event.kind, reason: "autonomy_budget_blocked" }
    }
  }

  try {
    // Reserve the canonical chat lane before any asynchronous adapter setup.
    // Every admitted inbound is projected in observation order even when a
    // newer turn supersedes its inference before provider work begins.
    return await withSharedTurnLock("bluebubbles", `${agentName}:${event.chat.sessionKey}`, async () => {
      options.lifecycleSignal?.throwIfAborted()
      // Fallback self-detection: BlueBubbles sometimes broadcasts a group-chat
      // outbound message back through the webhook with `isFromMe` missing/false.
      // Keep this group-only: stale ownHandles entries must not hide real DMs.
      if (await shouldFilterAgentSelfHandle(event, resolvedDeps)) {
        emitNervesEvent({
          level: "warn",
          component: "senses",
          event: "senses.bluebubbles_self_handle_filtered",
          message: "filtered bluebubbles event whose sender matched an agent-owned handle (isFromMe was missing/false)",
          meta: {
            messageGuid: event.messageGuid,
            kind: event.kind,
            senderExternalId: event.sender.externalId,
          },
        })
        return { handled: true, notifiedAgent: false, kind: event.kind, reason: "from_me" }
      }
      options.lifecycleSignal?.throwIfAborted()

      // ── Adapter setup: friend, session, content, callbacks ────────
      const store = resolvedDeps.createFriendStore()
      const resolver = resolvedDeps.createFriendResolver(store, resolveFriendParams(event))
      const baseContext = await resolver.resolve()
      options.lifecycleSignal?.throwIfAborted()
      const context = { ...baseContext, isGroupChat: event.chat.isGroup }
      const replyTarget = createReplyTargetController(event)
      const friendId = context.friend.id
      const sessPath = resolvedDeps.sessionPath(friendId, "bluebubbles", event.chat.sessionKey)
      try {
        findObsoleteBlueBubblesThreadSessions(sessPath)
      } catch (error) {
        emitNervesEvent({
          level: "warn",
          component: "senses",
          event: "senses.bluebubbles_thread_lane_cleanup_error",
          message: "failed to inspect obsolete bluebubbles thread-lane sessions",
          meta: {
            sessionPath: sessPath,
            reason: error instanceof Error ? error.message : String(error),
          },
        })
      }

      // Pre-load session inside the canonical turn lock so same-chat
      // deliveries cannot race on stale trunk state.
      const existing = resolvedDeps.loadSession(sessPath)
      const sessionMessages: OpenAI.ChatCompletionMessageParam[] =
        existing?.messages && existing.messages.length > 0
          ? structuredClone(existing.messages)
          : [{ role: "system", content: flattenSystemPrompt(await resolvedDeps.buildSystem("bluebubbles", {}, context)) }]

      // Record EARLY for audit and crash recovery. This is capture truth, not
      // a claim that the agent turn completed successfully.
      const inboundSource: BlueBubblesInboundSource =
        (options.semanticRecovery || source !== "webhook")
          && sessionLikelyContainsMessage(event, existing?.messages ?? sessionMessages)
          ? "recovery-bootstrap"
          : source
      recordBlueBubblesInbound(agentName, event, inboundSource)

      if (inboundSource === "recovery-bootstrap") {
        emitNervesEvent({
          component: "senses",
          event: "senses.bluebubbles_recovery_skip",
          message: "skipped bluebubbles recovery because the session already contains the message text",
          meta: {
            messageGuid: event.messageGuid,
            sessionKey: event.chat.sessionKey,
            source,
          },
        })
        recordProcessedBlueBubblesMessage(agentName, event, inboundSource, "session-bootstrap")
        return { handled: true, notifiedAgent: false, kind: event.kind, reason: "already_processed" }
      }

      // The inbound event is canonical truth as soon as its canonical lane is
      // reserved. Persist it before any supersedable orientation/provider work.
      const priorMessages = sessionMessages
      const userMessage: OpenAI.ChatCompletionMessageParam = {
        role: "user",
        content: buildInboundContent(event),
      }
      resolvedDeps.saveSession(
        sessPath,
        [...structuredClone(sessionMessages), structuredClone(userMessage)],
        existing?.lastUsage,
        existing?.state,
      )
      if (
        !await awaitDeliveryAdmission(options.latestTurnCapability)
        || !isLatestTurnCurrent(options.latestTurnCapability)
      ) {
        return { handled: true, notifiedAgent: false, kind: event.kind, reason: "superseded" }
      }
      options.lifecycleSignal?.throwIfAborted()

      const liveTurnId = beginBlueBubblesActiveTurn(agentName, event)
      activeTurnId = liveTurnId
      const mcpManager = await getSharedMcpManager() ?? undefined

      if (event.chat.isGroup) {
        await upsertGroupContextParticipants({
          store,
          participants: event.chat.participantHandles.map((externalId) => ({
            provider: "imessage-handle" as const,
            externalId,
          })),
          groupExternalId: resolveGroupExternalId(event),
        })
      }

      // Fetch the text of the message being replied to (if this is a threaded reply)
      const threadGuid = event.threadOriginatorGuid?.trim()
      let repliedToText: string | null = null
      if (threadGuid) {
        repliedToText = await client.getMessageText(threadGuid).catch(() => null)
        emitNervesEvent({
          component: "senses",
          event: "senses.bluebubbles_reply_context",
          message: repliedToText ? "fetched replied-to message text" : "could not fetch replied-to message text",
          meta: { threadGuid, hasText: !!repliedToText },
        })
      }
      // Shutdown can land during MCP/group/reply-context awaits above. Recheck
      // before the remaining synchronous setup installs its lifecycle listener.
      options.lifecycleSignal?.throwIfAborted()

      const orientationFrame = buildOrientationFrame({
        channel: "bluebubbles",
        messages: [...priorMessages, userMessage],
        currentUserMessages: [userMessage],
        structuredOutputs: existing?.structuredOutputs ?? [],
        source: buildBlueBubblesOrientationSource(
          event,
          priorMessages,
          options.orientationEvidence,
          options.orientationConversationKind,
          repliedToText,
        ),
      })
      if (!isLatestTurnCurrent(options.latestTurnCapability)) {
        return { handled: true, notifiedAgent: false, kind: event.kind, reason: "superseded" }
      }

      const turnStage = createBlueBubblesTurnStage(event.chat.sessionKey)

    let finalTransportInvoked = false
    let finalTransportAccepted = false
    const outboundRuntimeConfig = getBlueBubblesConfig()
    const callbacks = createBlueBubblesCallbacks(
      client,
      event.chat,
      replyTarget,
      event.chat.isGroup,
      () => noteBlueBubblesActiveTurnVisibleActivity(agentName, liveTurnId),
      {
        admitOutbound: async () => (
          !options.lifecycleSignal?.aborted
          && await awaitDeliveryAdmission(options.latestTurnCapability)
          && !options.lifecycleSignal?.aborted
        ),
        isOutboundCurrent: () => (
          !options.lifecycleSignal?.aborted
          && isLatestTurnCurrent(options.latestTurnCapability)
        ),
        isOutboundAdmittedNow: () => (
          !options.lifecycleSignal?.aborted
          && isDeliveryAdmittedNow(options.latestTurnCapability)
        ),
        onFinalTransportInvoked: () => {
          finalTransportInvoked = true
        },
        onFinalTransportAccepted: () => {
          finalTransportAccepted = true
        },
        durableOutbound: {
          agentRoot: getAgentRoot(),
          idempotencyKey: blueBubblesInboundReplyIdempotencyKey(
            options.currentIngressEvidence.captureKeyHash,
          ),
          attachment: {
            serverUrl: outboundRuntimeConfig.serverUrl,
            accountId: outboundRuntimeConfig.accountId,
          },
        },
      },
    )
    const controller = new AbortController()
    const lifecycleSignal = options.lifecycleSignal
    let rejectLifecycle!: (reason: unknown) => void
    const lifecyclePromise = new Promise<never>((_resolve, reject) => {
      rejectLifecycle = reject
    })
    let resolveSupersession!: (result: BlueBubblesHandleResult) => void
    const supersessionPromise = new Promise<BlueBubblesHandleResult>((resolve) => {
      resolveSupersession = resolve
    })
    const cancelForSupersession = (): void => {
      callbacks.cancelOutbound("superseded")
      if (!finalTransportInvoked) {
        controller.abort(options.latestTurnCapability.signal.reason)
        resolveSupersession({
          handled: true,
          notifiedAgent: false,
          kind: event.kind,
          reason: "superseded",
        })
      }
    }
    options.latestTurnCapability.signal.addEventListener("abort", cancelForSupersession, { once: true })
    const cancelForShutdown = (): void => {
      callbacks.cancelOutbound("shutdown")
      if (!finalTransportInvoked) {
        const reason = lifecycleSignal!.reason
        controller.abort(reason)
        rejectLifecycle(reason)
      }
    }
    lifecycleSignal?.addEventListener("abort", cancelForShutdown, { once: true })
    let timeoutTimer!: ReturnType<typeof setTimeout>
    let timeoutPromise!: Promise<BlueBubblesHandleResult>
    let resolveTimeout: ((result: BlueBubblesHandleResult) => void) | undefined
    let recoveryTimedOut = false

    // BB-specific tool context wrappers
    const summarize = createSummarize("human")

    const bbCapabilities = getChannelCapabilities("bluebubbles")
    const pendingDir = getPendingDir(resolvedDeps.getAgentName(), friendId, "bluebubbles", event.chat.sessionKey)

    // Buffer terminal errors so failover can suppress them.
    // If failover produces a message, the buffered error is skipped.
    // If failover doesn't fire, the buffered error is replayed.
    let bufferedTerminalError: Error | null = null
    /* v8 ignore start -- failover-aware error buffering @preserve */
    const failoverAwareCallbacks: typeof callbacks = {
      ...callbacks,
      onError(error: Error, severity: "transient" | "terminal"): void {
        if (severity === "terminal") {
          bufferedTerminalError = error
          return
        }
        callbacks.onError(error, severity)
      },
    }
    /* v8 ignore stop */

    try {
      // ── Compute trust gate context for group/acquaintance rules ─────
      // These store reads can block on filesystem I/O. Race them against the
      // runtime lifecycle before constructing the shared pipeline so a closed
      // worker cannot begin new durable or outward work after the read settles.
      const trustContext = await Promise.race([
        Promise.all([
          checkGroupHasFamilyMember(store, event),
          event.chat.isGroup
            ? Promise.resolve(false)
            : checkHasExistingGroupWithFamily(store, context.friend),
        ]),
        lifecyclePromise,
        supersessionPromise.then(() => null),
      ])
      if (trustContext === null) {
        return {
          handled: true,
          notifiedAgent: false,
          kind: event.kind,
          reason: "superseded",
        }
      }
      const [groupHasFamilyMember, hasExistingGroupWithFamily] = trustContext
      lifecycleSignal?.throwIfAborted()
      if (
        controller.signal.aborted
        || !isLatestTurnCurrent(options.latestTurnCapability)
      ) {
        return {
          handled: true,
          notifiedAgent: false,
          kind: event.kind,
          reason: "superseded",
        }
      }

      // ── Call shared pipeline ────────────────────────────────────────
      const timeoutMs = options.timeoutMs ?? BLUEBUBBLES_LIVE_TURN_TIMEOUT_MS
      timeoutPromise = new Promise<BlueBubblesHandleResult>((resolve) => {
        resolveTimeout = resolve
      })
      timeoutTimer = setTimeout(() => {
        const reason = new BlueBubblesRecoveryTurnTimeoutError(timeoutMs)
        recoveryTimedOut = true
        if (!finalTransportInvoked) {
          resolveTimeout?.({
            handled: true,
            notifiedAgent: false,
            kind: event.kind,
            reason: "turn_timeout",
          })
        }
        callbacks.cancelOutbound("turn_timeout")
        cancelLatestTurn(options.latestTurnCapability, "turn_timeout")
        if (!finalTransportInvoked) controller.abort(reason)
        emitNervesEvent({
          level: "warn",
          component: "senses",
          event: "senses.bluebubbles_turn_timeout",
          message: "bluebubbles turn timed out",
          meta: {
            messageGuid: event.messageGuid,
            sessionKey: event.chat.sessionKey,
            source,
            timeoutMs,
          },
        })
        emitNervesEvent({
          level: "warn",
          component: "senses",
          event: "senses.bluebubbles_timeout_notice_suppressed",
          message: "bluebubbles timeout notice suppressed from iMessage",
          meta: {
            messageGuid: event.messageGuid,
            sessionKey: event.chat.sessionKey,
            source,
            timeoutMs,
          },
        })
      }, timeoutMs)
      /* v8 ignore next -- timer handles expose unref only in some runtimes @preserve */
      if (typeof (timeoutTimer as { unref?: () => void }).unref === "function") {
        (timeoutTimer as { unref: () => void }).unref()
      }

      let preparedBlueBubblesContext: PreparedBlueBubblesContextMessages = {
        messages: [],
        contextPacketIds: [],
      }
      const turnPromise = handleInboundTurn({
        channel: "bluebubbles",
        sessionKey: event.chat.sessionKey,
        capabilities: bbCapabilities,
        messages: [userMessage],
        continuityIngressTexts: getBlueBubblesContinuityIngressTexts(event),
        friendResolver: { resolve: () => Promise.resolve(context) },
        sessionLoader: {
          loadOrCreate: () => Promise.resolve({
            messages: sessionMessages,
            sessionPath: sessPath,
            state: existing?.state,
            events: existing?.events,
            structuredOutputs: existing?.structuredOutputs,
          }),
        },
        pendingDir,
        friendStore: store,
        provider: "imessage-handle",
        externalId: event.sender.externalId,
        isGroupChat: event.chat.isGroup,
        groupHasFamilyMember,
        hasExistingGroupWithFamily,
        enforceTrustGate,
        drainPending,
        drainDeferredReturns: (deferredFriendId) => drainDeferredReturns(resolvedDeps.getAgentName(), deferredFriendId),
        prepareRunAgentOptions: async ({ messages = [], currentUserMessages = [], runAgentOptions }) => {
          preparedBlueBubblesContext = await buildBlueBubblesContextMessages({
            agentName,
            agentRoot: getAgentRoot(),
            client,
            event,
            knownMessages: messages,
          })
          const currentUserMessage = currentUserMessages.findLast((message) => message.role === "user")
            ?? messages.findLast((message) => message.role === "user")
          if (!currentUserMessage) return undefined
          Object.freeze(currentUserMessage)
          const { verifiedPredecessorMessage } = preparedBlueBubblesContext
          return {
            ...(preparedBlueBubblesContext.contextPacketIds.length > 0 ? {
              contextPacketIds: [
                ...(runAgentOptions.contextPacketIds ?? []),
                ...preparedBlueBubblesContext.contextPacketIds,
              ],
            } : {}),
            ...(preparedBlueBubblesContext.messages.length > 0 ? {
              promptOnlyEvidenceMessages: preparedBlueBubblesContext.messages,
            } : {}),
            requiredPromptEvidence: {
              currentUserMessage,
              ...(verifiedPredecessorMessage ? { verifiedPredecessorMessage } : {}),
            },
          }
        },
        runAgent: async (msgs, cb, channel, sig, opts) => {
          const { codingFeedback: _omittedCodingFeedback, ...safeToolContext } = opts?.toolContext ?? {}
          const requiredCurrent = opts?.requiredPromptEvidence?.currentUserMessage
          const providerMessages = insertEphemeralContextMessages(
            msgs.map((message) => message === requiredCurrent ? message : structuredClone(message)),
            [
              ...preparedBlueBubblesContext.messages,
              ...(preparedBlueBubblesContext.verifiedPredecessorMessage
                ? [preparedBlueBubblesContext.verifiedPredecessorMessage]
                : []),
            ],
            requiredCurrent,
          )
          let generatedMessages: OpenAI.ChatCompletionMessageParam[] = []
          const agentResult = await resolvedDeps.runAgent(providerMessages, cb, channel, sig, {
            ...opts,
            captureGeneratedMessages: (generated) => {
              opts?.captureGeneratedMessages?.(generated)
              generatedMessages = structuredClone(generated)
            },
            toolContext: {
              /* v8 ignore next -- default no-op signin; pipeline provides the real one @preserve */
              signin: async () => undefined,
              ...safeToolContext,
              summarize,
              bluebubblesReplyTarget: {
                setSelection: (selection: BlueBubblesReplyTargetSelection) => replyTarget.setSelection(selection),
              },
            },
          })
          if (generatedMessages.length > 0) {
            msgs.push(...generatedMessages)
          }
          return agentResult
        },
        postTurn: (turnMessages, sessionPathArg, usage, hooks, state) => {
          const prepared = resolvedDeps.postTurnTrim(turnMessages, usage, hooks)
          turnStage.postTurn = {
            sessionPath: sessionPathArg,
            prepared,
            usage,
            state,
          }
        },
        accumulateFriendTokens: async (tokenStore, tokenFriendId, usage) => {
          turnStage.tokens = {
            store: tokenStore,
            friendId: tokenFriendId,
            usage,
          }
        },
        signal: controller.signal,
        runAgentOptions: {
          mcpManager,
          orientationFrame,
          toolContext: {
            signin: async () => undefined,
            agentRoot: getAgentRoot(),
            currentIngressEvidence: options.currentIngressEvidence,
          },
        },
        callbacks: failoverAwareCallbacks,
        failoverState: turnStage.failoverState,
      })
      /* v8 ignore start -- detached late-rejection telemetry is asserted in timeout tests, but V8 does not reliably attribute Promise.catch callbacks @preserve */
      void turnPromise
        .catch((error) => {
          if (!recoveryTimedOut) return
          emitNervesEvent({
            level: "warn",
            component: "senses",
            event: "senses.bluebubbles_recovery_error",
            message: "bluebubbles recovery turn rejected after timeout",
            meta: {
              messageGuid: event.messageGuid,
              sessionKey: event.chat.sessionKey,
              source,
              reason: error instanceof Error ? error.message : String(error),
            },
          })
        })
      /* v8 ignore stop */
      const runTurn = (async (): Promise<BlueBubblesHandleResult> => {
        const result = await turnPromise
        if (recoveryTimedOut && !finalTransportInvoked) {
          emitNervesEvent({
            level: "warn",
            component: "senses",
            event: "senses.bluebubbles_timed_out_turn_suppressed",
            message: "suppressed late bluebubbles turn result after timeout",
            meta: {
              messageGuid: event.messageGuid,
              sessionKey: event.chat.sessionKey,
              source,
              reason: "turn completed after its final-transport boundary closed",
            },
          })
          return {
            handled: true,
            notifiedAgent: false,
            kind: event.kind,
            reason: "turn_timeout",
          }
        }

        /* v8 ignore start -- failover display + error replay @preserve */
        if (result.failoverMessage) {
          callbacks.onClearText?.()
          callbacks.onTextChunk(result.failoverMessage)
          bufferedTerminalError = null
        } else if (bufferedTerminalError) {
          callbacks.onError(bufferedTerminalError, "terminal")
          bufferedTerminalError = null
        }
        /* v8 ignore stop */

        // ── Handle gate result ────────────────────────────────────────

        let processedOutcome: "turn-complete" | "trust-gated" = "turn-complete"
        if (!result.gateResult.allowed) {
          callbacks.onClearText?.()
          if ("autoReply" in result.gateResult && result.gateResult.autoReply) {
            callbacks.onTextChunk(result.gateResult.autoReply)
          }
          processedOutcome = "trust-gated"
        }

        let delivery: BlueBubblesFinalTransportResult
        try {
          delivery = await callbacks.flush({ signal: controller.signal })
        } catch (error) {
          emitNervesEvent({
            level: "warn",
            component: "senses",
            event: "senses.bluebubbles_final_transport_failed",
            message: "bluebubbles final transport failed after invocation",
            meta: {
              messageGuid: event.messageGuid,
              sessionKey: event.chat.sessionKey,
              reason: error instanceof Error ? error.message : String(error),
            },
          })
          return {
            handled: true,
            notifiedAgent: false,
            kind: event.kind,
            reason: "delivery_failed",
          }
        }

        if (delivery.status !== "accepted" || !finalTransportAccepted) {
          return {
            handled: true,
            notifiedAgent: false,
            kind: event.kind,
            reason: !isLatestTurnCurrent(options.latestTurnCapability)
              ? "superseded"
              : "no_visible_reply",
          }
        }

        // Acceptance is the visibility boundary. Publish the terminal dedupe
        // receipt first, then project the private generated tail while this
        // chat's canonical lock remains held. Even if receipt publication
        // fails, make the best possible canonical projection before surfacing
        // the retained-claim failure. Ancillary accounting follows both.
        let receiptFailed = false
        let receiptFailure: unknown
        try {
          options.publishAcceptedReceipt()
        } catch (error) {
          receiptFailed = true
          receiptFailure = error
        }
        persistAcceptedBlueBubblesProjection({
          stage: turnStage,
          deps: resolvedDeps,
          event,
        })
        if (receiptFailed) throw receiptFailure
        promoteAcceptedBlueBubblesAncillaryState({
          stage: turnStage,
          deps: resolvedDeps,
          agentName,
          event,
          source,
          processedOutcome,
        })

        emitNervesEvent({
          component: "senses",
          event: "senses.bluebubbles_turn_end",
          message: "bluebubbles event handled",
          meta: {
            messageGuid: event.messageGuid,
            kind: event.kind,
            sessionKey: event.chat.sessionKey,
          },
        })

        return {
          handled: true,
          notifiedAgent: true,
          kind: event.kind,
        }
      })()
      /* v8 ignore start -- detached post-timeout suppression telemetry @preserve */
      void runTurn.catch((error) => {
        if (!recoveryTimedOut) return
        emitNervesEvent({
          level: "warn",
          component: "senses",
          event: "senses.bluebubbles_timed_out_turn_suppressed",
          message: "suppressed late bluebubbles turn result after timeout",
          meta: {
            messageGuid: event.messageGuid,
            sessionKey: event.chat.sessionKey,
            source,
            reason: error instanceof Error ? error.message : String(error),
          },
        })
      })
      /* v8 ignore stop */
      return await Promise.race([runTurn, timeoutPromise, supersessionPromise, lifecyclePromise])
    } finally {
      // If a terminal error was buffered and never replayed (e.g., handleInboundTurn threw),
      // replay it now so the user still sees the error.
      /* v8 ignore start -- error replay on throw: tested via BB error test @preserve */
      if (bufferedTerminalError) {
        callbacks.onError(bufferedTerminalError, "terminal")
        bufferedTerminalError = null
      }
      /* v8 ignore stop */
      clearTimeout(timeoutTimer)
      options.latestTurnCapability.signal.removeEventListener("abort", cancelForSupersession)
      lifecycleSignal?.removeEventListener("abort", cancelForShutdown)
      finishBlueBubblesActiveTurn(agentName, liveTurnId)
      activeTurnId = null
      await callbacks.finish({ timeoutMs: BLUEBUBBLES_CALLBACK_CLEANUP_TIMEOUT_MS })
    }
    })
  } finally {
    if (activeTurnId) finishBlueBubblesActiveTurn(agentName, activeTurnId)
  }
}

interface CapturedBlueBubblesSemanticEvent {
  status: "captured"
  capture: BlueBubblesSemanticCaptureV1
  normalized: BlueBubblesDirectionObservedEvent
  writeResult: BlueBubblesSemanticCaptureWriteResult
}

interface AuditOnlyBlueBubblesSemanticEvent {
  status: "audit_only"
  normalized: BlueBubblesNormalizedEvent
}

type BlueBubblesSemanticCaptureResult =
  | CapturedBlueBubblesSemanticEvent
  | AuditOnlyBlueBubblesSemanticEvent

function recordBlueBubblesAuditSidecar(
  agentName: string,
  event: BlueBubblesNormalizedEvent,
  source: BlueBubblesInboundSource,
  resolvedDeps: RuntimeDeps,
): void {
  if (event.kind === "message") {
    if (event.fromMe !== true) recordBlueBubblesInbound(agentName, event, source)
    return
  }
  try {
    resolvedDeps.recordMutation(agentName, event)
  } catch (error) {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.bluebubbles_mutation_log_error",
      message: "failed recording bluebubbles mutation sidecar",
      meta: {
        messageGuid: event.messageGuid,
        mutationType: event.mutationType,
        reason: error instanceof Error ? error.message : String(error),
      },
    })
  }
}

async function captureBlueBubblesSemanticEvent(
  normalized: BlueBubblesNormalizedEvent,
  resolvedDeps: RuntimeDeps,
  source: BlueBubblesInboundSource,
  observationReservation: BlueBubblesObservationReservation,
): Promise<BlueBubblesSemanticCaptureResult> {
  const agentName = resolvedDeps.getAgentName()
  const capturedAt = new Date().toISOString()
  if (!hasObservedBlueBubblesDirection(normalized)) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_direction_unobserved",
      message: "kept bluebubbles event audit-only because message direction was unobserved",
      meta: {
        messageGuid: normalized.messageGuid,
        kind: normalized.kind,
        source,
      },
    })
    recordBlueBubblesAuditSidecar(agentName, normalized, source, resolvedDeps)
    return { status: "audit_only", normalized }
  }
  const observed = normalized
  const cutover = initializeBlueBubblesSemanticCutover(agentName)

  let coordinateGeneration: number | undefined
  if (
    observed.kind === "mutation"
    && observed.mutationType === "reaction"
    && observed.reaction
    && !observed.revision
    && !Number.isFinite(observed.effectiveTimestamp)
    && observed.sender.observed === true
  ) {
    const identity = buildBlueBubblesSemanticIdentity({
      providerNamespace: cutover.providerNamespace,
      kind: "reaction",
      eventGuid: observed.messageGuid,
      targetGuid: observed.targetMessageGuid,
      actorExternalId: observed.sender.externalId,
      canonicalValue: observed.reaction.canonicalValue,
      canonicalAction: observed.reaction.action,
      coordinateGeneration: 0,
    })
    if (identity?.coordinateKey && identity.coordinateHash) {
      const coordinate = await allocateBlueBubblesReactionCoordinate(agentName, {
        coordinateKey: identity.coordinateKey,
        coordinateHash: identity.coordinateHash,
        canonicalAction: observed.reaction.action,
      })
      coordinateGeneration = coordinate.generation
    }
  }

  const capture = buildBlueBubblesSemanticCapture({
    cutover,
    capturedAt,
    observationEpoch: observationReservation.observationEpoch,
    observationOrdinal: observationReservation.ordinal,
    event: observed,
    targetAuthorship: null,
    coordinateGeneration,
  })
  if (!capture) {
    classifyBlueBubblesRecoveryRecord(observed, cutover)
    recordBlueBubblesAuditSidecar(agentName, observed, source, resolvedDeps)
    return { status: "audit_only", normalized: observed }
  }

  const writeResult = writeBlueBubblesSemanticCapture(agentName, capture)
  if (writeResult === "semantic_identity_collision") {
    throw new Error("semantic_capture_failed")
  }
  recordBlueBubblesAuditSidecar(agentName, observed, source, resolvedDeps)
  return {
    status: "captured",
    capture,
    normalized: observed,
    writeResult,
  }
}

function semanticCaptureChat(
  capture: BlueBubblesSemanticCaptureV1,
): BlueBubblesChatRef | null {
  const event = capture.event
  const sessionKey = event.sessionKey?.trim()
  const chatGuid = event.chatGuid?.trim() || undefined
  const chatIdentifier = event.chatIdentifier?.trim() || undefined
  if (!sessionKey) return null
  const fallbackSendTarget = sessionKey.startsWith("chat:")
    ? { kind: "chat_guid" as const, value: sessionKey.slice("chat:".length).trim() }
    : sessionKey.startsWith("chat_identifier:")
      ? { kind: "chat_identifier" as const, value: sessionKey.slice("chat_identifier:".length).trim() }
      : null
  const sendTarget = chatGuid
    ? { kind: "chat_guid" as const, value: chatGuid }
    : chatIdentifier
      ? { kind: "chat_identifier" as const, value: chatIdentifier }
      : fallbackSendTarget
  if (!sendTarget?.value) return null
  return {
    chatGuid,
    chatIdentifier,
    isGroup: Boolean(chatGuid?.includes(";+;") || event.participants.length > 1),
    sessionKey,
    sendTarget,
    participantHandles: event.participants.map((participant) => participant.externalId),
  }
}

function semanticCaptureRequiresRoutingRepair(capture: BlueBubblesSemanticCaptureV1): boolean {
  return !capture.event.chatGuid?.trim() && !capture.event.chatIdentifier?.trim()
}

function hasResolvedBlueBubblesRouting(event: BlueBubblesNormalizedEvent): boolean {
  return Boolean(event.chat.chatGuid?.trim() || event.chat.chatIdentifier?.trim())
}

function reserveBlueBubblesObservation(event: BlueBubblesNormalizedEvent): BlueBubblesObservationReservation {
  return reserveObservation({
    chatGuid: event.chat.chatGuid,
    chatIdentifier: event.chat.chatIdentifier,
  })
}

function groupBlueBubblesObservationsByLane<T extends {
  observationReservation: BlueBubblesObservationReservation
}>(candidates: readonly T[]): T[][] {
  let groups: Array<{ keys: Set<string>; candidates: T[] }> = []
  for (const candidate of candidates) {
    const keys = new Set(observationSchedulingKeys(candidate.observationReservation))
    const destination = { keys: new Set(keys), candidates: [candidate] }
    const independentGroups: typeof groups = []
    for (const group of groups) {
      const intersects = (
        keys.has("unresolved:*")
        || group.keys.has("unresolved:*")
        || [...keys].some((key) => group.keys.has(key))
      )
      if (!intersects) {
        independentGroups.push(group)
        continue
      }
      destination.candidates.push(...group.candidates)
      for (const key of group.keys) destination.keys.add(key)
    }
    groups = [...independentGroups, destination]
  }
  return groups.map((group) => group.candidates.sort((left, right) => (
    right.observationReservation.ordinal - left.observationReservation.ordinal
  )))
}

function canonicalizeBlueBubblesEvent(
  event: BlueBubblesDirectionObservedMessage,
  capability: BlueBubblesLatestTurnCapability,
): CanonicalBlueBubblesDirectionObservedMessage {
  const canonical = capability.canonicalChat
  const { chatIdentifier: _observedIdentifier, ...observedChat } = event.chat
  return {
    ...event,
    chat: {
      ...observedChat,
      chatGuid: canonical.chatGuid,
      ...(canonical.chatIdentifier ? { chatIdentifier: canonical.chatIdentifier } : {}),
      sessionKey: canonical.sessionKey,
      sendTarget: { kind: "chat_guid", value: canonical.chatGuid },
    },
  }
}

function isCaptureOnlyBlueBubblesMutation(
  capture: BlueBubblesSemanticCaptureV1,
): boolean {
  return capture.event.kind === "reaction"
    || capture.event.kind === "edit"
    || capture.event.kind === "unsend"
}

function isAuditOnlySemanticCapture(capture: BlueBubblesSemanticCaptureV1): boolean {
  return capture.event.kind === "read" || capture.event.kind === "delivery"
}

function semanticCaptureToNormalizedEvent(
  capture: BlueBubblesSemanticCaptureV1,
): BlueBubblesDirectionObservedEvent | null {
  const event = capture.event
  const messageGuid = event.eventGuid?.trim()
  const chat = semanticCaptureChat(capture)
  if (!messageGuid || !chat) return null
  const sender = {
    provider: "imessage-handle" as const,
    externalId: event.actor.externalId,
    rawId: event.actor.externalId,
    displayName: event.actor.displayName ?? event.actor.externalId,
    observed: true,
  }
  const timestamp = Date.parse(event.effectiveAt ?? capture.capturedAt)
  if (event.kind === "message") {
    const text = event.text ?? ""
    return {
      kind: "message",
      eventType: event.sourceEventType,
      messageGuid,
      timestamp,
      fromMe: event.fromMe,
      sender,
      chat,
      text,
      textForAgent: text,
      attachments: [],
      hasPayloadData: false,
      requiresRepair: true,
    }
  }

  const shouldNotifyAgent = event.kind === "reaction" || event.kind === "edit" || event.kind === "unsend"
  const targetMessageGuid = event.targetGuid ?? undefined
  const reaction = event.kind === "reaction" && event.canonicalAction && event.canonicalValue
    ? {
        ...describeBlueBubblesReaction(
          event.rawTransportValue ?? event.canonicalValue,
          event.rawTransportValue ?? event.canonicalValue,
        ),
        canonicalValue: event.canonicalValue,
        action: event.canonicalAction,
      }
    : undefined
  const textForAgent = reaction
    ? renderBlueBubblesReactionText(reaction, { guid: targetMessageGuid })
    : event.kind === "edit"
      ? event.text ? `edited message: ${event.text}` : "edited a message"
      : event.kind === "unsend"
        ? "unsent a message"
        : event.kind === "read"
          ? "message marked as read"
          : "message marked as delivered"
  return {
    kind: "mutation",
    eventType: event.sourceEventType,
    mutationType: event.kind,
    messageGuid,
    targetMessageGuid,
    timestamp,
    fromMe: event.fromMe,
    sender,
    chat,
    shouldNotifyAgent,
    textForAgent,
    requiresRepair: true,
    ...(reaction ? { reaction } : {}),
    ...(event.kind === "edit" && event.text !== null ? { editedText: event.text } : {}),
    ...(event.revision ? { revision: event.revision } : {}),
    ...(event.effectiveAt ? { effectiveTimestamp: Date.parse(event.effectiveAt) } : {}),
    ...(event.kind === "unsend" && event.effectiveAt
      ? { retractionTimestamp: Date.parse(event.effectiveAt) }
      : {}),
  }
}

export function seedBlueBubblesStartupSemanticObservations(
  deps: Partial<RuntimeDeps> = {},
): number {
  const resolvedDeps = { ...defaultDeps, ...deps }
  const agentName = resolvedDeps.getAgentName()
  const cutover = initializeBlueBubblesSemanticCutover(agentName)
  let seeded = 0

  for (const capture of listPendingBlueBubblesSemanticCaptures(agentName)
    .sort(compareBlueBubblesSemanticCaptureOrder)) {
    const disposition = classifyBlueBubblesRecoveryRecord(capture, cutover)
    if (disposition.disposition === "audit_only") continue
    const normalized = semanticCaptureToNormalizedEvent(capture)
    if (!normalized) continue

    const generation = adoptBlueBubblesSemanticObservation(
      capture.keyHash,
      reserveBlueBubblesObservation(normalized),
      false,
    )
    // Startup seeding runs synchronously before listen. Retain each fence so
    // persisted pre-restart observations remain causally older than any live
    // webhook accepted by this process and can reuse the same generation when
    // the delayed recovery pass begins.
    suspendBlueBubblesSemanticObservation(generation)
    seeded += 1
  }
  return seeded
}

interface CapturedReactionClassification {
  decision: BlueBubblesReactionPolicyDecision
}

async function classifyCapturedBlueBubblesReaction(
  captured: CapturedBlueBubblesSemanticEvent,
): Promise<CapturedReactionClassification | null> {
  const event = captured.capture.event
  if (event.kind !== "reaction" || !event.canonicalAction || !event.canonicalValue) return null

  const input = {
    fromMe: event.fromMe,
    action: event.canonicalAction,
    canonicalValue: event.canonicalValue,
  }
  return { decision: classifyBlueBubblesReaction(input) }
}

interface BlueBubblesSemanticHandledDisposition {
  outcome: BlueBubblesSemanticHandledOutcome
  detailCode: string | null
}

function captureOnlyHandledDisposition(
  capture: BlueBubblesSemanticCaptureV1,
  reactionDecision: BlueBubblesReactionPolicyDecision | null,
): BlueBubblesSemanticHandledDisposition {
  if (capture.event.kind !== "reaction") {
    return {
      outcome: capture.event.kind === "edit" ? "edit_capture_only" : "unsend_capture_only",
      detailCode: null,
    }
  }
  const classifiedOutcome = reactionDecision!.outcome
  if (classifiedOutcome === "capture_only_negative" || classifiedOutcome === "capture_only_question") {
    return {
      outcome: "capture_only_unknown",
      detailCode: classifiedOutcome,
    }
  }
  return { outcome: classifiedOutcome, detailCode: null }
}

function auditOnlyHandledOutcome(
  kind: "read" | "delivery",
): BlueBubblesSemanticHandledOutcome {
  return kind === "read" ? "read_audit_only" : "delivery_audit_only"
}

function writeCapturedBlueBubblesHandled(
  agentName: string,
  capture: BlueBubblesSemanticCaptureV1,
  outcome: BlueBubblesSemanticHandledOutcome,
  detailCode: string | null = null,
): void {
  const handledResult = writeBlueBubblesSemanticHandled(agentName, {
    schemaVersion: 1,
    canonicalKey: capture.canonicalKey,
    keyHash: capture.keyHash,
    handledAt: new Date().toISOString(),
    outcome,
    detailCode,
  })
  if (handledResult === "semantic_handled_collision") {
    throw new Error("semantic_handled_collision")
  }
}

function blueBubblesInboundReplyIdempotencyKey(captureKeyHash: string): string {
  return `bluebubbles-inbound-reply:${captureKeyHash}`
}

function blueBubblesRecoveredOutboundOutcome(
  record: BlueBubblesOutboundRecord,
): BlueBubblesSemanticHandledOutcome {
  return BLUEBUBBLES_VISIBLE_OUTBOUND_STATUSES.has(record.status)
    ? "message_completed"
    : "message_observed"
}

async function handleCapturedBlueBubblesSemanticEvent(
  captured: CapturedBlueBubblesSemanticEvent,
  resolvedDeps: RuntimeDeps,
  source: BlueBubblesInboundSource,
  options: BlueBubblesHandleOptions & {
    observationReservation: BlueBubblesObservationReservation
  },
): Promise<BlueBubblesHandleResult> {
  options.lifecycleSignal?.throwIfAborted()
  const agentName = resolvedDeps.getAgentName()
  const identity = {
    canonicalKey: captured.capture.canonicalKey,
    keyHash: captured.capture.keyHash,
  }
  const generation = adoptBlueBubblesSemanticObservation(
    identity.keyHash,
    options.observationReservation,
    true,
  )
  const semanticHandling = await acquireBlueBubblesSemanticHandlingSlot(
    identity.keyHash,
    generation,
  )
  if (semanticHandling.status === "handled_by_owner") {
    return {
      handled: true,
      notifiedAgent: false,
      kind: captured.normalized.kind,
      reason: "already_processed",
    }
  }
  const reservation = semanticHandling.reservation
  let claim: Awaited<ReturnType<typeof acquireBlueBubblesSemanticClaim>>
  try {
    options.lifecycleSignal?.throwIfAborted()
    claim = await acquireBlueBubblesSemanticClaim(agentName, identity)
  } catch (error) {
    releaseBlueBubblesSemanticHandlingSlot(identity.keyHash, semanticHandling.slot, "retryable")
    throw error
  }
  if (claim.status === "already_handled") {
    releaseBlueBubblesSemanticHandlingSlot(identity.keyHash, semanticHandling.slot, "terminal")
    return {
      handled: true,
      notifiedAgent: false,
      kind: captured.normalized.kind,
      reason: "already_processed",
    }
  }
  if (claim.status === "timeout") {
    releaseBlueBubblesSemanticHandlingSlot(identity.keyHash, semanticHandling.slot, "retryable")
    return {
      handled: false,
      notifiedAgent: false,
      kind: captured.normalized.kind,
      reason: "semantic_claim_timeout",
    }
  }

  let latestTurnCapability: BlueBubblesLatestTurnCapability | null = null
  let semanticHandlingCompleted = false
  let retainSemanticClaim = false
  let acceptedReceiptPublished = false
  const publishTerminalReceipt = (
    outcome: BlueBubblesSemanticHandledOutcome,
    detailCode: string | null = null,
  ): void => {
    try {
      writeCapturedBlueBubblesHandled(
        agentName,
        captured.capture,
        outcome,
        detailCode,
      )
    } catch (error) {
      // A missing terminal receipt must never reopen this semantic event. Keep
      // the durable claim live so recovery cannot resurrect a canceled turn or
      // duplicate a reply whose transport is already externally visible.
      retainSemanticClaim = true
      semanticHandlingCompleted = true
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.bluebubbles_terminal_receipt_failed",
        message: "bluebubbles event could not publish its terminal semantic receipt",
        meta: {
          messageGuid: captured.normalized.messageGuid,
          keyHash: captured.capture.keyHash,
          outcome,
          reason: error instanceof Error ? error.message : String(error),
        },
      })
      throw error
    }
  }
  const publishAcceptedReceipt = (): void => {
    if (acceptedReceiptPublished) return
    publishTerminalReceipt("message_completed")
    acceptedReceiptPublished = true
  }
  try {
    options.lifecycleSignal?.throwIfAborted()
    const reactionClassification = await classifyCapturedBlueBubblesReaction(captured)
    options.lifecycleSignal?.throwIfAborted()
    const reactionDecision = reactionClassification?.decision ?? null
    if (captured.capture.event.fromMe) {
      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_from_me_ignored",
        message: "ignored from-me bluebubbles event",
        meta: {
          messageGuid: captured.normalized.messageGuid,
          kind: captured.normalized.kind,
        },
      })
      if (captured.normalized.chat.isGroup) {
        recordDiscoveredOwnHandle(captured.normalized.sender.externalId)
      }
      const result: BlueBubblesHandleResult = {
        handled: true,
        notifiedAgent: false,
        kind: captured.normalized.kind,
        reason: "from_me",
      }
      publishTerminalReceipt("ignored_self")
      semanticHandlingCompleted = true
      return result
    }

    const durableOutbound = readBlueBubblesOutboundRecordByIdempotencyKey(
      getAgentRoot(),
      blueBubblesInboundReplyIdempotencyKey(captured.capture.keyHash),
    )
    if (durableOutbound) {
      const outcome = blueBubblesRecoveredOutboundOutcome(durableOutbound)
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_inbound_reply_recovery_suppressed",
        message: "suppressed bluebubbles inbound reply recovery at its durable send boundary",
        meta: {
          messageGuid: captured.normalized.messageGuid,
          recordId: durableOutbound.recordId,
          outboundStatus: durableOutbound.status,
          outcome,
        },
      })
      publishTerminalReceipt(outcome)
      semanticHandlingCompleted = true
      return {
        handled: true,
        notifiedAgent: false,
        kind: captured.normalized.kind,
        reason: "already_processed",
      }
    }

    let handledOutcome: BlueBubblesSemanticHandledOutcome = "message_observed"
    let result: BlueBubblesHandleResult
    if (isAuditOnlySemanticCapture(captured.capture)) {
      handledOutcome = auditOnlyHandledOutcome(captured.capture.event.kind as "read" | "delivery")
      result = {
        handled: true,
        notifiedAgent: false,
        kind: captured.normalized.kind,
        reason: "mutation_state_only",
      }
    } else {
      const captureOnlyMutation = isCaptureOnlyBlueBubblesMutation(captured.capture)
      const repaired = captureOnlyMutation && captured.normalized.chat.chatGuid?.trim()
        ? captured.normalized
        : await resolvedDeps.createClient().repairEvent(captured.normalized)
      options.lifecycleSignal?.throwIfAborted()
      if (
        semanticCaptureRequiresRoutingRepair(captured.capture)
        && !hasResolvedBlueBubblesRouting(repaired)
      ) {
        throw new Error("semantic_capture_routing_invalid")
      }
      const identityGroundedRepaired: BlueBubblesDirectionObservedEvent = {
        ...repaired,
        fromMe: captured.normalized.fromMe,
        sender: captured.normalized.sender,
      }
      const promotion = promoteLatestTurn(reservation, {
        chatGuid: identityGroundedRepaired.chat.chatGuid,
        chatIdentifier: identityGroundedRepaired.chat.chatIdentifier,
      }, {
        allowSameGenerationRetry: semanticHandling.allowSameGenerationRetry,
      })
      if (promotion.status !== "promoted") {
        if (!captureOnlyMutation && promotion.status === "unresolved") {
          throw new Error("semantic_capture_routing_invalid")
        }
        const disposition = captureOnlyMutation
          ? captureOnlyHandledDisposition(captured.capture, reactionDecision)
          : { outcome: "message_observed" as const, detailCode: null }
        publishTerminalReceipt(disposition.outcome, disposition.detailCode)
        semanticHandlingCompleted = true
        return {
          handled: true,
          notifiedAgent: false,
          kind: captured.normalized.kind,
          reason: captureOnlyMutation ? "mutation_state_only" : "superseded",
        }
      }
      latestTurnCapability = promotion.capability
      if (captureOnlyMutation) {
        const disposition = captureOnlyHandledDisposition(captured.capture, reactionDecision)
        publishTerminalReceipt(disposition.outcome, disposition.detailCode)
        semanticHandlingCompleted = true
        return {
          handled: true,
          notifiedAgent: false,
          kind: captured.normalized.kind,
          reason: "mutation_state_only",
        }
      }
      if (identityGroundedRepaired.kind === "mutation") {
        const outcome = auditOnlyHandledOutcome(identityGroundedRepaired.mutationType as "read" | "delivery")
        publishTerminalReceipt(outcome)
        semanticHandlingCompleted = true
        return {
          handled: true,
          notifiedAgent: false,
          kind: captured.normalized.kind,
          reason: "mutation_state_only",
        }
      }
      const canonicalEvent = canonicalizeBlueBubblesEvent(
        identityGroundedRepaired,
        latestTurnCapability,
      )

      const capturedOptions: CapturedBlueBubblesHandleOptions = {
        ...options,
        latestTurnCapability,
        currentIngressEvidence: Object.freeze({
          schemaVersion: 1,
          provider: "bluebubbles",
          captureKeyHash: captured.capture.keyHash,
        }),
        orientationEvidence: captured.capture.event,
        orientationConversationKind: canonicalEvent.chat.isGroup ? "group" : "one_to_one",
        publishAcceptedReceipt,
      }
      result = await handleBlueBubblesNormalizedEvent(canonicalEvent, resolvedDeps, source, capturedOptions)
      handledOutcome = result.notifiedAgent ? "message_completed" : "message_observed"
    }
    if (result.notifiedAgent) {
      publishAcceptedReceipt()
    } else {
      publishTerminalReceipt(handledOutcome)
    }
    semanticHandlingCompleted = true
    return result
  } finally {
    if (latestTurnCapability) finishLatestTurn(latestTurnCapability)
    try {
      if (!retainSemanticClaim) {
        releaseBlueBubblesSemanticClaim(agentName, claim)
      }
    } finally {
      releaseBlueBubblesSemanticHandlingSlot(
        identity.keyHash,
        semanticHandling.slot,
        retainSemanticClaim
          ? "retained"
          : semanticHandlingCompleted ? "terminal" : "retryable",
      )
    }
  }
}

export async function handleBlueBubblesEvent(
  payload: unknown,
  deps: Partial<RuntimeDeps> = {},
): Promise<BlueBubblesHandleResult> {
  const resolvedDeps = { ...defaultDeps, ...deps }
  let normalized: BlueBubblesNormalizedEvent
  try {
    normalized = normalizeBlueBubblesEvent(payload)
  } catch (error) {
    if (error instanceof BlueBubblesIgnoredEventError) {
      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_event_skipped",
        message: "skipped ignorable bluebubbles event",
        meta: {
          eventType: error.eventType,
        },
      })
      return {
        handled: true,
        notifiedAgent: false,
        reason: "ignored",
      }
    }
    throw error
  }

  const observationReservation = reserveBlueBubblesObservation(normalized)
  let captured: BlueBubblesSemanticCaptureResult
  try {
    captured = await captureBlueBubblesSemanticEvent(
      normalized,
      resolvedDeps,
      "webhook",
      observationReservation,
    )
  } catch (error) {
    clearPending(observationReservation)
    throw error
  }
  if (captured.status === "audit_only") {
    clearPending(observationReservation)
    return { handled: true, notifiedAgent: false, kind: normalized.kind, reason: "ignored" }
  }
  return handleCapturedBlueBubblesSemanticEvent(captured, resolvedDeps, "webhook", {
    observationReservation,
  })
}

export interface BlueBubblesRecoveryResult {
  recovered: number
  skipped: number
  pending: number
  failed: number
}

export interface BlueBubblesCatchUpResult {
  inspected: number
  recovered: number
  skipped: number
  queued?: number
  failed: number
  lastRecoveredMessageGuid?: string
}

function parseTimestampMs(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function resolveBlueBubblesCatchUpSince(previousState: BlueBubblesRuntimeState, nowMs = Date.now()): number {
  if (previousState.upstreamStatus === "error") {
    return nowMs - BLUEBUBBLES_RECOVERY_CATCHUP_LOOKBACK_MS
  }

  const lastCheckedAt = parseTimestampMs(previousState.lastCheckedAt)
  if (lastCheckedAt !== null) {
    return Math.max(0, lastCheckedAt - BLUEBUBBLES_HEALTHY_CATCHUP_OVERLAP_MS)
  }

  return nowMs - BLUEBUBBLES_FIRST_CATCHUP_LOOKBACK_MS
}

function formatBlueBubblesRuntimeDetail(
  queued: number,
  failed: number,
  active: ReturnType<typeof snapshotBlueBubblesActiveTurns>,
): string {
  if (active.stalledTurnCount > 0) {
    return `iMessage live turn appears stalled; ${active.stalledTurnCount} active turn(s) older than ${BLUEBUBBLES_LIVE_TURN_STALLED_MS}ms`
  }
  if (active.activeTurnCount > 0) return `upstream reachable; ${active.activeTurnCount} live turn(s) active`
  if (queued > 0) return `upstream reachable but iMessage is not caught up; ${queued} recovery item(s) queued`
  if (failed > 0) return `${failed} message(s) unrecoverable this cycle; upstream ok`
  return "upstream reachable"
}

function blueBubblesPendingRecoverySnapshot(agentName: string, nowMs = Date.now()): {
  pendingRecoveryCount: number
  oldestPendingRecoveryAt?: string
  oldestPendingRecoveryAgeMs?: number
} {
  const pendingEntries = listPendingBlueBubblesSemanticCaptures(agentName)
  const pendingRecordedAt = pendingEntries
    .map((entry) => entry.capturedAt)
    .map((value) => ({ value, ms: Date.parse(value) }))
    .filter((entry): entry is { value: string; ms: number } => Number.isFinite(entry.ms))
    .sort((left, right) => left.ms - right.ms)

  const oldest = pendingRecordedAt[0]
  return {
    pendingRecoveryCount: pendingEntries.length,
    oldestPendingRecoveryAt: oldest?.value,
    oldestPendingRecoveryAgeMs: oldest ? Math.max(0, nowMs - oldest.ms) : undefined,
  }
}

async function syncBlueBubblesRuntime(
  deps: Partial<RuntimeDeps> = {},
  options: {
    catchUpObservationBatch?: BlueBubblesObservationBatch
    lifecycleSignal?: AbortSignal
  } = {},
): Promise<void> {
  options.lifecycleSignal?.throwIfAborted()
  const resolvedDeps = { ...defaultDeps, ...deps }
  const agentName = resolvedDeps.getAgentName()
  // Allocate before the first health-probe await. Any live webhook accepted
  // while that probe is pending must remain causally newer than this pass.
  const catchUpObservationBatch = options.catchUpObservationBatch ?? beginObservationBatch(
    BLUEBUBBLES_CATCHUP_PAGE_SIZE * BLUEBUBBLES_CATCHUP_MAX_PAGES,
  )
  pruneBlueBubblesSemanticObservationGenerations()
  const client = resolvedDeps.createClient()
  const checkedAt = new Date().toISOString()
  const previousState = readBlueBubblesRuntimeState(agentName)

  try {
    await client.checkHealth()
    options.lifecycleSignal?.throwIfAborted()
    const pendingBeforeCatchup = blueBubblesPendingRecoverySnapshot(agentName)
    const activeBeforeCatchup = snapshotBlueBubblesActiveTurns(agentName, BLUEBUBBLES_LIVE_TURN_STALLED_MS)
    writeBlueBubblesRuntimeState(agentName, {
      upstreamStatus: "ok",
      detail: "upstream reachable; recovery pass running",
      lastCheckedAt: checkedAt,
      proofMethod: "bluebubbles.checkHealth",
      ...pendingBeforeCatchup,
      ...activeBeforeCatchup,
      lastRecoveredAt: previousState.lastRecoveredAt,
      lastRecoveredMessageGuid: previousState.lastRecoveredMessageGuid,
    })
    const catchUp = await catchUpMissedBlueBubblesMessages(resolvedDeps, previousState, {
      processTurns: false,
      observationBatch: catchUpObservationBatch,
      lifecycleSignal: options.lifecycleSignal,
    })
    options.lifecycleSignal?.throwIfAborted()
    const failed = catchUp.failed
    const pendingAfterCatchup = blueBubblesPendingRecoverySnapshot(agentName)
    const activeAfterCatchup = snapshotBlueBubblesActiveTurns(agentName, BLUEBUBBLES_LIVE_TURN_STALLED_MS)
    const queued = pendingAfterCatchup.pendingRecoveryCount
    // upstreamStatus reflects whether BlueBubbles itself and the local bridge
    // can answer webhook traffic. The daemon status layer treats
    // pendingRecoveryCount as unhealthy for user-facing iMessage reachability,
    // while this field stays scoped to upstream transport reachability.
    writeBlueBubblesRuntimeState(agentName, {
      upstreamStatus: "ok",
      detail: formatBlueBubblesRuntimeDetail(queued, failed, activeAfterCatchup),
      lastCheckedAt: checkedAt,
      proofMethod: "bluebubbles.checkHealth",
      ...pendingAfterCatchup,
      ...activeAfterCatchup,
      pendingRecoveryCount: queued,
      failedRecoveryCount: failed,
      lastRecoveredAt: previousState.lastRecoveredAt,
      lastRecoveredMessageGuid: previousState.lastRecoveredMessageGuid,
    })
  } catch (error) {
    if (options.lifecycleSignal?.aborted) return
    writeBlueBubblesRuntimeState(agentName, {
      upstreamStatus: "error",
      detail: error instanceof Error ? error.message : String(error),
      lastCheckedAt: checkedAt,
      proofMethod: "bluebubbles.checkHealth",
      ...blueBubblesPendingRecoverySnapshot(agentName),
      ...snapshotBlueBubblesActiveTurns(agentName, BLUEBUBBLES_LIVE_TURN_STALLED_MS),
      failedRecoveryCount: 0,
    })
  }
}

export interface BlueBubblesQueuedRecoveryResult {
  recovered: number
  skipped: number
  failed: number
  pendingRecoveryCount: number
}

export async function recoverQueuedBlueBubblesMessages(
  deps: Partial<RuntimeDeps> = {},
  options: { lifecycleSignal?: AbortSignal } = {},
): Promise<BlueBubblesQueuedRecoveryResult> {
  options.lifecycleSignal?.throwIfAborted()
  const resolvedDeps = { ...defaultDeps, ...deps }
  const agentName = resolvedDeps.getAgentName()
  const previousState = readBlueBubblesRuntimeState(agentName)
  const initialPending = blueBubblesPendingRecoverySnapshot(agentName).pendingRecoveryCount
  if (initialPending === 0) {
    return { recovered: 0, skipped: 0, failed: 0, pendingRecoveryCount: 0 }
  }

  const captured = await recoverCapturedBlueBubblesInboundMessages(resolvedDeps, options)
  options.lifecycleSignal?.throwIfAborted()
  const recovery = await recoverMissedBlueBubblesMessages(resolvedDeps)
  options.lifecycleSignal?.throwIfAborted()
  const pendingSnapshot = blueBubblesPendingRecoverySnapshot(agentName)
  const pendingRecoveryCount = pendingSnapshot.pendingRecoveryCount
  const failed = captured.failed + recovery.failed
  const recovered = captured.recovered + recovery.recovered
  const skipped = captured.skipped + recovery.skipped
  const checkedAt = new Date().toISOString()

  try {
    await resolvedDeps.createClient().checkHealth()
    options.lifecycleSignal?.throwIfAborted()
    const activeSnapshot = snapshotBlueBubblesActiveTurns(agentName, BLUEBUBBLES_LIVE_TURN_STALLED_MS)
    writeBlueBubblesRuntimeState(agentName, {
      upstreamStatus: "ok",
      detail: formatBlueBubblesRuntimeDetail(pendingRecoveryCount, failed, activeSnapshot),
      lastCheckedAt: checkedAt,
      proofMethod: "bluebubbles.checkHealth",
      ...pendingSnapshot,
      ...activeSnapshot,
      failedRecoveryCount: failed,
      lastRecoveredAt: recovered > 0 ? checkedAt : previousState.lastRecoveredAt,
      lastRecoveredMessageGuid: previousState.lastRecoveredMessageGuid,
    })
  } catch (error) {
    if (options.lifecycleSignal?.aborted) throw options.lifecycleSignal.reason
    writeBlueBubblesRuntimeState(agentName, {
      upstreamStatus: "error",
      detail: error instanceof Error ? error.message : String(error),
      lastCheckedAt: checkedAt,
      proofMethod: "bluebubbles.checkHealth",
      ...pendingSnapshot,
      ...snapshotBlueBubblesActiveTurns(agentName, BLUEBUBBLES_LIVE_TURN_STALLED_MS),
      failedRecoveryCount: failed,
      lastRecoveredAt: recovered > 0 ? checkedAt : previousState.lastRecoveredAt,
      lastRecoveredMessageGuid: previousState.lastRecoveredMessageGuid,
    })
  }

  return { recovered, skipped, failed, pendingRecoveryCount }
}

export async function catchUpMissedBlueBubblesMessages(
  deps: Partial<RuntimeDeps> = {},
  previousState?: BlueBubblesRuntimeState,
  options: {
    processTurns?: boolean
    observationBatch?: BlueBubblesObservationBatch
    lifecycleSignal?: AbortSignal
  } = {},
): Promise<BlueBubblesCatchUpResult> {
  options.lifecycleSignal?.throwIfAborted()
  const resolvedDeps = { ...defaultDeps, ...deps }
  const agentName = resolvedDeps.getAgentName()
  const client = resolvedDeps.createClient()
  const result: BlueBubblesCatchUpResult = { inspected: 0, recovered: 0, skipped: 0, failed: 0 }
  const state = previousState ?? readBlueBubblesRuntimeState(agentName)
  const cutover = initializeBlueBubblesSemanticCutover(agentName)
  const catchUpSince = Math.max(
    resolveBlueBubblesCatchUpSince(state),
    Date.parse(cutover.effectiveAt),
  )
  const processTurns = options.processTurns !== false

  /* v8 ignore next -- older injected test doubles may omit the catch-up query method */
  if (!client.listRecentMessages) return result

  emitNervesEvent({
    component: "senses",
    event: "senses.bluebubbles_catchup_start",
    message: "bluebubbles upstream catch-up pass started",
    meta: {
      since: new Date(catchUpSince).toISOString(),
      pageSize: BLUEBUBBLES_CATCHUP_PAGE_SIZE,
      maxPages: BLUEBUBBLES_CATCHUP_MAX_PAGES,
    },
  })

  type PreparedCatchUpCandidate =
    | { status: "skip"; event: BlueBubblesNormalizedMessage }
    | {
        status: "ready"
        event: BlueBubblesNormalizedMessage
        observationReservation: BlueBubblesObservationReservation
      }
  const preparedCandidates: PreparedCatchUpCandidate[] = []
  const seenMessageGuids = new Set<string>()
  const observationBatch = options.observationBatch ?? beginObservationBatch(
    BLUEBUBBLES_CATCHUP_PAGE_SIZE * BLUEBUBBLES_CATCHUP_MAX_PAGES,
  )
  for (let page = 0; page < BLUEBUBBLES_CATCHUP_MAX_PAGES; page++) {
    let pageEvents: BlueBubblesNormalizedEvent[]
    try {
      pageEvents = await client.listRecentMessages({
        limit: BLUEBUBBLES_CATCHUP_PAGE_SIZE,
        offset: page * BLUEBUBBLES_CATCHUP_PAGE_SIZE,
        beforeTimestamp: observationBatch.beforeTimestamp,
      })
    } catch (error) {
      if (options.lifecycleSignal?.aborted) throw options.lifecycleSignal.reason
      result.failed++
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_catchup_error",
        message: "bluebubbles upstream catch-up query failed",
        meta: {
          offset: page * BLUEBUBBLES_CATCHUP_PAGE_SIZE,
          reason: error instanceof Error ? error.message : String(error),
        },
      })
      break
    }
    options.lifecycleSignal?.throwIfAborted()

    const pageMessages = pageEvents
      .filter((event): event is BlueBubblesNormalizedMessage => event.kind === "message")
      .sort((left, right) => right.timestamp - left.timestamp)
    for (let pageIndex = 0; pageIndex < pageMessages.length; pageIndex++) {
      const event = pageMessages[pageIndex]
      if (seenMessageGuids.has(event.messageGuid)) continue
      seenMessageGuids.add(event.messageGuid)
      if (
        event.fromMe
        || event.timestamp < catchUpSince
        || (Number.isFinite(event.timestamp) && event.timestamp > observationBatch.beforeTimestamp)
      ) {
        preparedCandidates.push({ status: "skip", event })
        continue
      }
      // The bounded ordinal range and upstream snapshot were fixed before the
      // first query. Each returned page can therefore publish its fences
      // before the next await, while later ingress stays outside this pass.
      preparedCandidates.push({
        status: "ready",
        event,
        observationReservation: reserveObservationFromBatch(
          observationBatch,
          page * BLUEBUBBLES_CATCHUP_PAGE_SIZE + pageIndex,
          {
            chatGuid: event.chat.chatGuid,
            chatIdentifier: event.chat.chatIdentifier,
          },
        ),
      })
    }
    if (pageEvents.length < BLUEBUBBLES_CATCHUP_PAGE_SIZE) break

    const oldestMessageTimestamp = pageMessages
      .reduce((oldest, event) => Math.min(oldest, event.timestamp), Number.POSITIVE_INFINITY)
    if (oldestMessageTimestamp <= catchUpSince) break

    if (page === BLUEBUBBLES_CATCHUP_MAX_PAGES - 1) {
      result.failed++
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_catchup_error",
        message: "bluebubbles upstream catch-up reached the bounded page limit",
        meta: {
          inspectedPages: BLUEBUBBLES_CATCHUP_MAX_PAGES,
          reason: "catch-up page limit reached before the outage window cutoff",
        },
      })
    }
  }

  for (const prepared of preparedCandidates) {
    result.inspected++
    if (prepared.status === "skip") {
      result.skipped++
    }
  }
  const readyCandidates = preparedCandidates.filter((prepared): prepared is Extract<
    PreparedCatchUpCandidate,
    { status: "ready" }
  > => prepared.status === "ready")
  let lastRecoveredOrdinal = -1

  await Promise.all(groupBlueBubblesObservationsByLane(readyCandidates).map(async (lane) => {
    for (const prepared of lane) {
      const { event, observationReservation } = prepared
      let semanticGenerationOwned = false

      try {
        options.lifecycleSignal?.throwIfAborted()
        const captured = await captureBlueBubblesSemanticEvent(
          event,
          resolvedDeps,
          "upstream-catchup",
          observationReservation,
        )
        if (captured.status === "audit_only") {
          clearPending(observationReservation)
          result.skipped++
          continue
        }

        if (!processTurns) {
          const generation = adoptBlueBubblesSemanticObservation(
            captured.capture.keyHash,
            observationReservation,
            false,
          )
          semanticGenerationOwned = true
          if (captured.writeResult === "semantic_capture_duplicate") {
            if (!activeSemanticHandlingSlots.has(captured.capture.keyHash)) {
              suspendBlueBubblesSemanticObservation(generation)
            }
            result.skipped++
          } else {
            // Runtime sync only captures work for the delayed recovery pass,
            // but its original generation must revoke older work now and be
            // reused by the queued recovery pass after any intervening turn.
            const promotion = promoteLatestTurn(generation.reservation, {
              chatGuid: event.chat.chatGuid,
              chatIdentifier: event.chat.chatIdentifier,
            })
            if (promotion.status === "promoted") finishLatestTurn(promotion.capability)
            suspendBlueBubblesSemanticObservation(generation)
            result.queued = (result.queued ?? 0) + 1
          }
          continue
        }

        semanticGenerationOwned = true
        const handled = await handleCapturedBlueBubblesSemanticEvent(captured, resolvedDeps, "upstream-catchup", {
          timeoutMs: BLUEBUBBLES_RECOVERY_TURN_TIMEOUT_MS,
          autonomyBudgetTrigger: "recovery",
          observationReservation,
          lifecycleSignal: options.lifecycleSignal,
        })
        if (handled.reason === "semantic_claim_timeout") {
          continue
        }
        if (shouldCountBlueBubblesRecoveryResultAsSkipped(handled.reason) || !handled.notifiedAgent) {
          result.skipped++
        } else {
          result.recovered++
          if (observationReservation.ordinal > lastRecoveredOrdinal) {
            lastRecoveredOrdinal = observationReservation.ordinal
            result.lastRecoveredMessageGuid = event.messageGuid
          }
        }
      } catch (error) {
        if (!semanticGenerationOwned) clearPending(observationReservation)
        if (options.lifecycleSignal?.aborted) throw options.lifecycleSignal.reason
        recordBlueBubblesRecoveryFailureForBudget(agentName, event, "upstream-catchup")
        result.failed++
        emitNervesEvent({
          level: "warn",
          component: "senses",
          event: "senses.bluebubbles_catchup_error",
          message: "bluebubbles upstream catch-up message failed",
          meta: {
            messageGuid: event.messageGuid,
            reason: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }
  }))

  if (result.inspected > 0 || result.recovered > 0 || result.skipped > 0 || result.failed > 0) {
    emitNervesEvent({
      component: "senses",
      event: "senses.bluebubbles_catchup_complete",
      message: "bluebubbles upstream catch-up pass completed",
      meta: { ...result },
    })
  }

  return result
}

export interface BlueBubblesCapturedRecoveryResult {
  recovered: number
  skipped: number
  failed: number
}

export async function recoverCapturedBlueBubblesInboundMessages(
  deps: Partial<RuntimeDeps> = {},
  options: { lifecycleSignal?: AbortSignal } = {},
): Promise<BlueBubblesCapturedRecoveryResult> {
  options.lifecycleSignal?.throwIfAborted()
  const resolvedDeps = { ...defaultDeps, ...deps }
  const agentName = resolvedDeps.getAgentName()
  const cutover = initializeBlueBubblesSemanticCutover(agentName)
  const result: BlueBubblesCapturedRecoveryResult = { recovered: 0, skipped: 0, failed: 0 }
  const seenKeyHashes = new Set<string>()
  const candidates = listPendingBlueBubblesSemanticCaptures(agentName)
    .sort(compareBlueBubblesSemanticCaptureOrder)

  type PreparedCapturedRecoveryCandidate =
    | { status: "skip"; capture: BlueBubblesSemanticCaptureV1 }
    | { status: "invalid"; capture: BlueBubblesSemanticCaptureV1 }
    | {
        status: "ready"
        capture: BlueBubblesSemanticCaptureV1
        normalized: BlueBubblesDirectionObservedEvent
        observationReservation: BlueBubblesObservationReservation
      }
  const preparedCandidates: PreparedCapturedRecoveryCandidate[] = []
  for (const capture of candidates) {
    options.lifecycleSignal?.throwIfAborted()
    if (seenKeyHashes.has(capture.keyHash)) {
      preparedCandidates.push({ status: "skip", capture })
      continue
    }
    seenKeyHashes.add(capture.keyHash)

    const disposition = classifyBlueBubblesRecoveryRecord(capture, cutover)
    if (disposition.disposition === "audit_only" && disposition.reason !== "audit_event") {
      preparedCandidates.push({ status: "skip", capture })
      continue
    }
    const normalized = semanticCaptureToNormalizedEvent(capture)
    if (!normalized) {
      preparedCandidates.push({ status: "invalid", capture })
      continue
    }
    preparedCandidates.push({
      status: "ready",
      capture,
      normalized,
      observationReservation: reserveBlueBubblesObservation(normalized),
    })
  }

  for (const prepared of preparedCandidates) {
    const { capture } = prepared
    if (prepared.status === "skip") {
      result.skipped++
      continue
    }
    if (prepared.status === "invalid") {
      result.failed++
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_capture_recovery_error",
        message: "captured bluebubbles message recovery failed",
        meta: {
          messageGuid: capture.event.eventGuid,
          sessionKey: capture.event.sessionKey,
          reason: "semantic_capture_routing_invalid",
        },
      })
    }
  }
  const readyCandidates = preparedCandidates.filter((prepared): prepared is Extract<
    PreparedCapturedRecoveryCandidate,
    { status: "ready" }
  > => prepared.status === "ready")

  await Promise.all(groupBlueBubblesObservationsByLane(readyCandidates).map(async (lane) => {
    for (const prepared of lane) {
      const { capture, normalized, observationReservation } = prepared
      try {
        options.lifecycleSignal?.throwIfAborted()
        const handled = await handleCapturedBlueBubblesSemanticEvent({
          status: "captured",
          capture,
          normalized,
          writeResult: "semantic_capture_duplicate",
        }, resolvedDeps, "webhook", {
          timeoutMs: BLUEBUBBLES_RECOVERY_TURN_TIMEOUT_MS,
          autonomyBudgetTrigger: "recovery",
          semanticRecovery: true,
          observationReservation,
          lifecycleSignal: options.lifecycleSignal,
        })
        if (handled.reason === "semantic_claim_timeout") {
          continue
        }
        if (shouldCountBlueBubblesRecoveryResultAsSkipped(handled.reason) || !handled.notifiedAgent) {
          result.skipped++
        } else {
          result.recovered++
        }
      } catch (error) {
        if (options.lifecycleSignal?.aborted) throw options.lifecycleSignal.reason
        recordBlueBubblesRecoveryFailureForBudget(agentName, normalized, "webhook")
        result.failed++
        emitNervesEvent({
          level: "warn",
          component: "senses",
          event: "senses.bluebubbles_capture_recovery_error",
          message: "captured bluebubbles message recovery failed",
          meta: {
            messageGuid: capture.event.eventGuid,
            sessionKey: capture.event.sessionKey,
            reason: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }
  }))

  const semanticEventGuids = new Set(
    candidates
      .map((capture) => capture.event.eventGuid)
      .filter((eventGuid): eventGuid is string => typeof eventGuid === "string")
      .map((eventGuid) => eventGuid.trim().toLowerCase()),
  )
  for (const legacyEntry of listRecordedBlueBubblesInbound(agentName)) {
    if (semanticEventGuids.has(legacyEntry.messageGuid.trim().toLowerCase())) continue
    classifyBlueBubblesRecoveryRecord(legacyEntry, cutover)
    result.skipped++
  }

  return result
}

export async function recoverMissedBlueBubblesMessages(
  deps: Partial<RuntimeDeps> = {},
): Promise<BlueBubblesRecoveryResult> {
  const resolvedDeps = { ...defaultDeps, ...deps }
  const agentName = resolvedDeps.getAgentName()
  const cutover = initializeBlueBubblesSemanticCutover(agentName)
  const result: BlueBubblesRecoveryResult = { recovered: 0, skipped: 0, pending: 0, failed: 0 }

  for (const candidate of listBlueBubblesRecoveryCandidates(agentName)) {
    classifyBlueBubblesRecoveryRecord(candidate, cutover)
    result.skipped++
  }

  if (result.recovered > 0 || result.skipped > 0 || result.pending > 0 || result.failed > 0) {
    emitNervesEvent({
      component: "senses",
      event: "senses.bluebubbles_recovery_complete",
      message: "bluebubbles backlog recovery pass completed",
      meta: { ...result },
    })
  }

  return result
}

interface BlueBubblesWebhookHandlerOptions {
  lifecycleSignal?: AbortSignal
}

export function createBlueBubblesWebhookHandler(
  deps: Partial<RuntimeDeps> = {},
  options: BlueBubblesWebhookHandlerOptions = {},
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")

    if (url.pathname === "/health") {
      if (req.method === "GET" || req.method === "HEAD") {
        writeJson(res, 200, { status: "ok", uptime: process.uptime() })
        return
      }
      writeJson(res, 405, { error: "Method not allowed" })
      return
    }

    const channelConfig = getBlueBubblesChannelConfig()
    const runtimeConfig = getBlueBubblesConfig()

    if (url.pathname !== channelConfig.webhookPath) {
      writeJson(res, 404, { error: "Not found" })
      return
    }
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "Method not allowed" })
      return
    }

    if (!isWebhookPasswordValid(url, runtimeConfig.password)) {
      writeJson(res, 401, { error: "Unauthorized" })
      return
    }

    let payload: unknown
    try {
      const rawBody = await readRequestBody(req)
      payload = JSON.parse(rawBody) as unknown
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_webhook_bad_json",
        message: "failed to parse bluebubbles webhook body",
        meta: {
          reason: error instanceof Error ? error.message : String(error),
        },
      })
      writeJson(res, 400, { error: "Invalid JSON body" })
      return
    }

    let normalized: BlueBubblesNormalizedEvent
    try {
      normalized = normalizeBlueBubblesEvent(payload)
    } catch (error) {
      if (error instanceof BlueBubblesIgnoredEventError) {
        emitNervesEvent({
          component: "senses",
          event: "senses.bluebubbles_event_skipped",
          message: "skipped ignorable bluebubbles event",
          meta: {
            eventType: error.eventType,
          },
        })
        writeJson(res, 200, {
          handled: true,
          notifiedAgent: false,
          reason: "ignored",
        })
        return
      }
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.bluebubbles_webhook_error",
        message: "bluebubbles webhook handling failed",
        meta: {
          /* v8 ignore next -- normalizeBlueBubblesEvent throws Error subclasses; String fallback is defensive @preserve */
          reason: error instanceof Error ? error.message : String(error),
        },
      })
      writeJson(res, 500, {
        /* v8 ignore next -- normalizeBlueBubblesEvent throws Error subclasses; String fallback is defensive @preserve */
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }

    const resolvedDeps = { ...defaultDeps, ...deps }
    const observationReservation = reserveBlueBubblesObservation(normalized)
    let captured: BlueBubblesSemanticCaptureResult
    try {
      captured = await captureBlueBubblesSemanticEvent(
        normalized,
        resolvedDeps,
        "webhook",
        observationReservation,
      )
    } catch (error) {
      clearPending(observationReservation)
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.bluebubbles_webhook_error",
        message: "bluebubbles semantic capture failed before acknowledgement",
        meta: {
          messageGuid: normalized.messageGuid,
          reason: error instanceof Error ? error.message : String(error),
        },
      })
      writeSemanticCaptureFailure(res)
      return
    }

    if (captured.status === "audit_only") {
      clearPending(observationReservation)
      writeJson(res, 200, {
        handled: true,
        notifiedAgent: false,
        kind: normalized.kind,
        queued: false,
        reason: "ignored",
      })
      return
    }

    writeJson(res, 200, {
      handled: true,
      notifiedAgent: false,
      kind: normalized.kind,
      queued: true,
      reason: "queued",
    })

    setTimeout(() => {
      if (options.lifecycleSignal?.aborted) {
        clearPending(observationReservation)
        return
      }
      void handleCapturedBlueBubblesSemanticEvent(captured, resolvedDeps, "webhook", {
        observationReservation,
        lifecycleSignal: options.lifecycleSignal,
      }).catch((error) => {
        if (options.lifecycleSignal?.aborted) return
        emitNervesEvent({
          level: "error",
          component: "senses",
          event: "senses.bluebubbles_webhook_async_error",
          message: "bluebubbles webhook async handling failed after durable capture",
          meta: {
            reason: error instanceof Error ? error.message : String(error),
          },
        })
      })
    }, 0)
  }
}

export interface DrainAndSendPendingResult {
  sent: number
  skipped: number
  failed: number
}


function findImessageHandle(friend: FriendRecord): string | undefined {
  for (const ext of friend.externalIds) {
    if (ext.provider === "imessage-handle" && !ext.externalId.startsWith("group:")) {
      return ext.externalId
    }
  }
  return undefined
}

function normalizeBlueBubblesSessionKey(sessionKey: string): string {
  const trimmed = sessionKey.trim()
  if (trimmed.startsWith("chat_identifier_")) {
    return `chat_identifier:${trimmed.slice("chat_identifier_".length)}`
  }
  if (trimmed.startsWith("chat_")) {
    return `chat:${trimmed.slice("chat_".length)}`
  }
  return trimmed
}

function extractChatIdentifierFromSessionKey(sessionKey: string): string | undefined {
  const normalizedKey = normalizeBlueBubblesSessionKey(sessionKey)
  if (normalizedKey.startsWith("chat:")) {
    const chatGuid = normalizedKey.slice("chat:".length).trim()
    const parts = chatGuid.split(";")
    return parts.length >= 3 ? parts[2]?.trim() || undefined : undefined
  }
  if (normalizedKey.startsWith("chat_identifier:")) {
    const identifier = normalizedKey.slice("chat_identifier:".length).trim()
    return identifier || undefined
  }
  return undefined
}

function buildChatRefForSessionKey(friend: FriendRecord, sessionKey: string): BlueBubblesChatRef | null {
  const normalizedKey = normalizeBlueBubblesSessionKey(sessionKey)
  if (normalizedKey.startsWith("chat:")) {
    const chatGuid = normalizedKey.slice("chat:".length).trim()
    if (!chatGuid) return null
    return {
      chatGuid,
      chatIdentifier: extractChatIdentifierFromSessionKey(sessionKey) ?? findImessageHandle(friend),
      isGroup: chatGuid.includes(";+;"),
      sessionKey,
      sendTarget: { kind: "chat_guid", value: chatGuid },
      participantHandles: [],
    }
  }

  const chatIdentifier = extractChatIdentifierFromSessionKey(sessionKey) ?? findImessageHandle(friend)
  if (!chatIdentifier) return null
  return {
    chatIdentifier,
    isGroup: false,
    sessionKey,
    sendTarget: { kind: "chat_identifier", value: chatIdentifier },
    participantHandles: [],
  }
}

export async function sendProactiveBlueBubblesMessageToSession(
  params: ProactiveBlueBubblesSessionSendParams,
  deps: Partial<RuntimeDeps> = {},
): Promise<ProactiveBlueBubblesSessionSendResult> {
  if (containsInternalMetaMarkers(params.text)) {
    emitBluebubblesMetaBlocked({
      site: "proactive",
      message: "bluebubbles proactive send blocked: internal meta markers",
      meta: {
        friendId: params.friendId,
        sessionKey: params.sessionKey,
      },
    })
    return { delivered: false, reason: "blocked_meta_content" }
  }

  const resolvedDeps = { ...defaultDeps, ...deps }
  const client = resolvedDeps.createClient()
  const store = resolvedDeps.createFriendStore()

  let friend: FriendRecord | null
  try {
    friend = await store.get(params.friendId)
  } catch {
    friend = null
  }

  // Direct filesystem fallback — store.get() with name resolution wasn't working in production
  // despite correct compiled code. Bypass the entire store abstraction.
  /* v8 ignore start -- direct filesystem name resolution @preserve */
  if (!friend) {
    try {
      const friendsDir = path.join(getAgentRoot(), "friends")
      const files = fs.readdirSync(friendsDir).filter((f: string) => f.endsWith(".json"))
      for (const file of files) {
        const raw = JSON.parse(fs.readFileSync(path.join(friendsDir, file), "utf-8")) as FriendRecord
        if (raw.name?.toLowerCase() === params.friendId.toLowerCase()) {
          friend = raw
          emitNervesEvent({
            component: "senses",
            event: "senses.bluebubbles_proactive_name_resolved",
            message: "resolved friend by name via direct filesystem scan",
            meta: { friendId: params.friendId, resolvedId: raw.id, name: raw.name },
          })
          break
        }
      }
    } catch (err) {
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_proactive_name_resolve_error",
        message: "direct filesystem name resolution failed",
        meta: { friendId: params.friendId, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }
  /* v8 ignore stop */

  if (!friend) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_proactive_no_friend",
      message: "proactive send skipped: friend not found",
      meta: { friendId: params.friendId, sessionKey: params.sessionKey },
    })
    return { delivered: false, reason: "friend_not_found" }
  }

  const explicitCrossChatAuthorized = params.intent === "explicit_cross_chat"
    && TRUSTED_LEVELS.has((params.authorizingSession?.trustLevel as any) ?? "stranger")

  if (!explicitCrossChatAuthorized && !TRUSTED_LEVELS.has(friend.trustLevel ?? "stranger")) {
    emitNervesEvent({
      component: "senses",
      event: "senses.bluebubbles_proactive_trust_skip",
      message: "proactive send skipped: trust level not allowed",
      meta: {
        friendId: params.friendId,
        sessionKey: params.sessionKey,
        trustLevel: friend.trustLevel ?? "unknown",
        intent: params.intent ?? "generic_outreach",
        authorizingTrustLevel: params.authorizingSession?.trustLevel ?? null,
      },
    })
    return { delivered: false, reason: "trust_skip" }
  }

  const chat = buildChatRefForSessionKey(friend, params.sessionKey)
  if (!chat) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_proactive_no_handle",
      message: "proactive send skipped: no iMessage handle found",
      meta: { friendId: params.friendId, sessionKey: params.sessionKey },
    })
    return { delivered: false, reason: "missing_target" }
  }

  // Proactive outreach to individuals must go to DMs, never group chats.
  // Explicit cross-chat responses (bridge completions, delegation returns) ARE allowed to groups
  // because the request originated from that group.
  /* v8 ignore start -- group gate: only fires when proactive send targets a group session @preserve */
  if (chat.isGroup && params.intent !== "explicit_cross_chat") {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_proactive_group_blocked",
      message: "proactive send blocked: would route to group chat",
      meta: { friendId: params.friendId, sessionKey: params.sessionKey, chatGuid: chat.chatGuid ?? null, intent: params.intent ?? null },
    })
    return { delivered: false, reason: "group_blocked" }
  }
  /* v8 ignore stop */

  const internalContentBlockReason = getProactiveInternalContentBlockReason(params.text)
  if (internalContentBlockReason) {
    emitProactiveInternalContentBlocked({
      friendId: params.friendId,
      sessionKey: params.sessionKey,
      reason: internalContentBlockReason,
      source: "session_send",
      intent: params.intent ?? "generic_outreach",
    })
    return { delivered: false, reason: "internal_content_blocked" }
  }

  try {
    await client.sendText({ chat, text: params.text })
    emitNervesEvent({
      component: "senses",
      event: "senses.bluebubbles_proactive_sent",
      message: "proactive bluebubbles message sent",
      meta: {
        friendId: params.friendId,
        sessionKey: params.sessionKey,
        chatGuid: chat.chatGuid ?? null,
        chatIdentifier: chat.chatIdentifier ?? null,
      },
    })
    return { delivered: true }
  } catch (error) {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.bluebubbles_proactive_send_error",
      message: "proactive bluebubbles send failed",
      meta: {
        friendId: params.friendId,
        sessionKey: params.sessionKey,
        reason: error instanceof Error ? error.message : String(error),
      },
    })
    return { delivered: false, reason: "send_error" }
  }
}

function scanPendingBlueBubblesFiles(pendingRoot: string): Array<{
  friendId: string
  key: string
  filePath: string
  content: string
}> {
  const results: Array<{ friendId: string; key: string; filePath: string; content: string }> = []

  let friendIds: string[]
  try {
    friendIds = fs.readdirSync(pendingRoot)
  } catch {
    return results
  }

  for (const friendId of friendIds) {
    const bbDir = path.join(pendingRoot, friendId, "bluebubbles")
    let keys: string[]
    try {
      keys = fs.readdirSync(bbDir)
    } catch {
      continue
    }

    for (const key of keys) {
      const keyDir = path.join(bbDir, key)
      let files: string[]
      try {
        files = fs.readdirSync(keyDir)
      } catch {
        continue
      }

      for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
        const filePath = path.join(keyDir, file)
        try {
          const content = fs.readFileSync(filePath, "utf-8")
          results.push({ friendId, key, filePath, content })
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  return results
}

export async function drainAndSendPendingBlueBubbles(
  deps: Partial<RuntimeDeps> = {},
  pendingRoot?: string,
): Promise<DrainAndSendPendingResult> {
  const resolvedDeps = { ...defaultDeps, ...deps }
  const root = pendingRoot ?? path.join(getAgentRoot(), "state", "pending")
  const client = resolvedDeps.createClient()
  const store = resolvedDeps.createFriendStore()

  const pendingFiles = scanPendingBlueBubblesFiles(root)
  const result: DrainAndSendPendingResult = { sent: 0, skipped: 0, failed: 0 }

  for (const { friendId, filePath, content } of pendingFiles) {
    let parsed: { content?: string }
    try {
      parsed = JSON.parse(content) as { content?: string }
    } catch {
      result.failed++
      try { fs.unlinkSync(filePath) } catch { /* ignore */ }
      continue
    }

    const messageText = typeof parsed.content === "string" ? parsed.content : ""
    if (!messageText.trim()) {
      result.skipped++
      try { fs.unlinkSync(filePath) } catch { /* ignore */ }
      continue
    }

    if (containsInternalMetaMarkers(messageText)) {
      result.skipped++
      try { fs.unlinkSync(filePath) } catch { /* ignore */ }
      emitBluebubblesMetaBlocked({
        site: "drain",
        message: "bluebubbles drain blocked: internal meta markers",
        meta: {
          friendId,
          filePath,
        },
      })
      continue
    }

    const internalBlockReason = getProactiveInternalContentBlockReason(messageText)
    if (internalBlockReason) {
      result.skipped++
      try { fs.unlinkSync(filePath) } catch { /* ignore */ }
      emitProactiveInternalContentBlocked({
        friendId,
        reason: internalBlockReason,
        source: "pending_drain",
      })
      continue
    }

    let friend: FriendRecord | null
    try {
      friend = await store.get(friendId)
    } catch {
      friend = null
    }

    if (!friend) {
      result.skipped++
      try { fs.unlinkSync(filePath) } catch { /* ignore */ }
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_proactive_no_friend",
        message: "proactive send skipped: friend not found",
        meta: { friendId },
      })
      continue
    }

    if (!TRUSTED_LEVELS.has(friend.trustLevel ?? "stranger")) {
      result.skipped++
      try { fs.unlinkSync(filePath) } catch { /* ignore */ }
      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_proactive_trust_skip",
        message: "proactive send skipped: trust level not allowed",
        meta: { friendId, trustLevel: friend.trustLevel ?? "unknown" },
      })
      continue
    }

    const handle = findImessageHandle(friend)
    if (!handle) {
      result.skipped++
      try { fs.unlinkSync(filePath) } catch { /* ignore */ }
      emitNervesEvent({
        level: "warn",
        component: "senses",
        event: "senses.bluebubbles_proactive_no_handle",
        message: "proactive send skipped: no iMessage handle found",
        meta: { friendId },
      })
      continue
    }

    const chat: BlueBubblesChatRef = {
      chatIdentifier: handle,
      isGroup: false,
      sessionKey: friendId,
      sendTarget: { kind: "chat_identifier", value: handle },
      participantHandles: [],
    }

    try {
      await client.sendText({ chat, text: messageText })
      result.sent++
      try { fs.unlinkSync(filePath) } catch { /* ignore */ }

      emitNervesEvent({
        component: "senses",
        event: "senses.bluebubbles_proactive_sent",
        message: "proactive bluebubbles message sent",
        meta: { friendId, handle },
      })
    } catch (error) {
      result.failed++
      emitNervesEvent({
        level: "error",
        component: "senses",
        event: "senses.bluebubbles_proactive_send_error",
        message: "proactive bluebubbles send failed",
        meta: {
          friendId,
          handle,
          reason: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  if (result.sent > 0 || result.skipped > 0 || result.failed > 0) {
    emitNervesEvent({
      component: "senses",
      event: "senses.bluebubbles_proactive_drain_complete",
      message: "bluebubbles proactive drain complete",
      meta: { sent: result.sent, skipped: result.skipped, failed: result.failed },
    })
  }

  return result
}

export function startBlueBubblesApp(deps: Partial<RuntimeDeps> = {}): http.Server {
  const resolvedDeps = { ...defaultDeps, ...deps }
  const lifecycleController = new AbortController()
  initializeBlueBubblesSemanticCutover(resolvedDeps.getAgentName())
  resolvedDeps.createClient()
  seedBlueBubblesStartupSemanticObservations(resolvedDeps)
  const startupCatchUpObservationBatch = beginObservationBatch(
    BLUEBUBBLES_CATCHUP_PAGE_SIZE * BLUEBUBBLES_CATCHUP_MAX_PAGES,
  )
  const channelConfig = getBlueBubblesChannelConfig()
  const server = resolvedDeps.createServer(createBlueBubblesWebhookHandler(deps, {
    lifecycleSignal: lifecycleController.signal,
  }))
  let recoveryPassRunning = false
  let runtimeSyncRunning = false
  let recoveryDelayTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  function triggerRecoveryPass(): void {
    /* v8 ignore next -- close clears both recovery timers; guard covers an already-queued host callback @preserve */
    if (closed) return
    /* v8 ignore next -- re-entrant timer guard; difficult to force deterministically without timing the turn lock @preserve */
    if (recoveryPassRunning) return
    recoveryPassRunning = true
    void recoverQueuedBlueBubblesMessages(resolvedDeps, {
      lifecycleSignal: lifecycleController.signal,
    })
      /* v8 ignore start -- defensive wrapper; expected per-message failures are handled inside recovery helpers @preserve */
      .catch((error) => {
        if (closed || lifecycleController.signal.aborted) return
        emitNervesEvent({
          level: "warn",
          component: "senses",
          event: "senses.bluebubbles_recovery_error",
          message: "bluebubbles queued recovery pass failed",
          meta: { reason: error instanceof Error ? error.message : String(error) },
        })
      })
      /* v8 ignore stop */
      .finally(() => {
        recoveryPassRunning = false
      })
  }

  function scheduleRecoveryPass(): void {
    if (closed) return
    /* v8 ignore next -- duplicate scheduling guard for overlapping health sync completions @preserve */
    if (recoveryDelayTimer !== null) return
    recoveryDelayTimer = setTimeout(() => {
      recoveryDelayTimer = null
      triggerRecoveryPass()
    }, BLUEBUBBLES_RECOVERY_PASS_DELAY_MS)
  }

  function triggerRuntimeSync(
    catchUpObservationBatch?: BlueBubblesObservationBatch,
  ): void {
    if (closed || runtimeSyncRunning) return
    runtimeSyncRunning = true
    void syncBlueBubblesRuntime(resolvedDeps, {
      ...(catchUpObservationBatch ? { catchUpObservationBatch } : {}),
      lifecycleSignal: lifecycleController.signal,
    })
      .then(scheduleRecoveryPass)
      .catch((error) => {
        if (closed || lifecycleController.signal.aborted) return
        emitNervesEvent({
          level: "warn",
          component: "senses",
          event: "senses.bluebubbles_recovery_error",
          message: "bluebubbles runtime sync failed",
          meta: { reason: error instanceof Error ? error.message : String(error) },
        })
      })
      .finally(() => {
        runtimeSyncRunning = false
      })
  }

  const runtimeTimer = setInterval(() => {
    /* v8 ignore next -- close clears this interval; guard covers an already-queued host callback @preserve */
    if (closed) return
    triggerRuntimeSync()
  }, BLUEBUBBLES_RUNTIME_SYNC_INTERVAL_MS)
  const recoveryTimer = setInterval(triggerRecoveryPass, BLUEBUBBLES_RECOVERY_PASS_INTERVAL_MS)
  server.on?.("close", () => {
    closed = true
    lifecycleController.abort(new Error("bluebubbles_runtime_shutdown"))
    clearInterval(runtimeTimer)
    clearInterval(recoveryTimer)
    if (recoveryDelayTimer !== null) {
      clearTimeout(recoveryDelayTimer)
      recoveryDelayTimer = null
    }
  })
  server.listen(channelConfig.port, () => {
    emitNervesEvent({
      component: "channels",
      event: "channel.app_started",
      message: "BlueBubbles sense started",
      meta: { port: channelConfig.port, webhookPath: channelConfig.webhookPath },
    })
  })
  triggerRuntimeSync(startupCatchUpObservationBatch)
  return server
}
