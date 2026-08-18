import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawn } from "node:child_process"

import { afterEach, describe, expect, it, vi } from "vitest"

import { openApprovalStore, type ApprovalStore } from "../../heart/approval-store"

const APPROVAL_ID = "11111111-1111-4111-8111-111111111111"
const roots: string[] = []

function makeStorePair() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-continuation-claim-"))
  roots.push(root)
  const databasePath = path.join(root, "approvals.sqlite")
  const options = {
    databasePath,
    now: () => new Date("2026-08-17T17:30:00.000Z"),
    randomUUID: () => APPROVAL_ID,
    randomBytes: (size: number) => Buffer.alloc(size, 0xab),
  }
  return { databasePath, first: openApprovalStore(options), second: openApprovalStore(options), options }
}

function makeSucceeded(store: ApprovalStore): void {
  const prepared = store.prepare({
    toolCallId: "call_restart",
    toolName: "shell",
    arguments: { command: "docker restart calibre-web" },
    schemaDigest: "a".repeat(64),
    toolDigest: "b".repeat(64),
    policyDigest: "c".repeat(64),
    policyId: "shell.docker-lifecycle.v1",
    sessionKey: "telegram:chat-7",
    sessionPath: "/tmp/disposable/session.json",
    baseSessionRevision: "d".repeat(64),
    checkpointDigest: "e".repeat(64),
    requesterId: "friend-ari",
    transport: "telegram",
    transportUserId: "42",
    transportChatId: "7",
    expiresAt: "2026-08-17T18:30:00.000Z",
    frozenAssistantMessage: {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_restart", type: "function", function: { name: "shell", arguments: "{\"command\":\"docker restart calibre-web\"}" } }],
    },
  })
  store.activate({ approvalId: APPROVAL_ID, checkpointDigest: "e".repeat(64), suspendedSessionRevision: "f".repeat(64) })
  store.bindPrompt({ approvalId: APPROVAL_ID, transport: "telegram", transportChatId: "7", transportMessageId: "99" })
  const claimed = store.decide({
    approvalId: APPROVAL_ID,
    decisionToken: prepared.decisionToken,
    decision: "approve",
    requesterId: "friend-ari",
    transport: "telegram",
    transportUserId: "42",
    transportChatId: "7",
    transportMessageId: "99",
    sessionKey: "telegram:chat-7",
    ownerId: "execution-owner",
  })
  store.markAttempted({ approvalId: APPROVAL_ID, ownerId: "execution-owner", epoch: claimed.epoch })
  store.complete({ approvalId: APPROVAL_ID, ownerId: "execution-owner", epoch: claimed.epoch, state: "succeeded", result: "restarted" })
}

function continuationWorkerScript(): string {
  return String.raw`
const ts = require("typescript")
require.extensions[".ts"] = (module, filename) => {
  const source = require("fs").readFileSync(filename, "utf8")
  module._compile(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename,
  }).outputText, filename)
}
const fs = require("fs")
const storeModule = require(process.argv[1])
const core = require(process.argv[2])
const databasePath = process.argv[3]
const fixturePath = process.argv[4]
const effectsPath = process.argv[5]
const ownerId = process.argv[6]
const store = storeModule.openApprovalStore({ databasePath })
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"))
process.stdout.write("READY\n")
process.stdin.once("data", async () => {
  try {
    await core.resumeApprovalContinuation({
      record: store.read(fixture.approvalId),
      checkpoint: fixture.checkpoint,
      currentSessionRevision: fixture.revision,
      sessionMessages: fixture.checkpoint.preCallMessages,
      callbacks: { onTextChunk: () => {} },
      channel: "telegram",
      claimContinuation: () => store.claimContinuation({ approvalId: fixture.approvalId, ownerId }),
      runAgent: async (messages, callbacks) => {
        fs.appendFileSync(effectsPath, "provider\n")
        callbacks.onTextChunk("calibre-web is back up")
        messages.push({ role: "assistant", content: "calibre-web is back up" })
        return { outcome: "settled" }
      },
      persist: (messages) => fs.appendFileSync(effectsPath, "persist:" + JSON.stringify(messages) + "\n"),
      deliver: (text) => fs.appendFileSync(effectsPath, "deliver:" + text + "\n"),
    })
    process.stdout.write("DONE\n")
  } catch (error) {
    process.stderr.write(String(error.stack || error))
    process.exitCode = 1
  } finally {
    store.close()
  }
})
`
}

function waitFor(child: ReturnType<typeof spawn>, needle: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ""
    child.stdout!.on("data", (chunk) => {
      output += String(chunk)
      if (output.includes(needle)) resolve(output)
    })
    child.stderr!.on("data", (chunk) => reject(new Error(String(chunk))))
    child.once("exit", (code) => {
      if (!output.includes(needle)) reject(new Error(`child exited ${code}: ${output}`))
    })
  })
}

function cleanExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`))))
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("durable continuation claim", () => {
  it("allows exactly one SQLite CAS winner to enter the provider continuation", () => {
    const fixture = makeStorePair()
    makeSucceeded(fixture.first)
    const provider = vi.fn()

    const first = (fixture.first as any).claimContinuation({ approvalId: APPROVAL_ID, ownerId: "continuation-a" })
    const second = (fixture.second as any).claimContinuation({ approvalId: APPROVAL_ID, ownerId: "continuation-b" })
    if (first.claimed) provider(first)
    if (second.claimed) provider(second)

    expect([first.claimed, second.claimed].filter(Boolean)).toHaveLength(1)
    expect(provider).toHaveBeenCalledTimes(1)
    fixture.first.close()
    fixture.second.close()
  })

  it("persists a consumed continuation claim across process restart and never retries provider work", () => {
    const fixture = makeStorePair()
    makeSucceeded(fixture.first)
    const claimed = (fixture.first as any).claimContinuation({ approvalId: APPROVAL_ID, ownerId: "continuation-a" })
    expect(claimed.claimed).toBe(true)
    fixture.first.close()
    fixture.second.close()

    const restarted = openApprovalStore(fixture.options)
    const duplicate = (restarted as any).claimContinuation({ approvalId: APPROVAL_ID, ownerId: "continuation-after-restart" })
    expect(duplicate.claimed).toBe(false)
    expect(duplicate.record.continuationOwnerId).toBe("continuation-a")
    restarted.close()
  })

  it("fences continuation completion by owner and epoch", () => {
    const fixture = makeStorePair()
    makeSucceeded(fixture.first)
    const claim = (fixture.first as any).claimContinuation({ approvalId: APPROVAL_ID, ownerId: "continuation-a" })

    expect(() => (fixture.second as any).completeContinuation({
      approvalId: APPROVAL_ID,
      ownerId: "continuation-b",
      epoch: claim.record.continuationEpoch,
    })).toThrow()
    const completed = (fixture.first as any).completeContinuation({
      approvalId: APPROVAL_ID,
      ownerId: "continuation-a",
      epoch: claim.record.continuationEpoch,
    })
    expect(completed.continuedAt).toBe("2026-08-17T17:30:00.000Z")
    fixture.first.close()
    fixture.second.close()
  })

  it("lets one of two real process claimants produce exactly one pair, provider run, persist, and delivery", async () => {
    const fixture = makeStorePair()
    makeSucceeded(fixture.first)
    fixture.first.close()
    fixture.second.close()
    const root = path.dirname(fixture.databasePath)
    const fixturePath = path.join(root, "continuation.json")
    const effectsPath = path.join(root, "effects.ndjson")
    const checkpoint = {
      approvalId: APPROVAL_ID,
      checkpointDigest: "e".repeat(64),
      baseSessionRevision: "d".repeat(64),
      suspendedSessionRevision: "f".repeat(64),
      argumentDigest: "1".repeat(64),
      schemaDigest: "a".repeat(64),
      toolDigest: "b".repeat(64),
      policyDigest: "c".repeat(64),
      preCallDigest: "2".repeat(64),
      preCallMessages: [{ role: "user", content: "restart calibre-web" }],
      frozenAssistantMessage: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_restart", type: "function", function: { name: "shell", arguments: "{\"command\":\"docker restart calibre-web\"}" } }],
      },
    }
    fs.writeFileSync(fixturePath, JSON.stringify({ approvalId: APPROVAL_ID, revision: "f".repeat(64), checkpoint }))
    const storePath = path.resolve(__dirname, "../../heart/approval-store.ts")
    const corePath = path.resolve(__dirname, "../../heart/core.ts")
    const workers = ["continuation-a", "continuation-b"].map((owner) => spawn(process.execPath, [
      "-e", continuationWorkerScript(), storePath, corePath, fixture.databasePath, fixturePath, effectsPath, owner,
    ], { stdio: ["pipe", "pipe", "pipe"] }))
    await Promise.all(workers.map((worker) => waitFor(worker, "READY")))
    const done = workers.map((worker) => waitFor(worker, "DONE"))
    const exits = workers.map(cleanExit)
    for (const worker of workers) worker.stdin!.write("GO\n")
    await Promise.all(done)
    for (const worker of workers) worker.stdin!.end()
    await Promise.all(exits)

    const effects = fs.readFileSync(effectsPath, "utf8").trim().split("\n")
    expect(effects.filter((line) => line === "provider")).toHaveLength(1)
    expect(effects.filter((line) => line.startsWith("persist:"))).toHaveLength(1)
    expect(effects.filter((line) => line === "deliver:calibre-web is back up")).toHaveLength(1)
    const persisted = JSON.parse(effects.find((line) => line.startsWith("persist:"))!.slice("persist:".length))
    expect(persisted.slice(1, 3)).toEqual([
      checkpoint.frozenAssistantMessage,
      { role: "tool", tool_call_id: "call_restart", content: "restarted" },
    ])
  })
})
