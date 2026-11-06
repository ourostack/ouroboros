import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FriendRecord } from "../../../mind/friends/types"

const { placeConfiguredTwilioPhoneCall } = vi.hoisted(() => ({
  placeConfiguredTwilioPhoneCall: vi.fn(),
}))

vi.mock("../../../senses/voice/twilio-phone-runtime", () => ({
  placeConfiguredTwilioPhoneCall,
}))

import {
  findVoiceOutboundFriendRecord,
  placeTrustedFriendVoiceOutboundCall,
  readVoiceOutboundFriendRecordById,
  voiceOutboundPhoneNumberForFriend,
} from "../../../senses/voice/outbound"
import { normalizeTwilioE164PhoneNumber } from "../../../senses/voice/phone"

function friend(overrides: Partial<FriendRecord> = {}): FriendRecord {
  return {
    id: "ari",
    name: "Ari",
    trustLevel: "family",
    externalIds: [{ provider: "imessage-handle", externalId: "+1 (555) 123-4567", linkedAt: "2026-05-08T12:00:00.000Z" }],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: "2026-05-08T12:00:00.000Z",
    updatedAt: "2026-05-08T12:00:00.000Z",
    schemaVersion: 1,
    ...overrides,
  }
}

async function writeFriend(root: string, record: FriendRecord, fileName = `${record.id}.json`): Promise<void> {
  const friendsDir = path.join(root, "friends")
  await fs.mkdir(friendsDir, { recursive: true })
  await fs.writeFile(path.join(friendsDir, fileName), JSON.stringify(record), "utf8")
}

