import { describe, it, expect, beforeEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { FileFriendStore, FriendResolver, type FriendRecord } from "@ouro.bot/friends"
import { DEFAULT_LINK_CODE_TTL_MS, formatLinkCode, issueLinkCode, parseLinkCode, redeemLinkCode } from "../../mind/friend-link-codes"

const AAD = { provider: "aad" as const, externalId: "aad-object-1", tenantId: "tenant-1" }
const NOW = new Date("2026-10-12T20:00:00.000Z")

let agentRoot: string
let friendsDir: string
let store: FileFriendStore
let family: FriendRecord

function teamsResolver(): FriendResolver {
  return new FriendResolver(store, { provider: "aad", externalId: AAD.externalId, tenantId: AAD.tenantId, displayName: "Ari Mendelow", channel: "teams" })
}

async function teamsStranger(): Promise<FriendRecord> {
  return (await teamsResolver().resolve()).friend
}

function redeem(text: string, claimant: FriendRecord, overrides: Partial<Parameters<typeof redeemLinkCode>[0]> = {}) {
  return redeemLinkCode({ agentRoot, friendsDir, store, text, claimant, channel: "teams", isGroupChat: false, now: () => NOW, ...overrides })
}

beforeEach(async () => {
  agentRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "link-codes-")), "agent.ouro")
  friendsDir = path.join(agentRoot, "friends")
  store = new FileFriendStore(friendsDir)
  family = {
    id: "family-ari",
    name: "Ari",
    role: "family",
    trustLevel: "family",
    connections: [],
    externalIds: [{ provider: "local", externalId: "ari@host.local", linkedAt: "2026-01-01T00:00:00.000Z" }],
    tenantMemberships: [],
    toolPreferences: {},
    notes: { name: { value: "Ari", savedAt: "2026-01-01T00:00:00.000Z" } },
    totalTokens: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
    kind: "human",
  }
  await store.put(family.id, family)
})

describe("parseLinkCode", () => {
  it("accepts one code in any spacing, case or light markup", () => {
    expect(parseLinkCode("OURO-ABCD-EF23")).toBe("ABCDEF23")
    expect(parseLinkCode("  ouro abcd ef23 ")).toBe("ABCDEF23")
    expect(parseLinkCode("OUROABCDEF23")).toBe("ABCDEF23")
    expect(parseLinkCode("<p>OURO-ABCD-EF23</p>")).toBe("ABCDEF23")
    expect(parseLinkCode("<at>Ouro</at> OURO-ABCD-EF23")).toBe("ABCDEF23")
    expect(parseLinkCode("OURO-ABCD&nbsp;-EF23")).toBe("ABCDEF23")
  })

  it("rejects anything that is not exactly one code", () => {
    expect(parseLinkCode("hello")).toBeNull()
    expect(parseLinkCode("my code is OURO-ABCD-EF23")).toBeNull()
    expect(parseLinkCode("OURO-ABCD-EF2")).toBeNull()
    // 0, 1, I and O are not in the alphabet.
    expect(parseLinkCode("OURO-ABCD-EF01")).toBeNull()
    expect(formatLinkCode("ABCDEF23")).toBe("OURO-ABCD-EF23")
  })
})

describe("issueLinkCode", () => {
  it("stores only a digest of the code, privately, with an expiry", () => {
    const issued = issueLinkCode({ agentRoot, friend: family, channel: "teams", issuedBy: "cli", now: () => NOW })
    expect(issued).toMatchObject({ friendId: family.id, friendName: "Ari", channel: "teams", expiresAt: new Date(NOW.getTime() + DEFAULT_LINK_CODE_TTL_MS).toISOString() })
    expect(parseLinkCode(issued.code)).not.toBeNull()
    const pendingDir = path.join(agentRoot, "state", "friend-link-codes", "pending")
    const [file] = fs.readdirSync(pendingDir)
    expect(file).toMatch(/^[a-f0-9]{64}\.json$/)
    const raw = fs.readFileSync(path.join(pendingDir, file!), "utf-8")
    expect(raw).not.toContain(parseLinkCode(issued.code)!)
    expect(fs.statSync(path.join(pendingDir, file!)).mode & 0o777).toBe(0o600)
  })

  it("clamps the lifetime between one minute and one day and may omit the channel", () => {
    const short = issueLinkCode({ agentRoot, friend: family, ttlMs: 1, issuedBy: "cli", now: () => NOW })
    expect(short.channel).toBeUndefined()
    expect(Date.parse(short.expiresAt) - NOW.getTime()).toBe(60 * 1000)
    const long = issueLinkCode({ agentRoot, friend: family, ttlMs: 10 * 24 * 60 * 60 * 1000, issuedBy: "cli", now: () => NOW })
    expect(Date.parse(long.expiresAt) - NOW.getTime()).toBe(24 * 60 * 60 * 1000)
    expect(Date.parse(issueLinkCode({ agentRoot, friend: family, issuedBy: "cli" }).expiresAt)).toBeGreaterThan(Date.now())
  })
})

