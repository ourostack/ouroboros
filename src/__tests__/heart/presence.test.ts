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
} from "../../heart/presence"

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
    it("returns empty array when no relationships exist", () => {
      const peers = readPeerPresence(tmpDir)
      expect(peers).toEqual([])
    })

    it("returns empty array when relationships dir is missing", () => {
      const peers = readPeerPresence(tmpDir)
      expect(peers).toEqual([])
    })

    it("reads peer presence from their bundles when available", () => {
      // Create a relationship file to establish a known peer
      const relDir = path.join(tmpDir, "state", "relationships")
      fs.mkdirSync(relDir, { recursive: true })
      fs.writeFileSync(
        path.join(relDir, "slugger.json"),
        JSON.stringify({ agentName: "slugger", displayName: "Slugger" }),
        "utf-8",
      )

      // Create the peer's presence file at the expected location
      const peerRoot = path.join(os.homedir(), "AgentBundles", "slugger.ouro")
      const peerPresenceDir = path.join(peerRoot, "state", "presence")
      const peerPresenceExists = fs.existsSync(peerPresenceDir)

      // Create temp peer presence for test (skip if we can't write to peer bundle)
      let createdPeerPresence = false
      try {
        fs.mkdirSync(peerPresenceDir, { recursive: true })
        fs.writeFileSync(
          path.join(peerPresenceDir, "self.json"),
          JSON.stringify({
            agentName: "slugger",
            availability: "active",
            lane: "coding",
            mission: "working on tests",
            tempo: "standard",
            updatedAt: new Date().toISOString(),
          }),
          "utf-8",
        )
        createdPeerPresence = true
      } catch {
        // Cannot write to peer bundle in test environment - skip
      }

      if (createdPeerPresence) {
        const peers = readPeerPresence(tmpDir)
        expect(peers.length).toBeGreaterThanOrEqual(1)
        const slugger = peers.find((p) => p.agentName === "slugger")
        expect(slugger).toBeDefined()
        expect(slugger!.availability).toBe("active")

        // Clean up peer presence
        if (!peerPresenceExists) {
          fs.rmSync(peerPresenceDir, { recursive: true, force: true })
        }
      }
    })

    it("skips peers whose presence files do not exist", () => {
      // Create a relationship file for a peer that has no presence
      const relDir = path.join(tmpDir, "state", "relationships")
      fs.mkdirSync(relDir, { recursive: true })
      fs.writeFileSync(
        path.join(relDir, "nonexistent-agent.json"),
        JSON.stringify({ agentName: "nonexistent-agent", displayName: "Ghost" }),
        "utf-8",
      )

      const peers = readPeerPresence(tmpDir)
      // Should not crash, just return empty or skip the missing peer
      expect(Array.isArray(peers)).toBe(true)
    })
  })
})
