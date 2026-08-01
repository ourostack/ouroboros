import * as fs from "node:fs"
import * as path from "node:path"

import { describe, expect, it } from "vitest"

import { cancelHabit, type HabitCancelDeps } from "../../../heart/habits/habit-cancel"

const childMode = process.env.HABIT_CANCEL_CHILD_MODE

async function enterStartBarrier(): Promise<void> {
  const readyPath = process.env.HABIT_CANCEL_CHILD_READY!
  const startPath = process.env.HABIT_CANCEL_CHILD_START!
  fs.writeFileSync(readyPath, "ready\n", "utf8")
  const startedAt = Date.now()
  while (!fs.existsSync(startPath)) {
    if (Date.now() - startedAt >= 10_000) throw new Error("habit cancellation child start barrier timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function crashAfterDefinitionRename(definitionPath: string): typeof fs {
  const adapter = Object.create(fs) as Record<string, unknown>
  adapter.renameSync = (...args: unknown[]) => {
    const result = Reflect.apply(fs.renameSync, fs, args)
    if (path.resolve(String(args[1])) === path.resolve(definitionPath)) process.exit(86)
    return result
  }
  return adapter as typeof fs
}

describe.skipIf(!childMode)("habit cancellation child process", () => {
  it("cancels from one real process or dies immediately after definition publication", async () => {
    await enterStartBarrier()
    const agentRoot = process.env.HABIT_CANCEL_CHILD_AGENT_ROOT!
    const habitId = process.env.HABIT_CANCEL_CHILD_HABIT_ID!
    const captureKeyHash = process.env.HABIT_CANCEL_CHILD_CAPTURE_HASH!
    const deps: HabitCancelDeps = {
      now: () => new Date("2026-07-01T12:05:00.000Z"),
      ...(childMode === "crash_after_definition"
        ? { fs: crashAfterDefinitionRename(path.join(agentRoot, "habits", `${habitId}.md`)) }
        : {}),
    }
    const receipt = await cancelHabit({
      agentRoot,
      habitId,
      evidenceLocator: `capture:${captureKeyHash}`,
      authority: {
        kind: "current_ingress",
        currentIngressEvidence: {
          schemaVersion: 1,
          provider: "bluebubbles",
          captureKeyHash,
        },
      },
    }, deps)
    fs.writeFileSync(process.env.HABIT_CANCEL_CHILD_RESULT!, `${JSON.stringify(receipt)}\n`, "utf8")
    expect(receipt.transition.toStatus).toBe("cancelled")
  })
})
