import type OpenAI from "openai"
import * as fs from "fs"
import * as path from "path"
import { sessionPath } from "../heart/config"
import { runAgent, type ChannelCallbacks, type CompletionMetadata, type RunAgentOutcome } from "../heart/core"
import { getAgentName, getAgentRoot, type AgentProvider } from "../heart/identity"
import { loadSession, postTurnTrim, deferPostTurnPersist, type UsageData } from "../mind/context"
import { buildSystem, flattenSystemPrompt } from "../mind/prompt"
import { getSharedMcpManager } from "../repertoire/mcp-manager"
import { getSanctuaryRelationshipTools, getToolsForChannel } from "../repertoire/tools"
import { cancelStaleAwait, hasActiveExternalEventAwait, inspectRelationshipFollowUp } from "../repertoire/tools-awaiting"
import { renderRelationshipPreferences } from "../repertoire/relationship-authorization"
import { appendRunLedgerRecordNonFatal, createRunLedgerRecord, usageMetadataFromUsageData } from "../heart/run-ledger"
import { findNonCanonicalBundlePaths } from "../mind/bundle-manifest"
import {
  drainPending,
  getPrivateRuntimePendingDir,
  getDeferredReturnDir,
  getPendingDir,
  PRIVATE_RUNTIME_PENDING,
  type PendingMessage,
  type DelegatedFrom,
} from "../mind/pending"
import { advanceReturnObligation, listActiveReturnObligations, findPendingObligationForOrigin, fulfillObligation } from "../arc/obligations"
import { buildAttentionQueue, buildAttentionQueueStatusFrame, type AttentionItem } from "./attention-queue"
import { readPonderPacket } from "../arc/packets"
import { FileFriendStore, getChannelCapabilities, accumulateFriendTokens } from "@ouro.bot/friends"
import type { FriendRecord, ResolvedContext, FriendStore } from "@ouro.bot/friends"
import { enforceTrustGate } from "./trust-gate"
import { handleInboundTurn } from "./pipeline"
import { withSessionTurnLease, type SessionTurnLease } from "../mind/session-transaction"
import { createTraceId } from "../nerves"
import { emitNervesEvent } from "../nerves/runtime"
import { readCachedProviderCredentialRecord } from "../heart/provider-credentials"
import { createBridgeManager } from "../heart/bridges/manager"
import { listSessionActivity, type SessionActivityRecord } from "../heart/session-activity"
import { sendProactiveBlueBubblesMessageToSession } from "./bluebubbles"
import { buildHabitTurnMessage, type PriorHabitSessionSummaryInfo } from "./habit-turn-message"
import { buildAwaitTurnMessage } from "./await-turn-message"
import { parseAwaitFile, type AwaitFile } from "../heart/awaiting/await-parser"
import { applyAwaitRuntimeState, type AwaitRuntimeState } from "../heart/awaiting/await-runtime-state"
import {
  createDegradedHabitFile,
  parseHabitFile,
  type HabitFile,
  type HabitOrigin,
  type HabitSurface,
} from "../heart/habits/habit-parser"
import { applyHabitRuntimeState } from "../heart/habits/habit-runtime-state"
import { privateRuntimeHabitRejectionReason } from "./habit-lifecycle-guard"
import { parseCadenceToMs } from "../heart/daemon/cadence"
import { isRsvpHabitName } from "../rsvp/habit-policy"
import { readHealth, getDefaultHealthPath } from "../heart/daemon/daemon-health"
import { readFlightRecorderResume, formatFlightRecorderResume } from "../arc/flight-recorder"
import { deskRecordOrientationSection } from "../mind/desk-section"
import type { HabitSessionToolContext } from "../repertoire/tools-base"
import type { ExternalEventLeaseContext } from "../heart/external-events/router"
import { createSanctuaryToolContext } from "./sanctuary-runtime"
import { getSenseSessionPath } from "./shared-turn"
import { createRelationshipAuthorizationEvaluator, loadRelationshipCapabilityRegistry, resolveProfileScopedRelationshipAuthorization } from "../repertoire/relationship-authorization"
import {
  createPrivateTurnRequestFingerprint,
  readPrivateTurnLedger,
  type PrivateTurnDecision,
  type PrivateTurnOriginRef,
  type PrivateTurnProviderLaneMetadata,
  type PrivateTurnRequest,
} from "../heart/private-runtime"

export interface PrivateRuntimeInstinct {
  id: string
  prompt: string
  enabled?: boolean
}

export interface PrivateRuntimeTurnState {
  cycleCount: number
  resting?: boolean
  lastHeartbeatAt?: string
  checkpoint?: string
}

export interface HabitParseErrorInfo {
  file: string
  error: string
}

export interface RunPrivateRuntimeTurnOptions {
  reason?: "boot" | "heartbeat" | "habit" | "instinct" | "await"
  taskId?: string
  habitName?: string
  awaitName?: string
  parseErrors?: HabitParseErrorInfo[]
  instincts?: PrivateRuntimeInstinct[]
  now?: () => Date
  signal?: AbortSignal
  habitSession?: HabitSessionToolContext
  preparedHabit?: PreparedHabitContext
  privateTurnDecision?: PrivateTurnDecision
  externalEvent?: ExternalEventLeaseContext
  noSend?: true
  _withSessionTurnLease?: <T>(sessionPath: string, work: (lease: SessionTurnLease) => Promise<T>) => Promise<T>
}

export interface PreparedHabitContext {
  runId: string
  trigger: string
  operationId: string | null
  habit: HabitFile
  priorSessionSummary?: PriorHabitSessionSummaryInfo
}

export interface PrivateRuntimeTurnResult {
  messages: OpenAI.ChatCompletionMessageParam[]
  usage?: UsageData
  sessionPath: string
  completion?: CompletionMetadata
  turnOutcome?: RunAgentOutcome | "command"
  restStatus?: string
}

interface PrivateRuntimeStateSnapshot {
  status: "idle" | "running"
  reason?: "boot" | "heartbeat" | "habit" | "instinct" | "await"
  startedAt?: string
  lastCompletedAt?: string
}

export const PRIVATE_TURN_DECISION_MAX_AGE_MS = 15 * 60_000
const DUPLICATE_PRIVATE_TURN_STATUS = "DUPLICATE_PRIVATE_TURN"

const DEFAULT_PRIVATE_RUNTIME_INSTINCTS: PrivateRuntimeInstinct[] = [
  {
    id: "heartbeat_checkin",
    prompt: "...time passing. anything stirring?",
    enabled: true,
  },
]

type RelationshipAwaitCoordinates = { friendId: string; channel: string; key: string; requestId: string | null }

class StaleRelationshipAwaitError extends Error {
  constructor(readonly reason: string) {
    super(`Relationship await authority ${reason}`)
  }
}

function exactFriendFileIsMissing(agentRoot: string, friendId: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(friendId)) throw new Error("Relationship await authority friend id is invalid")
  try {
    fs.lstatSync(path.join(agentRoot, "friends", `${friendId}.json`))
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
    throw error
  }
}

function relationshipAwaitCoordinates(awaitFile: AwaitFile): RelationshipAwaitCoordinates | null {
  const values = [awaitFile.filed_for_friend_id, awaitFile.filed_from, awaitFile.filed_from_key]
  if (!awaitFile.request_id) {
    if (awaitFile.filed_from === "external-event" && awaitFile.filed_for_friend_id && awaitFile.filed_from_key) {
      if (Buffer.byteLength(awaitFile.filed_for_friend_id) > 256 || Buffer.byteLength(awaitFile.filed_from_key) > 1_024) throw new Error("Relationship await provenance is invalid")
      return { friendId: awaitFile.filed_for_friend_id, channel: awaitFile.filed_from, key: awaitFile.filed_from_key, requestId: null }
    }
    const isSystemAwait = awaitFile.filed_for_friend_id === null
      && awaitFile.filed_from_key === null
      && (awaitFile.filed_from === null || awaitFile.filed_from === "unknown" || awaitFile.filed_from === "cli")
    if (isSystemAwait) return null
    throw new Error("Relationship await provenance is incomplete or legacy")
  }
  if (values.some((value) => value === null)) throw new Error("Relationship await provenance is incomplete or legacy")
  const [friendId, channel, key] = values as [string, string, string]
  if (channel !== "telegram" || Buffer.byteLength(friendId) > 256 || Buffer.byteLength(channel) > 64 || Buffer.byteLength(key) > 1_024 || Buffer.byteLength(awaitFile.request_id) > 256) {
    throw new Error("Relationship await provenance is invalid")
  }
  return { friendId, channel, key, requestId: awaitFile.request_id }
}

