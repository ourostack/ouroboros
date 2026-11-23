/**
 * A claim held when the process is stopped is put back without counting a try: a shutdown is not the messages'
 * fault. These run a real child process, since a signal's default action skips exit handlers.
 */
import { spawn } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const PENDING_SOURCE = path.resolve(__dirname, "../../mind/pending.ts")
let root = ""
let pendingBundle = ""

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pending-signals-"))
  pendingBundle = path.join(root, "pending.cjs")
  const { build } = await import("rolldown")
  await build({ input: PENDING_SOURCE, platform: "node", external: [/^node:/], output: { file: pendingBundle, format: "cjs", codeSplitting: false }, logLevel: "silent" })
}, 60_000)

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

async function runHolding(name: string, extra: string[]): Promise<{ exit: { code: number | null; signal: NodeJS.Signals | null }; dir: string }> {
  const dir = path.join(root, name)
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, "1-a.json"), JSON.stringify({ from: "mail", content: "notice", timestamp: 1 }))
  const ready = path.join(root, `${name}.ready`)
  const script = [
    `const fs = require("fs")`,
    `const pending = require(${JSON.stringify(pendingBundle)})`,
    `const claim = pending.claimPending(${JSON.stringify(dir)})`,
    `if (claim.messages.length !== 1) process.exit(3)`,
    ...extra,
    `fs.writeFileSync(${JSON.stringify(ready)}, "")`,
    `setInterval(() => {}, 1000)`,
  ].join("\n")
  const child = spawn(process.execPath, ["-e", script], { stdio: "ignore", env: { ...process.env, OURO_NERVES_SILENT: "1" } })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }))
  })
  try {
    const deadline = Date.now() + 20_000
    while (!fs.existsSync(ready)) {
      if (Date.now() > deadline) throw new Error("child never claimed")
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(fs.readdirSync(dir)).toEqual(["1-a.json.claimed"])
    child.kill("SIGTERM")
    return { exit: await exited, dir }
  } finally {
    child.kill("SIGKILL")
  }
}

function stored(dir: string): Record<string, unknown> {
  expect(fs.readdirSync(dir)).toEqual(["1-a.json"])
  return JSON.parse(fs.readFileSync(path.join(dir, "1-a.json"), "utf-8")) as Record<string, unknown>
}

describe("pending claims at a stop", () => {
  it("puts a claim back, uncounted, when SIGTERM ends a process with no handler of its own", async () => {
    const { exit, dir } = await runHolding("bare", [])
    expect(exit).toEqual({ code: null, signal: "SIGTERM" })
    expect(stored(dir)).not.toHaveProperty("failedTries")
  }, 30_000)

  it("leaves a process's own graceful shutdown to finish, and puts the claim back when it exits", async () => {
    const { exit, dir } = await runHolding("graceful", [
      `process.once("SIGTERM", () => { setTimeout(() => process.exit(0), 200) })`,
    ])
    expect(exit).toEqual({ code: 0, signal: null })
    expect(stored(dir)).not.toHaveProperty("failedTries")
  }, 30_000)

  it("still ends the process when another termination guard (sync's) is listening too", async () => {
    const { exit, dir } = await runHolding("guarded", [
      // Like sync's guard with nothing to abort: it steps aside, and would re-raise only if it were alone.
      `const guard = () => { process.removeListener("SIGTERM", guard) }`,
      `guard[Symbol.for("ouro.terminationGuard")] = true`,
      `process.prependListener("SIGTERM", guard)`,
    ])
    expect(exit).toEqual({ code: null, signal: "SIGTERM" })
    expect(stored(dir)).not.toHaveProperty("failedTries")
  }, 30_000)
})
