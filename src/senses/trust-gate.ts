import * as fs from "fs"
import * as path from "path"
import { getAgentRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import { isTrustedLevel, type Channel, type FriendRecord, type IdentityProvider, type SenseType } from "../mind/friends/types"
import { INNER_DIALOG_PENDING } from "../mind/pending"

// Canned reply; eventually agents should compose their own first-contact message
export const STRANGER_AUTO_REPLY = "I'm sorry, I'm not allowed to talk to strangers"

interface StrangerRepliesState {
  [externalKey: string]: string
}

export interface TrustGateInput {
  friend: FriendRecord
  provider: IdentityProvider
  externalId: string
  tenantId?: string
  channel: Channel
  /** How the channel is exposed. When omitted, derived from channel name. */
  senseType: SenseType
  /** Whether this message arrived in a group chat (vs 1:1). Default false. */
  isGroupChat: boolean
  /** For acquaintance group chats: is a family member present in the group? Default false. */
  groupHasFamilyMember: boolean
  /** For acquaintance 1:1: does the acquaintance share an existing group with a family member? Default false. */
  hasExistingGroupWithFamily: boolean
  bundleRoot?: string
  now?: () => Date
}

export type TrustGateResult =
  | { allowed: true }
  | { allowed: false; reason: "stranger_first_reply"; autoReply: string }
  | { allowed: false; reason: "stranger_silent_drop" }
  | { allowed: false; reason: "acquaintance_group_no_family" }
  | { allowed: false; reason: "acquaintance_1on1_has_group"; autoReply: string }
  | { allowed: false; reason: "acquaintance_1on1_no_group"; autoReply: string }

function buildExternalKey(provider: IdentityProvider, externalId: string, tenantId?: string): string {
  return `${provider}:${tenantId ?? ""}:${externalId}`
}

function loadRepliesState(repliesPath: string): StrangerRepliesState {
  try {
    if (!fs.existsSync(repliesPath)) return {}
    const raw = fs.readFileSync(repliesPath, "utf8").trim()
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed as StrangerRepliesState
  } catch {
    return {}
  }
}

function persistRepliesState(repliesPath: string, state: StrangerRepliesState): void {
  fs.writeFileSync(repliesPath, JSON.stringify(state, null, 2) + "\n", "utf8")
}

function appendPrimaryNotification(
  bundleRoot: string,
  provider: IdentityProvider,
  externalId: string,
  tenantId: string | undefined,
  nowIso: string,
): void {
  const inboxDir = path.join(bundleRoot, "inbox")
  const notificationsPath = path.join(inboxDir, "primary-notifications.jsonl")
  const message = `Unknown contact tried to message me. Want to add them? Use ouro link <agent> --friend <id> --provider ${provider} --external-id ${externalId}.`

  const payload = {
    type: "stranger_contact",
    at: nowIso,
    provider,
    externalId,
    tenantId: tenantId ?? null,
    message,
  }

  fs.mkdirSync(inboxDir, { recursive: true })
  fs.appendFileSync(notificationsPath, `${JSON.stringify(payload)}\n`, "utf8")
}

function writeInnerPendingNotice(
  bundleRoot: string,
  noticeContent: string,
  nowIso: string,
): void {
  const innerPendingDir = path.join(bundleRoot, "state", "pending", INNER_DIALOG_PENDING.friendId, INNER_DIALOG_PENDING.channel, INNER_DIALOG_PENDING.key)
  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
  const filePath = path.join(innerPendingDir, fileName)

  const payload = {
    from: "instinct",
    content: noticeContent,
    timestamp: Date.now(),
    at: nowIso,
  }

  fs.mkdirSync(innerPendingDir, { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(payload), "utf-8")
}

export function enforceTrustGate(input: TrustGateInput): TrustGateResult {
  const { senseType } = input

  // Local (CLI) and internal (inner dialog) — always allow
  if (senseType === "local" || senseType === "internal") {
    return { allowed: true }
  }

  // Closed senses (Teams) — org already gates access, allow all trust levels
  if (senseType === "closed") {
    return { allowed: true }
  }

  // Open senses (BlueBubbles/iMessage) — enforce trust rules

  // Group chat with a family member present — allow regardless of trust level
  if (input.isGroupChat && input.groupHasFamilyMember) {
    return { allowed: true }
  }

  const trustLevel = input.friend.trustLevel ?? "friend"

  // Family and friend — always allow on open
  if (isTrustedLevel(trustLevel)) {
    return { allowed: true }
  }

  const bundleRoot = input.bundleRoot ?? getAgentRoot()
  const nowIso = (input.now ?? (() => new Date()))().toISOString()

  // Acquaintance rules
  if (trustLevel === "acquaintance") {
    return handleAcquaintance(input, bundleRoot, nowIso)
  }

  // Stranger rules (trustLevel === "stranger")
  return handleStranger(input, bundleRoot, nowIso)
}

function handleAcquaintance(
  input: TrustGateInput,
  bundleRoot: string,
  nowIso: string,
): TrustGateResult {
  const { isGroupChat, hasExistingGroupWithFamily } = input

  let result: TrustGateResult
  let noticeDetail: string

  if (isGroupChat) {
    // Group chat without family member — reject silently
    result = { allowed: false, reason: "acquaintance_group_no_family" }
    noticeDetail = `acquaintance "${input.friend.name}" messaged in a group chat without a family member present`
  } else if (hasExistingGroupWithFamily) {
    // 1:1 but shares a group with family — redirect
    result = {
      allowed: false,
      reason: "acquaintance_1on1_has_group",
      autoReply: "Hey! Reach me in our group chat instead.",
    }
    noticeDetail = `acquaintance "${input.friend.name}" DMed me directly — redirected to our group chat`
  } else {
    // 1:1, no shared group with family — redirect to any group
    result = {
      allowed: false,
      reason: "acquaintance_1on1_no_group",
      autoReply: "Hey! Reach me in a group chat instead.",
    }
    noticeDetail = `acquaintance "${input.friend.name}" DMed me directly — asked to reach me in a group chat`
  }

  emitNervesEvent({
    level: "warn",
    component: "senses",
    event: "senses.trust_gate",
    message: "acquaintance message blocked",
    meta: {
      channel: input.channel,
      provider: input.provider,
      reason: result.reason,
    },
  })

  try {
    writeInnerPendingNotice(bundleRoot, noticeDetail, nowIso)
  } catch (error) {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.trust_gate_error",
      message: "failed to write inner pending notice",
      meta: {
        reason: error instanceof Error ? error.message : String(error),
      },
    })
  }

  return result
}