describe("redeemLinkCode", () => {
  it("ignores messages that are not codes", async () => {
    expect(await redeem("hello", await teamsStranger())).toBeNull()
  })

  it("links the Teams identity into the family record, once", async () => {
    const issued = issueLinkCode({ agentRoot, friend: family, channel: "teams", issuedBy: "cli", now: () => NOW })
    const stranger = await teamsStranger()

    const result = await redeem(issued.code.toLowerCase(), stranger)
    expect(result).toMatchObject({ status: "linked", friend: { id: family.id, trustLevel: "family" } })
    expect(result!.reply).toContain("Ari")

    // Trust after link: the next Teams message resolves to family.
    const next = await teamsStranger()
    expect(next.id).toBe(family.id)
    expect(next.trustLevel).toBe("family")
    expect(await store.get(stranger.id)).toBeNull()
    expect(fs.existsSync(path.join(friendsDir, "_retired", `${stranger.id}.json`))).toBe(true)

    // The used code records its outcome and cannot be replayed.
    const usedDir = path.join(agentRoot, "state", "friend-link-codes", "used")
    const [usedFile] = fs.readdirSync(usedDir)
    expect(JSON.parse(fs.readFileSync(path.join(usedDir, usedFile!), "utf-8"))).toMatchObject({ outcome: "linked", claimantId: stranger.id, consumedAt: NOW.toISOString() })
    const replayClaimant = { ...stranger, id: "another-stranger" }
    expect(await redeem(issued.code, replayClaimant)).toMatchObject({ status: "rejected", reason: "unknown_or_used" })
  })

  it("uses the real clock when none is injected", async () => {
    const result = await redeem("OURO-ZZZZ-ZZZZ", await teamsStranger(), { now: undefined })
    expect(result).toMatchObject({ status: "rejected", reason: "unknown_or_used" })
  })

  it("rejects an unknown code", async () => {
    expect(await redeem("OURO-AAAA-BBBB", await teamsStranger())).toMatchObject({ status: "rejected", reason: "unknown_or_used" })
  })

  it("rejects an expired code and consumes it", async () => {
    const issued = issueLinkCode({ agentRoot, friend: family, issuedBy: "cli", now: () => new Date(NOW.getTime() - DEFAULT_LINK_CODE_TTL_MS) })
    const stranger = await teamsStranger()
    expect(await redeem(issued.code, stranger)).toMatchObject({ status: "rejected", reason: "expired" })
    expect(await redeem(issued.code, stranger)).toMatchObject({ status: "rejected", reason: "unknown_or_used" })
    expect((await teamsStranger()).trustLevel).toBe("stranger")
  })

  it("rejects codes in group chats, on the wrong channel, from the same person, or from a trusted record", async () => {
    const stranger = await teamsStranger()
    const code = () => issueLinkCode({ agentRoot, friend: family, channel: "teams", issuedBy: "cli", now: () => NOW }).code
    expect(await redeem(code(), stranger, { isGroupChat: true })).toMatchObject({ reason: "group_chat" })
    expect(await redeem(code(), stranger, { channel: "bluebubbles" })).toMatchObject({ reason: "wrong_channel" })
    expect(await redeem(code(), family)).toMatchObject({ reason: "already_linked" })
    expect(await redeem(code(), { ...stranger, trustLevel: "friend" })).toMatchObject({ reason: "claimant_trusted" })
    expect(await redeem(code(), { ...stranger, trustLevel: undefined })).toMatchObject({ reason: "claimant_trusted" })
    expect((await teamsStranger()).id).toBe(stranger.id)
  })

  it("accepts an acquaintance and rejects a code whose friend is gone", async () => {
    const stranger = await teamsStranger()
    const ghost = issueLinkCode({ agentRoot, friend: { id: "ghost", name: "Ghost" }, issuedBy: "cli", now: () => NOW })
    expect(await redeem(ghost.code, stranger)).toMatchObject({ status: "rejected", reason: "friend_missing" })
    const issued = issueLinkCode({ agentRoot, friend: family, issuedBy: "cli", now: () => NOW })
    expect(await redeem(issued.code, { ...stranger, trustLevel: "acquaintance" })).toMatchObject({ status: "linked" })
  })
})