async function resolveRelationshipAwaitAuthority(agentRoot: string, store: FileFriendStore, registry: ReturnType<typeof loadRelationshipCapabilityRegistry>, coordinates: RelationshipAwaitCoordinates) {
  const friend = await store.get(coordinates.friendId)
  if (!friend) {
    if (exactFriendFileIsMissing(agentRoot, coordinates.friendId)) throw new StaleRelationshipAwaitError("friend is missing")
    throw new Error("Relationship await authority friend exists but could not be read")
  }
  if (friend.id !== coordinates.friendId) throw new Error("Relationship await authority friend record is ambiguous")
  if (friend.admissionState !== "active" || !friend.capabilityProfileId) throw new StaleRelationshipAwaitError("admission or profile is not active")
  if (!registry.profiles[friend.capabilityProfileId]) throw new StaleRelationshipAwaitError("admission or profile is not active")
  if (coordinates.channel === "external-event" && (friend.capabilityProfileId !== "sanctuary-owner" || !registry.profiles["sanctuary-event"])) {
    throw new StaleRelationshipAwaitError("admission or profile is not active")
  }
  const authorization = coordinates.channel === "external-event"
    ? createRelationshipAuthorizationEvaluator({ friend, registry, profileId: "sanctuary-event", requestPhase: "follow_up" })
    : createRelationshipAuthorizationEvaluator({ friend, registry, requestId: coordinates.requestId!, requestPhase: "follow_up" })
  if (authorization.subject.friendId !== coordinates.friendId) throw new Error("Relationship await authority friend is ambiguous")
  if (!authorization.authorizeTool("resolve_await").allowed) throw new StaleRelationshipAwaitError("admission or profile is not active")
  return { authorization, friend }
}

function readAspirations(agentRoot: string): string {
  try {
    return fs.readFileSync(path.join(agentRoot, "psyche", "ASPIRATIONS.md"), "utf8").trim()
  } catch {
    return ""
  }
}

export function loadPrivateRuntimeInstincts(): PrivateRuntimeInstinct[] {
  return [...DEFAULT_PRIVATE_RUNTIME_INSTINCTS]
}

export function buildPrivateRuntimeBootstrapMessage(aspirations: string, stateSummary: string): string {
  const lines = ["waking up."]
  if (aspirations) {
    lines.push("", "## what matters to me", aspirations)
  }
  if (stateSummary) {
    lines.push("", "## what i know so far", stateSummary)
  }
  lines.push("", "what needs my attention?")
  return lines.join("\n")
}

export function buildNonCanonicalCleanupNudge(nonCanonicalPaths: string[]): string {
  if (nonCanonicalPaths.length === 0) return ""
  const listed = nonCanonicalPaths.slice(0, 20).map((entry) => `- ${entry}`)
  if (nonCanonicalPaths.length > 20) {
    listed.push(`- ... (${nonCanonicalPaths.length - 20} more)`)
  }
  return [
    "## canonical cleanup nudge",
    "I found non-canonical files in my bundle. I should distill anything valuable into my diary and remove these files.",
    ...listed,
  ].join("\n")
}

function displayCheckpoint(checkpoint?: string): string | undefined {
  const trimmed = checkpoint?.trim()
  if (!trimmed || trimmed === "no prior checkpoint recorded") {
    return undefined
  }
  return trimmed
}

export function buildInstinctUserMessage(
  instincts: PrivateRuntimeInstinct[],
  _reason: "boot" | "heartbeat" | "habit" | "instinct" | "await",
  state: PrivateRuntimeTurnState,
): string {
  const active = instincts.find((instinct) => instinct.enabled !== false) ?? DEFAULT_PRIVATE_RUNTIME_INSTINCTS[0]
  const checkpoint = displayCheckpoint(state.checkpoint)
  const lines = [active.prompt]
  if (checkpoint) {
    lines.push(`\nlast checkpoint: ${checkpoint}`)
  }
  return lines.join("\n")
}

export function readTaskFile(agentRoot: string, taskId: string): string {
  // Task files live in collection subdirectories (one-shots, ongoing).
  // Try each collection, then fall back to root tasks/ for legacy layout.
  // Habits are no longer in tasks/ — they live at bundle root habits/.
  const collections = ["one-shots", "ongoing", ""]
  for (const collection of collections) {
    try {
      return fs.readFileSync(path.join(agentRoot, "tasks", collection, `${taskId}.md`), "utf8").trim()
    } catch {
      // not in this collection — try next
    }
  }
  return ""
}

export function buildTaskTriggeredMessage(taskId: string, taskContent: string, checkpoint?: string): string {
  const lines = ["a task needs my attention."]
  if (taskContent) {
    lines.push("", `## task: ${taskId}`, taskContent)
  } else {
    lines.push("", `## task: ${taskId}`, "(task file not found)")
  }
  const renderedCheckpoint = displayCheckpoint(checkpoint)
  if (renderedCheckpoint) {
    lines.push("", `last checkpoint: ${renderedCheckpoint}`)
  }
  return lines.join("\n")
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""
  const text = content
    .map((part) => {
      if (typeof part === "string") return part
      if (!part || typeof part !== "object") return ""
      if ("text" in part && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text
      }
      return ""
    })
    .join("\n")
  return text.trim()
}

function checkpointTextFromAssistantContent(content: unknown): string | null {
  const assistantText = contentToText(content)
  if (!assistantText) return null

  const cleanedLines = assistantText
    .split("\n")
    .map((line) => line.replace(/<\/?think>/gi, "").trim())
    .filter((line) => line.length > 0)

  const explicitCheckpoint = cleanedLines
    .find((line) => /^checkpoint\s*:/i.test(line))
  if (explicitCheckpoint) {
    const parsed = explicitCheckpoint.replace(/^checkpoint\s*:\s*/i, "").trim()
    return parsed || null
  }

  const firstLine = cleanedLines[0]
  return firstLine ?? null
}

function truncateCheckpointText(text: string): string {
  if (text.length <= 220) return text
  return `${text.slice(0, 217)}...`
}

function parseToolArguments(argumentsValue: string | undefined): Record<string, unknown> {
  if (!argumentsValue) return {}
  try {
    const parsed = JSON.parse(argumentsValue) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function toolArgumentText(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === "string" && value.trim()) {
      return value.trim()
    }
  }
  return ""
}

function summarizeToolAction(name: string | undefined, argumentsValue: string | undefined): string | null {
  if (!name) return null
  const args = parseToolArguments(argumentsValue)
  if (name === "surface") {
    const message = toolArgumentText(args, ["message", "text", "content"])
    return message ? `surfaced: ${message}` : null
  }
  if (name === "ponder") {
    const thought = toolArgumentText(args, ["summary", "question", "topic", "prompt"])
    return thought ? `pondered: ${thought}` : null
  }
  if (name === "diary_write") {
    const note = toolArgumentText(args, ["text", "content", "note", "entry"])
    return note ? `diary: ${note}` : null
  }
  if (name === "let_go") {
    const reason = toolArgumentText(args, ["reason", "note", "status"])
    return reason ? `let go: ${reason}` : null
  }
  if (name === "rest") {
    const note = toolArgumentText(args, ["note", "status"])
    return note ? `rested: ${note}` : null
  }
  return null
}

function extractToolFunction(toolCall: unknown): { name?: string; arguments?: string } | null {
  if (!toolCall || typeof toolCall !== "object" || !("function" in toolCall)) return null
  const maybeFunction = (toolCall as { function?: unknown }).function
  if (!maybeFunction || typeof maybeFunction !== "object") return null

  const name = "name" in maybeFunction && typeof maybeFunction.name === "string"
    ? maybeFunction.name
    : undefined
  const argumentsValue = "arguments" in maybeFunction && typeof maybeFunction.arguments === "string"
    ? maybeFunction.arguments
    : undefined

  return { name, arguments: argumentsValue }
}

