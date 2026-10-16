import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import type { FriendRecord, FriendStore } from "@ouro.bot/friends"
import { getAgentRoot } from "../../heart/identity"
import type { DaemonResponse } from "../../heart/daemon/daemon"
import { emitNervesEvent } from "../../nerves/runtime"
import { SELF_FRIEND_ID } from "../../repertoire/tools-base"
import { agentPresentation, readAgentPresentation, type AgentPresentation } from "./agent-presentation"
import { feedbackStorePath, openFeedbackStore, type FeedbackRecipient, type FeedbackStore } from "./feedback-store"
import type { FeedbackOrigin } from "./feedback-source"
import type { ShepherdHost } from "./host"
import { redactSecrets } from "./redact"
import { readReturns, type ReturnRecord } from "./returns"
import { localShepherdFriendStore, machineShepherdHost, resolveExistingLocalOwner, SHEPHERD_UUID } from "./surface"

export interface FeedbackSubmission { requestId: string; feedback: string; context?: string }
export interface FeedbackRequest { agent: string; friendId: string; origin: FeedbackOrigin; submission: FeedbackSubmission }
export type FeedbackCommand = { kind: "agent.shepherdFeedback" } & FeedbackRequest
  | { kind: "agent.shepherdFeedbackStatus"; agent: string; friendId: string; requestId: string }
