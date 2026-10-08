import * as fs from "fs"
import * as path from "path"
import { getAgentRoot, getAgentName } from "../heart/identity"
import { capStructuredRecordString } from "../heart/session-events"
import { emitNervesEvent } from "../nerves/runtime"
import {
  parseAwaitFile,
  renderAwaitFile,
  type AwaitFile,
  type AwaitMode,
} from "../heart/awaiting/await-parser"
import {
  deliverAwaitAlert,
  type AwaitAlertResult,
} from "../heart/awaiting/await-alert"
import { FileFriendStore } from "@ouro.bot/friends"
import { askedOwnerText, createA2AAwaitOwnerDeliverer, defaultNotifyOwner, type NotifyOwner } from "../heart/awaiting/a2a-await-delivery"
import { getPrivateRuntimePendingDir, queuePendingMessageOnce } from "../mind/pending"
import type { PendingMessage } from "../mind/pending"
import type { ToolContext, ToolDefinition } from "./tools-base"
import type { CrossChatDeliveryDeps } from "../heart/cross-chat-delivery"
import { advanceExternalEventFromAwait, getExternalEventRoot, readExternalEventRecord } from "../heart/external-events/router"
import { advanceObligation, createObligation, fulfillObligation, readVerifiedObligations, readVerifiedPendingObligations } from "../arc/obligations"
import { parseCadenceToMs } from "../heart/daemon/cadence"

/**
 * Bundle-root-relative locations.
 * - `awaiting/<name>.md` — active awaits (status: pending)
 * - `awaiting/.done/<name>.md` — terminal awaits (resolved/expired/canceled)
 */
function awaitingDir(agentRoot: string): string {
  return path.join(agentRoot, "awaiting")
}

function awaitingDoneDir(agentRoot: string): string {
  return path.join(awaitingDir(agentRoot), ".done")
}

function awaitFilePath(agentRoot: string, name: string): string {
  return path.join(awaitingDir(agentRoot), `${name}.md`)
}

function awaitDoneFilePath(agentRoot: string, name: string): string {
  return path.join(awaitingDoneDir(agentRoot), `${name}.md`)
}

const VALID_NAME = /^[A-Za-z0-9_-]+$/

function validateName(name: string): string | null {
  if (!name) return "name is required"
  if (!VALID_NAME.test(name)) return "name must be alphanumeric, underscores, or hyphens"
  return null
}

/**
 * The relationship scope a resolve/cancel is judged against. A turn that is ticking an await carries that await's own
 * binding (`awaitTick`), because the pipeline rewrites `currentSession` to the private-runtime session; that binding covers the
 * ticked await only, so a tick can never touch any other await. Every other turn is judged by its current session.
 */
function relationshipScopeFor(ctx: ToolContext, awaitName: string): { session: { friendId: string; channel: string; key: string } | undefined; requestId: string | undefined } {
  const tick = ctx.awaitTick
  if (tick) {
    return tick.awaitName === awaitName
      ? { session: { friendId: tick.friendId, channel: tick.channel, key: tick.key }, requestId: tick.requestId ?? undefined }
      : { session: undefined, requestId: undefined }
  }
  return { session: ctx.currentSession, requestId: ctx.relationshipAuthorization?.requestId }
}

function readAwaitDoneDefinition(agentRoot: string, name: string): AwaitFile | null {
  const filePath = awaitDoneFilePath(agentRoot, name)
  try {
    return parseAwaitFile(fs.readFileSync(filePath, "utf-8"), filePath)
  } catch {
    return null
  }
}

export function readAwaitDefinition(agentRoot: string, name: string): AwaitFile | null {
  const filePath = awaitFilePath(agentRoot, name)
  try {
    const content = fs.readFileSync(filePath, "utf-8")
    return parseAwaitFile(content, filePath)
  } catch {
    return null
  }
}

/**
 * Default delivery deps for the await alert path used from the tool.
 * Mirrors the proactive-outreach pattern: queue to the private-runtime pending
 * dir when no live deliverer is registered.
 */
function defaultDeliveryDeps(agentName: string): CrossChatDeliveryDeps {
  const pendingDir = getPrivateRuntimePendingDir(agentName)
  return {
    agentName,
    queuePending: (message: PendingMessage) => {
      // Mirror the write-as-pending convention from tools-session.
      fs.mkdirSync(pendingDir, { recursive: true })
      const filename = `${message.timestamp}-${Math.random().toString(36).slice(2, 10)}.json`
      fs.writeFileSync(
        path.join(pendingDir, filename),
        JSON.stringify({ ...message, content: capStructuredRecordString(message.content) }, null, 2),
        "utf-8",
      )
    },
  }
}

/** Override hook for tests + daemon to inject real channel deliverers. */
export interface AwaitToolDeps {
  /** Override the delivery deps factory (testing or daemon-wired live deliverers). */
  buildDeliveryDeps?: (agentName: string) => CrossChatDeliveryDeps
  /** Override how an ask_owner question reaches the owner (default: the Butler's own Telegram owner notice). */
  notifyOwner?: (agentName: string) => NotifyOwner
}

