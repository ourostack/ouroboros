import * as path from "node:path"
import { inspectStandingActionGrant } from "../../heart/steward-policy"
import { emitNervesEvent } from "../../nerves/runtime"
import { cmuxVersionAtLeast, pendingFeedItems, type CmuxPendingFeedItem } from "./attention"
import {
  appendDecision,
  cmuxCasebookPath,
  cmuxDecisionLogPath,
  findPrecedent,
  readCasebook,
  readDecisions,
  REPLY_HISTORY_MS,
  repliesInWindow,
  storeShape,
  withDecisionLock,
  type CmuxCase,
  type DecisionOutcome,
} from "./casebook"
import type { CmuxClient } from "./client"
import { evaluateFloor, type CaseShape, type FloorFs, type FloorVerdict } from "./floor"

/**
 * Whether the sense may answer a pending Feed permission request itself, and the reply path that
 * sends only `once`. A reply needs all of: the floor (allow, or soft with the human's exact
 * precedent), no "ask me" precedent, cmux 0.65.0 or later, and a standing owner grant for the
 * repository under its count cap. Anything else escalates to the human.
 */
export const CMUX_GRANT_KEY = "cmux-feed-once"
export const CMUX_GRANT_ACTION = "cmux.feed.once"
export const CMUX_MIN_ANSWER_VERSION = "0.65.0"
/** The only reply mode this code can send. `always`, `all` and `bypass` would widen the coding agent's permissions. */
const REPLY_MODE = "once" as const

export interface AnswerContext {
  agentRoot: string
  stateDir: string
  client: CmuxClient
  now: () => number
  /** The connected cmux's version, from `system.identify`. */
  cmuxVersion: () => string | null
  fsx?: FloorFs
}

export type Judgment =
  | { reply: true; floor: FloorVerdict; shape: CaseShape; precedent: CmuxCase | null; authority: string }
  | { reply: false; floor: FloorVerdict; shape: CaseShape | null; precedent: CmuxCase | null; reason: string }

/** `not_sent` (nothing went out) and `unconfirmed` (a reply may have gone out) leave the request with the human; the caller escalates it. */
export type AnswerOutcome = "replied_once" | "race" | "not_sent" | "unconfirmed"

export function cmuxStateDir(agentRoot: string): string {
  return path.join(agentRoot, "state", "senses", "cmux")
}

function inspectGrant(ctx: AnswerContext, repoRoot: string): ReturnType<typeof inspectStandingActionGrant> {
  const nowMs = ctx.now()
  const grant = inspectStandingActionGrant(ctx.agentRoot, {
    key: CMUX_GRANT_KEY,
    action: CMUX_GRANT_ACTION,
    target: repoRoot,
    now: new Date(nowMs).toISOString(),
    usesInWindow: (windowMs) => repliesInWindow(readDecisions(cmuxDecisionLogPath(ctx.stateDir)), windowMs, nowMs),
  })
  // The decision log keeps reply records for REPLY_HISTORY_MS, so it cannot count a longer window.
  if (grant.allowed && grant.windowMs > REPLY_HISTORY_MS) return { allowed: false, reason: "the standing grant's window is longer than the 31 days of replies the sense keeps" }
  return grant
}

export function judgeFeedItem(ctx: AnswerContext, item: CmuxPendingFeedItem): Judgment {
  const floor = evaluateFloor({ kind: item.kind, source: item.source, toolName: item.toolName, toolInput: item.toolInput, toolInputTruncated: item.toolInputTruncated, cwd: item.cwd }, ctx.fsx)
  if (floor.verdict === "hard") return { reply: false, floor, shape: null, precedent: null, reason: `floor: ${floor.reason}` }
  const shape = floor.shape
  const precedent = findPrecedent(readCasebook(cmuxCasebookPath(ctx.stateDir)), shape)
  if (precedent?.verdict === "ask") return { reply: false, floor, shape, precedent, reason: "the human asked to be asked about this exact request" }
  if (floor.verdict === "soft" && precedent?.verdict !== "once") return { reply: false, floor, shape, precedent, reason: `floor: ${floor.reason}, and the human has not answered this exact request before` }
  const basis = floor.verdict === "allow" ? `floor: ${floor.reason}` : `precedent ${precedent!.id}`
  const version = ctx.cmuxVersion()
  if (!cmuxVersionAtLeast(version, CMUX_MIN_ANSWER_VERSION)) {
    return { reply: false, floor, shape, precedent, reason: `would answer once (${basis}), but cmux ${version ?? "of unknown version"} is older than ${CMUX_MIN_ANSWER_VERSION}` }
  }
  const grant = inspectGrant(ctx, shape.repoRoot)
  if (!grant.allowed) return { reply: false, floor, shape, precedent, reason: `would answer once (${basis}), but ${grant.reason}` }
  return { reply: true, floor, shape, precedent, authority: `standing grant v${grant.grantVersion} (${grant.maxCount} per ${Math.round(grant.windowMs / 60_000)} min); ${basis}` }
}

