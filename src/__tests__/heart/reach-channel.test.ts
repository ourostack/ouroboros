import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FriendRecord } from "@ouro.bot/friends"

vi.mock("../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

import { emitNervesEvent } from "../../nerves/runtime"
import { resolveReachTarget, type ReachChannel } from "../../heart/reach-channel"

const NOW = Date.parse("2026-10-24T12:00:00.000Z")
const BB_KEY = "chat_any;-;+15555550123"
const TEAMS_KEY = "a_1abcDEF"
const BOTH = new Set<ReachChannel>(["bluebubbles", "teams"])
let root: string
let sessionsDir: string
let friendsDir: string

function iso(minutesAgo: number): string {
  return new Date(NOW - minutesAgo * 60_000).toISOString()
}

function event(sequence: number, role: "user" | "assistant", minutesAgo: number, captureKind = "live") {
  const at = iso(minutesAgo)
  return {
    id: `evt-${String(sequence).padStart(6, "0")}`, sequence, role, content: `${role} ${sequence}`, name: null, toolCallId: null, toolCalls: [], attachments: [],
    time: { authoredAt: at, authoredAtSource: "local", observedAt: at, observedAtSource: "ingest", recordedAt: at, recordedAtSource: "save" },
    relations: { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null },
    provenance: { captureKind, legacyVersion: null, sourceMessageIndex: null },
  }
}

function session(channel: string, key: string, events: ReturnType<typeof event>[], friendId = "ari"): void {
  const dir = path.join(sessionsDir, friendId, channel)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify({
    version: 2, events,
    projection: { eventIds: events.map(item => item.id), trimmed: false, maxTokens: 80000, contextMargin: 20, inputTokens: null, projectedAt: iso(0) },
    lastUsage: null,
    state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
  }))
}

function friend(overrides: Partial<FriendRecord> = {}, reach?: { value: string; provenance?: "stated" | "observed" | "default"; expiresAt?: string }): FriendRecord {
  return {
    id: "ari", name: "Ari", trustLevel: "family",
    externalIds: [
      { provider: "imessage-handle", externalId: "+15555550123", linkedAt: iso(9999) },
      { provider: "aad", externalId: "AAD-Ari", tenantId: "tenant-1", linkedAt: iso(9999) },
    ],
    ...(reach ? { relationshipPolicy: { schemaVersion: 1, version: 1, preferences: {
      reachChannel: { value: reach.value, provenance: reach.provenance ?? "stated", version: 1, source: "test", ...(reach.expiresAt ? { expiresAt: reach.expiresAt } : {}) },
    } } } : {}),
    ...overrides,
  } as FriendRecord
}

function resolve(record: FriendRecord, enabledChannels: ReadonlySet<ReachChannel> = BOTH) {
  return resolveReachTarget({ friend: record, enabledChannels, sessionsDir, friendsDir, agentName: "slugger", now: () => NOW })
}