let injected: AwaitToolDeps = {}

export function setAwaitToolDeps(deps: AwaitToolDeps): void {
  injected = deps
}

export function resetAwaitToolDeps(): void {
  injected = {}
}

function resolveDeliveryDeps(agentName: string): CrossChatDeliveryDeps {
  const deps = injected.buildDeliveryDeps ? injected.buildDeliveryDeps(agentName) : defaultDeliveryDeps(agentName)
  return { ...deps, deliverers: { a2a: createA2AAwaitOwnerDeliverer(agentName), ...deps.deliverers } }
}

const ASK_OWNER_MIN_CHOICES = 2
const ASK_OWNER_MAX_CHOICES = 4

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim()
}

/**
 * Validates an ask_owner request. The question and choices are collapsed to single lines because they are archived as
 * frontmatter, and choices may not contain "|" because the archive joins them with " | ".
 */
function parseAskOwner(question: unknown, choices: unknown): { ok: true; question: string; choices: string[] } | { ok: false; error: string } {
  const cleanQuestion = typeof question === "string" ? oneLine(question) : ""
  if (!cleanQuestion) return { ok: false, error: "question is required for ask_owner: put the decision to the owner in plain words" }
  if (!Array.isArray(choices) || choices.length < ASK_OWNER_MIN_CHOICES || choices.length > ASK_OWNER_MAX_CHOICES) {
    return { ok: false, error: `ask_owner needs ${ASK_OWNER_MIN_CHOICES} to ${ASK_OWNER_MAX_CHOICES} choices` }
  }
  const cleanChoices = choices.map((choice) => typeof choice === "string" ? oneLine(choice) : "")
  if (cleanChoices.some((choice) => !choice)) return { ok: false, error: "every ask_owner choice must be a non-empty string" }
  if (cleanChoices.some((choice) => choice.includes("|"))) return { ok: false, error: 'ask_owner choices must not contain "|"' }
  return { ok: true, question: cleanQuestion, choices: cleanChoices }
}

function formatOwnerQuestion(question: string, choices: string[]): string {
  return `${question}\n\n${choices.map((choice) => `- ${choice}`).join("\n")}`
}

function failedAskOwner(agentName: string, name: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  emitNervesEvent({ level: "error", component: "repertoire", event: "repertoire.await_ask_owner_error", message: "ask_owner could not reach the owner", meta: { agent: agentName, name, error: detail } })
  return JSON.stringify({ error: `the owner message could not be sent (${detail}); the await is still pending, so ask_owner can be retried` })
}

/** At most this many ask_owner closures per requester in a rolling day, so one requester cannot make the Butler pester the owner. */
const ASK_OWNER_DAILY_LIMIT = 3
const ASK_OWNER_WINDOW_MS = 24 * 60 * 60 * 1000

function askLedgerPath(agentRoot: string): string {
  return path.join(awaitingDir(agentRoot), ".asks.jsonl")
}

/** Every ask_owner closure is appended here, because the archive is overwritten when an await name is reused. */
function recordAsk(agentRoot: string, entry: { filer: string | null; name: string; at: string }): void {
  fs.mkdirSync(awaitingDir(agentRoot), { recursive: true })
  fs.appendFileSync(askLedgerPath(agentRoot), `${JSON.stringify(entry)}\n`, "utf-8")
}

function recentAskCount(agentRoot: string, filer: string | null, now: number): number {
  let raw: string
  try {
    raw = fs.readFileSync(askLedgerPath(agentRoot), "utf-8")
  } catch {
    return 0
  }
  return raw.split("\n").filter((line) => {
    try {
      const entry = JSON.parse(line) as { filer?: unknown; at?: unknown }
      return (entry.filer ?? null) === filer && typeof entry.at === "string" && now - Date.parse(entry.at) < ASK_OWNER_WINDOW_MS
    } catch {
      return false
    }
  }).length
}

const askOwnerInFlight = new Set<string>()

type Filer = { isOwner: boolean; name: string | null }

/** A friend store that cannot be read makes the filer unknown, which is never the owner; it must not fail the ask. */
async function lookupFiler(agentRoot: string, friendId: string | null): Promise<Filer> {
  try {
    const friend = friendId ? await new FileFriendStore(path.join(agentRoot, "friends")).get(friendId) : null
    return { isOwner: Boolean(friend && friend.admissionState === "active" && friend.trustLevel === "family" && friend.capabilityProfileId === "sanctuary-owner"), name: friend?.name ?? null }
  } catch {
    return { isOwner: false, name: null }
  }
}

function delivered(alert: AwaitAlertResult | null): boolean {
  return alert?.delivery?.status === "delivered_now" || alert?.delivery?.status === "queued_for_later"
}