function privateTurnRequestFromDecision(decision: PrivateTurnDecision): PrivateTurnRequest {
  return {
    agent: decision.agent,
    origin: decision.origin,
    reason: decision.requestReason ?? decision.reason,
    providerLane: decision.providerLane.lane,
    triggerSource: decision.triggerSource,
    idempotencyKey: decision.idempotencyKey,
    budgetClass: decision.budgetClass,
    originRefs: decision.originRefs,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function configuredProviderLaneMetadata(agentName: string, lane: PrivateTurnProviderLaneMetadata["lane"]): PrivateTurnProviderLaneMetadata {
  const configPath = path.join(getAgentRoot(agentName), "agent.json")
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown
  if (!isRecord(parsed)) {
    throw new Error("private-runtime provider lane mismatch: agent.json is not an object")
  }
  const facingKey = lane === "inner" ? "agentFacing" : "humanFacing"
  const facing = parsed[facingKey]
  if (!isRecord(facing)) {
    throw new Error(`private-runtime provider lane mismatch: missing ${facingKey}`)
  }
  const provider = facing.provider
  const model = facing.model
  if (typeof provider !== "string" || provider.trim().length === 0 || typeof model !== "string" || model.trim().length === 0) {
    throw new Error(`private-runtime provider lane mismatch: incomplete ${facingKey}`)
  }
  const credential = readCachedProviderCredentialRecord(agentName, provider as AgentProvider)
  if (!credential.ok) {
    throw new Error(`private-runtime provider lane mismatch: credential revision unavailable for ${provider}`)
  }
  return {
    lane,
    provider,
    model,
    source: "agent.json",
    credentialRevision: credential.record.revision,
  }
}

function assertProviderLaneStillMatches(decision: PrivateTurnDecision, agentName: string): void {
  const current = configuredProviderLaneMetadata(agentName, decision.providerLane.lane)
  if (typeof decision.providerLane.credentialRevision !== "string" || decision.providerLane.credentialRevision.trim().length === 0) {
    throw new Error(
      `private-runtime provider lane mismatch: receipt for ${decision.providerLane.provider}/${decision.providerLane.model} is missing credential revision`,
    )
  }
  if (
    current.lane !== decision.providerLane.lane
    || current.provider !== decision.providerLane.provider
    || current.model !== decision.providerLane.model
    || current.source !== decision.providerLane.source
    || current.credentialRevision !== decision.providerLane.credentialRevision
  ) {
    throw new Error(
      `private-runtime provider lane mismatch: receipt was for ${decision.providerLane.provider}/${decision.providerLane.model}, current ${decision.providerLane.lane} lane is ${current.provider}/${current.model}`,
    )
  }
}

function findOriginRef(refs: PrivateTurnOriginRef[], kind: string, id: string): PrivateTurnOriginRef | undefined {
  return refs.find((ref) => ref.kind === kind && ref.id === id)
}

function assertPayloadBinding(
  decision: PrivateTurnDecision,
  kind: "task" | "habit" | "await",
  id: string | undefined,
): void {
  const refs = decision.originRefs.filter((ref) => ref.kind === kind)
  if (!id && refs.length === 0) return
  if (!id) {
    throw new Error(`private-runtime decision payload mismatch: missing ${kind} payload for ${refs.map((ref) => ref.id).join(", ")}`)
  }
  if (findOriginRef(refs, kind, id)) return
  throw new Error(`private-runtime decision payload mismatch: missing ${kind} origin ref ${id}`)
}

function assertNoSendBinding(decision: PrivateTurnDecision, noSend: true | undefined): void {
  const refs = decision.originRefs.filter((ref) => ref.kind === "capability" && ref.id === "no-send")
  if (noSend === true && refs.length === 1) return
  if (noSend === undefined && refs.length === 0) return
  throw new Error("private-runtime decision payload mismatch: no-send capability binding does not match the turn")
}

function ledgerDecisionFor(decision: PrivateTurnDecision): PrivateTurnDecision {
  const ledgerPath = decision.ledgerLocator?.path
  if (!ledgerPath) {
    throw new Error("private-runtime decision has no ledger locator")
  }
  const rows = readPrivateTurnLedger(ledgerPath)
  const lineIndex = typeof decision.ledgerLocator.line === "number"
    ? decision.ledgerLocator.line - 1
    : -1
  const row = lineIndex >= 0 && lineIndex < rows.length
    ? rows[lineIndex]
    : rows.find((candidate) =>
      candidate.receiptId === decision.receiptId
      && candidate.idempotencyKey === decision.idempotencyKey
      && candidate.requestFingerprint === decision.requestFingerprint
    )
  if (!row) {
    throw new Error("private-runtime decision is not present in the ledger")
  }
  if (
    row.receiptId !== decision.receiptId
    || row.idempotencyKey !== decision.idempotencyKey
    || row.requestFingerprint !== decision.requestFingerprint
    || row.result !== decision.result
    || row.executable !== decision.executable
  ) {
    throw new Error("private-runtime decision does not match its ledger row")
  }
  return row
}

function assertPrivateTurnDecisionAllowed(input: {
  decision: PrivateTurnDecision | undefined
  agentName: string
  options?: RunPrivateRuntimeTurnOptions
  now: () => Date
}): PrivateTurnDecision {
  const { decision, agentName, options, now } = input
  if (!decision) {
    throw new Error("private-runtime provider boundary requires an approved private-turn decision")
  }
  if (decision.agent !== agentName) {
    throw new Error(`private-runtime decision agent mismatch: expected ${agentName}, got ${decision.agent}`)
  }
  if (decision.result !== "allow" || decision.executable !== true) {
    throw new Error(`private-runtime decision denied: ${decision.deniedReason ?? decision.result}`)
  }
  assertProviderLaneStillMatches(decision, agentName)
  const expectedFingerprint = createPrivateTurnRequestFingerprint(privateTurnRequestFromDecision(decision), decision.providerLane)
  if (decision.requestFingerprint !== expectedFingerprint) {
    throw new Error("private-runtime decision fingerprint mismatch")
  }

  assertPayloadBinding(decision, "task", options?.taskId)
  assertPayloadBinding(decision, "habit", options?.habitName)
  assertPayloadBinding(decision, "await", options?.awaitName)
  assertNoSendBinding(decision, options?.noSend)

  const ledgerRow = ledgerDecisionFor(decision)
  const decidedAtMs = Date.parse(ledgerRow.decidedAt)
  if (!Number.isFinite(decidedAtMs)) {
    throw new Error("private-runtime decision has invalid decidedAt timestamp")
  }
  const ageMs = now().getTime() - decidedAtMs
  if (ageMs < 0 || ageMs > PRIVATE_TURN_DECISION_MAX_AGE_MS) {
    throw new Error("private-runtime decision is stale")
  }
  return ledgerRow
}

function privateTurnExecutionPath(decision: PrivateTurnDecision): string {
  const safeReceiptId = decision.receiptId.replace(/[^A-Za-z0-9_.-]/g, "_")
  return path.join(path.dirname(decision.ledgerLocator.path), "executions", `${safeReceiptId}.json`)
}

function claimPrivateTurnExecution(decision: PrivateTurnDecision, now: () => Date): boolean {
  const executionPath = privateTurnExecutionPath(decision)
  fs.mkdirSync(path.dirname(executionPath), { recursive: true })
  try {
    fs.writeFileSync(executionPath, JSON.stringify({
      receiptId: decision.receiptId,
      idempotencyKey: decision.idempotencyKey,
      requestFingerprint: decision.requestFingerprint,
      claimedAt: now().toISOString(),
    }), { encoding: "utf-8", flag: "wx" })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
    throw error
  }
}

function checkpointTextFromAssistantToolCalls(message: OpenAI.ChatCompletionMessageParam): string | null {
  if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) return null
  for (let i = message.tool_calls.length - 1; i >= 0; i--) {
    const toolFunction = extractToolFunction(message.tool_calls[i])
    const summary = summarizeToolAction(toolFunction?.name, toolFunction?.arguments)
    if (summary) return summary
  }
  return null
}

function latestRestStatus(messages: OpenAI.ChatCompletionMessageParam[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue
    for (let j = message.tool_calls.length - 1; j >= 0; j--) {
      const toolFunction = extractToolFunction(message.tool_calls[j])
      if (toolFunction?.name !== "rest") continue
      const status = parseToolArguments(toolFunction.arguments).status
      return typeof status === "string" && status.trim() ? status.trim() : undefined
    }
  }
  return undefined
}

export function deriveResumeCheckpoint(messages: OpenAI.ChatCompletionMessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== "assistant") continue
    const textCheckpoint = checkpointTextFromAssistantContent(message.content)
    if (textCheckpoint) return truncateCheckpointText(textCheckpoint)
    const toolCheckpoint = checkpointTextFromAssistantToolCalls(message)
    if (toolCheckpoint) return truncateCheckpointText(toolCheckpoint)
  }
  return "no prior checkpoint recorded"
}

