import * as fs from "fs"
import * as path from "path"
import { isTrustedLevel, type FriendRecord } from "../../mind/friends/types"
import { emitNervesEvent } from "../../nerves/runtime"
import { normalizeTwilioE164PhoneNumber } from "./phone"
import type { VoiceCallAudioRequest } from "../../repertoire/tools-base"

export interface VoiceOutboundCallRequest {
  agentName: string
  agentRoot: string
  friendId: string
  reason: string
  phoneNumber?: string
  initialAudio?: VoiceCallAudioRequest
}

export type VoiceOutboundCallResult =
  | {
    status: "placed"
    detail: string
    friendId: string
    phoneNumber: string
    outboundId: string
    callSid?: string
    callStatus?: string
  }
  | {
    status: "blocked" | "failed"
    detail: string
  }

export function readVoiceOutboundFriendRecordById(friendsDir: string, friendId: string): FriendRecord | null {
  const recordPath = path.join(friendsDir, `${friendId}.json`)
  if (!fs.existsSync(recordPath)) return null
  try {
    return JSON.parse(fs.readFileSync(recordPath, "utf-8")) as FriendRecord
  } catch {
    return null
  }
}

function externalIdMatches(externalId: string, wanted: string, wantedPhone: string | undefined): boolean {
  const normalized = externalId.trim().toLowerCase()
  /* v8 ignore next -- exact external-id aliases are supported for non-phone providers; phone aliases are the production voice path @preserve */
  if (normalized === wanted) return true
  const phone = normalizeTwilioE164PhoneNumber(externalId)
  return Boolean(wantedPhone && phone === wantedPhone)
}

export function findVoiceOutboundFriendRecord(friendsDir: string, friendId: string): FriendRecord | null {
  const byId = readVoiceOutboundFriendRecordById(friendsDir, friendId)
  if (byId) return byId
  const normalized = friendId.trim().toLowerCase()
  if (!normalized) return null
  const normalizedPhone = normalizeTwilioE164PhoneNumber(friendId)
  try {
    const records = fs.readdirSync(friendsDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(friendsDir, file), "utf-8")) as FriendRecord
        } catch {
          return null
        }
      })
      .filter((record): record is FriendRecord => Boolean(record))

    return records.find((record) =>
      record.id === friendId
      || record.name?.toLowerCase() === normalized
      || record.externalIds?.some((externalId) => externalIdMatches(externalId.externalId, normalized, normalizedPhone))
    ) ?? records.find((record) => record.name?.toLowerCase().startsWith(normalized)) ?? null
  } catch {
    return null
  }
}

export function voiceOutboundPhoneNumberForFriend(friend: FriendRecord | null, explicitPhoneNumber?: string): string | undefined {
  const explicit = normalizeTwilioE164PhoneNumber(explicitPhoneNumber)
  if (explicit) return explicit
  for (const externalId of friend?.externalIds ?? []) {
    /* v8 ignore next -- voice outbound only consumes iMessage phone handles today @preserve */
    if (externalId.provider !== "imessage-handle") continue
    const phoneNumber = normalizeTwilioE164PhoneNumber(externalId.externalId)
    /* v8 ignore next -- malformed iMessage handles are covered by missing-number blocking at the caller boundary @preserve */
    if (phoneNumber) return phoneNumber
  }
  return undefined
}

export async function placeTrustedFriendVoiceOutboundCall(
  request: VoiceOutboundCallRequest,
): Promise<VoiceOutboundCallResult> {
  emitNervesEvent({
    component: "senses",
    event: "senses.voice_outbound_call_start",
    message: "checking trusted friend outbound voice call request",
    meta: { agentName: request.agentName, friendId: request.friendId },
  })
  const friendsDir = path.join(request.agentRoot, "friends")
  const friend = findVoiceOutboundFriendRecord(friendsDir, request.friendId)
  if (!friend) {
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_outbound_call_blocked",
      message: "blocked outbound voice call request",
      meta: { agentName: request.agentName, friendId: request.friendId, reason: "unknown_friend" },
    })
    return { status: "blocked", detail: "voice call requires a known friend record" }
  }
  if (!isTrustedLevel(friend.trustLevel)) {
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_outbound_call_blocked",
      message: "blocked outbound voice call request",
      meta: { agentName: request.agentName, friendId: friend.id, reason: "untrusted_friend" },
    })
    return { status: "blocked", detail: "voice calls are limited to trusted friends" }
  }
  const phoneNumber = voiceOutboundPhoneNumberForFriend(friend, request.phoneNumber)
  if (!phoneNumber) {
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_outbound_call_blocked",
      message: "blocked outbound voice call request",
      meta: { agentName: request.agentName, friendId: friend.id, reason: "missing_phone_number" },
    })
    return { status: "blocked", detail: "no phone number is available for voice call" }
  }

  try {
    const { placeConfiguredTwilioPhoneCall } = await import("./twilio-phone-runtime")
    const call = await placeConfiguredTwilioPhoneCall({
      agentName: request.agentName,
      friendId: friend.id,
      to: phoneNumber,
      reason: request.reason,
      ...(request.initialAudio ? { initialAudio: request.initialAudio } : {}),
    })
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_outbound_call_placed",
      message: "placed outbound voice call request",
      meta: {
        agentName: request.agentName,
        friendId: friend.id,
        outboundId: call.outboundId.replace(/[^A-Za-z0-9._-]+/g, "-"),
        callSid: call.callSid?.replace(/[^A-Za-z0-9._-]+/g, "-") ?? "unknown",
        status: call.status ?? "unknown",
      },
    })
    return {
      status: "placed",
      detail: `voice call initiated${call.status ? ` (${call.status})` : ""}`,
      friendId: friend.id,
      phoneNumber,
      outboundId: call.outboundId,
      ...(call.callSid ? { callSid: call.callSid } : {}),
      ...(call.status ? { callStatus: call.status } : {}),
    }
  } catch (error) {
    emitNervesEvent({
      level: "error",
      component: "senses",
      event: "senses.voice_outbound_call_failed",
      message: "failed outbound voice call request",
      /* v8 ignore next -- dynamic import/runtime failures arrive as Error objects in supported Node runtimes @preserve */
      meta: { agentName: request.agentName, friendId: friend.id, error: error instanceof Error ? error.message : String(error) },
    })
    return {
      status: "failed",
      /* v8 ignore next -- dynamic import/runtime failures arrive as Error objects in supported Node runtimes @preserve */
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}
