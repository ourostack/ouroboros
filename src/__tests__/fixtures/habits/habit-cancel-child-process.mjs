import * as fs from "node:fs"
import * as path from "node:path"

import { createServer } from "vite"

async function enterStartBarrier() {
  const readyPath = process.env.HABIT_CANCEL_CHILD_READY
  const startPath = process.env.HABIT_CANCEL_CHILD_START
  fs.writeFileSync(readyPath, "ready\n", "utf8")
  const startedAt = Date.now()
  while (!fs.existsSync(startPath)) {
    if (Date.now() - startedAt >= 10_000) {
      throw new Error("habit cancellation child start barrier timed out")
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function crashAfterDefinitionRename(definitionPath) {
  return new Proxy(fs, {
    get(target, property) {
      if (property === "renameSync") {
        return (...args) => {
          const result = Reflect.apply(fs.renameSync, fs, args)
          if (path.resolve(String(args[1])) === path.resolve(definitionPath)) {
            process.exit(86)
          }
          return result
        }
      }
      return Reflect.get(target, property)
    },
  })
}

const server = await createServer({
  appType: "custom",
  configFile: false,
  logLevel: "silent",
  server: { middlewareMode: true },
})

try {
  const { cancelHabit } = await server.ssrLoadModule("/src/heart/habits/habit-cancel.ts")
  await enterStartBarrier()
  const agentRoot = process.env.HABIT_CANCEL_CHILD_AGENT_ROOT
  const habitId = process.env.HABIT_CANCEL_CHILD_HABIT_ID
  const captureKeyHash = process.env.HABIT_CANCEL_CHILD_CAPTURE_HASH
  const crash = process.env.HABIT_CANCEL_CHILD_MODE === "crash_after_definition"
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
  }, {
    now: () => new Date("2026-07-01T12:05:00.000Z"),
    ...(crash
      ? { fs: crashAfterDefinitionRename(path.join(agentRoot, "habits", `${habitId}.md`)) }
      : {}),
  })
  fs.writeFileSync(
    process.env.HABIT_CANCEL_CHILD_RESULT,
    `${JSON.stringify(receipt)}\n`,
    "utf8",
  )
} finally {
  await server.close()
}