function extractAssistantPreview(messages: OpenAI.ChatCompletionMessageParam[], maxLength = 120): string {
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")
  if (!lastAssistant) return ""
  const text = contentToText(lastAssistant.content)
  if (!text) return ""
  /* v8 ignore next -- unreachable: contentToText().trim() guarantees a non-empty line @preserve */
  const firstLine = text.split("\n").find((line) => line.trim().length > 0) ?? ""
  if (firstLine.length <= maxLength) return firstLine
  return `${firstLine.slice(0, maxLength - 3)}...`
}

function extractToolCallNames(messages: OpenAI.ChatCompletionMessageParam[]): string[] {
  const names: string[] = []
  for (const msg of messages) {
    if (msg.role === "assistant" && "tool_calls" in msg && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if ("function" in tc && tc.function?.name) names.push(tc.function.name)
      }
    }
  }
  return [...new Set(names)]
}

function createPrivateRuntimeCallbacks(): ChannelCallbacks {
  return {
    settleOutputMode: "final_only",
    onModelStart: () => {},
    onModelStreamStart: () => {},
    onTextChunk: () => {},
    onReasoningChunk: () => {},
    onToolStart: () => {},
    onToolEnd: () => {},
    onError: () => {},
  }
}

export function privateRuntimeSessionPath(): string {
  return sessionPath(PRIVATE_RUNTIME_PENDING.friendId, PRIVATE_RUNTIME_PENDING.channel, PRIVATE_RUNTIME_PENDING.key)
}

function privateRuntimeStatePath(sessionFilePath: string): string {
  return path.join(path.dirname(sessionFilePath), "runtime.json")
}

function writePrivateRuntimeState(sessionFilePath: string, state: PrivateRuntimeStateSnapshot): void {
  const filePath = privateRuntimeStatePath(sessionFilePath)
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + "\n", "utf8")
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.private_runtime_state_error",
      message: "failed to write private-runtime state",
      meta: {
        status: state.status,
        reason: state.reason ?? null,
        path: filePath,
        /* v8 ignore next -- Node fs APIs throw Error objects for mkdirSync/writeFileSync failures @preserve */
        error: error instanceof Error ? error.message : String(error),
      },
    })
  }
}

/* v8 ignore start -- routing helpers: called from routing functions which are integration paths @preserve */
function writePendingEnvelope(pendingDir: string, message: PendingMessage): void {
  fs.mkdirSync(pendingDir, { recursive: true })
  const fileName = `${message.timestamp}-${Math.random().toString(36).slice(2, 10)}.json`
  const filePath = path.join(pendingDir, fileName)
  fs.writeFileSync(filePath, JSON.stringify(message, null, 2), "utf8")
}

function sessionMatchesActivity(
  activity: SessionActivityRecord,
  session: { friendId: string; channel: string; key: string },
): boolean {
  return activity.friendId === session.friendId
    && activity.channel === session.channel
    && activity.key === session.key
}
/* v8 ignore stop */

/* v8 ignore start -- routing: delivery now inline via surface tool; routing functions preserved for reuse @preserve */
function resolveBridgePreferredSession(
  delegatedFrom: NonNullable<PendingMessage["delegatedFrom"]>,
  sessionActivity: SessionActivityRecord[],
): SessionActivityRecord | null {
  if (!delegatedFrom.bridgeId) return null
  const bridge = createBridgeManager().getBridge(delegatedFrom.bridgeId)
  if (!bridge || bridge.lifecycle === "completed" || bridge.lifecycle === "cancelled") {
    return null
  }
  return sessionActivity.find((activity) =>
    activity.friendId === delegatedFrom.friendId
    && activity.channel !== "inner"
    && bridge.attachedSessions.some((session) => sessionMatchesActivity(activity, session)),
  ) ?? null
}

async function tryDeliverDelegatedCompletion(
  target: SessionActivityRecord,
  outboundEnvelope: PendingMessage,
): Promise<boolean> {
  if (target.channel !== "bluebubbles") {
    return false
  }

  const result = await sendProactiveBlueBubblesMessageToSession({
    friendId: target.friendId,
    sessionKey: target.key,
    text: outboundEnvelope.content,
    intent: "explicit_cross_chat",
  } as any)
  return result.delivered
}

export function enrichDelegatedFromWithBridge(delegatedFrom: DelegatedFrom): DelegatedFrom {
  if (delegatedFrom.bridgeId) {
    return delegatedFrom
  }
  const bridgeManager = createBridgeManager()
  const originBridges = bridgeManager.findBridgesForSession({
    friendId: delegatedFrom.friendId,
    channel: delegatedFrom.channel,
    key: delegatedFrom.key,
  })
  const activeBridge = originBridges.find((b) => b.lifecycle === "active")
  if (activeBridge) {
    return { ...delegatedFrom, bridgeId: activeBridge.id }
  }
  return delegatedFrom
}

function advanceObligationQuietly(
  agentName: string,
  obligationId: string | undefined,
  update: Parameters<typeof advanceReturnObligation>[2],
): void {
  if (!obligationId) return
  try {
    advanceReturnObligation(agentName, obligationId, update)
  /* v8 ignore start -- best-effort: obligation fs errors must never block return routing @preserve */
  } catch {
    // swallowed
  }
  /* v8 ignore stop */
}

export async function routeDelegatedCompletion(
  agentRoot: string,
  agentName: string,
  completion: CompletionMetadata | undefined,
  drainedPending: PendingMessage[] | undefined,
  timestamp: number,
): Promise<void> {
  const delegated = (drainedPending ?? []).find((message) => message.delegatedFrom)
  if (!delegated?.delegatedFrom || !completion?.answer?.trim()) {
    return
  }

  const delegatedFrom = enrichDelegatedFromWithBridge(delegated.delegatedFrom)
  const obligationId = delegated.obligationId

  // Advance any private-runtime return obligations from queued -> running (they were drained this turn).
  // drainedPending is guaranteed non-null here (we found delegated above).
  for (const msg of drainedPending!) {
    if (msg.obligationId) {
      advanceObligationQuietly(agentName, msg.obligationId, {
        status: "running",
        startedAt: timestamp,
      })
    }
  }

  if (delegated.obligationStatus === "pending") {
    // Fulfill the persistent obligation in the store
    try {
      const pending = findPendingObligationForOrigin(agentRoot, {
        friendId: delegatedFrom.friendId,
        channel: delegatedFrom.channel,
        key: delegatedFrom.key,
      })
      /* v8 ignore next 2 -- obligation fulfillment tested via obligations.test.ts; integration requires real disk state @preserve */
      if (pending) {
        fulfillObligation(agentRoot, pending.id)
      }
    } catch {
      /* v8 ignore next -- defensive: obligation store read failure should not break delivery @preserve */
    }
    emitNervesEvent({
      event: "senses.obligation_fulfilled",
      component: "senses",
      message: "obligation fulfilled via delegated completion",
      meta: {
        friendId: delegatedFrom.friendId,
        channel: delegatedFrom.channel,
        key: delegatedFrom.key,
      },
    })
  }
  const outboundEnvelope: PendingMessage = {
    from: agentName,
    friendId: delegatedFrom.friendId,
    channel: delegatedFrom.channel,
    key: delegatedFrom.key,
    content: completion.answer.trim(),
    timestamp,
    delegatedFrom,
    ...(obligationId ? { obligationId } : {}),
  }

  const sessionActivity = listSessionActivity({
    sessionsDir: path.join(agentRoot, "state", "sessions"),
    friendsDir: path.join(agentRoot, "friends"),
    agentName,
  })

  // Priority 1: Bridge-preferred session (if delegation was within a bridge).
  const bridgeTarget = resolveBridgePreferredSession(delegatedFrom, sessionActivity)
  if (bridgeTarget) {
    if (await tryDeliverDelegatedCompletion(bridgeTarget, outboundEnvelope)) {
      advanceObligationQuietly(agentName, obligationId, { status: "returned", returnedAt: timestamp, returnTarget: "bridge-session" })
      return
    }
    writePendingEnvelope(getPendingDir(agentName, bridgeTarget.friendId, bridgeTarget.channel, bridgeTarget.key), outboundEnvelope)
    advanceObligationQuietly(agentName, obligationId, { status: "returned", returnedAt: timestamp, returnTarget: "bridge-session" })
    return
  }

  // Priority 1.5: Direct return to originating session (ponder without bridge).
  // When delegatedFrom has specific channel+key, route directly there instead of searching for freshest.
  if (delegatedFrom.channel && delegatedFrom.key && delegatedFrom.channel !== "inner") {
    const directTarget = sessionActivity.find((a) =>
      a.friendId === delegatedFrom.friendId && a.channel === delegatedFrom.channel && a.key === delegatedFrom.key,
    )
    if (directTarget) {
      if (await tryDeliverDelegatedCompletion(directTarget, outboundEnvelope)) {
        advanceObligationQuietly(agentName, obligationId, { status: "returned", returnedAt: timestamp, returnTarget: "direct-originator" })
        return
      }
    }
    // Even if session isn't in activity list (might have ended), queue to its pending dir
    writePendingEnvelope(getPendingDir(agentName, delegatedFrom.friendId, delegatedFrom.channel, delegatedFrom.key), outboundEnvelope)
    advanceObligationQuietly(agentName, obligationId, { status: "returned", returnedAt: timestamp, returnTarget: "direct-originator" })
    return
  }

  // Priority 2: Freshest active friend session.
  // For BB, prefer DM sessions (;-;) over group chats (;+;) — proactive outreach should never land in groups.
  const allFriendSessions = listSessionActivity({
    sessionsDir: path.join(agentRoot, "state", "sessions"),
    friendsDir: path.join(agentRoot, "friends"),
    agentName,
  }).filter((s) => s.friendId === delegatedFrom.friendId && s.channel !== "inner")
  const bbDm = allFriendSessions.find((s) => s.channel === "bluebubbles" && s.key.includes(";-;"))
  const freshest = bbDm ?? allFriendSessions.find((s) => s.channel !== "bluebubbles" || s.key.includes(";-;")) ?? allFriendSessions[0]
  if (freshest) {
    if (await tryDeliverDelegatedCompletion(freshest, outboundEnvelope)) {
      advanceObligationQuietly(agentName, obligationId, { status: "returned", returnedAt: timestamp, returnTarget: "freshest-session" })
      return
    }
    writePendingEnvelope(getPendingDir(agentName, freshest.friendId, freshest.channel, freshest.key), outboundEnvelope)
    advanceObligationQuietly(agentName, obligationId, { status: "returned", returnedAt: timestamp, returnTarget: "freshest-session" })
    return
  }

  // Priority 3: Deferred return queue.
  writePendingEnvelope(getDeferredReturnDir(agentName, delegatedFrom.friendId), outboundEnvelope)
  advanceObligationQuietly(agentName, obligationId, { status: "deferred", returnedAt: timestamp, returnTarget: "deferred" })
}
/* v8 ignore stop */

