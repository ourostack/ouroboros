import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { FileFriendStore, type FriendRecord, type TrustLevel } from "@ouro.bot/friends"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { capLocalTrust, resolveLocalAudioFriend } from "../../../senses/voice/local-audio-identity"

let root: string
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "local-audio-identity-")) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

async function seed(id: string, trustLevel?: TrustLevel, name = "Ari"): Promise<void> {
  const store = new FileFriendStore(path.join(root, "friends"))
  const now = new Date().toISOString()
  const record: FriendRecord = {
    id, name, ...(trustLevel ? { trustLevel } : {}), externalIds: [], tenantMemberships: [], toolPreferences: {},
    notes: {}, totalTokens: 0, createdAt: now, updatedAt: now, schemaVersion: 1,
  } as FriendRecord
  await store.put(id, record)
}

describe("capLocalTrust", () => {
  it("is acquaintance unless the room is the owner alone, and never raises a lower trust", () => {
    expect(capLocalTrust("family", false)).toBe("acquaintance")
    expect(capLocalTrust("friend", false)).toBe("acquaintance")
    expect(capLocalTrust("stranger", false)).toBe("stranger")
    expect(capLocalTrust(undefined, false)).toBe("acquaintance")
    expect(capLocalTrust("family", true)).toBe("family")
    expect(capLocalTrust("friend", true)).toBe("friend")
    expect(capLocalTrust(undefined, true)).toBe("acquaintance")
    expect(capLocalTrust("acquaintance", true)).toBe("acquaintance")
  })
})

describe("resolveLocalAudioFriend", () => {
  it("runs a family friend at acquaintance by default", async () => {
    await seed("ari", "family")
    const resolved = await resolveLocalAudioFriend({ agentRoot: root, friendId: "ari", ownerAlone: false })
    expect(resolved.friendId).toBe("ari")
    expect(resolved.resolved.friend.trustLevel).toBe("acquaintance")
    expect(resolved.resolved.channel.channel).toBe("voice")
    expect((await resolved.friendStore.get("ari"))!.trustLevel).toBe("family")
  })

  it("keeps the recorded trust only when the join says the owner is alone", async () => {
    await seed("ari", "family")
    const resolved = await resolveLocalAudioFriend({ agentRoot: root, friendId: "ari", ownerAlone: true })
    expect(resolved.resolved.friend.trustLevel).toBe("family")
  })

  it("falls back to one stable acquaintance-level room record for an unknown or unsafe friend id", async () => {
    const first = await resolveLocalAudioFriend({ agentRoot: root, friendId: "../etc/passwd", ownerAlone: true })
    expect(first.resolved.friend.trustLevel).toBe("acquaintance")
    expect(await first.friendStore.get("local-audio-room")).toBeNull()
    const second = await resolveLocalAudioFriend({ agentRoot: root, friendId: "nobody", ownerAlone: false })
    const third = await resolveLocalAudioFriend({ agentRoot: root, ownerAlone: false })
    expect(second.friendId).toBe(first.friendId)
    expect(third.friendId).toBe(first.friendId)
    expect(third.resolved.friend.trustLevel).toBe("acquaintance")
    await seed("local-audio-room", "stranger", "Saved room")
    const saved = await resolveLocalAudioFriend({ agentRoot: root, ownerAlone: true })
    expect(saved.resolved.friend.name).toBe("Saved room")
    expect(saved.resolved.friend.trustLevel).toBe("stranger")
  })

  it("never matches a friend by display name", async () => {
    await seed("ari-id", "family", "ari")
    const resolved = await resolveLocalAudioFriend({ agentRoot: root, friendId: "ari", ownerAlone: true })
    expect(resolved.friendId).not.toBe("ari-id")
  })
})