/**
 * The await's condition cannot be met without the owner deciding. The owner is asked once, as the agent, in the
 * owner's own chat, and only then is the await archived as asked_owner. One notice id per await instance ties every
 * path together: the A2A owner delivery, the direct owner message and the replay sink all dedupe on it, so a retry after
 * a crash between send and archive sends nothing twice. An await filed from A2A goes through the A2A owner delivery,
 * which writes the owner notice (or the replay sink during a replay window); the direct notice is only the fallback
 * when that path blocked or failed. When someone other than the owner filed the await, the text says whose request it is
 * about, and a non-A2A filer is also told that the owner was asked (the obligation stays open if that could not be said).
 */
async function askOwnerTool(name: string, observation: string, question: unknown, choices: unknown, existing: AwaitFile, agentRoot: string, agentName: string): Promise<string> {
  const parsed = parseAskOwner(question, choices)
  if (!parsed.ok) return JSON.stringify({ error: parsed.error })
  const inFlightKey = `${agentRoot}\0${name}`
  if (askOwnerInFlight.has(inFlightKey)) return JSON.stringify({ error: `await "${name}" is already being asked; wait for the owner's reply instead of asking again` })
  askOwnerInFlight.add(inFlightKey)
  try {
    const filerId = existing.filed_for_friend_id ?? null
    const filer = await lookupFiler(agentRoot, filerId)
    if (!filer.isOwner && recentAskCount(agentRoot, filerId, Date.now()) >= ASK_OWNER_DAILY_LIMIT) {
      return JSON.stringify({ error: `ask_owner limit reached: this requester has already had my owner asked ${ASK_OWNER_DAILY_LIMIT} times in the last day; do not retry ask_owner, resolve with verdict 'no' with an observation and keep polling` })
    }
    const isA2A = existing.filed_from === "a2a"
    const noticeId = `await:${name}:asked_owner:${String(existing.created_at)}`
    const question = formatOwnerQuestion(parsed.question, parsed.choices)
    const ownerText = filer.isOwner ? question : askedOwnerText(question, filer.name ?? (isA2A ? "a connected agent" : "a friend"))

    let alert: AwaitAlertResult | null = null
    let sent = false
    if (isA2A) {
      try {
        alert = await deliverAwaitAlert({ awaitFile: { ...existing, alert: "a2a" }, reason: "asked_owner", observation: question, content: question, deliveryId: noticeId, agentRoot, agentName, deliveryDeps: resolveDeliveryDeps(agentName) })
      } catch (error) {
        emitNervesEvent({ level: "error", component: "repertoire", event: "repertoire.await_alert_error", message: "await alert delivery threw", meta: { agent: agentName, name, error: error instanceof Error ? error.message : String(error) } })
      }
      sent = delivered(alert)
    }
    if (!sent) {
      try {
        await (injected.notifyOwner ? injected.notifyOwner(agentName) : defaultNotifyOwner(agentName))({ noticeId, text: ownerText })
      } catch (error) {
        return failedAskOwner(agentName, name, error)
      }
    }

    let friendNotice: AwaitAlertResult | null = null
    const tellsFriend = !isA2A && !filer.isOwner && Boolean(filerId)
    if (tellsFriend) {
      try {
        friendNotice = await deliverAwaitAlert({ awaitFile: existing, reason: "asked_owner", observation: observation.trim(), content: `About "${existing.condition ?? name}": I have asked the owner how to proceed and will let you know what they decide.`, deliveryId: `${noticeId}:filer`, agentRoot, agentName, deliveryDeps: resolveDeliveryDeps(agentName) })
      } catch (error) {
        emitNervesEvent({ level: "error", component: "repertoire", event: "repertoire.await_alert_error", message: "await alert delivery threw", meta: { agent: agentName, name, error: error instanceof Error ? error.message : String(error) } })
      }
    }

    const askedAt = new Date().toISOString()
    const archive = archiveAwait(agentRoot, name, {
      status: "asked_owner",
      asked_at: askedAt,
      ask_question: parsed.question,
      ask_choices: parsed.choices.join(" | "),
      resolution_observation: observation.trim(),
    })
    /* v8 ignore next -- defensive: archiveAwait only fails on the file-disappears-mid-call race already covered by v8 ignore inside archiveAwait @preserve */
    if (!archive.ok) return JSON.stringify({ error: archive.error })
    recordAsk(agentRoot, { filer: filerId, name, at: askedAt })
    if (!tellsFriend || delivered(friendNotice)) fulfillAwaitObligation(agentRoot, archive.file)

    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.await_asked_owner",
      message: "await closed by asking the owner",
      meta: { agent: agentName, name, choices: parsed.choices.length },
    })

    const summary = (result: AwaitAlertResult | null) => result ? { attempted: result.attempted, status: result.delivery?.status ?? null, skipped: result.skipped ?? null } : null
    return JSON.stringify({
      verdict: "ask_owner",
      asked: true,
      archived: awaitDoneFilePath(agentRoot, name),
      alert: summary(alert),
      ...(tellsFriend ? { filerNotice: summary(friendNotice) } : {}),
    })
  } finally {
    askOwnerInFlight.delete(inFlightKey)
  }
}

