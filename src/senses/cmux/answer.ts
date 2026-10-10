import * as path from "node:path"
import { inspectStandingActionGrant } from "../../heart/steward-policy"
import { emitNervesEvent } from "../../nerves/runtime"
import { pendingFeedItems, type CmuxPendingFeedItem } from "./attention"
import {
  appendDecision,
  cmuxCasebookPath,
  cmuxDecisionLogPath,
  findPrecedent,
  readCasebook,
  readDecisions,
  repliesInWindow,
  type CmuxCase,
  type DecisionOutcome,
} from "./casebook"
import type { CmuxClient } from "./client"
import { evaluateFloor, type CaseShape, type FloorFs, type FloorVerdict } from "./floor"

/**
 * Whether the sense may answer a pending Feed permission request itself, and the reply path that
 * sends only `once`. A reply needs all three: the floor (allow, or soft with the human's exact
 * precedent), no "ask me" precedent, and a standing owner grant for the repository under its count
 * cap. Anything else escalates to the human.
 */
export const CMUX_GRANT_KEY = "cmux-feed-once"
export const CMUX_GRANT_ACTION = "cmux.feed.once"
/** The only reply mode this code can send. `always`, `all` and `bypass` would widen the coding agent's permissions. */
const REPLY_MODE = "once" as const

export interface AnswerContext {
  agentRoot: string
  stateDir: string
  client: CmuxClient
  now: () => number
  fsx?: FloorFs
}

export type Judgment =
  | { reply: true; floor: FloorVerdict; shape: CaseShape; precedent: CmuxCase | null; authority: string }
  | { reply: false; floor: FloorVerdict; shape: CaseShape | null; precedent: CmuxCase | null; reason: string }

export function cmuxStateDir(agentRoot: string): string {
  return path.join(agentRoot, "state", "senses", "cmux")
}

export function judgeFeedItem(ctx: AnswerContext, item: CmuxPendingFeedItem): Judgment {
  const floor = evaluateFloor({ kind: item.kind, source: item.source, toolName: item.toolName, toolInput: item.toolInput, toolInputTruncated: item.toolInputTruncated, cwd: item.cwd }, ctx.fsx)
  if (floor.verdict === "hard") return { reply: false, floor, shape: null, precedent: null, reason: `floor: ${floor.reason}` }
  const shape = floor.shape
  const precedent = findPrecedent(readCasebook(cmuxCasebookPath(ctx.stateDir)), shape)
  if (precedent?.verdict === "ask") return { reply: false, floor, shape, precedent, reason: "the human asked to be asked about this exact request" }
  if (floor.verdict === "soft" && precedent?.verdict !== "once") return { reply: false, floor, shape, precedent, reason: `floor: ${floor.reason}, and the human has not answered this exact request before` }
  const basis = floor.verdict === "allow" ? `floor: ${floor.reason}` : `precedent ${precedent!.id}`
  const nowMs = ctx.now()
  const grant = inspectStandingActionGrant(ctx.agentRoot, {
    key: CMUX_GRANT_KEY,
    action: CMUX_GRANT_ACTION,
    target: shape.repoRoot,
    now: new Date(nowMs).toISOString(),
    usesInWindow: (windowMs) => repliesInWindow(readDecisions(cmuxDecisionLogPath(ctx.stateDir)), windowMs, nowMs),
  })
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
    shape: judgment.shape,
    precedent: judgment.precedent ? { id: judgment.precedent.id, verdict: judgment.precedent.verdict } : null,
    authority: judgment.reply ? judgment.authority : "none",
    detail: detail.slice(0, 2_000),
  })
}

/**
 * Re-checks that the exact request is still pending, then sends `once`. cmux reports a reply as
 * delivered even when the waiter is gone, so the re-check is what catches the human answering first.
 */
export async function answerOnce(ctx: AnswerContext, item: CmuxPendingFeedItem, judgment: Extract<Judgment, { reply: true }>): Promise<DecisionOutcome> {
  let current: CmuxPendingFeedItem | undefined
  try {
    current = pendingFeedItems(await ctx.client.call("feed.list", { pending_only: true })).find((entry) => entry.requestId === item.requestId)
  } catch (error) {
    recordDecision(ctx, item, judgment, "reply_failed", `could not re-check the request: ${(error as Error).message}`)
    return "reply_failed"
  }
  if (!current) {
    recordDecision(ctx, item, judgment, "race", "the request was answered or withdrawn before the reply")
    emitNervesEvent({ component: "senses", event: "senses.cmux_reply_race", message: "a cmux Feed request was resolved before the sense replied", meta: { requestId: item.requestId } })
    return "race"
  }
  if (current.toolName !== item.toolName || current.toolInput !== item.toolInput || current.cwd !== item.cwd || current.toolInputTruncated !== item.toolInputTruncated) {
    recordDecision(ctx, item, judgment, "reply_failed", "the pending request changed after it was judged")
    return "reply_failed"
  }
  try {
    await ctx.client.call("feed.permission.reply", { request_id: item.requestId, mode: REPLY_MODE })
  } catch (error) {
    recordDecision(ctx, item, judgment, "reply_failed", (error as Error).message)
    return "reply_failed"
  }
  recordDecision(ctx, item, judgment, "replied_once", judgment.authority)
  emitNervesEvent({ component: "senses", event: "senses.cmux_replied_once", message: "answered a coding agent's permission request once", meta: { requestId: item.requestId, tool: item.toolName } })
  return "replied_once"
}