function handleStranger(
  input: TrustGateInput,
  bundleRoot: string,
  nowIso: string,
): TrustGateResult {
  const repliesPath = path.join(bundleRoot, "stranger-replies.json")
  const externalKey = buildExternalKey(input.provider, input.externalId, input.tenantId)

  const state = loadRepliesState(repliesPath)

  // Subsequent contact — silent drop
  if (state[externalKey]) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.trust_gate",
      message: "stranger message silently dropped",
      meta: {
        channel: input.channel,
        provider: input.provider,
      },
    })
    return {
      allowed: false,
      reason: "stranger_silent_drop",
    }
  }

  // First contact — auto-reply, persist state, notify agent
  state[externalKey] = nowIso

  try {
    persistRepliesState(repliesPath, state)
  } catch (error) {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.trust_gate_error",
      message: "failed to persist stranger reply state",
      meta: {
        reason: error instanceof Error ? error.message : String(error),
      },
    })
  }

  try {
    appendPrimaryNotification(bundleRoot, input.provider, input.externalId, input.tenantId, nowIso)
  } catch (error) {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.trust_gate_error",
      message: "failed to persist primary stranger notification",
      meta: {
        reason: error instanceof Error ? error.message : String(error),
      },
    })
  }

  const noticeDetail = `stranger "${input.friend.name}" tried to reach me via ${input.channel}. Auto-replied once.`

  try {
    writeInnerPendingNotice(bundleRoot, noticeDetail, nowIso)
  } catch (error) {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.trust_gate_error",
      message: "failed to write inner pending notice",
      meta: {
        reason: error instanceof Error ? error.message : String(error),
      },
    })
  }

  emitNervesEvent({
    level: "warn",
    component: "senses",
    event: "senses.trust_gate",
    message: "stranger message blocked before model invocation",
    meta: {
      channel: input.channel,
      provider: input.provider,
    },
  })

  return {
    allowed: false,
    reason: "stranger_first_reply",
    autoReply: STRANGER_AUTO_REPLY,
  }
}
