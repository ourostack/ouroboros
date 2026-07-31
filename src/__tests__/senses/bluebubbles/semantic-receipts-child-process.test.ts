import * as fs from "node:fs"
import * as path from "node:path"

import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"

import {
  acquireBlueBubblesSemanticClaim,
  allocateBlueBubblesReactionCoordinate,
  getBlueBubblesSemanticPaths,
  releaseBlueBubblesSemanticClaim,
} from "../../../senses/bluebubbles/semantic-receipts"

const childAgent = process.env.BB_SEMANTIC_CHILD_AGENT
const childMode = process.env.BB_SEMANTIC_CHILD_MODE

async function enterStartBarrier(): Promise<void> {
  const readyPath = process.env.BB_SEMANTIC_CHILD_READY!
  const startPath = process.env.BB_SEMANTIC_CHILD_START!
  fs.writeFileSync(readyPath, "ready", "utf8")
  const startedAt = Date.now()
  while (!fs.existsSync(startPath)) {
    if (Date.now() - startedAt >= 5_000) throw new Error("semantic child start barrier timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function coordinateRaceFs(coordinateHash: string): {
  adapter: unknown
  owner: () => { ownerPath: string; ownerSnapshot: unknown }
} {
  const adapter = Object.create(fs) as Record<string, unknown>
  let ownerPath = ""
  let ownerSnapshot: unknown = null
  adapter.linkSync = (...args: unknown[]) => {
    const result = Reflect.apply(fs.linkSync, fs, args)
    const destination = String(args[1])
    if (path.basename(destination) === `${coordinateHash}.owner.lock`) {
      ownerPath = path.basename(destination)
      ownerSnapshot = JSON.parse(fs.readFileSync(destination, "utf8"))
    }
    return result
  }
  adapter.renameSync = (...args: unknown[]) => {
    const destination = String(args[1])
    if (path.basename(destination) === `${coordinateHash}.json`) {
      const precommitPath = process.env.BB_SEMANTIC_CHILD_PRECOMMIT!
      const peerPrecommitPath = process.env.BB_SEMANTIC_CHILD_PEER_PRECOMMIT!
      const semanticPaths = getBlueBubblesSemanticPaths(childAgent!)
      const liveOwnerPath = path.join(semanticPaths.coordinates, `${coordinateHash}.owner.lock`)
      if (ownerSnapshot === null) {
        ownerPath = path.basename(liveOwnerPath)
        ownerSnapshot = JSON.parse(fs.readFileSync(liveOwnerPath, "utf8"))
      }
      fs.writeFileSync(precommitPath, "precommit", "utf8")
      const waitUntil = Date.now() + 250
      const waitCell = new Int32Array(new SharedArrayBuffer(4))
      while (!fs.existsSync(peerPrecommitPath) && Date.now() < waitUntil) {
        Atomics.wait(waitCell, 0, 0, 5)
      }
    }
    return Reflect.apply(fs.renameSync, fs, args)
  }
  return { adapter, owner: () => ({ ownerPath, ownerSnapshot }) }
}

describe.skipIf(!childAgent || childMode !== "coordinate")(
  "BlueBubbles semantic coordinate child process",
  () => {
  it("allocates one shared reaction coordinate generation", async () => {
    const coordinateKey = process.env.BB_SEMANTIC_CHILD_COORDINATE_KEY!
    const coordinateHash = process.env.BB_SEMANTIC_CHILD_COORDINATE_HASH!
    const canonicalAction = process.env.BB_SEMANTIC_CHILD_ACTION as "add" | "remove"
    const resultPath = process.env.BB_SEMANTIC_CHILD_RESULT!
    await enterStartBarrier()
    const raceFs = coordinateRaceFs(coordinateHash)
    const record = await allocateBlueBubblesReactionCoordinate(childAgent!, {
      coordinateKey,
      coordinateHash,
      canonicalAction,
    }, { fs: raceFs.adapter })

    fs.writeFileSync(resultPath, JSON.stringify({ ...record, ...raceFs.owner() }), "utf8")
    expect(record.coordinateHash).toBe(coordinateHash)
    expect(record.lastAction).toBe(canonicalAction)
  })
  },
)

describe.skipIf(!childAgent || childMode !== "claim")(
  "BlueBubbles semantic claim child process",
  () => {
    it("acquires, holds, and ownership-safely releases one semantic claim", async () => {
      const canonicalKey = process.env.BB_SEMANTIC_CHILD_CANONICAL_KEY!
      const keyHash = process.env.BB_SEMANTIC_CHILD_KEY_HASH!
      const resultPath = process.env.BB_SEMANTIC_CHILD_RESULT!
      await enterStartBarrier()
      const lease = await acquireBlueBubblesSemanticClaim(childAgent!, { canonicalKey, keyHash })
      expect(lease.status).toBe("acquired")
      if (lease.status !== "acquired") throw new Error(`claim was not acquired: ${lease.status}`)
      const acquiredAtMs = Date.now()
      const claimPath = path.join(
        getBlueBubblesSemanticPaths(childAgent!).claims,
        `${keyHash}.owner.json`,
      )
      const ownerSnapshot = JSON.parse(fs.readFileSync(claimPath, "utf8"))
      await new Promise((resolve) => setTimeout(
        resolve,
        Number(process.env.BB_SEMANTIC_CHILD_HOLD_MS ?? "0"),
      ))
      expect(releaseBlueBubblesSemanticClaim(childAgent!, lease)).toBe(true)
      const releasedAtMs = Date.now()
      fs.writeFileSync(resultPath, JSON.stringify({ acquiredAtMs, releasedAtMs, ownerSnapshot }), "utf8")
    })
  },
)

describe.skipIf(!childAgent || childMode !== "claim-abandon")(
  "BlueBubbles abandoned semantic claim child process",
  () => {
    it("publishes one claim and exits without releasing it", async () => {
      const canonicalKey = process.env.BB_SEMANTIC_CHILD_CANONICAL_KEY!
      const keyHash = process.env.BB_SEMANTIC_CHILD_KEY_HASH!
      const resultPath = process.env.BB_SEMANTIC_CHILD_RESULT!
      await enterStartBarrier()
      const lease = await acquireBlueBubblesSemanticClaim(childAgent!, { canonicalKey, keyHash })
      expect(lease.status).toBe("acquired")
      if (lease.status !== "acquired") throw new Error(`claim was not acquired: ${lease.status}`)
      fs.writeFileSync(resultPath, JSON.stringify({ pid: process.pid, record: lease.record }), "utf8")
    })
  },
)

describe.skipIf(!childAgent || childMode !== "ownership-lock")(
  "BlueBubbles semantic ownership lock child process",
  () => {
    it("holds the SQLite writer briefly for a release retry", async () => {
      const ownershipPath = path.join(
        getBlueBubblesSemanticPaths(childAgent!).root,
        "ownership.sqlite",
      )
      const ownership = new Database(ownershipPath, { timeout: 0 })
      ownership.pragma("busy_timeout = 0")
      ownership.exec("BEGIN IMMEDIATE")
      fs.writeFileSync(process.env.BB_SEMANTIC_CHILD_READY!, "ready", "utf8")
      await new Promise((resolve) => setTimeout(
        resolve,
        Number(process.env.BB_SEMANTIC_CHILD_HOLD_MS ?? "0"),
      ))
      ownership.exec("COMMIT")
      ownership.close()
      expect(fs.existsSync(ownershipPath)).toBe(true)
    })
  },
)