export interface FeedbackReceipt { id: string; receipt: string; state: "pending" | "claimed" | "complete" | "uncertain" }
export interface FeedbackSubmitDeps {
  agentRoot: string
  store: FeedbackStore
  host: () => ShepherdHost
  friendStore: Pick<FriendStore, "get">
  resolveOwner: () => Promise<string>
  presentation: () => AgentPresentation
  returns: () => ReturnRecord[]
  now: () => string
}
function refuse(reason: string): never {
  emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_feedback_submit_refused",
    message: "native feedback submission refused", meta: { reason } })
  throw new Error(`Shepherd feedback: ${reason}`)
}
function validate(submission: FeedbackSubmission): void {
  if (!submission || typeof submission !== "object" || Object.keys(submission).some(key => !["requestId", "feedback", "context"].includes(key)) ||
    typeof submission.requestId !== "string" || !SHEPHERD_UUID.test(submission.requestId) ||
    typeof submission.feedback !== "string" || !submission.feedback.trim() || submission.feedback.length > 2000 ||
    submission.context !== undefined && (typeof submission.context !== "string" || Buffer.byteLength(JSON.stringify(submission.context)) > 8192)) {
    refuse("invalid feedback request")
  }
}
function fingerprint(submission: FeedbackSubmission): string {
  return createHash("sha256").update(JSON.stringify([submission.requestId, submission.feedback, submission.context ?? null])).digest("hex")
}
function clean(value: string): string {
  return redactSecrets(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
}
export function feedbackRecipient(friend: FriendRecord | null): FeedbackRecipient {
  if (!friend || friend.id === SELF_FRIEND_ID || friend.trustLevel !== "family" || friend.admissionState === "revoked") refuse("existing family Teams recipient required")
  const identities = new Map(friend.externalIds.filter(identity => identity.provider === "aad" && !identity.externalId.startsWith("group:"))
    .map(identity => [`${identity.tenantId ?? ""}:${identity.externalId.toLowerCase()}`, identity]))
  if (identities.size !== 1) refuse("unique private Teams identity required")
  const identity = [...identities.values()][0]!
  if (!identity.externalId.trim() || identity.externalId.length > 512 || (identity.tenantId?.length ?? 0) > 512) refuse("invalid Teams identity")
  return { friendId: friend.id, aadObjectId: identity.externalId.toLowerCase(), tenantId: identity.tenantId ?? null }
}
function defaultDeps(agent: string): FeedbackSubmitDeps {
  agentPresentation(agent, {})
  const agentRoot = getAgentRoot(agent)
  const friendStore = localShepherdFriendStore(agent)
  return {
    agentRoot, friendStore, store: openFeedbackStore(feedbackStorePath(agentRoot)),
    host: () => machineShepherdHost(agent),
    resolveOwner: () => resolveExistingLocalOwner(friendStore),
    presentation: () => readAgentPresentation(agent, agentRoot),
    returns: () => readReturns(agentRoot),
    now: () => new Date().toISOString(),
  }
}
export async function submitShepherdFeedback(input: FeedbackRequest, injected?: FeedbackSubmitDeps): Promise<FeedbackReceipt> {
  validate(input.submission)
  agentPresentation(input.agent, {})
  if (!injected && !fs.existsSync(path.join(getAgentRoot(input.agent), "agent.json"))) refuse("existing configured agent required")
  const deps = injected ?? defaultDeps(input.agent)
  try {
    if (!input.friendId || input.friendId === SELF_FRIEND_ID || await deps.resolveOwner() !== input.friendId) refuse("existing local-family owner required")
    const id = `feedback:${input.submission.requestId}`
    const bodyHash = fingerprint(input.submission)
    const prior = deps.store.read(id, input.friendId)
    if (prior) {
      if (prior.bodyHash !== bodyHash) refuse("request ID has a different body")
      return { id, receipt: prior.receipt, state: prior.review.state }
    }
    const recipient = feedbackRecipient(await deps.friendStore.get(input.friendId))
    if (!input.origin || Object.keys(input.origin).length !== 1 || typeof input.origin.tty !== "string" ||
      !/^\/dev\/(?:tty[s]?[A-Za-z0-9]+|pts\/[0-9]+)$/.test(input.origin.tty)) refuse("native terminal origin required")
    const host = deps.host()
    if (host.name !== "cmux") refuse("native terminal host unsupported")
    const matches = (await host.list()).filter(session => session.tty?.replace(/^\/dev\//, "") === input.origin.tty.slice(5))
    const source = matches[0]
    if (matches.length !== 1 || !source || !SHEPHERD_UUID.test(source.id) ||
      !/^(?:claude(?: code)?|copilot(?: cli)?|codex|agency(?: .+)?)$/i.test(source.agent ?? "")) refuse("unique coding terminal required")
    if (source.cwd && clean(source.cwd) !== source.cwd) refuse("unsafe terminal metadata")
    const latest = deps.returns().filter(record => record.host === host.name && record.session === source.id).at(-1) ?? null
    const screen = clean(await host.read(source.id, 80))
    if (Buffer.byteLength(JSON.stringify(screen)) > 16384) refuse("terminal evidence byte limit")
    const name = deps.presentation().name
    const record = deps.store.submit({
      id, actorId: input.friendId, agent: input.agent, bodyHash, createdAt: deps.now(),
      source: { id: source.id, host: "cmux", label: clean([source.agent, source.workspaceTitle, source.title].filter(Boolean).join(" / ")).slice(0, 1024),
        tty: input.origin.tty, cwd: source.cwd ?? null, task: latest?.cwd === source.cwd ? latest?.task ?? null : null },
      packet: { feedback: clean(input.submission.feedback), context: input.submission.context === undefined ? null : clean(input.submission.context),
        screen, previousReturn: latest === null ? null : JSON.parse(JSON.stringify(latest, (_key, value: unknown) => typeof value === "string" ? clean(value) : value)) as ReturnRecord },
      recipient, receipt: `${name}: feedback received (${id}). I'll follow up in Teams.`,
    })
    emitNervesEvent({ component: "senses", event: "senses.shepherd_feedback_received",
      message: "persisted native-session feedback and follow-up intent", meta: { state: record.review.state } })
    return { id: record.id, receipt: record.receipt, state: record.review.state }
  } finally { if (!injected) deps.store.close() }
}

export async function shepherdFeedbackStatus(input: { agent: string; friendId: string; requestId: string }, injected?: FeedbackSubmitDeps) {
  if (!SHEPHERD_UUID.test(input.requestId)) refuse("invalid request ID")
  const deps = injected ?? (() => {
    const root = getAgentRoot(input.agent)
    agentPresentation(input.agent, {})
    if (!fs.existsSync(feedbackStorePath(root))) refuse("unknown request")
    return defaultDeps(input.agent)
  })()
  try {
    if (await deps.resolveOwner() !== input.friendId || input.friendId === SELF_FRIEND_ID) refuse("existing local-family owner required")
    const record = deps.store.read(`feedback:${input.requestId}`, input.friendId) ?? refuse("unknown request")
    return { id: record.id, receipt: record.receipt, review: record.review.state,
      delivery: record.delivery.state, reason: record.delivery.reason ?? record.review.reason }
  } finally { if (!injected) deps.store.close() }
}

export async function executeFeedbackCommand(command: FeedbackCommand, deps?: FeedbackSubmitDeps): Promise<DaemonResponse> {
  try {
    const result = command.kind === "agent.shepherdFeedback"
      ? await submitShepherdFeedback(command, deps)
      : await shepherdFeedbackStatus(command, deps)
    return { ok: true, message: result.receipt, data: result }
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_feedback_command_refused",
      message: "feedback command has no confirmed result", meta: { operation: command.kind } })
    return { ok: false, error: `Feedback result unavailable: ${redactSecrets(error instanceof Error ? error.message : String(error))}. Check the original request status before retrying.` }
  }
}