// Self-referencing friend record for the private runtime (agent talking to itself).
// No real friend to resolve -- this satisfies the pipeline's friend resolver contract.
function createSelfFriend(agentName: string): FriendRecord {
  return {
    id: "self",
    name: agentName,
    trustLevel: "family",
    externalIds: [],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    schemaVersion: 1,
  }
}

function buildOwnerPresentationPreferences(friend: FriendRecord): string {
  const lines = [
    `## ${friend.name}'s presentation preferences`,
    "Use this relationship context to decide whether and how to contact the owner. It is presentation-only and grants no mutation authority.",
  ]
  lines.push(...renderRelationshipPreferences(friend))
  if (lines.length === 2) lines.push("- No presentation preferences have been learned yet; be calm, concise, and useful.")
  return lines.join("\n")
}

// No-op friend store for the private runtime. It doesn't track token usage per-friend.
function createNoOpFriendStore(): FriendStore {
  return {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    findByExternalId: async () => null,
  }
}

export function buildParseErrorNudge(parseErrors: HabitParseErrorInfo[]): string {
  if (parseErrors.length === 0) return ""
  const lines = parseErrors.map(
    (e) => `I noticed my habit file \`${e.file}\` has invalid frontmatter — I should fix it. (${e.error})`,
  )
  return lines.join("\n")
}

export function buildHeldReturnWakeMessage(): string {
  return [
    "held return work arrived; use the current held-work frame above as the authority for this turn.",
    "Older checkpoints, rest summaries, transcript memories, completed returns, and repeated probes are historical context, not evidence about what is waiting now.",
    "Return only the requested result; do not add commentary about prior attempts, old loops, or completed probes.",
    "Return each listed item with surface(delegationId=...) before resting or settling.",
  ].join("\n")
}

function buildExternalEventLeaseMessage(event: ExternalEventLeaseContext): string {
  const members = [event, ...(event.relatedEvents ?? [])]
  return [
    "[current external-event disposition contract]",
    "This exact lease frame is authoritative for this turn. Ignore older receipts, failed tool arguments, held-work summaries, and checkpoints when choosing disposition arguments.",
    "Investigate the current observation, then call external_event_disposition once for every listed lease before settling.",
    ...members.flatMap((member, index) => [
      "",
      `lease ${index + 1}:`,
      `recordPath: ${JSON.stringify(member.recordPath)}`,
      `expectedGeneration: ${member.generation}`,
      `classifiedRevision: ${JSON.stringify(member.observationRevision)}`,
    ]),
  ].join("\n")
}

function externalEventLeaseKey(event: ExternalEventLeaseContext): string {
  return JSON.stringify([event.recordPath, event.generation, event.observationRevision, event.claimOwner])
}

function buildAlsoDueLine(agentRoot: string, currentHabitName: string, now: () => Date): string {
  const habitsDir = path.join(agentRoot, "habits")
  let files: string[]
  try {
    files = fs.readdirSync(habitsDir)
  } catch {
    return ""
  }

  const nowMs = now().getTime()
  const alsoDue: string[] = []

  for (const file of files) {
    if (!file.endsWith(".md")) continue
    const stem = file.replace(/\.md$/, "")
    if (stem === currentHabitName) continue

    try {
      const content = fs.readFileSync(path.join(habitsDir, file), "utf-8")
      const habit = applyHabitRuntimeState(agentRoot, parseHabitFile(content, path.join(habitsDir, file)))
      if (habit.status !== "active" || !habit.cadence) continue

      const cadenceMs = parseCadenceToMs(habit.cadence)
      if (cadenceMs === null) continue

      if (habit.lastRun === null) {
        alsoDue.push(stem)
        continue
      }

      const lastRunMs = new Date(habit.lastRun).getTime()
      if (nowMs - lastRunMs >= cadenceMs) {
        alsoDue.push(stem)
      }
    } catch {
      // skip unreadable habits
    }
  }

  if (alsoDue.length === 0) return ""
  return `also due: ${alsoDue.join(", ")}`
}

function buildHabitSurfacePolicy(origin: HabitOrigin | null, surface: HabitSurface): string {
  const lines = ["## habit surface policy"]
  lines.push("this habit runs privately, but it may message outward when it needs input, has a useful answer, is blocked, or should report status.")
  if (surface.family) lines.push("- family recipients are allowed by default.")
  if (surface.originator && origin) lines.push(`- the originator is allowed: ${origin.friendId} via ${origin.channel}/${origin.key}.`)
  if (surface.originator && !origin) lines.push("- originator messaging is enabled, but this habit has no origin metadata.")
  if (surface.extra.length > 0) lines.push(`- extra allowed recipients: ${surface.extra.join(", ")}.`)
  lines.push("- use send_message for intentional contact; use surface only for a held return tied to an existing return obligation.")
  return lines.join("\n")
}

function reduceHabitSessionToNoSend(
  habitSession: HabitSessionToolContext | undefined,
): HabitSessionToolContext {
  const deniedTools = new Set([
    ...(habitSession?.permissionEnvelope.deniedTools ?? []),
    ...(habitSession?.toolPolicy.grantedTools ?? []),
    ...(habitSession?.toolPolicy.deniedTools ?? []),
    "send_message",
    "surface",
  ])
  return {
    ...habitSession,
    noSend: true,
    permissionEnvelope: {
      schemaVersion: 1,
      canMessageOutward: false,
      returnRoutes: [],
      deniedTools: [...deniedTools],
      warnings: [...(habitSession?.permissionEnvelope.warnings ?? [])],
    },
    toolPolicy: {
      requestedTools: habitSession?.toolPolicy.requestedTools ?? null,
      grantedTools: [],
      deniedTools: [...deniedTools],
      outwardMessagingAllowed: false,
    },
  }
}

