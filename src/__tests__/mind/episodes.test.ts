import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import {
  emitEpisode,
  readRecentEpisodes,
  type EpisodeRecord,
  type EpisodeKind,
} from "../../arc/episodes"

describe("episode store", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "episodes-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("EpisodeRecord interface compliance", () => {
    it("emitEpisode returns a record with all required fields", () => {
      const episode = emitEpisode(tmpDir, {
        kind: "obligation_shift",
        summary: "obligation reclassified from pending to investigating",
        whyItMattered: "shows commitment to follow-through",
        relatedEntities: ["ob-123"],
        salience: "medium",
      })

      expect(episode.id).toBeTruthy()
      expect(typeof episode.id).toBe("string")
      expect(episode.timestamp).toBeTruthy()
      expect(episode.kind).toBe("obligation_shift")
      expect(episode.summary).toBe("obligation reclassified from pending to investigating")
      expect(episode.whyItMattered).toBe("shows commitment to follow-through")
      expect(episode.relatedEntities).toEqual(["ob-123"])
      expect(episode.salience).toBe("medium")
    })

    it("supports all EpisodeKind values", () => {
      const kinds: EpisodeKind[] = [
        "obligation_shift",
        "coding_milestone",
        "bridge_event",
        "care_event",
        "tempo_shift",
        "turning_point",
      ]

      for (const kind of kinds) {
        const episode = emitEpisode(tmpDir, {
          kind,
          summary: `test ${kind}`,
          whyItMattered: "testing",
          relatedEntities: [],
          salience: "low",
        })
        expect(episode.kind).toBe(kind)
      }
    })

    it("accepts optional meta field", () => {
      const episode = emitEpisode(tmpDir, {
        kind: "turning_point",
        summary: "realized a better approach",
        whyItMattered: "saves hours of wasted effort",
        relatedEntities: [],
        salience: "high",
        meta: { source: "reflection", threadId: "abc-123" },
      })

      expect(episode.meta).toEqual({ source: "reflection", threadId: "abc-123" })
    })
  })

  describe("emitEpisode", () => {
    it("writes JSON to arc/episodes/ directory", () => {
      const episode = emitEpisode(tmpDir, {
        kind: "coding_milestone",
        summary: "PR merged",
        whyItMattered: "shipped the feature",
        relatedEntities: ["pr-42"],
        salience: "high",
      })

      const filePath = path.join(tmpDir, "arc", "episodes", `${episode.id}.json`)
      expect(fs.existsSync(filePath)).toBe(true)

      const stored = JSON.parse(fs.readFileSync(filePath, "utf-8")) as EpisodeRecord
      expect(stored.id).toBe(episode.id)
      expect(stored.kind).toBe("coding_milestone")
      expect(stored.summary).toBe("PR merged")
      expect(stored.whyItMattered).toBe("shipped the feature")
    })

    it("generates unique IDs for multiple episodes", () => {
      const ep1 = emitEpisode(tmpDir, {
        kind: "bridge_event",
        summary: "first",
        whyItMattered: "test",
        relatedEntities: [],
        salience: "low",
      })
      const ep2 = emitEpisode(tmpDir, {
        kind: "bridge_event",
        summary: "second",
        whyItMattered: "test",
        relatedEntities: [],
        salience: "low",
      })
      expect(ep1.id).not.toBe(ep2.id)
    })

    it("creates the episodes directory if it does not exist", () => {
      const episodesDir = path.join(tmpDir, "arc", "episodes")
      expect(fs.existsSync(episodesDir)).toBe(false)

      emitEpisode(tmpDir, {
        kind: "care_event",
        summary: "created a care",
        whyItMattered: "tracking what matters",
        relatedEntities: [],
        salience: "medium",
      })

      expect(fs.existsSync(episodesDir)).toBe(true)
    })
  })

  describe("readRecentEpisodes", () => {
    it("returns empty array when directory does not exist", () => {
      const episodes = readRecentEpisodes(tmpDir)
      expect(episodes).toEqual([])
    })

    it("returns episodes sorted by timestamp descending (most recent first)", () => {
      const ep1 = emitEpisode(tmpDir, {
        kind: "obligation_shift",
        summary: "first",
        whyItMattered: "test",
        relatedEntities: [],
        salience: "low",
      })
      const ep2 = emitEpisode(tmpDir, {
        kind: "coding_milestone",
        summary: "second",
        whyItMattered: "test",
        relatedEntities: [],
        salience: "low",
      })

      // Ensure distinct timestamps by backdating ep1
      const ep1Path = path.join(tmpDir, "arc", "episodes", `${ep1.id}.json`)
      const ep1Data = JSON.parse(fs.readFileSync(ep1Path, "utf-8")) as EpisodeRecord
      ep1Data.timestamp = "2020-01-01T00:00:00.000Z"
      fs.writeFileSync(ep1Path, JSON.stringify(ep1Data, null, 2), "utf-8")

      const episodes = readRecentEpisodes(tmpDir)
      expect(episodes).toHaveLength(2)
      // Most recent first
      expect(episodes[0].id).toBe(ep2.id)
      expect(episodes[1].id).toBe(ep1.id)
    })

    it("respects limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        emitEpisode(tmpDir, {
          kind: "turning_point",
          summary: `episode ${i}`,
          whyItMattered: "test",
          relatedEntities: [],
          salience: "low",
        })
      }

      const limited = readRecentEpisodes(tmpDir, { limit: 3 })
      expect(limited).toHaveLength(3)
    })

    it("defaults to limit of 50", () => {
      for (let i = 0; i < 55; i++) {
        emitEpisode(tmpDir, {
          kind: "turning_point",
          summary: `episode ${i}`,
          whyItMattered: "test",
          relatedEntities: [],
          salience: "low",
        })
      }

      const episodes = readRecentEpisodes(tmpDir)
      expect(episodes).toHaveLength(50)
    })

    it("filters by since timestamp", () => {
      const old = emitEpisode(tmpDir, {
        kind: "obligation_shift",
        summary: "old episode",
        whyItMattered: "test",
        relatedEntities: [],
        salience: "low",
      })

      // Manually backdate the old episode
      const oldPath = path.join(tmpDir, "arc", "episodes", `${old.id}.json`)
      const oldData = JSON.parse(fs.readFileSync(oldPath, "utf-8")) as EpisodeRecord
      oldData.timestamp = "2020-01-01T00:00:00.000Z"
      fs.writeFileSync(oldPath, JSON.stringify(oldData, null, 2), "utf-8")

      emitEpisode(tmpDir, {
        kind: "coding_milestone",
        summary: "new episode",
        whyItMattered: "test",
        relatedEntities: [],
        salience: "low",
      })

      const filtered = readRecentEpisodes(tmpDir, { since: "2024-01-01T00:00:00.000Z" })
      expect(filtered).toHaveLength(1)
      expect(filtered[0].summary).toBe("new episode")
    })

    it("filters by episode kinds", () => {
      emitEpisode(tmpDir, {
        kind: "obligation_shift",
        summary: "obligation episode",
        whyItMattered: "test",
        relatedEntities: [],
        salience: "low",
      })
      emitEpisode(tmpDir, {
        kind: "coding_milestone",
        summary: "coding episode",
        whyItMattered: "test",
        relatedEntities: [],
        salience: "low",
      })
      emitEpisode(tmpDir, {
        kind: "turning_point",
        summary: "turning point",
        whyItMattered: "test",
        relatedEntities: [],
        salience: "low",
      })

      const filtered = readRecentEpisodes(tmpDir, { kinds: ["coding_milestone", "turning_point"] })
      expect(filtered).toHaveLength(2)
      expect(filtered.every((e) => e.kind === "coding_milestone" || e.kind === "turning_point")).toBe(true)
    })

    it("skips malformed JSON files gracefully", () => {
      emitEpisode(tmpDir, {
        kind: "bridge_event",
        summary: "valid episode",
        whyItMattered: "test",
        relatedEntities: [],
        salience: "low",
      })

      // Write a malformed file
      const episodesDir = path.join(tmpDir, "arc", "episodes")
      fs.writeFileSync(path.join(episodesDir, "bad-file.json"), "not valid json{{{", "utf-8")

      const episodes = readRecentEpisodes(tmpDir)
      expect(episodes).toHaveLength(1)
      expect(episodes[0].summary).toBe("valid episode")
    })

    it("skips non-JSON files", () => {
      emitEpisode(tmpDir, {
        kind: "care_event",
        summary: "valid",
        whyItMattered: "test",
        relatedEntities: [],
        salience: "low",
      })

      const episodesDir = path.join(tmpDir, "arc", "episodes")
      fs.writeFileSync(path.join(episodesDir, "readme.txt"), "not an episode", "utf-8")

      const episodes = readRecentEpisodes(tmpDir)
      expect(episodes).toHaveLength(1)
    })

    it("handles equal timestamps in sort (stable order)", () => {
      const ep1 = emitEpisode(tmpDir, {
        kind: "bridge_event",
        summary: "alpha",
        whyItMattered: "test",
        relatedEntities: [],
        salience: "low",
      })
      const ep2 = emitEpisode(tmpDir, {
        kind: "bridge_event",
        summary: "beta",
        whyItMattered: "test",
        relatedEntities: [],
        salience: "low",
      })

      // Set both to the exact same timestamp
      const sharedTimestamp = "2025-06-15T12:00:00.000Z"
      for (const id of [ep1.id, ep2.id]) {
        const filePath = path.join(tmpDir, "arc", "episodes", `${id}.json`)
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as EpisodeRecord
        data.timestamp = sharedTimestamp
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8")
      }

      const episodes = readRecentEpisodes(tmpDir)
      expect(episodes).toHaveLength(2)
      // Both returned, order is stable (0 comparison means no swap)
      expect(episodes.map((e) => e.timestamp)).toEqual([sharedTimestamp, sharedTimestamp])
    })

    it("combines kind and since filters", () => {
      const old = emitEpisode(tmpDir, {
        kind: "obligation_shift",
        summary: "old obligation",
        whyItMattered: "test",
        relatedEntities: [],
        salience: "low",
      })

      // Backdate
      const oldPath = path.join(tmpDir, "arc", "episodes", `${old.id}.json`)
      const oldData = JSON.parse(fs.readFileSync(oldPath, "utf-8")) as EpisodeRecord
      oldData.timestamp = "2020-01-01T00:00:00.000Z"
      fs.writeFileSync(oldPath, JSON.stringify(oldData, null, 2), "utf-8")

      emitEpisode(tmpDir, {
        kind: "obligation_shift",
        summary: "new obligation",
        whyItMattered: "test",
        relatedEntities: [],
        salience: "low",
      })

      emitEpisode(tmpDir, {
        kind: "coding_milestone",
        summary: "new coding",
        whyItMattered: "test",
        relatedEntities: [],
        salience: "low",
      })

      const filtered = readRecentEpisodes(tmpDir, {
        since: "2024-01-01T00:00:00.000Z",
        kinds: ["obligation_shift"],
      })
      expect(filtered).toHaveLength(1)
      expect(filtered[0].summary).toBe("new obligation")
    })
  })
})
