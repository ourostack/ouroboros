// Identity link codes: how a person proves that a new channel identity is theirs.
//
// A friend on a surface the agent already trusts (the owner's CLI, or a family chat)
// asks for a short code. When that exact code arrives as a 1:1 message from an
// identity the agent does not yet trust, that identity's record merges into the
// friend who asked, and the new identity is treated as them from then on.
//
// Codes are single use and expire. Only a SHA-256 digest of each code is stored, under
// the agent's `state/` directory, which bundle sync does not carry. A code is consumed
// by its first presentation, whatever the outcome, by an atomic rename, so a replay or a
// race between two senders finds nothing to redeem.
import * as fs from "node:fs"
import * as path from "node:path"
import { createHash, randomInt } from "node:crypto"
import type { Channel, FriendRecord, FriendStore } from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"
import { mergeFriends } from "./friend-merge"

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const CODE_BODY_LENGTH = 8
export const DEFAULT_LINK_CODE_TTL_MS = 10 * 60 * 1000
const MAX_LINK_CODE_TTL_MS = 24 * 60 * 60 * 1000
const CODE_SHAPE = new RegExp(`^OURO-?([${CODE_ALPHABET}]{4})-?([${CODE_ALPHABET}]{4})$`)

export interface LinkCodeRecord {
  schemaVersion: 1
  friendId: string
  friendName: string
  channel?: Channel
  issuedAt: string
  expiresAt: string
  issuedBy: string
}

export interface IssuedLinkCode {
  code: string
  friendId: string
  friendName: string
  channel?: Channel
  expiresAt: string
}

function codesRoot(agentRoot: string): string {
  return path.join(agentRoot, "state", "friend-link-codes")
}

function digest(codeBody: string): string {
  return createHash("sha256").update(codeBody).digest("hex")
}

/**
 * The code body when `text` is exactly one link code (case, spacing, dashes and simple
 * markup ignored), otherwise null. Anything else in the message means it is not a code.
 */
export function parseLinkCode(text: string): string | null {
  const plain = text
    .replace(/<at>[^<]*<\/at>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, "")
    .toUpperCase()
  const match = CODE_SHAPE.exec(plain)
  return match ? `${match[1]}${match[2]}` : null
}

export function formatLinkCode(codeBody: string): string {
  return `OURO-${codeBody.slice(0, 4)}-${codeBody.slice(4)}`
}