export async function runPrivateRuntimeTurn(options?: RunPrivateRuntimeTurnOptions): Promise<PrivateRuntimeTurnResult> {
  const now = options?.now ?? (() => new Date())
  const reason = options?.reason ?? "instinct"
  const sessionFilePath = options?.habitSession?.sessionPath ?? privateRuntimeSessionPath()
  const agentName = getAgentName()
  const privateTurnDecision = assertPrivateTurnDecisionAllowed({
    decision: options?.privateTurnDecision,
    agentName,
    options,
    now,
  })
  if (!claimPrivateTurnExecution(privateTurnDecision, now)) {
    return {
      messages: [],
      usage: undefined,
      sessionPath: sessionFilePath,
      turnOutcome: "rested",
      restStatus: DUPLICATE_PRIVATE_TURN_STATUS,
    }
  }
  writePrivateRuntimeState(sessionFilePath, {
    status: "running",
    reason,
    startedAt: now().toISOString(),
  })

  const runWithLease = options?._withSessionTurnLease ?? withSessionTurnLease
  return await runWithLease(sessionFilePath, async (sessionTurnLease) => {
  try {
  const loaded = loadSession(sessionFilePath)
  const existingMessages = loaded?.messages ? [...loaded.messages] : []
  const instincts = options?.instincts ?? loadPrivateRuntimeInstincts()
  const state: PrivateRuntimeTurnState = {
    cycleCount: 1,
    resting: false,
    lastHeartbeatAt: now().toISOString(),
  }
  const pendingDir = options?.habitSession?.pendingDir ?? getPrivateRuntimePendingDir(agentName)
  const shouldUseHeldReturnWake =
    !options?.taskId && reason !== "habit" && reason !== "await"
      ? listActiveReturnObligations(agentName).length > 0
      : false

  // ── Adapter concern: build user message ──────────────────────────
  let userContent: string
  let habitTools: string[] | undefined
  let habitParsedSuccessfully = false
  let parsedAwait: AwaitFile | null = null
  const isPayloadSpecificWake =
    !!options?.taskId
    || (reason === "habit" && !!options?.habitName)
    || (reason === "await" && !!options?.awaitName)

  if (existingMessages.length === 0 && !isPayloadSpecificWake) {
    // Fresh session: bootstrap message with non-canonical cleanup nudge
    const aspirations = readAspirations(getAgentRoot())
    const nonCanonical = findNonCanonicalBundlePaths(getAgentRoot())
    const cleanupNudge = buildNonCanonicalCleanupNudge(nonCanonical)
    userContent = [
      buildPrivateRuntimeBootstrapMessage(aspirations, "No prior private-runtime session found."),
      cleanupNudge,
    ].filter(Boolean).join("\n\n")
  } else {
    // Resumed session: task-triggered or instinct message with checkpoint context
    const assistantTurns = existingMessages.filter((message) => message.role === "assistant").length
    state.cycleCount = assistantTurns + 1
    state.checkpoint = deriveResumeCheckpoint(existingMessages)

    if (options?.taskId) {
      const taskContent = readTaskFile(getAgentRoot(), options.taskId)
      userContent = buildTaskTriggeredMessage(options.taskId, taskContent, state.checkpoint)
    } else if (reason === "habit" && options?.habitName) {
      const agentRoot = getAgentRoot()
      const habitName = options.habitName
      const habitFilePath = path.join(agentRoot, "habits", `${habitName}.md`)
      const preparedHabit = options.preparedHabit?.habit.name === habitName ? options.preparedHabit.habit : null
      const rsvpHabit = isRsvpHabitName(habitName)

      // Read and parse the habit file
      let habitBody: string | undefined
      let habitTitle: string = habitName
      let habitLastRun: string | null = null
      let habitOrigin: HabitOrigin | null = null
      let habitSurface: HabitSurface = { family: true, originator: true, extra: [] }
      if (preparedHabit) {
        if (rsvpHabit && !preparedHabit.rsvp) {
          const detail = preparedHabit.status === "degraded"
            ? preparedHabit.degradedDetail
            : null
          throw new Error(`RSVP habit metadata is required before private runtime execution: ${detail ?? habitName}`)
        }
        const blockedReason = privateRuntimeHabitRejectionReason(preparedHabit, "private-runtime")
        if (blockedReason) throw new Error(blockedReason)
      }

      let currentHabit: HabitFile
      try {
        const habitContent = fs.readFileSync(habitFilePath, "utf-8")
        currentHabit = applyHabitRuntimeState(agentRoot, parseHabitFile(habitContent, habitFilePath))
      } catch (error) {
        const readReason = error instanceof Error ? error.message : String(error)
        if (rsvpHabit) {
          throw new Error(`RSVP habit metadata is required before private runtime execution: ${readReason}`)
        }
        const degraded = createDegradedHabitFile(habitFilePath, "read_error", "", readReason)
        const blockedReason = privateRuntimeHabitRejectionReason(degraded, "private-runtime")
        throw new Error(blockedReason)
      }
      if (rsvpHabit && !currentHabit.rsvp) {
        const detail = currentHabit.status === "degraded" ? currentHabit.degradedDetail : null
        throw new Error(`RSVP habit metadata is required before private runtime execution: ${detail ?? habitName}`)
      }
      const currentBlockedReason = privateRuntimeHabitRejectionReason(currentHabit, "private-runtime")
      if (currentBlockedReason) throw new Error(currentBlockedReason)
      const executableHabit = preparedHabit ?? currentHabit

      habitBody = executableHabit.body || undefined
      habitTitle = executableHabit.title || habitName
      habitLastRun = executableHabit.lastRun
      habitTools = executableHabit.tools
      habitOrigin = executableHabit.origin
      habitSurface = executableHabit.surface

      // If the habit file couldn't be read at all (no body, no title parsed), error message
      if (habitBody === undefined && habitTitle === habitName) {
        userContent = `habit "${habitName}" could not be read (file not found or unreadable). check habits/${habitName}.md exists.`
      } else {
        habitParsedSuccessfully = true
        // Unified path: gather context for ALL habits (heartbeat included)
        const obligations = listActiveReturnObligations(agentName)
        const nowMs = now().getTime()
        const staleObligations = obligations.map((o) => ({
          friendName: o.origin.friendId,
          content: o.delegatedContent,
          stalenessMs: nowMs - o.createdAt,
        }))

        const alsoDue = buildAlsoDueLine(agentRoot, habitName, now)
        const arcResume = formatFlightRecorderResume(readFlightRecorderResume(agentRoot))
        const deskOrientation = deskRecordOrientationSection(agentRoot, now())
        const surfacePolicy = buildHabitSurfacePolicy(habitOrigin, habitSurface)

        // Degraded state (best-effort: never crash)
        let degradedComponents: { component: string; reason: string }[] = []
        try {
          const health = readHealth(getDefaultHealthPath())
          if (health && health.degraded.length > 0) {
            degradedComponents = health.degraded.map((d) => ({ component: d.component, reason: d.reason }))
          }
        } catch {
          // Best-effort: missing file or parse error -> empty array, no crash
        }

        userContent = buildHabitTurnMessage({
          habitName,
          habitTitle,
          habitBody,
          lastRun: habitLastRun,
          checkpoint: displayCheckpoint(state.checkpoint),
          alsoDue: alsoDue || undefined,
          staleObligations,
          parseErrors: options?.parseErrors ?? [],
          degradedComponents,
          arcResume,
          deskOrientation,
          surfacePolicy,
          priorSessionSummary: options.preparedHabit?.habit.name === habitName ? options.preparedHabit.priorSessionSummary : undefined,
          now,
        })
      }
    } else if (reason === "await" && options?.awaitName) {
      const agentRoot = getAgentRoot()
      const awaitName = options.awaitName
      const awaitFilePath = path.join(agentRoot, "awaiting", `${awaitName}.md`)
      let awaitBody: string | undefined
      let condition: string | null = null
      let lastCheckedAt: string | null = null
      let lastObservation: string | null = null
      let checkedCount = 0
      let awaitFound = false
      try {
        const awaitContent = fs.readFileSync(awaitFilePath, "utf-8")
        const parsed = applyAwaitRuntimeState(agentRoot, parseAwaitFile(awaitContent, awaitFilePath)) as ReturnType<typeof parseAwaitFile> & Partial<AwaitRuntimeState>
        parsedAwait = parsed
        awaitFound = true
        awaitBody = parsed.body || undefined
        condition = parsed.condition
        lastCheckedAt = parsed.last_checked ?? null
        lastObservation = parsed.last_observation ?? null
        checkedCount = parsed.checked_count ?? 0
      } catch {
        // file missing — fall through to error message
      }

      if (!awaitFound || !condition) {
        userContent = `await "${awaitName}" could not be read (file not found or no condition). check awaiting/${awaitName}.md.`
      } else {
        userContent = buildAwaitTurnMessage({
          awaitName,
          condition,
          body: awaitBody,
          lastCheckedAt,
          lastObservation,
          checkedCount,
          checkpoint: displayCheckpoint(state.checkpoint),
          now,
        })
      }
    } else {
      userContent = buildInstinctUserMessage(instincts, reason, state)
    }
  }

  if (options?.externalEvent) {
    userContent = buildExternalEventLeaseMessage(options.externalEvent)
  } else if (shouldUseHeldReturnWake) {
    userContent = buildHeldReturnWakeMessage()
  }

  // ── Session loader: wraps existing session logic ──────────────────
  const innerCapabilities = getChannelCapabilities("inner")
  const selfFriend = createSelfFriend(agentName)
  const selfContext: ResolvedContext = { friend: selfFriend, channel: innerCapabilities }

  const mcpManager = await getSharedMcpManager() ?? undefined
  const relationshipAwaitCoordinatesValue = parsedAwait ? relationshipAwaitCoordinates(parsedAwait) : null
  const relationshipAwait = relationshipAwaitCoordinatesValue
      ? await (async () => {
        const agentRoot = getAgentRoot(agentName)
        const assertLiveBinding = () => {
          const binding = relationshipAwaitCoordinatesValue.channel === "external-event"
            ? parsedAwait!.wake_at && hasActiveExternalEventAwait(agentName, { recordPath: relationshipAwaitCoordinatesValue.key, awaitName: parsedAwait!.name, wakeAt: parsedAwait!.wake_at })
              ? { active: true as const }
              : { active: false as const, reason: "external event disposition is no longer active" }
            : inspectRelationshipFollowUp(agentRoot, {
              friendId: relationshipAwaitCoordinatesValue.friendId,
              channel: relationshipAwaitCoordinatesValue.channel,
              key: relationshipAwaitCoordinatesValue.key,
              requestId: relationshipAwaitCoordinatesValue.requestId!,
              awaitName: parsedAwait!.name,
              now: now().getTime(),
            })
          if (!binding.active) {
            cancelStaleAwait(agentRoot, agentName, parsedAwait!.name, binding.reason)
            throw new Error(`Relationship await authority binding is missing, stale, or ambiguous: ${binding.reason}`)
          }
        }
        assertLiveBinding()
        const store = new FileFriendStore(path.join(agentRoot, "friends"))
        const resolve = () => resolveRelationshipAwaitAuthority(agentRoot, store, loadRelationshipCapabilityRegistry(agentRoot), relationshipAwaitCoordinatesValue)
        const resolveOrCancel = async () => {
          try {
            return await resolve()
          } catch (error) {
            if (error instanceof StaleRelationshipAwaitError) cancelStaleAwait(agentRoot, agentName, parsedAwait!.name, error.reason)
            throw error
          }
        }
        const initial = await resolveOrCancel()
        return {
          store,
          context: { friend: initial.friend, channel: innerCapabilities } as ResolvedContext,
          currentSession: {
            friendId: relationshipAwaitCoordinatesValue.friendId,
            channel: relationshipAwaitCoordinatesValue.channel,
            key: relationshipAwaitCoordinatesValue.key,
            sessionPath: relationshipAwaitCoordinatesValue.channel === "telegram"
              ? getSenseSessionPath(agentName, relationshipAwaitCoordinatesValue.friendId, "telegram", relationshipAwaitCoordinatesValue.key, agentRoot)
              : sessionFilePath,
          },
          relationshipAuthorization: {
            ...(relationshipAwaitCoordinatesValue.requestId ? { requestId: relationshipAwaitCoordinatesValue.requestId } : {}),
            profileId: initial.authorization.profileId,
            authorizedContextScopes: initial.authorization.authorizedContextScopes,
            advertisedToolNames: relationshipAwaitCoordinatesValue.channel === "external-event" ? ["resolve_await"] : initial.authorization.advertisedToolNames,
            authorizeTool: async (name: string, args: Record<string, string>) => {
              assertLiveBinding()
              const decision = (await resolveOrCancel()).authorization.authorizeTool(name, args)
              return relationshipAwaitCoordinatesValue.channel !== "external-event" || name === "resolve_await"
                ? decision
                : { ...decision, allowed: false as const, reason: "external event await wake is resolve-only" }
            },
          },
        }
      })()
    : undefined
  const committedExternalEventLeases = new Set<string>()
  const externalEventRelationship = options?.externalEvent
    ? await (async () => {
        const agentRoot = getAgentRoot(agentName)
        const store = new FileFriendStore(path.join(agentRoot, "friends"))
        const registry = loadRelationshipCapabilityRegistry(agentRoot)
        const resolve = () => resolveProfileScopedRelationshipAuthorization({
          store,
          registry,
          relationshipProfileId: "sanctuary-owner",
          profileId: "sanctuary-event",
        })
        const initial = await resolve()
        const initialDisposition = initial.authorizeTool("external_event_disposition")
        if (!initialDisposition.allowed) throw new Error(`external event relationship authority denied: ${initialDisposition.reason}`)
        const owners = (await store.listAll()).filter((friend) => friend.capabilityProfileId === "sanctuary-owner")
        const [owner] = owners
        if (owners.length !== 1 || !owner) throw new Error("external event owner presentation context must resolve to exactly one Friend")
        return {
          store,
          context: { friend: owner, channel: innerCapabilities } as ResolvedContext,
          ownerPresentationPreferences: buildOwnerPresentationPreferences(owner),
          relationshipAuthorization: {
            profileId: initial.profileId,
            authorizedContextScopes: initial.authorizedContextScopes,
            advertisedToolNames: initial.advertisedToolNames,
            authorizeTool: async (name: string) => (await resolve()).authorizeTool(name),
          },
          externalEventAuthority: {
            authorizeDisposition: () => {
              const decision = initial.authorizeTool("external_event_disposition")
              return decision.allowed ? { allowed: true, reason: "relationship-authorized" } : { allowed: false, reason: decision.reason }
            },
            recordCommittedDisposition: (event: ExternalEventLeaseContext) => {
              committedExternalEventLeases.add(externalEventLeaseKey(event))
            },
          },
          externalEventEffects: {
            deliverOwnerDecision: async (input: { source: string; eventId: string; generation: number; text: string }) => {
              const { sendTelegramExternalEventDecision } = await import("./telegram")
              await sendTelegramExternalEventDecision(agentName, input)
            },
          },
        }
      })()
    : undefined

  if (externalEventRelationship) userContent = `${userContent}\n\n${externalEventRelationship.ownerPresentationPreferences}`
  const userMessage: OpenAI.ChatCompletionMessageParam = { role: "user", content: userContent }

  // ── Habit tool enforcement ───────────────────────────────────────
  let habitToolsResolved: OpenAI.ChatCompletionFunctionTool[] | undefined
  if (habitTools !== undefined) {
    const fullTools = getToolsForChannel(innerCapabilities)
    habitToolsResolved = fullTools.filter((t) => habitTools!.includes(t.function.name))
    emitNervesEvent({
      event: "habit.tools_restricted",
      component: "senses",
      message: "habit running with restricted tools",
      meta: {
        habitName: options?.habitName,
        declared: habitTools,
        resolved: habitToolsResolved.map((t) => t.function.name),
      },
    })
  } else if (reason === "habit" && options?.habitName && habitParsedSuccessfully) {
    emitNervesEvent({
      event: "habit.tools_unrestricted",
      component: "senses",
      message: "habit running with full tool repertoire",
      meta: { habitName: options.habitName },
    })
  }
  if (options?.noSend === true) {
    habitToolsResolved = []
  }
  const externalEventToolsResolved = options?.externalEvent
    ? getSanctuaryRelationshipTools(externalEventRelationship!.relationshipAuthorization.advertisedToolNames)
    : undefined
  const relationshipAwaitToolsResolved = relationshipAwait
    ? getSanctuaryRelationshipTools(relationshipAwait.relationshipAuthorization.advertisedToolNames)
    : undefined

  const effectiveHabitSession = options?.noSend === true
    ? reduceHabitSessionToNoSend(options.habitSession)
    : options?.habitSession

  const sessionLoader = {
    loadOrCreate: async () => {
      if (existingMessages.length > 0) {
        return {
          messages: existingMessages,
          sessionPath: sessionFilePath,
          structuredOutputs: loaded?.structuredOutputs,
        }
      }
      // Fresh session: build system prompt
      const systemPrompt = await buildSystem("inner", {
        toolChoiceRequired: true,
        flightRecorderResume: readFlightRecorderResume(getAgentRoot()),
      })
      return {
        messages: [{ role: "system" as const, content: flattenSystemPrompt(systemPrompt) }],
        sessionPath: sessionFilePath,
        structuredOutputs: [],
      }
    },
  }

  // ── Call shared pipeline ──────────────────────────────────────────
  const callbacks = createPrivateRuntimeCallbacks()
  const traceId = createTraceId()

  // Attention queue: built when pending messages are drained, shared with tool context
  let attentionQueue: AttentionItem[] = []

  const externalRunStartedAt = now().toISOString()
  const externalRunBase = options?.externalEvent ? {
    agent: agentName,
    triggerType: "inbound" as const,
    sourceKind: "private-runtime" as const,
    senseOrHabit: "external-event",
    target: { source: options.externalEvent.source, eventId: options.externalEvent.eventId, generation: options.externalEvent.generation, observationRevision: options.externalEvent.observationRevision },
    idempotencyScope: { recordPath: options.externalEvent.recordPath, generation: options.externalEvent.generation, observationRevision: options.externalEvent.observationRevision },
    startedAt: externalRunStartedAt,
  } : null
  if (externalRunBase) appendRunLedgerRecordNonFatal(getAgentRoot(agentName), createRunLedgerRecord({ ...externalRunBase, lifecycle: "started" }))
  let result: Awaited<ReturnType<typeof handleInboundTurn>>
  try {
    result = await handleInboundTurn({
    channel: "inner",
    sessionKey: "dialog",
    capabilities: innerCapabilities,
    messages: [userMessage],
    continuityIngressTexts: [],
    callbacks,
    sessionTurnLease,
    friendResolver: { resolve: () => Promise.resolve(selfContext) },
    sessionLoader,
    pendingDir,
    friendStore: createNoOpFriendStore(),
    enforceTrustGate,
    drainPending,
    runAgent,
    postTurn: (turnMessages, sessionPathArg, usage, hooks, state) => {
      const prepared = postTurnTrim(turnMessages, usage, hooks)
      return deferPostTurnPersist(sessionPathArg, prepared, usage, state)
    },
    accumulateFriendTokens,
    signal: options?.signal,
    /* v8 ignore start -- attention queue: callback invoked by pipeline during pending drain; tested via attention-queue unit tests @preserve */
    onPendingDrained: (drained) => {
      const outstandingObligations = listActiveReturnObligations(agentName)
      const builtAttentionQueue = buildAttentionQueue({
        drainedPending: drained,
        outstandingObligations,
        friendNameResolver: (friendId) => {
          try {
            const raw = fs.readFileSync(path.join(getAgentRoot(agentName), "friends", friendId + ".json"), "utf-8")
            const parsed = JSON.parse(raw)
            return typeof parsed.name === "string" ? parsed.name : null
          } catch {
            return null
          }
        },
        packetResolver: (packetId) => {
          try {
            return readPonderPacket(getAgentRoot(agentName), packetId)
          } catch {
            return null
          }
        },
      })
      attentionQueue.splice(0, attentionQueue.length, ...builtAttentionQueue)
      const attentionFrame = buildAttentionQueueStatusFrame(attentionQueue)
      return attentionFrame ? [attentionFrame] : []
    },
    /* v8 ignore stop */
    runAgentOptions: {
      traceId,
      toolChoiceRequired: true,
      mcpManager,
      ...(options?.externalEvent
        ? { tools: externalEventToolsResolved }
        : relationshipAwaitToolsResolved !== undefined ? { tools: relationshipAwaitToolsResolved }
        : habitToolsResolved !== undefined ? { tools: habitToolsResolved } : {}),
      toolContext: {
        signin: async () => undefined,
        delegatedOrigins: attentionQueue,
        ...(relationshipAwait ? {
          friendStore: relationshipAwait.store,
          context: relationshipAwait.context,
          currentSession: relationshipAwait.currentSession,
          relationshipAuthorization: relationshipAwait.relationshipAuthorization,
        } : {}),
        ...(options?.externalEvent ? {
          currentExternalEvent: Object.freeze({ ...options.externalEvent }),
          friendStore: externalEventRelationship!.store,
          context: externalEventRelationship!.context,
          relationshipAuthorization: externalEventRelationship!.relationshipAuthorization,
          externalEventAuthority: externalEventRelationship!.externalEventAuthority,
          externalEventEffects: externalEventRelationship!.externalEventEffects,
          ...(["sanctuary-health", "sanctuary-usenet"].includes(options.externalEvent.source) ? createSanctuaryToolContext(agentName) : {}),
        } : {}),
        ...(options?.noSend ? { noSend: true } : {}),
        ...(effectiveHabitSession ? { habitSession: effectiveHabitSession } : {}),
      },
      ...(effectiveHabitSession ? { habitSession: effectiveHabitSession } : {}),
    },
    })
    if (options?.externalEvent && ["settled", "observed", "rested"].includes(String(result.turnOutcome))) {
      const incomplete = [options.externalEvent, ...(options.externalEvent.relatedEvents ?? [])]
        .filter((event) => !committedExternalEventLeases.has(externalEventLeaseKey(event)))
      if (incomplete.length > 0) {
        throw new Error(`External-event turn did not commit dispositions for every exact lease (${incomplete.length} incomplete)`)
      }
    }
    if (externalRunBase) {
      const lifecycle = result.turnOutcome === "settled" || result.turnOutcome === "observed" || result.turnOutcome === "rested"
        ? "completed" as const
        : result.turnOutcome === "errored" ? "error" as const
          : result.turnOutcome === "blocked" || result.turnOutcome === "suspended" ? "blocked" as const
            : "skipped" as const
      appendRunLedgerRecordNonFatal(getAgentRoot(agentName), createRunLedgerRecord({ ...externalRunBase, lifecycle, endedAt: now().toISOString(), usage: usageMetadataFromUsageData(result.usage, result.usage ? "provider" : "reported-unavailable"), ...(result.turnOutcome === "errored" ? { errorName: "AgentTurnError" } : {}) }))
    }
  } catch (error) {
    if (externalRunBase) appendRunLedgerRecordNonFatal(getAgentRoot(agentName), createRunLedgerRecord({ ...externalRunBase, lifecycle: "error", endedAt: now().toISOString(), errorName: error instanceof Error ? error.name : "UnknownError" }))
    throw error
  }
  // Post-turn routeDelegatedCompletion removed: delivery is now inline via surface tool.
  // settle in the private runtime produces no CompletionMetadata, so routeDelegatedCompletion
  // would be a no-op. The routing infrastructure is reused by the surface handler.

  const resultMessages = result.messages ?? []
  const assistantPreview = extractAssistantPreview(resultMessages)
  const toolCalls = extractToolCallNames(resultMessages)

  emitNervesEvent({
    component: "senses",
    event: "senses.private_runtime_turn",
    message: "private-runtime turn completed",
    meta: {
      reason,
      session: sessionFilePath,
      ...(options?.taskId && { taskId: options.taskId }),
      ...(assistantPreview && { assistantPreview }),
      ...(toolCalls.length > 0 && { toolCalls }),
      ...(result.usage && {
        promptTokens: result.usage.input_tokens,
        completionTokens: result.usage.output_tokens,
        totalTokens: result.usage.total_tokens,
      }),
    },
  })

  return {
    messages: resultMessages,
    usage: result.usage,
    sessionPath: result.sessionPath ?? sessionFilePath,
    completion: result.completion,
    turnOutcome: result.turnOutcome,
    restStatus: latestRestStatus(resultMessages),
  }
  } finally {
    writePrivateRuntimeState(sessionFilePath, {
      status: "idle",
      lastCompletedAt: now().toISOString(),
    })
  }
  })
}
