import * as fs from "node:fs"

import Database from "better-sqlite3"
import { describe, expect, it } from "vitest"

import {
  acquireHabitLifecycleLock,
  getHabitLifecyclePaths,
  publishHabitLifecycleReceipt,
  releaseHabitLifecycleLock,
  type HabitCancellationReceipt,
  type HabitLifecycleLease,
} from "../../../heart/habits/habit-lifecycle"

const childMode = process.env.HABIT_LIFECYCLE_CHILD_MODE

async function enterStartBarrier(): Promise<void> {
  const readyPath = process.env.HABIT_LIFECYCLE_CHILD_READY!
  const startPath = process.env.HABIT_LIFECYCLE_CHILD_START!
  fs.writeFileSync(readyPath, "ready\n", "utf8")
  const startedAt = Date.now()
  while (!fs.existsSync(startPath)) {
    if (Date.now() - startedAt >= 10_000) throw new Error("habit lifecycle child start barrier timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function receiptRaceFs(): typeof fs {
  const precommitPath = process.env.HABIT_LIFECYCLE_CHILD_PRECOMMIT!
  const peerPrecommitPath = process.env.HABIT_LIFECYCLE_CHILD_PEER_PRECOMMIT!
  const adapter = Object.create(fs) as Record<string, unknown>
  adapter.linkSync = (...args: unknown[]) => {
    fs.writeFileSync(precommitPath, "precommit\n", "utf8")
    const startedAt = Date.now()
    const waitCell = new Int32Array(new SharedArrayBuffer(4))
    while (!fs.existsSync(peerPrecommitPath)) {
      if (Date.now() - startedAt >= 10_000) throw new Error("habit lifecycle receipt precommit barrier timed out")
      Atomics.wait(waitCell, 0, 0, 10)
    }
    return Reflect.apply(fs.linkSync, fs, args)
  }
  return adapter as typeof fs
}

describe.skipIf(!childMode || !["lock", "abandon"].includes(childMode))(
  "habit lifecycle lock child process",
  () => {
    it("attempts, acquires, and either releases or abandons one real process lock", async () => {
      const resultPath = process.env.HABIT_LIFECYCLE_CHILD_RESULT!
      await enterStartBarrier()
      fs.writeFileSync(process.env.HABIT_LIFECYCLE_CHILD_ATTEMPTING!, "attempting\n", "utf8")
      const result = await acquireHabitLifecycleLock({
        agentRoot: process.env.HABIT_LIFECYCLE_CHILD_AGENT_ROOT!,
        habitId: process.env.HABIT_LIFECYCLE_CHILD_HABIT_ID!,
        operationId: process.env.HABIT_LIFECYCLE_CHILD_OPERATION_ID!,
      })
      expect(result.status).toBe("acquired")
      if (result.status !== "acquired") throw new Error(`lock was not acquired: ${result.status}`)
      fs.writeFileSync(resultPath, JSON.stringify({ pid: process.pid, lease: result.lease }), "utf8")
      if (childMode === "abandon") return

      const releasePath = process.env.HABIT_LIFECYCLE_CHILD_RELEASE!
      const startedAt = Date.now()
      while (!fs.existsSync(releasePath)) {
        if (Date.now() - startedAt >= 10_000) throw new Error("habit lifecycle release barrier timed out")
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(releaseHabitLifecycleLock(result.lease)).toBe(true)
    })
  },
)

describe.skipIf(childMode !== "coordination")(
  "habit lifecycle coordination child process",
  () => {
    it("holds the process-death-safe owner mutation transaction", async () => {
      await enterStartBarrier()
      const paths = getHabitLifecyclePaths({
        agentRoot: process.env.HABIT_LIFECYCLE_CHILD_AGENT_ROOT!,
        habitId: process.env.HABIT_LIFECYCLE_CHILD_HABIT_ID!,
      })
      const database = new Database(paths.coordination)
      database.pragma("busy_timeout = 0")
      database.exec("BEGIN IMMEDIATE")
      fs.writeFileSync(process.env.HABIT_LIFECYCLE_CHILD_RESULT!, "held\n", "utf8")
      const releasePath = process.env.HABIT_LIFECYCLE_CHILD_RELEASE!
      const startedAt = Date.now()
      while (!fs.existsSync(releasePath)) {
        if (Date.now() - startedAt >= 10_000) throw new Error("habit lifecycle coordination release timed out")
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      database.exec("COMMIT")
      database.close()
      expect(fs.existsSync(paths.coordination)).toBe(true)
    })
  },
)

describe.skipIf(childMode !== "receipt")(
  "habit lifecycle receipt child process",
  () => {
    it("races one immutable receipt publication at the no-clobber boundary", async () => {
      const resultPath = process.env.HABIT_LIFECYCLE_CHILD_RESULT!
      await enterStartBarrier()
      const lease = JSON.parse(process.env.HABIT_LIFECYCLE_CHILD_LEASE!) as HabitLifecycleLease
      const receipt = JSON.parse(process.env.HABIT_LIFECYCLE_CHILD_RECEIPT!) as HabitCancellationReceipt
      let outcome: string
      try {
        outcome = publishHabitLifecycleReceipt(
          lease,
          process.env.HABIT_LIFECYCLE_CHILD_EVIDENCE_HASH!,
          receipt,
          { fs: receiptRaceFs() },
        )
      } catch (error) {
        outcome = error instanceof Error && "code" in error ? String(error.code) : String(error)
      }
      fs.writeFileSync(resultPath, JSON.stringify({ outcome }), "utf8")
      expect(["published", "duplicate", "lifecycle_receipt_collision"]).toContain(outcome)
    })
  },
)
