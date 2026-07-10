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
})