export function issueLinkCode(input: {
  agentRoot: string
  friend: Pick<FriendRecord, "id" | "name">
  channel?: Channel
  ttlMs?: number
  issuedBy: string
  now?: () => Date
}): IssuedLinkCode {
  const now = (input.now ?? (() => new Date()))()
  const ttlMs = Math.min(Math.max(input.ttlMs ?? DEFAULT_LINK_CODE_TTL_MS, 60 * 1000), MAX_LINK_CODE_TTL_MS)
  let codeBody = ""
  for (let index = 0; index < CODE_BODY_LENGTH; index += 1) codeBody += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  const record: LinkCodeRecord = {
    schemaVersion: 1,
    friendId: input.friend.id,
    friendName: input.friend.name,
    ...(input.channel ? { channel: input.channel } : {}),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    issuedBy: input.issuedBy,
  }
  const pendingDir = path.join(codesRoot(input.agentRoot), "pending")
  fs.mkdirSync(pendingDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(pendingDir, `${digest(codeBody)}.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" })
  emitNervesEvent({
    component: "friends",
    event: "friends.link_code_issued",
    message: "issued an identity link code",
    meta: { friendId: input.friend.id, channel: input.channel ?? "any", expiresAt: record.expiresAt, issuedBy: input.issuedBy },
  })
  return { code: formatLinkCode(codeBody), friendId: record.friendId, friendName: record.friendName, ...(record.channel ? { channel: record.channel } : {}), expiresAt: record.expiresAt }
}

export type LinkCodeRejection =
  | "unknown_or_used"
  | "expired"
  | "group_chat"
  | "wrong_channel"
  | "already_linked"
  | "claimant_trusted"
  | "friend_missing"

export type LinkCodeRedemption =
  | { status: "linked"; friend: FriendRecord; reply: string }
  | { status: "rejected"; reason: LinkCodeRejection; reply: string }

const REJECTION_REPLIES: Record<LinkCodeRejection, string> = {
  unknown_or_used: "That link code isn't valid. Ask for a new one.",
  expired: "That link code has expired. Ask for a new one.",
  group_chat: "Link codes only work in a 1:1 chat with me. Ask for a new code and send it to me directly.",
  wrong_channel: "That link code was issued for a different channel. Ask for a new one.",
  already_linked: "This account is already linked to you.",
  claimant_trusted: "This account is already known to me as someone I trust, so a code can't relink it. The owner can merge the records instead.",
  friend_missing: "The person this code was issued for no longer exists. Ask for a new code.",
}

function reject(reason: LinkCodeRejection, meta: Record<string, unknown>): LinkCodeRedemption {
  emitNervesEvent({
    level: "warn",
    component: "friends",
    event: "friends.link_code_rejected",
    message: "rejected an identity link code",
    meta: { reason, ...meta },
  })
  return { status: "rejected", reason, reply: REJECTION_REPLIES[reason] }
}

/** Atomically take the code out of `pending/`. Null when no pending code has this body. */
function consumeCode(agentRoot: string, codeBody: string, nowIso: string): { record: LinkCodeRecord; usedPath: string } | null {
  const root = codesRoot(agentRoot)
  const name = `${digest(codeBody)}.json`
  const usedDir = path.join(root, "used")
  fs.mkdirSync(usedDir, { recursive: true, mode: 0o700 })
  const usedPath = path.join(usedDir, name)
  try {
    fs.renameSync(path.join(root, "pending", name), usedPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    /* v8 ignore next -- only ENOENT is expected; other filesystem failures propagate @preserve */
    throw error
  }
  const record = JSON.parse(fs.readFileSync(usedPath, "utf-8")) as LinkCodeRecord
  fs.writeFileSync(usedPath, `${JSON.stringify({ ...record, consumedAt: nowIso }, null, 2)}\n`, { mode: 0o600 })
  return { record, usedPath }
}

function recordOutcome(usedPath: string, outcome: Record<string, unknown>): void {
  const current = JSON.parse(fs.readFileSync(usedPath, "utf-8")) as Record<string, unknown>
  fs.writeFileSync(usedPath, `${JSON.stringify({ ...current, ...outcome }, null, 2)}\n`, { mode: 0o600 })
}

/**
 * Redeem a link code sent by `claimant`. Returns null when `text` is not a link code, so
 * callers can run this on every inbound message and fall through to a normal turn.
 */
export async function redeemLinkCode(input: {
  agentRoot: string
  friendsDir: string
  store: FriendStore
  text: string
  claimant: FriendRecord
  channel: Channel
  isGroupChat: boolean
  now?: () => Date
}): Promise<LinkCodeRedemption | null> {
  const codeBody = parseLinkCode(input.text)
  if (!codeBody) return null
  const now = (input.now ?? (() => new Date()))()
  const nowIso = now.toISOString()
  const baseMeta = { claimantId: input.claimant.id, channel: input.channel }

  const consumed = consumeCode(input.agentRoot, codeBody, nowIso)
  if (!consumed) return reject("unknown_or_used", baseMeta)
  const { record, usedPath } = consumed
  const meta = { ...baseMeta, friendId: record.friendId }
  const refuse = (reason: LinkCodeRejection): LinkCodeRedemption => {
    recordOutcome(usedPath, { outcome: "rejected", reason, claimantId: input.claimant.id, channel: input.channel })
    return reject(reason, meta)
  }

  if (Date.parse(record.expiresAt) <= now.getTime()) return refuse("expired")
  if (input.isGroupChat) return refuse("group_chat")
  if (record.channel && record.channel !== input.channel) return refuse("wrong_channel")
  if (input.claimant.id === record.friendId) return refuse("already_linked")
  // A code can only bring in an identity the agent does not already trust; trusted
  // records are merged deliberately by the owner, not by whoever holds a code.
  if (input.claimant.trustLevel !== "stranger" && input.claimant.trustLevel !== "acquaintance") return refuse("claimant_trusted")

  const merged = await mergeFriends({
    store: input.store,
    friendsDir: input.friendsDir,
    targetId: record.friendId,
    sourceIds: [input.claimant.id],
    actor: `link-code:${record.issuedBy}`,
    reason: `identity link code redeemed on ${input.channel}`,
    now: () => now,
  })
  if (!merged.ok) return refuse("friend_missing")

  recordOutcome(usedPath, { outcome: "linked", claimantId: input.claimant.id, channel: input.channel, linkedExternalIds: merged.addedExternalIds.map((externalId) => externalId.provider) })
  emitNervesEvent({
    component: "friends",
    event: "friends.link_code_redeemed",
    message: "linked a new identity through a link code",
    meta: { ...meta, trustLevel: merged.target.trustLevel ?? "unknown", linkedExternalIds: merged.addedExternalIds.map((externalId) => externalId.provider) },
  })
  return {
    status: "linked",
    friend: merged.target,
    reply: `Linked. I'll recognize this ${input.channel} account as ${merged.target.name} from now on.`,
  }
}
