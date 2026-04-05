import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import {
  derivePresence,
  readPresence,
  writePresence,
  readPeerPresence,
  type AgentPresence,
  type PresenceAvailability,
} from "../../arc/presence"

describe("presence", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "presence-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("AgentPresence interface", () => {
    it("derivePresence returns all required fields", () => {
      const presence = derivePresence(tmpDir, "ouroboros", {
        activeSessions: 1,
        openObligations: 2,
        activeBridges: 0,
        codingLanes: 1,
        currentTempo: "standard",
      })

      expect(presence.agentName).toBe("ouroboros")
      expect(presence.availability).toBeDefined()
      expect(presence.lane).toBeDefined()
      expect(presence.mission).toBeDefined()
      expect(presence.tempo).toBe("standard")
      expect(presence.updatedAt).toBeTruthy()
    })

    it("supports all PresenceAvailability values", () => {
      const values: PresenceAvailability[] = ["active", "idle", "away", "dnd"]
      for (const v of values) {
        expect(typeof v).toBe("string")
      }
    })
  })

  describe("derivePresence", () => {
    it("returns active availability when sessions > 0", () => {
      const presence = derivePresence(tmpDir, "ouroboros", {
        activeSessions: 2,
        openObligations: 0,
        activeBridges: 0,
        codingLanes: 0,
        currentTempo: "brief",
      })
      expect(presence.availability).toBe("active")
    })

    it("returns idle availability when no sessions and some obligations", () => {
      const presence = derivePresence(tmpDir, "ouroboros", {
        activeSessions: 0,
        openObligations: 3,
        activeBridges: 0,
        codingLanes: 0,
        currentTempo: "standard",
      })
      expect(presence.availability).toBe("idle")
    })

    it("returns away availability when no sessions and no obligations", () => {
      const presence = derivePresence(tmpDir, "ouroboros", {
        activeSessions: 0,
        openObligations: 0,
        activeBridges: 0,
        codingLanes: 0,
        currentTempo: "brief",
      })
      expect(presence.availability).toBe("away")
    })

    it("returns dnd availability during crisis tempo", () => {
      const presence = derivePresence(tmpDir, "ouroboros", {
        activeSessions: 1,
        openObligations: 5,
        activeBridges: 2,
        codingLanes: 1,
        currentTempo: "crisis",
      })
      expect(presence.availability).toBe("dnd")
    })

    it("derives lane from active bridges and coding lanes", () => {
      const coding = derivePresence(tmpDir, "ouroboros", {
        activeSessions: 1,
        openObligations: 0,
        activeBridges: 0,
        codingLanes: 2,
        currentTempo: "standard",
      })
      expect(coding.lane).toBe("coding")

      const bridge = derivePresence(tmpDir, "ouroboros", {
        activeSessions: 1,
        openObligations: 0,
        activeBridges: 1,
        codingLanes: 0,
        currentTempo: "standard",
      })
      expect(bridge.lane).toBe("conversation")

      const mixed = derivePresence(tmpDir, "ouroboros", {
        activeSessions: 1,
        openObligations: 0,
        activeBridges: 1,
        codingLanes: 1,
        currentTempo: "standard",
      })
      expect(mixed.lane).toBe("mixed")
    })

    it("derives idle lane when no active work", () => {
      const presence = derivePresence(tmpDir, "ouroboros", {
        activeSessions: 0,
        openObligations: 0,
        activeBridges: 0,
        codingLanes: 0,
        currentTempo: "brief",
      })
      expect(presence.lane).toBe("idle")
    })

    it("includes mission summary from open obligations", () => {
      const presence = derivePresence(tmpDir, "ouroboros", {
        activeSessions: 1,
        openObligations: 3,
        activeBridges: 1,
        codingLanes: 0,
        currentTempo: "standard",
      })
      expect(presence.mission).toContain("3")
    })

    it("uses singular form for exactly 1 obligation/bridge/lane", () => {
      const presence = derivePresence(tmpDir, "ouroboros", {
        activeSessions: 1,
        openObligations: 1,
        activeBridges: 1,
        codingLanes: 1,
        currentTempo: "standard",
      })
      expect(presence.mission).toContain("1 open obligation,")
      expect(presence.mission).toContain("1 active bridge,")
      expect(presence.mission).toContain("1 coding lane")
      // Singular - no trailing 's'
      expect(presence.mission).not.toContain("obligations")
      expect(presence.mission).not.toContain("bridges")
      expect(presence.mission).not.toContain("lanes")
    })

    it("passes through currentTempo", () => {
      for (const tempo of ["brief", "standard", "dense", "crisis"] as const) {
        const presence = derivePresence(tmpDir, "ouroboros", {
          activeSessions: 1,
          openObligations: 0,
          activeBridges: 0,
          codingLanes: 0,
          currentTempo: tempo,
        })
        expect(presence.tempo).toBe(tempo)
      }
    })
  })

  describe("writePresence + readPresence", () => {
    it("persists and reads back presence", () => {
      const presence = derivePresence(tmpDir, "ouroboros", {
        activeSessions: 1,
        openObligations: 0,
        activeBridges: 0,
        codingLanes: 0,
        currentTempo: "brief",
      })

      writePresence(tmpDir, "ouroboros", presence)
      const read = readPresence(tmpDir, "ouroboros")

      expect(read).toBeDefined()
      expect(read!.agentName).toBe("ouroboros")
      expect(read!.availability).toBe(presence.availability)
      expect(read!.tempo).toBe("brief")
    })

    it("returns null when presence file does not exist", () => {
      const read = readPresence(tmpDir, "ouroboros")
      expect(read).toBeNull()
    })

    it("returns null when presence file contains malformed JSON", () => {
      const dir = path.join(tmpDir, "state", "presence")
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, "self.json"), "not valid json{{{", "utf-8")

      const read = readPresence(tmpDir, "ouroboros")
      expect(read).toBeNull()
    })

    it("overwrites previous presence on write", () => {
      const first = derivePresence(tmpDir, "ouroboros", {
        activeSessions: 1,
        openObligations: 0,
        activeBridges: 0,
        codingLanes: 0,
        currentTempo: "brief",
      })
      writePresence(tmpDir, "ouroboros", first)

      const second = derivePresence(tmpDir, "ouroboros", {
        activeSessions: 0,
        openObligations: 5,
        activeBridges: 2,
        codingLanes: 1,
        currentTempo: "crisis",
      })
      writePresence(tmpDir, "ouroboros", second)

      const read = readPresence(tmpDir, "ouroboros")
      expect(read!.availability).toBe("dnd")
      expect(read!.tempo).toBe("crisis")
    })
  })

  describe("readPeerPresence", () => {
    it("reads from friends/ directory, not state/relationships/", () => {
      const friendsDir = path.join(tmpDir, "friends")
      fs.mkdirSync(friendsDir, { recursive: true })
      fs.writeFileSync(
        path.join(friendsDir, "slugger-uuid.json"),
        JSON.stringify({
          id: "slugger-uuid",
          name: "Slugger",
          kind: "agent",
          agentMeta: { bundleName: "slugger.ouro", familiarity: 5, sharedMissions: [], outcomes: [] },
          updatedAt: "2026-04-01T10:00:00.000Z",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          totalTokens: 0,
          createdAt: "2026-04-01T00:00:00.000Z",
          schemaVersion: 1,
        }),
        "utf-8",
      )

      const peers = readPeerPresence(tmpDir)
      expect(peers).toHaveLength(1)
      expect(peers[0].agentName).toBe("Slugger")
    })

    it("returns AgentPresence[] for kind=agent friends only", () => {
      const friendsDir = path.join(tmpDir, "friends")
      fs.mkdirSync(friendsDir, { recursive: true })

      // Agent friend
      fs.writeFileSync(
        path.join(friendsDir, "agent-uuid.json"),
        JSON.stringify({
          id: "agent-uuid",
          name: "Copilot",
          kind: "agent",
          agentMeta: { bundleName: "copilot.ouro", familiarity: 3, sharedMissions: [], outcomes: [] },
          updatedAt: "2026-04-01T10:00:00.000Z",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          totalTokens: 0,
          createdAt: "2026-04-01T00:00:00.000Z",
          schemaVersion: 1,
        }),
        "utf-8",
      )

      // Human friend
      fs.writeFileSync(
        path.join(friendsDir, "human-uuid.json"),
        JSON.stringify({
          id: "human-uuid",
          name: "Jordan",
          kind: "human",
          updatedAt: "2026-04-01T10:00:00.000Z",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          totalTokens: 0,
          createdAt: "2026-04-01T00:00:00.000Z",
          schemaVersion: 1,
        }),
        "utf-8",
      )

      const peers = readPeerPresence(tmpDir)
      expect(peers).toHaveLength(1)
      expect(peers[0].agentName).toBe("Copilot")
    })

    it("skips friend records where kind is missing", () => {
      const friendsDir = path.join(tmpDir, "friends")
      fs.mkdirSync(friendsDir, { recursive: true })
      fs.writeFileSync(
        path.join(friendsDir, "legacy-uuid.json"),
        JSON.stringify({
          id: "legacy-uuid",
          name: "Legacy",
          updatedAt: "2026-04-01T10:00:00.000Z",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          totalTokens: 0,
          createdAt: "2026-04-01T00:00:00.000Z",
          schemaVersion: 1,
        }),
        "utf-8",
      )

      const peers = readPeerPresence(tmpDir)
      expect(peers).toEqual([])
    })

    it("returns empty array when friends directory does not exist", () => {
      const peers = readPeerPresence(tmpDir)
      expect(peers).toEqual([])
    })

    it("returns empty array when no agent friends exist", () => {
      const friendsDir = path.join(tmpDir, "friends")
      fs.mkdirSync(friendsDir, { recursive: true })
      fs.writeFileSync(
        path.join(friendsDir, "human-uuid.json"),
        JSON.stringify({
          id: "human-uuid",
          name: "Jordan",
          kind: "human",
          updatedAt: "2026-04-01T10:00:00.000Z",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          totalTokens: 0,
          createdAt: "2026-04-01T00:00:00.000Z",
          schemaVersion: 1,
        }),
        "utf-8",
      )

      const peers = readPeerPresence(tmpDir)
      expect(peers).toEqual([])
    })

    it("handles malformed JSON files gracefully", () => {
      const friendsDir = path.join(tmpDir, "friends")
      fs.mkdirSync(friendsDir, { recursive: true })
      fs.writeFileSync(path.join(friendsDir, "bad.json"), "not valid json{{{", "utf-8")

      const peers = readPeerPresence(tmpDir)
      expect(peers).toEqual([])
    })

    it("handles non-JSON files gracefully", () => {
      const friendsDir = path.join(tmpDir, "friends")
      fs.mkdirSync(friendsDir, { recursive: true })
      fs.writeFileSync(path.join(friendsDir, ".DS_Store"), "junk", "utf-8")
      fs.writeFileSync(path.join(friendsDir, "readme.txt"), "not a friend", "utf-8")

      const peers = readPeerPresence(tmpDir)
      expect(peers).toEqual([])
    })

    it("populates AgentPresence fields correctly", () => {
      const friendsDir = path.join(tmpDir, "friends")
      fs.mkdirSync(friendsDir, { recursive: true })
      fs.writeFileSync(
        path.join(friendsDir, "slugger-uuid.json"),
        JSON.stringify({
          id: "slugger-uuid",
          name: "Slugger",
          kind: "agent",
          agentMeta: { bundleName: "slugger.ouro", familiarity: 5, sharedMissions: [], outcomes: [] },
          updatedAt: "2026-04-01T10:00:00.000Z",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          totalTokens: 0,
          createdAt: "2026-04-01T00:00:00.000Z",
          schemaVersion: 1,
        }),
        "utf-8",
      )

      const peers = readPeerPresence(tmpDir)
      expect(peers).toHaveLength(1)
      const peer = peers[0]
      expect(peer.agentName).toBe("Slugger")
      expect(peer.availability).toBe("idle")
      expect(peer.lane).toBe("idle")
      expect(peer.mission).toBe("")
      expect(peer.tempo).toBe("brief")
      expect(peer.updatedAt).toBe("2026-04-01T10:00:00.000Z")
    })

    it("stays synchronous (uses fs.readdirSync/readFileSync)", () => {
      // readPeerPresence returns AgentPresence[] directly, not a Promise
      const result = readPeerPresence(tmpDir)
      expect(Array.isArray(result)).toBe(true)
      // Not a promise
      expect(result).not.toHaveProperty("then")
    })

    it("falls back to filename when name is missing", () => {
      const friendsDir = path.join(tmpDir, "friends")
      fs.mkdirSync(friendsDir, { recursive: true })
      fs.writeFileSync(
        path.join(friendsDir, "nameless-agent.json"),
        JSON.stringify({
          id: "nameless",
          kind: "agent",
          updatedAt: "2026-04-01T10:00:00.000Z",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          totalTokens: 0,
          createdAt: "2026-04-01T00:00:00.000Z",
          schemaVersion: 1,
        }),
        "utf-8",
      )

      const peers = readPeerPresence(tmpDir)
      expect(peers).toHaveLength(1)
      expect(peers[0].agentName).toBe("nameless-agent")
    })

    it("falls back to current timestamp when updatedAt is missing", () => {
      const friendsDir = path.join(tmpDir, "friends")
      fs.mkdirSync(friendsDir, { recursive: true })
      fs.writeFileSync(
        path.join(friendsDir, "no-updated.json"),
        JSON.stringify({
          id: "no-updated",
          name: "NoUpdate",
          kind: "agent",
          externalIds: [],
          tenantMemberships: [],
          toolPreferences: {},
          notes: {},
          totalTokens: 0,
          createdAt: "2026-04-01T00:00:00.000Z",
          schemaVersion: 1,
        }),
        "utf-8",
      )

      const peers = readPeerPresence(tmpDir)
      expect(peers).toHaveLength(1)
      expect(peers[0].agentName).toBe("NoUpdate")
      // updatedAt should be a valid ISO date string (fallback to current time)
      expect(new Date(peers[0].updatedAt).getTime()).not.toBeNaN()
    })
  })
})