interface FileAwaitArgs {
  name: string
  condition: string
  cadence: string
  alert?: string
  mode?: string
  max_age?: string
  wake_at?: string
  body?: string
}

function fileAwait(args: FileAwaitArgs, agentRoot: string, agentName: string, sessionFriendId: string | null, sessionChannel: string | null, sessionKey: string | null, requestId: string | null): string {
  const nameError = validateName(args.name)
  if (nameError) return JSON.stringify({ error: nameError })

  if (!args.condition || !args.condition.trim()) {
    return JSON.stringify({ error: "condition is required" })
  }
  if (!args.cadence || !args.cadence.trim()) {
    return JSON.stringify({ error: "cadence is required" })
  }
  if (args.wake_at && (!Number.isFinite(Date.parse(args.wake_at)) || new Date(args.wake_at).toISOString() !== args.wake_at)) {
    return JSON.stringify({ error: "wake_at must be a canonical ISO timestamp" })
  }

  const filePath = awaitFilePath(agentRoot, args.name)
  if (fs.existsSync(filePath)) {
    return JSON.stringify({ error: `await "${args.name}" already exists` })
  }

  const mode: AwaitMode = args.mode === "quick" ? "quick" : "full"
  const alert = sessionChannel === "external-event" ? null : args.alert ?? sessionChannel ?? null

  const frontmatter: Record<string, unknown> = {
    condition: capStructuredRecordString(args.condition.trim()),
    cadence: capStructuredRecordString(args.cadence.trim()),
    alert,
    mode,
    max_age: typeof args.max_age === "string" ? capStructuredRecordString(args.max_age) : null,
    wake_at: typeof args.wake_at === "string" ? capStructuredRecordString(args.wake_at) : null,
    status: "pending",
    created_at: new Date().toISOString(),
    filed_from: sessionChannel ?? "unknown",
    filed_for_friend_id: sessionFriendId ?? null,
    filed_from_key: sessionKey,
    request_id: requestId,
  }
  let obligationId: string | null = null
  if (requestId && sessionFriendId && sessionChannel && sessionKey) {
    const obligation = createObligation(agentRoot, {
      origin: { friendId: sessionFriendId, channel: sessionChannel, key: sessionKey },
      owedTo: { friendId: sessionFriendId, channel: sessionChannel, key: sessionKey },
      requestId,
      content: args.condition.trim(),
    })
    advanceObligation(agentRoot, obligation.id, {
      currentSurface: { kind: "session", label: `${sessionChannel}/${sessionKey}` },
      currentArtifact: `awaiting/${args.name}.md`,
      nextAction: args.condition.trim(),
    })
    obligationId = obligation.id
    frontmatter.obligation_id = obligation.id
  }
  const rendered = renderAwaitFile(frontmatter, capStructuredRecordString(args.body ?? ""))
  fs.mkdirSync(awaitingDir(agentRoot), { recursive: true })
  try {
    fs.writeFileSync(filePath, rendered, "utf-8")
  } catch (error) {
    if (obligationId) fulfillObligation(agentRoot, obligationId)
    throw error
  }

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.await_filed",
    message: "filed new await",
    meta: { agent: agentName, name: args.name, cadence: args.cadence, alert },
  })

  return JSON.stringify({ filed: args.name, path: filePath })
}

function archiveAwait(agentRoot: string, name: string, updates: Record<string, unknown>): { ok: true; file: AwaitFile } | { ok: false; error: string } {
  const source = awaitFilePath(agentRoot, name)
  /* v8 ignore start -- defensive: callers (resolve/cancel) already verify the file exists via readAwaitDefinition; this guards the file-disappears-between-calls race @preserve */
  if (!fs.existsSync(source)) {
    return { ok: false, error: `await "${name}" not found in awaiting/` }
  }
  /* v8 ignore stop */

  const content = fs.readFileSync(source, "utf-8")
  const current = parseAwaitFile(content, source)

  // merge frontmatter from the parsed file with updates
  const merged: Record<string, unknown> = {
    condition: current.condition,
    cadence: current.cadence,
    alert: current.alert,
    mode: current.mode,
    max_age: current.max_age,
    wake_at: current.wake_at ?? null,
    status: current.status,
    created_at: current.created_at,
    filed_from: current.filed_from,
    filed_for_friend_id: current.filed_for_friend_id,
    filed_from_key: current.filed_from_key,
    request_id: current.request_id,
    obligation_id: current.obligation_id,
    ...updates,
  }

  const cappedMerged = Object.fromEntries(Object.entries(merged).map(([key, value]) => [
    key,
    typeof value === "string" ? capStructuredRecordString(value) : value,
  ]))
  const rendered = renderAwaitFile(cappedMerged, capStructuredRecordString(current.body))
  fs.mkdirSync(awaitingDoneDir(agentRoot), { recursive: true })
  fs.writeFileSync(awaitDoneFilePath(agentRoot, name), rendered, "utf-8")
  fs.unlinkSync(source)

  // re-parse the archived file so callers see merged fields (e.g. resolution_observation)
  const archivedContent = fs.readFileSync(awaitDoneFilePath(agentRoot, name), "utf-8")
  const archived = parseAwaitFile(archivedContent, awaitDoneFilePath(agentRoot, name))
  return { ok: true, file: archived }
}