const fallbackEvents = () => vi.mocked(emitNervesEvent).mock.calls.map(([entry]) => entry).filter(entry => entry.event === "senses.reach_channel_fallback")

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-channel-"))
  sessionsDir = path.join(root, "state", "sessions")
  friendsDir = path.join(root, "friends")
  fs.mkdirSync(friendsDir, { recursive: true })
  vi.mocked(emitNervesEvent).mockClear()
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe("resolveReachTarget", () => {
  it("a stated preference wins over a newer Teams session", () => {
    session("bluebubbles", BB_KEY, [event(1, "user", 120)])
    session("teams", TEAMS_KEY, [event(1, "user", 5)])
    expect(resolve(friend({}, { value: "bluebubbles" }))).toEqual({ channel: "bluebubbles", key: BB_KEY, friendId: "ari", handle: "+15555550123" })
    expect(fallbackEvents()).toHaveLength(0)
  })

  it("an expired preference is ignored", () => {
    session("bluebubbles", BB_KEY, [event(1, "user", 5)])
    session("teams", TEAMS_KEY, [event(1, "user", 120)])
    expect(resolve(friend({}, { value: "teams", expiresAt: iso(1) }))).toMatchObject({ channel: "bluebubbles", key: BB_KEY })
  })

  it("an observed preference is not a stated one", () => {
    session("bluebubbles", BB_KEY, [event(1, "user", 5)])
    expect(resolve(friend({}, { value: "teams", provenance: "observed" }))).toMatchObject({ channel: "bluebubbles" })
  })

  it("an unreachable preference falls back and logs once", () => {
    session("bluebubbles", BB_KEY, [event(1, "user", 30)])
    expect(resolve(friend({}, { value: "teams" }), new Set<ReachChannel>(["bluebubbles"]))).toMatchObject({ channel: "bluebubbles", key: BB_KEY })
    expect(fallbackEvents()).toEqual([expect.objectContaining({ meta: { friendId: "ari", preferred: "teams", chosen: "bluebubbles" } })])
  })

  it("most recent ranks by the friend's own inbound, not agent-recorded outbound", () => {
    session("bluebubbles", BB_KEY, [event(1, "user", 10)])
    session("teams", TEAMS_KEY, [event(1, "user", 60), event(2, "assistant", 1, "outbound")])
    expect(resolve(friend())).toMatchObject({ channel: "bluebubbles", key: BB_KEY })
  })

  it("a session older than 24 hours still counts", () => {
    session("teams", TEAMS_KEY, [event(1, "user", 3 * 24 * 60)])
    expect(resolve(friend())).toEqual({ channel: "teams", key: TEAMS_KEY, friendId: "ari", handle: "aad-ari", tenantId: "tenant-1" })
  })

  it("group chats are excluded", () => {
    session("bluebubbles", "chat_any;+;family-group", [event(1, "user", 1)])
    session("teams", "19_meeting-thread", [event(1, "user", 2)])
    session("teams", TEAMS_KEY, [event(1, "user", 300)])
    expect(resolve(friend())).toMatchObject({ channel: "teams", key: TEAMS_KEY })
  })

  it("a chat-identifier session counts only when it names the friend's own handle", () => {
    session("bluebubbles", "chat_identifier_chat123456", [event(1, "user", 1)])
    session("bluebubbles", "chat_identifier_+15555550123", [event(1, "user", 50)])
    session("teams", TEAMS_KEY, [event(1, "user", 20)])
    expect(resolve(friend())).toMatchObject({ channel: "teams", key: TEAMS_KEY })
    session("bluebubbles", "chat_identifier_+15555550123", [event(1, "user", 5)])
    expect(resolve(friend())).toMatchObject({ channel: "bluebubbles", key: "chat_identifier_+15555550123" })
  })

  it("an empty expiry means the preference has none, and a record without ids is unreachable", () => {
    expect(resolve(friend({}, { value: "teams", expiresAt: "" }))).toMatchObject({ channel: "teams" })
    expect(resolve(friend({ externalIds: undefined } as unknown as Partial<FriendRecord>))).toEqual({ unreachable: expect.any(String), friendId: "ari" })
  })

  it("ignores other friends' sessions and channels that are not enabled", () => {
    session("bluebubbles", BB_KEY, [event(1, "user", 1)], "someone-else")
    session("teams", TEAMS_KEY, [event(1, "user", 1)])
    expect(resolve(friend(), new Set<ReachChannel>(["bluebubbles"]))).toEqual({ channel: "bluebubbles", key: null, friendId: "ari", handle: "+15555550123" })
  })

  it("falls back to any reachable channel, BlueBubbles first, with key null", () => {
    expect(resolve(friend())).toEqual({ channel: "bluebubbles", key: null, friendId: "ari", handle: "+15555550123" })
    expect(resolve(friend({ externalIds: [{ provider: "aad", externalId: "AAD-Ari", linkedAt: iso(1) }] } as Partial<FriendRecord>)))
      .toEqual({ channel: "teams", key: null, friendId: "ari", handle: "aad-ari" })
  })

  it("a Teams group id is not a way to reach a person", () => {
    const record = friend({ externalIds: [{ provider: "aad", externalId: "group:team-chat", linkedAt: iso(1) }] } as Partial<FriendRecord>)
    expect(resolve(record)).toEqual({ unreachable: expect.stringContaining("no reachable channel"), friendId: "ari" })
  })

  it("returns unreachable when nothing is enabled", () => {
    expect(resolve(friend(), new Set())).toEqual({ unreachable: expect.any(String), friendId: "ari" })
  })
})
