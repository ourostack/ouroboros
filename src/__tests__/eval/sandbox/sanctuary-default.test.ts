/**
 * The Butler stays the sandbox's default agent, byte for byte. Each recording under `fixtures/` was taken from
 * `runSandboxed` before agent profiles existed (origin/main 3245e9b92): every `docker` command line of a run, and
 * every file the agent container could read with its write and run bits and sha256. A run that names no agent must
 * hand Docker exactly the same, for the replay eval's Telegram guest and for the interviews' guest.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ProviderRuntime } from "../../../heart/core"
import type { Case } from "../../../eval/domain/case"
import { runSandboxed } from "../../../eval/sandbox/docker"
import type { runTelegramTurn } from "../../../eval/transport/telegram-turn"
import { normalized, recordingDocker, sha } from "./sandbox-recording"

const FIXTURES = path.join(__dirname, "fixtures")

function testCase(): Case {
  const observation = { timeline: [], finalReply: "", library: [], mail: [], created: [], outcome: "settled", steps: 0, oracle: {} }
  return {
    schemaVersion: 1, id: "remove-bad-copy", actionIds: ["books.library.remove"], bundle: { include: ["agent.json", "books"] },
    prefix: [{ role: "user", content: "Which copy is on the shelf?" }, { role: "assistant", content: "Two: 187 and 189." }, { role: "user", content: "take 187 off" }],
    seed: {
      library: [{ id: 187, title: "The Harbour Almanac", sha256: sha("A") }],
      libgen: [],
      labels: [{ sha256: sha("A"), work: "harbour-almanac", edition: "A", readable: false }],
      deleteAllowed: true,
      disk: [],
    },
    assertions: [{ name: "mail.none" }],
    fixtures: { pass: observation, fail: { mailed: observation } },
  }
}

function hostRuntime(): ProviderRuntime {
  return {
    id: "minimax", model: "eval-scripted", client: {}, capabilities: new Set(),
    resetTurnState: () => undefined, appendToolOutput: () => undefined, ping: async () => undefined, classifyError: () => "unknown",
    streamTurn: async () => ({ content: "Done.", toolCalls: [], outputItems: [] }),
  }
}

const reply: typeof runTelegramTurn = async (turn) => {
  await turn.providerRuntime.streamTurn({ messages: [], activeTools: [], callbacks: {} } as never)
  return { timeline: [{ kind: "reply", text: "Done." }], finalReply: "Done.", outcome: "settled", steps: 1 }
}

describe("the Butler as the sandbox's default agent", () => {
  let root: string
  let bundleDir: string
  let seedBundleDir: string

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eval-default-")))
    bundleDir = path.join(root, "bundle")
    seedBundleDir = path.join(root, "seed")
    fs.mkdirSync(path.join(bundleDir, "books"), { recursive: true })
    fs.writeFileSync(path.join(bundleDir, "agent.json"), "{\"name\":\"sanctuary\"}")
    fs.writeFileSync(path.join(bundleDir, "books", "books"), "#!/bin/sh\n", { mode: 0o755 })
    fs.mkdirSync(path.join(seedBundleDir, "psyche"), { recursive: true })
    fs.writeFileSync(path.join(seedBundleDir, "psyche", "TACIT.md"), "public")
    fs.writeFileSync(path.join(seedBundleDir, "tool-profiles.json"), "{}")
  })
  afterEach(() => {
    fs.chmodSync(root, 0o700)
    fs.rmSync(root, { recursive: true, force: true })
  })

  const record = async (extra: Partial<Parameters<typeof runSandboxed>[0]>): Promise<string> => {
    const { docker, recorded } = recordingDocker(reply)
    const run = { case: testCase(), bundleDir, seedBundleDir, host: hostRuntime(), budget: { take: () => true }, docker, workRoot: root, ...extra }
    await runSandboxed(run)
    return normalized(recorded, root)
  }
  const golden = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), "utf8").trimEnd()

  it("hands Docker the same commands and files for the replay eval's Telegram turn", async () => {
    expect(await record({})).toBe(golden("sanctuary-telegram-run.txt"))
  })

  it("hands Docker the same commands and files for an interview guest", async () => {
    const guest = { entry: "interview-guest-entry.js" as const, turn: { prefix: [], userText: "job" } }
    expect(await record({ guest })).toBe(golden("sanctuary-interview-run.txt"))
  })
})