function fulfillAwaitObligation(agentRoot: string, awaitFile: AwaitFile): void {
  if (awaitFile.obligation_id) fulfillObligation(agentRoot, awaitFile.obligation_id)
}

async function resolveAwaitTool(name: string, verdict: string, observation: string, agentRoot: string, agentName: string, ask?: { question: unknown; choices: unknown }): Promise<string> {
  const nameError = validateName(name)
  if (nameError) return JSON.stringify({ error: nameError })

  const existing = readAwaitDefinition(agentRoot, name)
  if (!existing) {
    if (verdict === "ask_owner" && readAwaitDoneDefinition(agentRoot, name)?.status === "asked_owner") {
      return JSON.stringify({ error: `await "${name}" has already asked the owner and is closed; wait for the owner's reply instead of asking again` })
    }
    return JSON.stringify({ error: `await "${name}" not found in awaiting/` })
  }
  if (existing.status !== "pending") {
    return JSON.stringify({ error: `await "${name}" is not pending (status: ${existing.status})` })
  }

  if (verdict !== "yes" && verdict !== "no" && verdict !== "ask_owner") {
    return JSON.stringify({ error: `verdict must be exactly "yes", "no", or "ask_owner" (got ${JSON.stringify(verdict)}); use "no" with an observation while still waiting` })
  }

  if (!observation || !observation.trim()) {
    return JSON.stringify({ error: "observation is required" })
  }

  if (verdict === "ask_owner") return askOwnerTool(name, observation, ask?.question, ask?.choices, existing, agentRoot, agentName)

  if (verdict === "no") {
    // Update runtime state via recordAwaitCheck-style write
    const { recordAwaitCheck } = await import("../heart/awaiting/await-runtime-state")
    recordAwaitCheck(agentRoot, name, observation.trim(), new Date().toISOString())
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.await_check_no",
      message: "await checked, not yet ready",
      meta: { agent: agentName, name },
    })
    return JSON.stringify({ verdict: "no", recorded: true })
  }

  // Request-bound returns stay active through Telegram prepare/send authorization.
  let alert: AwaitAlertResult | null = null
  if (existing.request_id && existing.filed_from !== "external-event") {
    try {
      alert = await deliverAwaitAlert({ awaitFile: existing, reason: "resolved", observation: observation.trim(), agentRoot, agentName, deliveryDeps: resolveDeliveryDeps(agentName) })
    } catch (error) {
      emitNervesEvent({ level: "error", component: "repertoire", event: "repertoire.await_alert_error", message: "await alert delivery threw", meta: { agent: agentName, name, error: error instanceof Error ? error.message : String(error) } })
    }
    if (alert?.delivery?.status !== "delivered_now") {
      return JSON.stringify({ verdict: "yes", archived: null, alert: alert ? { attempted: alert.attempted, status: alert.delivery?.status ?? null, skipped: alert.skipped ?? null } : null, advancedExternalEvents: [] })
    }
  }

  const advancedEvents = existing.filed_from === "external-event" && existing.filed_from_key && existing.wake_at
    ? (() => {
        if (!hasActiveExternalEventAwait(agentName, { recordPath: existing.filed_from_key!, awaitName: name, wakeAt: existing.wake_at! })) throw new Error("External event await authority changed before resolution")
        const record = readExternalEventRecord(existing.filed_from_key!)
        if (record.agent !== agentName || record.recordPath !== existing.filed_from_key || record.executionState !== "handled"
          || record.disposition?.awaitId !== name || record.disposition.nextWake.kind !== "at" || record.disposition.nextWake.at !== existing.wake_at) {
          throw new Error("External event await authority changed before resolution")
        }
        return [advanceExternalEventFromAwait(record.recordPath, { awaitId: name, expectedVersion: record.version, expectedGeneration: record.generation })]
      })()
    : []
  const archive = archiveAwait(agentRoot, name, {
    status: "resolved",
    resolved_at: new Date().toISOString(),
    resolution_observation: observation.trim(),
  })
  /* v8 ignore next -- defensive: archiveAwait only fails on the file-disappears-mid-call race already covered by v8 ignore inside archiveAwait @preserve */
  if (!archive.ok) return JSON.stringify({ error: archive.error })
  fulfillAwaitObligation(agentRoot, archive.file)

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.await_resolved",
    message: "await resolved",
    meta: { agent: agentName, name },
  })

  if (!existing.request_id) {
    try {
      alert = await deliverAwaitAlert({ awaitFile: archive.file, reason: "resolved", observation: observation.trim(), agentRoot, agentName, deliveryDeps: resolveDeliveryDeps(agentName) })
    } catch (error) {
      emitNervesEvent({ level: "error", component: "repertoire", event: "repertoire.await_alert_error", message: "await alert delivery threw", meta: { agent: agentName, name, error: error instanceof Error ? error.message : String(error) } })
    }
  }

  return JSON.stringify({
    verdict: "yes",
    archived: awaitDoneFilePath(agentRoot, name),
    alert: alert ? { attempted: alert.attempted, status: alert.delivery?.status ?? null, skipped: alert.skipped ?? null } : null,
    advancedExternalEvents: advancedEvents.map((event) => event.recordPath),
  })
}

