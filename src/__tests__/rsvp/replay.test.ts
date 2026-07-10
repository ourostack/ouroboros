import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  renderLegacyRsvpSnapshotOffline,
  replayRsvpFixture,
} from "../../rsvp/replay"

const tempRoots: string[] = []

function makeTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

function writeFixture(root: string): string {
  const fixturePath = path.join(root, "rsvp-fixture.json")
  fs.writeFileSync(fixturePath, JSON.stringify({
    schemaVersion: 1,
    policyVersion: "rsvp-replay/v1",
    agent: "slugger",
    expected: {
      contextPacketHash: "sha256:fixture-context",
      modelInputHash: "sha256:fixture-model-input",
    },
    privacy: {
      rawLiveTranscriptStored: false,
      searchIndex: false,
      vectorIndex: false,
    },
    question: "who is pending?",
    snapshot: {
      snapshotId: "snap_fixture",
      pendingGuests: ["Casey Pending"],
    },
  }), "utf-8")
  return fixturePath
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe("RSVP offline replay", () => {
  it("replays a minimized fixture with expected packet and model-input hashes", async () => {
    const fixtureRoot = makeTempRoot("rsvp-replay-fixture-")
    const fixturePath = writeFixture(fixtureRoot)
    const forbiddenLiveCall = vi.fn(() => {
      throw new Error("live side effect should be blocked")
    })

    const result = await replayRsvpFixture({
      fixturePath,
      deps: {
        fetchAislePlanner: forbiddenLiveCall,
        sendBlueBubbles: forbiddenLiveCall,
        writeVaultItem: forbiddenLiveCall,
      },
    })

    expect(result).toMatchObject({
      schemaVersion: 1,
      policyVersion: "rsvp-replay-result/v1",
      sideEffect: false,
      contextPacketHash: "sha256:fixture-context",
      modelInputHash: "sha256:fixture-model-input",
      answer: expect.stringContaining("Casey Pending"),
    })
    expect(result.indexPolicy).toEqual({ search: false, vector: false })
    expect(forbiddenLiveCall).not.toHaveBeenCalled()
  })

  it("renders legacy RSVP state offline without mutating the legacy root or calling legacy live helpers", async () => {
    const legacyRoot = makeTempRoot("rsvp-legacy-offline-")
    const outputPath = path.join(makeTempRoot("rsvp-legacy-output-"), "legacy-render.json")
    fs.writeFileSync(path.join(legacyRoot, "guests.json"), JSON.stringify({
      guests: {
        pending_1: { first_name: "Casey", last_name: "Pending", attending_status: "pending" },
      },
    }), "utf-8")
    const before = fs.readdirSync(legacyRoot).map((name) => [name, fs.readFileSync(path.join(legacyRoot, name), "utf-8")])
    const forbiddenLegacyHelper = vi.fn(() => {
      throw new Error("legacy live helper should be blocked")
    })

    const result = await renderLegacyRsvpSnapshotOffline({
      legacyRoot,
      outputPath,
      deps: {
        saveSnapshot: forbiddenLegacyHelper,
        writeSentState: forbiddenLegacyHelper,
        runReportPipeline: forbiddenLegacyHelper,
        fetchAislePlanner: forbiddenLegacyHelper,
        sendBlueBubbles: forbiddenLegacyHelper,
      },
    })

    expect(result).toMatchObject({
      schemaVersion: 1,
      sideEffect: false,
      outputPath,
      legacyRootHashBefore: expect.any(String),
      legacyRootHashAfter: expect.any(String),
    })
    expect(result.legacyRootHashAfter).toBe(result.legacyRootHashBefore)
    expect(JSON.parse(fs.readFileSync(outputPath, "utf-8"))).toMatchObject({
      pendingGuests: ["Casey Pending"],
    })
    expect(fs.readdirSync(legacyRoot).map((name) => [name, fs.readFileSync(path.join(legacyRoot, name), "utf-8")])).toEqual(before)
    expect(forbiddenLegacyHelper).not.toHaveBeenCalled()
  })

  it("rejects unsupported or non-private replay fixture manifests", async () => {
    const fixtureRoot = makeTempRoot("rsvp-replay-invalid-")
    const fixturePath = writeFixture(fixtureRoot)
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf-8"))

    fs.writeFileSync(fixturePath, JSON.stringify({ ...fixture, policyVersion: "old" }), "utf-8")
    await expect(replayRsvpFixture({ fixturePath })).rejects.toThrow("unsupported RSVP replay fixture")

    fs.writeFileSync(fixturePath, JSON.stringify({
      ...fixture,
      privacy: { rawLiveTranscriptStored: true, searchIndex: false, vectorIndex: false },
    }), "utf-8")
    await expect(replayRsvpFixture({ fixturePath })).rejects.toThrow("minimized and private")

    fs.writeFileSync(fixturePath, JSON.stringify({
      ...fixture,
      privacy: null,
    }), "utf-8")
    await expect(replayRsvpFixture({ fixturePath })).rejects.toThrow("minimized and private")

    fs.writeFileSync(fixturePath, JSON.stringify({
      ...fixture,
      expected: {},
    }), "utf-8")
    await expect(replayRsvpFixture({ fixturePath })).rejects.toThrow("expected hashes")

    fs.writeFileSync(fixturePath, JSON.stringify({
      ...fixture,
      expected: null,
    }), "utf-8")
    await expect(replayRsvpFixture({ fixturePath })).rejects.toThrow("expected hashes")

    fs.writeFileSync(fixturePath, JSON.stringify({
      ...fixture,
      expected: { contextPacketHash: "sha256:fixture-context" },
    }), "utf-8")
    await expect(replayRsvpFixture({ fixturePath })).rejects.toThrow("expected hashes")

    fs.writeFileSync(fixturePath, "[]", "utf-8")
    await expect(replayRsvpFixture({ fixturePath })).rejects.toThrow("must be an object")
  })

  it("replays empty pending fixtures without indexing or live calls", async () => {
    const fixtureRoot = makeTempRoot("rsvp-replay-empty-")
    const fixturePath = writeFixture(fixtureRoot)
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf-8"))
    fs.writeFileSync(fixturePath, JSON.stringify({
      ...fixture,
      snapshot: { snapshotId: "snap_empty", pendingGuests: [] },
    }), "utf-8")

    const result = await replayRsvpFixture({ fixturePath })

    expect(result.answer).toBe("No pending guests in the replay fixture.")
    expect(result.indexPolicy).toEqual({ search: false, vector: false })

    fs.writeFileSync(fixturePath, JSON.stringify({
      ...fixture,
      snapshot: null,
    }), "utf-8")
    const noSnapshotResult = await replayRsvpFixture({ fixturePath })

    expect(noSnapshotResult.answer).toBe("No pending guests in the replay fixture.")
  })

  it("supports legacy rows with displayName and status fields", async () => {
    const legacyRoot = makeTempRoot("rsvp-legacy-display-")
    const outputPath = path.join(makeTempRoot("rsvp-legacy-display-output-"), "legacy-render.json")
    fs.writeFileSync(path.join(legacyRoot, "guests.json"), JSON.stringify({
      guests: {
        pending_1: { displayName: "Display Pending", status: "pending" },
        accepted_1: { displayName: "Accepted Guest", status: "accepted" },
      },
    }), "utf-8")

    const result = await renderLegacyRsvpSnapshotOffline({ legacyRoot, outputPath })

    expect(result.pendingGuests).toEqual(["Display Pending"])
  })

  it("handles directories, first-name-only rows, nameless rows, and missing legacy guest maps", async () => {
    const legacyRoot = makeTempRoot("rsvp-legacy-branches-")
    const outputPath = path.join(makeTempRoot("rsvp-legacy-branches-output-"), "legacy-render.json")
    fs.mkdirSync(path.join(legacyRoot, "nested"), { recursive: true })
    fs.writeFileSync(path.join(legacyRoot, "guests.json"), JSON.stringify({
      guests: {
        pending_1: { first_name: "FirstOnly", attending_status: "pending" },
        pending_2: { attending_status: "pending" },
      },
    }), "utf-8")

    const result = await renderLegacyRsvpSnapshotOffline({ legacyRoot, outputPath })

    expect(result.pendingGuests).toEqual(["FirstOnly"])

    fs.writeFileSync(path.join(legacyRoot, "guests.json"), "[]", "utf-8")
    const emptyResult = await renderLegacyRsvpSnapshotOffline({ legacyRoot, outputPath })

    expect(emptyResult.pendingGuests).toEqual([])
  })
})
