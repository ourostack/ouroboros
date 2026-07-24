import { createHash } from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { afterEach, describe, expect, it, vi } from "vitest"

import { sha256CanonicalJson } from "../../../heart/runtime/canonical-json"
import {
  createAgentConfigCasRequest,
  createHabitMigrationRequest,
  executeAgentConfigCas,
  executeHabitMigration,
  executeRuntimeAdoption,
  rollbackAgentConfigCas,
  rollbackHabitMigration,
  type AgentConfigCasRequestV1,
  type HabitMigrationRequestV1,
  type MigrationFaultPoint,
} from "../../../heart/habits/exact-file-migration"

const roots: string[] = []

const beforeHabit = Buffer.from("---\ntitle: Daily check\ncadence: 1d\n---\n\nReview the queue.\n")
const afterHabit = Buffer.from("---\ntitle: Daily check\ncadence: 2h\n---\n\nReview the queue.\n")

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function tempBundle(): { root: string; habitPath: string; configPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-exact-file-migration-"))
  roots.push(root)
  const habits = path.join(root, "habits")
  fs.mkdirSync(habits, { mode: 0o700 })
  const habitPath = path.join(habits, "daily-check.md")
  fs.writeFileSync(habitPath, beforeHabit, { mode: 0o600 })
  const configPath = path.join(root, "agent.json")
  fs.writeFileSync(configPath, canonicalConfigBytes("gpt-before"), { mode: 0o600 })
  return { root, habitPath, configPath }
}

function canonicalConfigBytes(model: string): Buffer {
  return Buffer.from(JSON.stringify({
    version: 2,
    enabled: true,
    humanFacing: { provider: "openai-codex", model },
    agentFacing: { provider: "openai-codex", model },
    senses: {},
    phrases: { thinking: ["Thinking"], tool: ["Working"], followup: ["Continuing"] },
  }))
}

function rehashRequest<T extends { requestSha256: string }>(request: T): T {
  const { requestSha256: _ignored, ...body } = request
  return { ...request, requestSha256: sha256CanonicalJson(body) }
}

function habitRequest(before = beforeHabit, after = afterHabit): HabitMigrationRequestV1 {
  return createHabitMigrationRequest({
    habitId: "daily-check",
    expectedBeforeBytes: before,
    targetBytes: after,
  })
}