export function cancelAwaitTool(name: string, reason: string | undefined, agentRoot: string, agentName: string): string {
  const nameError = validateName(name)
  if (nameError) return JSON.stringify({ error: nameError })

  const existing = readAwaitDefinition(agentRoot, name)
  if (!existing) {
    return JSON.stringify({ error: `await "${name}" not found in awaiting/` })
  }
  if (existing.status !== "pending") {
    return JSON.stringify({ error: `await "${name}" is not pending (status: ${existing.status})` })
  }

  const updates: Record<string, unknown> = {
    status: "canceled",
    canceled_at: new Date().toISOString(),
  }
  if (reason && reason.trim()) {
    updates.cancel_reason = reason.trim()
  }

  const archive = archiveAwait(agentRoot, name, updates)
  /* v8 ignore next -- defensive: archiveAwait only fails on the file-disappears-mid-call race already covered by v8 ignore inside archiveAwait @preserve */
  if (!archive.ok) return JSON.stringify({ error: archive.error })
  fulfillAwaitObligation(agentRoot, archive.file)

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.await_canceled",
    message: "await canceled",
    meta: { agent: agentName, name },
  })

  return JSON.stringify({ canceled: name, archived: awaitDoneFilePath(agentRoot, name) })
}

export type AwaitBindingInspection = { active: true } | { active: false; reason: string }

function exactFileIsMissing(filePath: string): boolean {
  try {
    fs.lstatSync(filePath)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
    throw error
  }
}

export function cancelStaleAwait(agentRoot: string, agentName: string, name: string, reason: string): void {
  const result = JSON.parse(cancelAwaitTool(name, reason, agentRoot, agentName)) as { canceled?: string; error?: string }
  if (result.canceled !== name) throw new Error(`Stale await could not be archived for repair: ${result.error ?? name}`)
}

/** Binding losses that mean the await is broken, as opposed to finished (fulfilled, expired). */
export function isBrokenBindingReason(reason: string): boolean {
  return reason === "request obligation is missing" || reason === "request obligation binding no longer matches"
}

/**
 * An await that can never run is ended, not retried: archived as canceled with the reason, logged as an error, and
 * the private runtime is told once that the follow-up it promised will not happen. Without this the await stayed
 * pending and every scheduled wake failed again, silently, for days.
 */
export function failBrokenAwait(agentRoot: string, agentName: string, awaitName: string, reason: string): void {
  cancelStaleAwait(agentRoot, agentName, awaitName, reason)
  emitNervesEvent({
    level: "error",
    component: "senses",
    event: "senses.relationship_await_failed",
    message: "relationship await could not run and was canceled",
    meta: { agentName, awaitName, reason },
  })
  queuePendingMessageOnce(getPrivateRuntimePendingDir(agentName), {
    from: agentName,
    friendId: "self",
    channel: "inner",
    key: "dialog",
    content: `my await "${awaitName}" was canceled because it could not run (${reason}). the follow-up it promised did not happen; i should tell my owner and decide whether to file it again.`,
    timestamp: Date.now(),
    packetId: `await-failed:${awaitName}`,
  })
}

export function inspectRelationshipFollowUp(agentRoot: string, input: { friendId: string; channel: string; key: string; requestId: string; awaitName: string; allowElapsed?: boolean; now?: number }): AwaitBindingInspection {
  const awaiting = readAwaitDefinition(agentRoot, input.awaitName)
  if (!awaiting) throw new Error(`Await ${input.awaitName} could not be verified`)
  if (!awaiting.obligation_id) return { active: false, reason: "request obligation is missing" }
  const obligationPath = path.join(agentRoot, "arc", "obligations", `${awaiting.obligation_id}.json`)
  const obligation = readVerifiedObligations(agentRoot).find((candidate) => candidate.id === awaiting.obligation_id)
  if (!obligation) {
    if (exactFileIsMissing(obligationPath)) return { active: false, reason: "request obligation is missing" }
    throw new Error(`Request obligation ${awaiting.obligation_id} exists but could not be verified`)
  }
  if (obligation.status === "fulfilled") return { active: false, reason: "request obligation is no longer active" }
  const matches = obligation.requestId === input.requestId
    && obligation.origin.friendId === input.friendId && obligation.origin.channel === input.channel && obligation.origin.key === input.key
    && obligation.owedTo?.friendId === input.friendId && obligation.owedTo.channel === input.channel && obligation.owedTo.key === input.key
    && obligation.currentArtifact === `awaiting/${input.awaitName}.md`
    && awaiting.status === "pending" && awaiting.obligation_id === obligation.id && awaiting.request_id === input.requestId
    && awaiting.filed_for_friend_id === input.friendId && awaiting.filed_from === input.channel && awaiting.filed_from_key === input.key
  if (!matches) return { active: false, reason: "request obligation binding no longer matches" }
  const maxAge = parseCadenceToMs(awaiting.max_age)
  if (input.allowElapsed !== true && maxAge !== null && awaiting.created_at && (input.now ?? Date.now()) >= Date.parse(awaiting.created_at) + maxAge) {
    return { active: false, reason: "request obligation await expired" }
  }
  return { active: true }
}