describe("voice outbound friend calls", () => {
  beforeEach(() => {
    placeConfiguredTwilioPhoneCall.mockReset()
  })

  it("normalizes phone handles while rejecting groups and invalid numbers", () => {
    expect(normalizeTwilioE164PhoneNumber(undefined)).toBeUndefined()
    expect(normalizeTwilioE164PhoneNumber("+1 (555) 123-4567")).toBe("+15551234567")
    expect(normalizeTwilioE164PhoneNumber("15551234567")).toBe("+15551234567")
    expect(normalizeTwilioE164PhoneNumber("555.123.4567")).toBe("+15551234567")
    expect(normalizeTwilioE164PhoneNumber("group:chat")).toBeUndefined()
    expect(normalizeTwilioE164PhoneNumber("not-a-phone")).toBeUndefined()
  })

  it("finds friends by id, name, exact external id, phone-shaped external id, and prefix", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-outbound-"))
    const friendsDir = path.join(root, "friends")
    const ari = friend()
    const bea = friend({
      id: "bea",
      name: "Beatrice",
      externalIds: [{ provider: "imessage-handle", externalId: "555-987-6543", linkedAt: "2026-05-08T12:00:00.000Z" }],
    })
    await writeFriend(root, ari)
    await writeFriend(root, bea)
    await fs.writeFile(path.join(friendsDir, "broken.json"), "{bad json", "utf8")

    expect(readVoiceOutboundFriendRecordById(friendsDir, "ari")?.id).toBe("ari")
    expect(readVoiceOutboundFriendRecordById(friendsDir, "missing")).toBeNull()
    expect(readVoiceOutboundFriendRecordById(friendsDir, "broken")).toBeNull()
    expect(findVoiceOutboundFriendRecord(friendsDir, "ari")?.id).toBe("ari")
    expect(findVoiceOutboundFriendRecord(friendsDir, "beatrice")?.id).toBe("bea")
    expect(findVoiceOutboundFriendRecord(friendsDir, "+15559876543")?.id).toBe("bea")
    expect(findVoiceOutboundFriendRecord(friendsDir, "beat")?.id).toBe("bea")
    expect(findVoiceOutboundFriendRecord(friendsDir, "")).toBeNull()

    const notDirectory = path.join(root, "friends-as-file")
    await fs.writeFile(notDirectory, "not a directory", "utf8")
    expect(findVoiceOutboundFriendRecord(notDirectory, "bea")).toBeNull()
  })

  it("chooses explicit trusted phone numbers before friend handles", () => {
    expect(voiceOutboundPhoneNumberForFriend(friend(), "555-000-1111")).toBe("+15550001111")
    expect(voiceOutboundPhoneNumberForFriend(friend())).toBe("+15551234567")
    expect(voiceOutboundPhoneNumberForFriend(null)).toBeUndefined()
  })

  it("blocks unknown, untrusted, and numberless outbound voice calls", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-outbound-"))
    await writeFriend(root, friend({ id: "stranger", trustLevel: "stranger" }))
    await writeFriend(root, friend({ id: "no-phone", externalIds: [] }))

    await expect(placeTrustedFriendVoiceOutboundCall({
      agentName: "slugger",
      agentRoot: root,
      friendId: "missing",
      reason: "test",
    })).resolves.toMatchObject({ status: "blocked", detail: "voice call requires a known friend record" })
    await expect(placeTrustedFriendVoiceOutboundCall({
      agentName: "slugger",
      agentRoot: root,
      friendId: "stranger",
      reason: "test",
    })).resolves.toMatchObject({ status: "blocked", detail: "voice calls are limited to trusted friends" })
    await expect(placeTrustedFriendVoiceOutboundCall({
      agentName: "slugger",
      agentRoot: root,
      friendId: "no-phone",
      reason: "test",
    })).resolves.toMatchObject({ status: "blocked", detail: "no phone number is available for voice call" })
  })

  it("places trusted friend calls through the configured Twilio runtime", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-outbound-"))
    await writeFriend(root, friend())
    placeConfiguredTwilioPhoneCall.mockResolvedValueOnce({
      outboundId: "outbound-123",
      callSid: "CA123",
      status: "queued",
    })

    const result = await placeTrustedFriendVoiceOutboundCall({
      agentName: "slugger",
      agentRoot: root,
      friendId: "ari",
      reason: "tell Ari the weather",
      initialAudio: { source: "tone", label: "knock" },
    })

    expect(placeConfiguredTwilioPhoneCall).toHaveBeenCalledWith({
      agentName: "slugger",
      friendId: "ari",
      to: "+15551234567",
      reason: "tell Ari the weather",
      initialAudio: { source: "tone", label: "knock" },
    })
    expect(result).toMatchObject({
      status: "placed",
      detail: "voice call initiated (queued)",
      friendId: "ari",
      phoneNumber: "+15551234567",
      outboundId: "outbound-123",
      callSid: "CA123",
      callStatus: "queued",
    })
  })

  it("places trusted friend calls without optional Twilio placement fields", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-outbound-"))
    await writeFriend(root, friend())
    placeConfiguredTwilioPhoneCall.mockResolvedValueOnce({
      outboundId: "outbound-no-status",
    })

    const result = await placeTrustedFriendVoiceOutboundCall({
      agentName: "slugger",
      agentRoot: root,
      friendId: "ari",
      reason: "quiet check",
    })

    expect(placeConfiguredTwilioPhoneCall).toHaveBeenCalledWith({
      agentName: "slugger",
      friendId: "ari",
      to: "+15551234567",
      reason: "quiet check",
    })
    expect(result).toEqual({
      status: "placed",
      detail: "voice call initiated",
      friendId: "ari",
      phoneNumber: "+15551234567",
      outboundId: "outbound-no-status",
    })
  })

  it("returns a failed result when the Twilio runtime rejects placement", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "voice-outbound-"))
    await writeFriend(root, friend())
    placeConfiguredTwilioPhoneCall.mockRejectedValueOnce(new Error("Twilio refused"))

    await expect(placeTrustedFriendVoiceOutboundCall({
      agentName: "slugger",
      agentRoot: root,
      friendId: "ari",
      reason: "test",
    })).resolves.toMatchObject({ status: "failed", detail: "Twilio refused" })
  })
})