function configRequest(before: Buffer, after: Buffer): AgentConfigCasRequestV1 {
  return createAgentConfigCasRequest({ expectedBeforeBytes: before, targetBytes: after })
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("exact-file@1 habit migration", () => {
  it("creates and commits byte-bound plan, transaction, result, receipt, and content authorities", () => {
    const bundle = tempBundle()
    const request = habitRequest()

    const completed = executeHabitMigration({
      bundleRoot: bundle.root,
      request,
      now: () => new Date("2026-07-24T16:00:00.000Z"),
    })

    expect(fs.readFileSync(bundle.habitPath)).toEqual(afterHabit)
    expect(completed.plan).toMatchObject({
      schemaVersion: 1,
      requestSha256: request.requestSha256,
      migrationId: "exact-file",
      version: 1,
      habitId: "daily-check",
      habitPath: "habits/daily-check.md",
      disposition: "migrated",
      beforeSha256: sha256(beforeHabit),
      afterSha256: sha256(afterHabit),
    })
    expect(completed.transaction).toMatchObject({
      state: "committed",
      currentExpectedSha256: sha256(afterHabit),
      forwardResultRef: expect.any(String),
      forwardResultSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      forwardReceiptRef: expect.any(String),
      forwardReceiptSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(completed.result).toMatchObject({
      direction: "forward",
      rollbackOf: null,
      expectedCurrentSha256: sha256(beforeHabit),
      resultingSha256: sha256(afterHabit),
      disposition: "migrated",
    })
    expect(completed.receipt).toMatchObject({
      phase: "apply",
      resultingFileSha256: sha256(afterHabit),
      resultSha256: completed.transaction.forwardResultSha256,
    })
    for (const relative of [
      completed.plan.beforeRef,
      completed.plan.afterRef,
      completed.transaction.planRef,
      completed.transaction.forwardResultRef!,
      completed.transaction.forwardReceiptRef!,
    ]) {
      const target = path.join(bundle.root, relative)
      expect(fs.lstatSync(target).isFile()).toBe(true)
      expect(fs.lstatSync(target).nlink).toBe(1)
    }
  })

  it("is idempotent when the exact target bytes are already current", () => {
    const bundle = tempBundle()
    fs.writeFileSync(bundle.habitPath, afterHabit)
    const request = habitRequest(afterHabit, afterHabit)
    const before = fs.lstatSync(bundle.habitPath)

    const first = executeHabitMigration({ bundleRoot: bundle.root, request })
    const second = executeHabitMigration({ bundleRoot: bundle.root, request })

    expect(first.plan.disposition).toBe("already_current")
    expect(first.result.disposition).toBe("already_current")
    expect(second).toEqual(first)
    expect(fs.lstatSync(bundle.habitPath).ino).toBe(before.ino)
  })

  it.each([
    ["migration id", (r: HabitMigrationRequestV1) => ({ ...r, migrationId: "other" as "exact-file" })],
    ["version", (r: HabitMigrationRequestV1) => ({ ...r, version: 2 as 1 })],
    ["habit id", (r: HabitMigrationRequestV1) => rehashRequest({ ...r, habitId: "../escape" })],
    ["habit path", (r: HabitMigrationRequestV1) => rehashRequest({ ...r, habitPath: "habits/other.md" })],
    ["preimage hash", (r: HabitMigrationRequestV1) => rehashRequest({ ...r, expectedBeforeSha256: "0".repeat(64) })],
    ["target hash", (r: HabitMigrationRequestV1) => rehashRequest({ ...r, targetSha256: "0".repeat(64) })],
    ["request hash", (r: HabitMigrationRequestV1) => ({ ...r, requestSha256: "0".repeat(64) })],
    ["non-canonical base64", (r: HabitMigrationRequestV1) => rehashRequest({ ...r, targetBytesBase64: `${r.targetBytesBase64}\n` })],
  ])("rejects an invalid %s before mutation", (_label, mutate) => {
    const bundle = tempBundle()
    expect(() => executeHabitMigration({ bundleRoot: bundle.root, request: mutate(habitRequest()) })).toThrow()
    expect(fs.readFileSync(bundle.habitPath)).toEqual(beforeHabit)
  })

  it("rejects target bytes above the one MiB ceiling", () => {
    const bundle = tempBundle()
    const target = Buffer.alloc(1024 * 1024 + 1, 1)
    const request = rehashRequest({
      ...habitRequest(),
      targetBytesBase64: target.toString("base64"),
      targetSha256: sha256(target),
    })
    expect(() => executeHabitMigration({ bundleRoot: bundle.root, request })).toThrow(/1 MiB|size/i)
    expect(fs.readFileSync(bundle.habitPath)).toEqual(beforeHabit)
  })

  it.each(["missing", "symlink", "hardlink", "directory"])("rejects a %s final target without overwrite", (kind) => {
    const bundle = tempBundle()
    if (kind === "missing") fs.unlinkSync(bundle.habitPath)
    if (kind === "symlink") {
      fs.unlinkSync(bundle.habitPath)
      fs.symlinkSync(path.join(bundle.root, "agent.json"), bundle.habitPath)
    }
    if (kind === "hardlink") fs.linkSync(bundle.habitPath, path.join(bundle.root, "habit-link.md"))
    if (kind === "directory") {
      fs.unlinkSync(bundle.habitPath)
      fs.mkdirSync(bundle.habitPath)
    }

    expect(() => executeHabitMigration({ bundleRoot: bundle.root, request: habitRequest() })).toThrow(/missing|regular|link|target/i)
    if (kind === "symlink") expect(fs.readlinkSync(bundle.habitPath)).toBe(path.join(bundle.root, "agent.json"))
  })

  it("rejects lstat/fstat target replacement and stable-parent replacement races", () => {
    const targetRace = tempBundle()
    expect(() => executeHabitMigration({
      bundleRoot: targetRace.root,
      request: habitRequest(),
      hook(point) {
        if (point === "after-target-lstat") {
          fs.renameSync(targetRace.habitPath, `${targetRace.habitPath}.old`)
          fs.writeFileSync(targetRace.habitPath, beforeHabit)
        }
      },
    })).toThrow(/changed|identity/i)
    expect(fs.readFileSync(targetRace.habitPath)).toEqual(beforeHabit)

    const parentRace = tempBundle()
    const originalParent = path.dirname(parentRace.habitPath)
    expect(() => executeHabitMigration({
      bundleRoot: parentRace.root,
      request: habitRequest(),
      hook(point) {
        if (point === "before-rename") {
          fs.renameSync(originalParent, `${originalParent}.old`)
          fs.mkdirSync(originalParent)
          fs.writeFileSync(parentRace.habitPath, beforeHabit)
        }
      },
    })).toThrow(/parent|directory|identity/i)
    expect(fs.readFileSync(parentRace.habitPath)).toEqual(beforeHabit)
  })

  it.each([
    "after-prepared",
    "after-rewrite",
    "after-applied",
    "after-result",
    "after-receipt",
  ] satisfies MigrationFaultPoint[])("recovers a crash at %s without a second rewrite", (faultPoint) => {
    const bundle = tempBundle()
    const request = habitRequest()
    let failed = false
    expect(() => executeHabitMigration({
      bundleRoot: bundle.root,
      request,
      fault(point) {
        if (!failed && point === faultPoint) {
          failed = true
          throw new Error(`crash:${point}`)
        }
      },
    })).toThrow(/crash:/)
    const appliedIdentity = fs.existsSync(bundle.habitPath) && fs.readFileSync(bundle.habitPath).equals(afterHabit)
      ? fs.lstatSync(bundle.habitPath).ino
      : null

    const recovered = executeHabitMigration({ bundleRoot: bundle.root, request })

    expect(recovered.transaction.state).toBe("committed")
    expect(fs.readFileSync(bundle.habitPath)).toEqual(afterHabit)
    if (appliedIdentity !== null) expect(fs.lstatSync(bundle.habitPath).ino).toBe(appliedIdentity)
  })

  it("rolls back to the byte-exact preimage and reconstructs rollback after crashes", () => {
    const bundle = tempBundle()
    const request = habitRequest()
    const forward = executeHabitMigration({ bundleRoot: bundle.root, request })
    let failed = false
    expect(() => rollbackHabitMigration({
      bundleRoot: bundle.root,
      requestSha256: request.requestSha256,
      fault(point) {
        if (!failed && point === "rollback-after-rewrite") {
          failed = true
          throw new Error("rollback crash")
        }
      },
    })).toThrow(/rollback crash/)

    const rollback = rollbackHabitMigration({ bundleRoot: bundle.root, requestSha256: request.requestSha256 })
    const replay = rollbackHabitMigration({ bundleRoot: bundle.root, requestSha256: request.requestSha256 })

    expect(fs.readFileSync(bundle.habitPath)).toEqual(beforeHabit)
    expect(rollback).toEqual(replay)
    expect(rollback.transaction).toMatchObject({ state: "rolled_back", currentExpectedSha256: sha256(beforeHabit) })
    expect(rollback.result).toMatchObject({
      direction: "rollback",
      rollbackOf: forward.transaction.forwardResultSha256,
      expectedCurrentSha256: sha256(afterHabit),
      resultingSha256: sha256(beforeHabit),
      disposition: "rolled_back",
    })
    expect(rollback.receipt.phase).toBe("rollback")
  })

  it("fences a third hash during forward recovery and rollback", () => {
    const forwardBundle = tempBundle()
    const request = habitRequest()
    let crashed = false
    expect(() => executeHabitMigration({
      bundleRoot: forwardBundle.root,
      request,
      fault(point) {
        if (!crashed && point === "after-prepared") {
          crashed = true
          throw new Error("prepared crash")
        }
      },
    })).toThrow()
    const third = Buffer.from("third authority")
    fs.writeFileSync(forwardBundle.habitPath, third)
    expect(() => executeHabitMigration({ bundleRoot: forwardBundle.root, request })).toThrow(/hash|conflict|expected/i)
    expect(fs.readFileSync(forwardBundle.habitPath)).toEqual(third)

    const rollbackBundle = tempBundle()
    executeHabitMigration({ bundleRoot: rollbackBundle.root, request })
    fs.writeFileSync(rollbackBundle.habitPath, third)
    expect(() => rollbackHabitMigration({ bundleRoot: rollbackBundle.root, requestSha256: request.requestSha256 })).toThrow(/hash|conflict|expected/i)
    expect(fs.readFileSync(rollbackBundle.habitPath)).toEqual(third)
  })
})

describe("agent-config-cas@1 and combined adoption", () => {
  it("validates a complete strict AgentConfig before preparing or mutating", () => {
    const bundle = tempBundle()
    const before = fs.readFileSync(bundle.configPath)
    for (const target of [
      Buffer.from("not-json"),
      Buffer.from(JSON.stringify({ version: 2, enabled: true })),
      Buffer.from(JSON.stringify({
        ...JSON.parse(canonicalConfigBytes("next").toString("utf8")),
        unknownRootAuthority: true,
      })),
    ]) {
      expect(() => executeAgentConfigCas({
        bundleRoot: bundle.root,
        request: configRequest(before, target),
      })).toThrow(/agent|config|JSON|required|unknown/i)
      expect(fs.readFileSync(bundle.configPath)).toEqual(before)
    }
  })

  it("accepts only agent.json and supports exact idempotent rollback", () => {
    const bundle = tempBundle()
    const before = fs.readFileSync(bundle.configPath)
    const after = canonicalConfigBytes("gpt-after")
    const request = configRequest(before, after)
    expect(() => executeAgentConfigCas({
      bundleRoot: bundle.root,
      request: rehashRequest({ ...request, agentConfigPath: "other.json" as "agent.json" }),
    })).toThrow(/agent\.json/i)

    const forward = executeAgentConfigCas({ bundleRoot: bundle.root, request })
    const replay = executeAgentConfigCas({ bundleRoot: bundle.root, request })
    expect(replay).toEqual(forward)
    expect(fs.readFileSync(bundle.configPath)).toEqual(after)
    const rollback = rollbackAgentConfigCas({ bundleRoot: bundle.root, requestSha256: request.requestSha256 })
    expect(rollback.transaction.state).toBe("rolled_back")
    expect(fs.readFileSync(bundle.configPath)).toEqual(before)
  })

  it("applies config then habits under one admission and rolls back in reverse order", () => {
    const bundle = tempBundle()
    const secondBefore = Buffer.from("---\ntitle: Second\ncadence: 1d\n---\n")
    const secondAfter = Buffer.from("---\ntitle: Second\ncadence: 1h\n---\n")
    const secondPath = path.join(bundle.root, "habits", "second.md")
    fs.writeFileSync(secondPath, secondBefore, { mode: 0o600 })
    const beforeConfig = fs.readFileSync(bundle.configPath)
    const afterConfig = canonicalConfigBytes("gpt-after")
    const order: string[] = []

    expect(() => executeRuntimeAdoption({
      bundleRoot: bundle.root,
      agentConfig: configRequest(beforeConfig, afterConfig),
      habits: [
        habitRequest(),
        createHabitMigrationRequest({ habitId: "second", expectedBeforeBytes: secondBefore, targetBytes: secondAfter }),
      ],
      hook(event) { order.push(event) },
      validateCombined() { throw new Error("combined graph invalid") },
    })).toThrow(/combined graph invalid/)

    expect(fs.readFileSync(bundle.configPath)).toEqual(beforeConfig)
    expect(fs.readFileSync(bundle.habitPath)).toEqual(beforeHabit)
    expect(fs.readFileSync(secondPath)).toEqual(secondBefore)
    expect(order).toEqual([
      "apply:agent.json",
      "apply:habits/daily-check.md",
      "apply:habits/second.md",
      "validate:combined",
      "rollback:habits/second.md",
      "rollback:habits/daily-check.md",
      "rollback:agent.json",
    ])
  })
})