export function hasActiveRelationshipFollowUp(agentRoot: string, input: { friendId: string; channel: string; key: string; requestId: string; awaitName?: string; allowElapsed?: boolean; now?: number }): boolean {
  if (input.awaitName) return inspectRelationshipFollowUp(agentRoot, { ...input, awaitName: input.awaitName }).active
  const obligation = readVerifiedPendingObligations(agentRoot).find((candidate) => candidate.requestId === input.requestId
    && candidate.origin.friendId === input.friendId && candidate.origin.channel === input.channel && candidate.origin.key === input.key
    && candidate.owedTo?.friendId === input.friendId && candidate.owedTo.channel === input.channel && candidate.owedTo.key === input.key
    && candidate.currentArtifact?.startsWith("awaiting/") && candidate.currentArtifact.endsWith(".md")
    && (!input.awaitName || candidate.currentArtifact === `awaiting/${input.awaitName}.md`))
  if (!obligation) return false
  const name = path.basename(obligation.currentArtifact!, ".md")
  if (!VALID_NAME.test(name) || obligation.currentArtifact !== `awaiting/${name}.md`) return false
  const awaiting = readAwaitDefinition(agentRoot, name)
  if (!awaiting || awaiting.status !== "pending" || awaiting.obligation_id !== obligation.id || awaiting.request_id !== input.requestId
    || awaiting.filed_for_friend_id !== input.friendId || awaiting.filed_from !== input.channel || awaiting.filed_from_key !== input.key) return false
  const maxAge = parseCadenceToMs(awaiting.max_age)
  return input.allowElapsed === true || maxAge === null || !awaiting.created_at || (input.now ?? Date.now()) < Date.parse(awaiting.created_at) + maxAge
}

export function hasActiveExternalEventAwait(agentName: string, input: { recordPath: string; awaitName: string; wakeAt: string }, root = getExternalEventRoot()): boolean {
  return inspectExternalEventAwait(agentName, input, root).active
}