export function recordDecision(ctx: AnswerContext, item: CmuxPendingFeedItem, judgment: Judgment, outcome: DecisionOutcome, detail: string): void {
  appendDecision(cmuxDecisionLogPath(ctx.stateDir), {
    at: new Date(ctx.now()).toISOString(),
    requestId: item.requestId,
    source: item.source,
    tool: item.toolName,
    cwd: item.cwd,
    outcome,
    floor: { verdict: judgment.floor.verdict, reason: judgment.floor.reason },
    shape: judgment.shape ? storeShape(judgment.shape) : null,
    precedent: judgment.precedent ? { id: judgment.precedent.id, verdict: judgment.precedent.verdict } : null,
    authority: judgment.reply ? judgment.authority : "none",
    detail,
  })
}

/** A Feed item's current status and decision, from the unfiltered `feed.list`, or null when cmux no longer lists it. */
export async function feedItemStatus(client: CmuxClient, requestId: string): Promise<{ status: string; mode: string | null; kind: string | null } | null> {
  const result = await client.call("feed.list", {})
  const items = Array.isArray(result.items) ? result.items as Array<Record<string, unknown>> : []
  const item = items.find((entry) => entry && entry.request_id === requestId)
  if (!item) return null
  const decision = item.decision && typeof item.decision === "object" ? item.decision as Record<string, unknown> : {}
  return {
    status: typeof item.status === "string" ? item.status : "unknown",
    mode: typeof decision.mode === "string" ? decision.mode : null,
    kind: typeof decision.kind === "string" ? decision.kind : null,
  }
}

/**
 * Re-checks that the exact request is still pending, re-checks the grant and records `reply_sent`
 * under the decision log's lock, sends `once`, then reads the item back. cmux reports a reply as
 * delivered even when the waiter is gone, so only a `resolved` item with a `once` permission
 * decision counts as `replied_once`; an item resolved some other way is a race (the human answered).
 * A failed reply call, an item still pending or expired, or one cmux no longer lists is `unconfirmed`,
 * and the caller escalates it.
 */
export async function answerOnce(ctx: AnswerContext, item: CmuxPendingFeedItem, judgment: Extract<Judgment, { reply: true }>): Promise<AnswerOutcome> {
  let current: CmuxPendingFeedItem | undefined
  try {
    current = pendingFeedItems(await ctx.client.call("feed.list", { pending_only: true })).find((entry) => entry.requestId === item.requestId)
  } catch (error) {
    recordDecision(ctx, item, judgment, "reply_failed", `could not re-check the request: ${(error as Error).message}`)
    return "not_sent"
  }
  if (!current) {
    recordDecision(ctx, item, judgment, "race", "the request was answered or withdrawn before the reply")
    return "race"
  }
  if (current.toolName !== item.toolName || current.toolInput !== item.toolInput || current.cwd !== item.cwd || current.toolInputTruncated !== item.toolInputTruncated) {
    recordDecision(ctx, item, judgment, "reply_failed", "the pending request changed after it was judged")
    return "not_sent"
  }
  const reserved = withDecisionLock(ctx.stateDir, () => {
    if (readDecisions(cmuxDecisionLogPath(ctx.stateDir)).some((entry) => entry.requestId === item.requestId && entry.outcome === "reply_sent")) return "the sense already sent a reply for this request"
    const grant = inspectGrant(ctx, judgment.shape.repoRoot)
    if (!grant.allowed) return grant.reason
    recordDecision(ctx, item, judgment, "reply_sent", judgment.authority)
    return null
  })
  if (reserved !== null) {
    recordDecision(ctx, item, judgment, "reply_failed", reserved)
    return "not_sent"
  }
  try {
    await ctx.client.call("feed.permission.reply", { request_id: item.requestId, mode: REPLY_MODE })
  } catch (error) {
    // The call can fail after cmux applied the reply, so its fate is unknown and the human decides.
    recordDecision(ctx, item, judgment, "reply_failed", `the reply call failed, so the reply may or may not have gone out: ${(error as Error).message}`)
    return "unconfirmed"
  }
  let after: Awaited<ReturnType<typeof feedItemStatus>>
  try {
    after = await feedItemStatus(ctx.client, item.requestId)
  } catch (error) {
    recordDecision(ctx, item, judgment, "reply_failed", `could not confirm the reply: ${(error as Error).message}`)
    return "unconfirmed"
  }
  if (after?.status === "resolved" && after.kind === "permission" && after.mode === REPLY_MODE) {
    recordDecision(ctx, item, judgment, "replied_once", judgment.authority)
    emitNervesEvent({ component: "senses", event: "senses.cmux_replied_once", message: "answered a coding agent's permission request once", meta: { requestId: item.requestId, tool: item.toolName } })
    return "replied_once"
  }
  if (after === null || after.status !== "resolved") {
    recordDecision(ctx, item, judgment, "reply_failed", after ? `the request is ${after.status} after the reply` : "cmux no longer lists the request")
    return "unconfirmed"
  }
  recordDecision(ctx, item, judgment, "race", `after the reply the request was ${after.status}${after.mode ? ` (${after.mode})` : ""}`)
  emitNervesEvent({ component: "senses", event: "senses.cmux_reply_race", message: "a cmux Feed request was resolved by someone else", meta: { requestId: item.requestId, status: after.status } })
  return "race"
}