export function inspectExternalEventAwait(agentName: string, input: { recordPath: string; awaitName: string; wakeAt: string }, root = getExternalEventRoot()): AwaitBindingInspection {
  const relative = path.relative(path.resolve(root), path.resolve(input.recordPath))
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("External event await record is outside the event root")
  let record: ReturnType<typeof readExternalEventRecord>
  try {
    record = readExternalEventRecord(input.recordPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { active: false, reason: "external event disposition is missing" }
    throw error
  }
  const active = record.agent === agentName && record.recordPath === input.recordPath && record.executionState === "handled"
    && record.disposition?.awaitId === input.awaitName && record.disposition.nextWake.kind === "at" && record.disposition.nextWake.at === input.wakeAt
  return active ? { active: true } : { active: false, reason: "external event disposition is no longer active" }
}

export function cancelRelationshipFollowUps(agentRoot: string, agentName: string, input: { friendId: string; channel: string; key: string }): void {
  const obligations = readVerifiedPendingObligations(agentRoot).filter((candidate) => candidate.owedTo?.friendId === input.friendId
    && candidate.owedTo.channel === input.channel && candidate.owedTo.key === input.key)
  for (const obligation of obligations) {
    const artifact = obligation.currentArtifact
    const name = artifact?.startsWith("awaiting/") && artifact.endsWith(".md") ? path.basename(artifact, ".md") : null
    if (name && VALID_NAME.test(name) && artifact === `awaiting/${name}.md` && readAwaitDefinition(agentRoot, name)) {
      cancelAwaitTool(name, "relationship revoked", agentRoot, agentName)
    } else {
      fulfillObligation(agentRoot, obligation.id)
    }
  }
}

export const awaitingToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "await_condition",
        description: "File a one-shot waiting condition. The daemon polls on cadence; on each tick I evaluate the condition and call resolve_await. When the condition becomes true, an alert fires via my outward channel.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Filename stem (alphanumeric/underscore/hyphen). Must be unique." },
            condition: { type: "string", description: "Natural-language condition to watch for." },
            cadence: { type: "string", description: "Polling cadence (e.g. '5m', '1h')." },
            alert: { type: "string", description: "Channel to alert on (e.g. 'bluebubbles', 'teams'). Defaults to filing session's channel." },
            mode: { type: "string", description: "'full' or 'quick'. Defaults 'full'." },
            max_age: { type: "string", description: "Optional auto-expiry (e.g. '24h')." },
            wake_at: { type: "string", description: "Optional exact canonical ISO time this Await supports." },
            body: { type: "string", description: "Optional notes: why I filed this, what 'ready' looks like." },
          },
          required: ["name", "condition", "cadence"],
        },
      },
    },
    handler: (a, ctx) => {
      const agentRoot = getAgentRoot()
      const agentName = getAgentName()
      const event = ctx?.currentExternalEvent
      const eventFriendId = event ? ctx?.context?.friend.id ?? null : null
      if (event && !eventFriendId) return JSON.stringify({ error: "external event await authority has no exact owner relationship" })
      return fileAwait(
        {
          name: a.name,
          condition: a.condition,
          cadence: a.cadence,
          alert: a.alert,
          mode: a.mode,
          max_age: a.max_age,
          wake_at: a.wake_at,
          body: a.body,
        },
        agentRoot,
        agentName,
        eventFriendId ?? ctx?.currentSession?.friendId ?? null,
        event ? "external-event" : ctx?.currentSession?.channel ?? null,
        event ? event.recordPath : ctx?.currentSession?.key ?? null,
        event ? null : ctx?.relationshipAuthorization?.requestId ?? null,
      )
    },
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "files a durable await condition" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "resolve_await",
        description: "Resolve a pending await with a verdict. verdict='yes' archives and fires the alert. verdict='no' records the observation and continues polling; still pending is always 'no'. verdict='ask_owner' (with question and choices) closes the await and asks my owner to decide, exactly once: use it when the condition cannot be met without the owner deciding, for example a confirmed dead download. Never use ask_owner for \"not yet\" or a merely suspected problem; that is 'no'.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Await name (filename stem)." },
            verdict: { type: "string", enum: ["yes", "no", "ask_owner"], description: "Exactly 'yes' if the condition is met. Exactly 'no' for anything else, including still pending, not yet, or unable to tell: send 'no' with an observation and polling continues. 'ask_owner' only when the condition cannot be met without the owner deciding; it needs question and choices." },
            observation: { type: "string", description: "One-line summary of what I saw this tick." },
            question: { type: "string", description: "Only for ask_owner: the decision I need from my owner, in plain words." },
            choices: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4, description: "Only for ask_owner: 2 to 4 short options the owner can pick from." },
          },
          required: ["name", "verdict", "observation"],
        },
      },
    },
    handler: async (a, ctx) => {
      const agentRoot = getAgentRoot()
      const agentName = getAgentName()
      if (ctx?.relationshipAuthorization) {
        const awaitName = String(a.name ?? "")
        const { session, requestId } = relationshipScopeFor(ctx, awaitName)
        const existing = readAwaitDefinition(agentRoot, awaitName)
        let binding: AwaitBindingInspection | null = null
        if (session?.channel === "external-event" && existing?.wake_at) {
          binding = inspectExternalEventAwait(agentName, { recordPath: session.key, awaitName, wakeAt: existing.wake_at })
        } else if (session && requestId) {
          if (existing?.filed_for_friend_id !== session.friendId || existing.filed_from !== session.channel
            || existing.filed_from_key !== session.key || existing.request_id !== requestId) {
            return JSON.stringify({ error: "resolve_await is limited to the current relationship request or bound external event" })
          }
          binding = inspectRelationshipFollowUp(agentRoot, { friendId: session.friendId, channel: session.channel, key: session.key, requestId, awaitName })
        }
        if (binding && !binding.active) {
          if (isBrokenBindingReason(binding.reason)) failBrokenAwait(agentRoot, agentName, awaitName, binding.reason)
          else cancelStaleAwait(agentRoot, agentName, awaitName, binding.reason)
          return JSON.stringify({ error: binding.reason })
        }
        if (!binding?.active) return JSON.stringify({ error: "resolve_await is limited to the current relationship request or bound external event" })
      }
      return resolveAwaitTool(a.name, a.verdict, a.observation, agentRoot, agentName, { question: a.question, choices: a.choices })
    },
    riskProfile: {
      mutates: ["durable_state_write", "external_side_effect"] as const,
      risk: "high",
      reason: "records await observations and may deliver an alert",
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "cancel_await",
        description: "Cancel a pending await without alerting. Archives with status: canceled.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Await name (filename stem)." },
            reason: { type: "string", description: "Optional cancel reason." },
          },
          required: ["name"],
        },
      },
    },
    handler: (a, ctx) => {
      const agentRoot = getAgentRoot()
      const agentName = getAgentName()
      if (ctx?.relationshipAuthorization) {
        const { session, requestId } = relationshipScopeFor(ctx, String(a.name ?? ""))
        if (!session || !requestId || !hasActiveRelationshipFollowUp(agentRoot, {
          friendId: session.friendId,
          channel: session.channel,
          key: session.key,
          requestId,
          awaitName: String(a.name ?? ""),
        })) return JSON.stringify({ error: "cancel_await is limited to the current relationship request" })
      }
      return cancelAwaitTool(a.name, a.reason, agentRoot, agentName)
    },
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "archives a durable await condition" },
  },
]
