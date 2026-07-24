import { createHash } from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { afterEach, describe, expect, it } from "vitest"

import { canonicalizeJson, sha256CanonicalJson } from "../../../heart/runtime/canonical-json"
import {
  createAgentConfigCasRequest,
  createHabitMigrationRequest,
  executeAgentConfigCas,
  executeHabitMigration,
  executeRuntimeAdoption,
  rollbackHabitMigration,
  type AgentConfigCasRequestV1,
  type HabitMigrationRequestV1,
} from "../../../heart/habits/exact-file-migration"

const roots: string[] = []
const beforeHabit = Buffer.from("---\ntitle: Queue\ncadence: 1d\n---\n\nReview.\n")
const afterHabit = Buffer.from("---\ntitle: Queue\ncadence: 1h\n---\n\nReview.\n")

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function completeConfig(): Record<string, unknown> {
  return {
    version: 2,
    enabled: true,
    provider: "anthropic",
    humanFacing: { provider: "anthropic", model: "outward" },
    agentFacing: { provider: "openai-codex", model: "inner" },
    context: { maxTokens: 80_000, contextMargin: 20 },
    logging: { level: "info", sinks: ["terminal", "ndjson"] },
    senses: { cli: { enabled: true }, bluebubbles: { enabled: false } },
    mcpServers: {
      "internal-tools": {
        command: "/usr/bin/true",
        args: ["--version"],
        env: { MODE: "test" },
        cwd: "/tmp",
        visibility: "internal",
      },
    },
    habitExecutors: [],
    mcpHealthProfiles: [],
    shell: { defaultTimeout: 1_000 },
    phrases: { thinking: ["Thinking"], tool: ["Working"], followup: ["Continuing"] },
    vault: { email: "agent@example.test", serverUrl: "https://vault.example.test" },
    sync: { enabled: true, remote: "origin" },
    plugins: [{ id: "desk", enabled: true, source: "local", version: "1" }],
    privateRuntime: { autoStart: false },
  }
}

function configBytes(value: Record<string, unknown> = completeConfig()): Buffer {
  return Buffer.from(JSON.stringify(value))
}

function tempBundle(config = configBytes()): { root: string; habitPath: string; configPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-exact-file-coverage-"))
  roots.push(root)
  fs.mkdirSync(path.join(root, "habits"), { mode: 0o700 })
  const habitPath = path.join(root, "habits", "queue.md")
  const configPath = path.join(root, "agent.json")
  fs.writeFileSync(habitPath, beforeHabit, { mode: 0o600 })
  fs.writeFileSync(configPath, config, { mode: 0o600 })
  return { root, habitPath, configPath }
}

function habitRequest(): HabitMigrationRequestV1 {
  return createHabitMigrationRequest({ habitId: "queue", expectedBeforeBytes: beforeHabit, targetBytes: afterHabit })
}

function configRequest(before: Buffer, target: Buffer): AgentConfigCasRequestV1 {
  return createAgentConfigCasRequest({ expectedBeforeBytes: before, targetBytes: target })
}

function rehash<T extends { requestSha256: string }>(request: T): T {
  const { requestSha256: _ignored, ...body } = request
  return { ...request, requestSha256: sha256CanonicalJson(body) }
}

function transactionPath(root: string, request: HabitMigrationRequestV1): string {
  return path.join(root, "state", "migrations", "exact-file", request.requestSha256, "transaction.json")
}

function requestPath(root: string, request: HabitMigrationRequestV1): string {
  return path.join(root, "state", "migrations", "exact-file", request.requestSha256, "request.json")
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>
}

function writeCanonical(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, canonicalizeJson(value), { mode: 0o600 })
}

function mutateConfig(mutator: (config: Record<string, unknown>) => void): Buffer {
  const config = structuredClone(completeConfig())
  mutator(config)
  return configBytes(config)
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("exact-file migration validation coverage", () => {
  it("accepts the complete optional AgentConfig surface", () => {
    const bundle = tempBundle()
    const before = fs.readFileSync(bundle.configPath)
    const target = mutateConfig((config) => {
      ;(config.agentFacing as Record<string, unknown>).model = "next"
    })
    const result = executeAgentConfigCas({ bundleRoot: bundle.root, request: configRequest(before, target) })
    expect(result.plan.parsedConfigSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it("accepts omitted optional senses and command-only MCP servers", () => {
    const bundle = tempBundle()
    const before = fs.readFileSync(bundle.configPath)
    const target = mutateConfig((config) => {
      delete config.senses
      config.mcpServers = { minimal: { command: "/usr/bin/true" } }
    })
    expect(executeAgentConfigCas({ bundleRoot: bundle.root, request: configRequest(before, target) }).transaction.state).toBe("committed")
  })

  it.each([
    ["array root", () => Buffer.from("[]")],
    ["null root", () => Buffer.from("null")],
    ["wrong version", () => mutateConfig((c) => { c.version = 1 })],
    ["wrong enabled", () => mutateConfig((c) => { c.enabled = "yes" })],
    ["facing object", () => mutateConfig((c) => { c.humanFacing = [] })],
    ["facing extra", () => mutateConfig((c) => { (c.humanFacing as Record<string, unknown>).extra = true })],
    ["facing provider type", () => mutateConfig((c) => { (c.humanFacing as Record<string, unknown>).provider = 1 })],
    ["facing provider value", () => mutateConfig((c) => { (c.humanFacing as Record<string, unknown>).provider = "other" })],
    ["facing model", () => mutateConfig((c) => { (c.agentFacing as Record<string, unknown>).model = 1 })],
    ["deprecated provider type", () => mutateConfig((c) => { c.provider = 1 })],
    ["deprecated provider value", () => mutateConfig((c) => { c.provider = "other" })],
    ["phrases object", () => mutateConfig((c) => { c.phrases = [] })],
    ["phrases extra", () => mutateConfig((c) => { (c.phrases as Record<string, unknown>).extra = [] })],
    ["phrases missing", () => mutateConfig((c) => { delete (c.phrases as Record<string, unknown>).tool })],
    ["thinking array", () => mutateConfig((c) => { (c.phrases as Record<string, unknown>).thinking = "x" })],
    ["tool array member", () => mutateConfig((c) => { (c.phrases as Record<string, unknown>).tool = [1] })],
    ["followup array", () => mutateConfig((c) => { (c.phrases as Record<string, unknown>).followup = {} })],
    ["context object", () => mutateConfig((c) => { c.context = [] })],
    ["context extra", () => mutateConfig((c) => { (c.context as Record<string, unknown>).extra = 1 })],
    ["context max type", () => mutateConfig((c) => { (c.context as Record<string, unknown>).maxTokens = 1.5 })],
    ["context max range", () => mutateConfig((c) => { (c.context as Record<string, unknown>).maxTokens = 0 })],
    ["context margin", () => mutateConfig((c) => { (c.context as Record<string, unknown>).contextMargin = "20" })],
    ["logging object", () => mutateConfig((c) => { c.logging = [] })],
    ["logging extra", () => mutateConfig((c) => { (c.logging as Record<string, unknown>).extra = true })],
    ["logging level", () => mutateConfig((c) => { (c.logging as Record<string, unknown>).level = "trace" })],
    ["logging sinks array", () => mutateConfig((c) => { (c.logging as Record<string, unknown>).sinks = "terminal" })],
    ["logging sink value", () => mutateConfig((c) => { (c.logging as Record<string, unknown>).sinks = ["other"] })],
    ["senses object", () => mutateConfig((c) => { c.senses = [] })],
    ["senses extra", () => mutateConfig((c) => { (c.senses as Record<string, unknown>).other = { enabled: true } })],
    ["sense object", () => mutateConfig((c) => { (c.senses as Record<string, unknown>).cli = [] })],
    ["sense missing", () => mutateConfig((c) => { (c.senses as Record<string, unknown>).cli = {} })],
    ["sense enabled", () => mutateConfig((c) => { ((c.senses as Record<string, unknown>).cli as Record<string, unknown>).enabled = "yes" })],
    ["servers object", () => mutateConfig((c) => { c.mcpServers = [] })],
    ["server id", () => mutateConfig((c) => { (c.mcpServers as Record<string, unknown>)["Bad Id"] = { command: "x" } })],
    ["server object", () => mutateConfig((c) => { (c.mcpServers as Record<string, unknown>)["internal-tools"] = [] })],
    ["server extra", () => mutateConfig((c) => { ((c.mcpServers as Record<string, unknown>)["internal-tools"] as Record<string, unknown>).extra = true })],
    ["server command type", () => mutateConfig((c) => { ((c.mcpServers as Record<string, unknown>)["internal-tools"] as Record<string, unknown>).command = 1 })],
    ["server command empty", () => mutateConfig((c) => { ((c.mcpServers as Record<string, unknown>)["internal-tools"] as Record<string, unknown>).command = "" })],
    ["server args", () => mutateConfig((c) => { ((c.mcpServers as Record<string, unknown>)["internal-tools"] as Record<string, unknown>).args = [1] })],
    ["server env object", () => mutateConfig((c) => { ((c.mcpServers as Record<string, unknown>)["internal-tools"] as Record<string, unknown>).env = [] })],
    ["server env value", () => mutateConfig((c) => { ((c.mcpServers as Record<string, unknown>)["internal-tools"] as Record<string, unknown>).env = { A: 1 } })],
    ["server cwd", () => mutateConfig((c) => { ((c.mcpServers as Record<string, unknown>)["internal-tools"] as Record<string, unknown>).cwd = 1 })],
    ["server visibility", () => mutateConfig((c) => { ((c.mcpServers as Record<string, unknown>)["internal-tools"] as Record<string, unknown>).visibility = "public" })],
    ["executors array", () => mutateConfig((c) => { c.habitExecutors = {} })],
    ["health profiles array", () => mutateConfig((c) => { c.mcpHealthProfiles = {} })],
    ["shell object", () => mutateConfig((c) => { c.shell = [] })],
    ["shell extra", () => mutateConfig((c) => { (c.shell as Record<string, unknown>).extra = true })],
    ["shell timeout type", () => mutateConfig((c) => { (c.shell as Record<string, unknown>).defaultTimeout = 1.5 })],
    ["shell timeout range", () => mutateConfig((c) => { (c.shell as Record<string, unknown>).defaultTimeout = 0 })],
    ["vault object", () => mutateConfig((c) => { c.vault = [] })],
    ["vault extra", () => mutateConfig((c) => { (c.vault as Record<string, unknown>).extra = true })],
    ["vault email", () => mutateConfig((c) => { (c.vault as Record<string, unknown>).email = 1 })],
    ["vault URL", () => mutateConfig((c) => { (c.vault as Record<string, unknown>).serverUrl = 1 })],
    ["sync object", () => mutateConfig((c) => { c.sync = [] })],
    ["sync extra", () => mutateConfig((c) => { (c.sync as Record<string, unknown>).extra = true })],
    ["sync enabled", () => mutateConfig((c) => { (c.sync as Record<string, unknown>).enabled = "yes" })],
    ["sync remote", () => mutateConfig((c) => { (c.sync as Record<string, unknown>).remote = 1 })],
    ["plugins array", () => mutateConfig((c) => { c.plugins = {} })],
    ["plugin object", () => mutateConfig((c) => { c.plugins = [[]] })],
    ["plugin extra", () => mutateConfig((c) => { ((c.plugins as unknown[])[0] as Record<string, unknown>).extra = true })],
    ["plugin identity", () => mutateConfig((c) => { ((c.plugins as unknown[])[0] as Record<string, unknown>).id = 1 })],
    ["plugin enabled", () => mutateConfig((c) => { ((c.plugins as unknown[])[0] as Record<string, unknown>).enabled = "yes" })],
    ["plugin source", () => mutateConfig((c) => { ((c.plugins as unknown[])[0] as Record<string, unknown>).source = 1 })],
    ["plugin version", () => mutateConfig((c) => { ((c.plugins as unknown[])[0] as Record<string, unknown>).version = 1 })],
    ["private runtime object", () => mutateConfig((c) => { c.privateRuntime = [] })],
    ["private runtime extra", () => mutateConfig((c) => { (c.privateRuntime as Record<string, unknown>).extra = true })],
    ["private runtime autoStart", () => mutateConfig((c) => { (c.privateRuntime as Record<string, unknown>).autoStart = "yes" })],
  ] as Array<[string, () => Buffer]>)("rejects invalid complete config: %s", (_label, target) => {
    const bundle = tempBundle()
    const before = fs.readFileSync(bundle.configPath)
    expect(() => executeAgentConfigCas({ bundleRoot: bundle.root, request: configRequest(before, target()) })).toThrow(/agent config/i)
    expect(fs.readFileSync(bundle.configPath)).toEqual(before)
  })

  it("rejects strict request key, hash-shape, and config protocol drift", () => {
    const bundle = tempBundle()
    const before = fs.readFileSync(bundle.configPath)
    const target = mutateConfig((c) => { (c.agentFacing as Record<string, unknown>).model = "next" })
    const config = configRequest(before, target)
    const habit = habitRequest()
    const invalid: Array<HabitMigrationRequestV1 | AgentConfigCasRequestV1> = [
      { ...config, migrationId: "other" as "agent-config-cas" },
      { ...config, version: 2 as 1 },
      { ...config, expectedBeforeSha256: "bad" },
      { ...config, targetSha256: "bad" },
      { ...config, requestSha256: "bad" },
      rehash({ ...config, extra: true } as AgentConfigCasRequestV1 & { extra: boolean }),
      rehash({ ...habit, extra: true } as HabitMigrationRequestV1 & { extra: boolean }),
      rehash(Object.fromEntries(Object.entries(habit).filter(([key]) => key !== "habitPath")) as unknown as HabitMigrationRequestV1),
    ]
    for (const request of invalid) {
      expect(() => request.migrationId === "exact-file"
        ? executeHabitMigration({ bundleRoot: bundle.root, request })
        : executeAgentConfigCas({ bundleRoot: bundle.root, request: request as AgentConfigCasRequestV1 })).toThrow()
    }
  })

  it("rejects bundle, parent, and protected metadata symlinks", () => {
    const bundle = tempBundle()
    const rootLink = `${bundle.root}-link`
    roots.push(rootLink)
    fs.symlinkSync(bundle.root, rootLink)
    expect(() => executeHabitMigration({ bundleRoot: rootLink, request: habitRequest() })).toThrow(/bundle root/i)

    const parentBundle = tempBundle()
    const realHabits = `${path.join(parentBundle.root, "habits")}-real`
    fs.renameSync(path.join(parentBundle.root, "habits"), realHabits)
    fs.symlinkSync(realHabits, path.join(parentBundle.root, "habits"))
    expect(() => executeHabitMigration({ bundleRoot: parentBundle.root, request: habitRequest() })).toThrow(/parent/i)

    const metadataBundle = tempBundle()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-migration-outside-"))
    roots.push(outside)
    fs.symlinkSync(outside, path.join(metadataBundle.root, "state"))
    expect(() => executeHabitMigration({ bundleRoot: metadataBundle.root, request: habitRequest() })).toThrow(/directory|symlink/i)
    expect(fs.readFileSync(metadataBundle.habitPath)).toEqual(beforeHabit)
  })

  it("rejects non-directory parents and unreadable targets", () => {
    const parentBundle = tempBundle()
    fs.rmSync(path.join(parentBundle.root, "habits"), { recursive: true })
    fs.writeFileSync(path.join(parentBundle.root, "habits"), "not a directory", { mode: 0o600 })
    expect(() => executeHabitMigration({ bundleRoot: parentBundle.root, request: habitRequest() })).toThrow(/real directory/i)

    const unreadable = tempBundle()
    fs.chmodSync(unreadable.habitPath, 0o000)
    expect(() => executeHabitMigration({ bundleRoot: unreadable.root, request: habitRequest() })).toThrow(/could not be opened/i)
  })

  it("rejects immutable-authority conflicts and tampering", () => {
    const conflict = tempBundle()
    const authorityDir = path.join(conflict.root, "state", "migrations", "authorities", "bytes")
    fs.mkdirSync(authorityDir, { recursive: true })
    fs.writeFileSync(path.join(authorityDir, `${sha256(beforeHabit)}.bin`), "wrong", { mode: 0o600 })
    expect(() => executeHabitMigration({ bundleRoot: conflict.root, request: habitRequest() })).toThrow(/authority content conflicts/i)

    const tampered = tempBundle()
    const request = habitRequest()
    expect(() => executeHabitMigration({
      bundleRoot: tampered.root,
      request,
      fault(point) { if (point === "after-prepared") throw new Error("stop") },
    })).toThrow("stop")
    const transaction = readJson(transactionPath(tampered.root, request))
    fs.writeFileSync(path.join(tampered.root, transaction.planRef as string), "{}", { mode: 0o600 })
    expect(() => executeHabitMigration({ bundleRoot: tampered.root, request })).toThrow(/authority hash/i)
  })

  it("rejects persisted request and transaction authority drift", () => {
    const requestDrift = tempBundle()
    const request = habitRequest()
    expect(() => executeHabitMigration({
      bundleRoot: requestDrift.root,
      request,
      fault(point) { if (point === "after-prepared") throw new Error("stop") },
    })).toThrow("stop")
    writeCanonical(requestPath(requestDrift.root, request), { ...request, targetSha256: "0".repeat(64) })
    expect(() => executeHabitMigration({ bundleRoot: requestDrift.root, request })).toThrow(/migration request conflicts/i)

    const transactionDrift = tempBundle()
    expect(() => executeHabitMigration({
      bundleRoot: transactionDrift.root,
      request,
      fault(point) { if (point === "after-prepared") throw new Error("stop") },
    })).toThrow("stop")
    const transaction = readJson(transactionPath(transactionDrift.root, request))
    writeCanonical(transactionPath(transactionDrift.root, request), { ...transaction, requestSha256: "0".repeat(64) })
    expect(() => executeHabitMigration({ bundleRoot: transactionDrift.root, request })).toThrow(/transaction request authority/i)
  })

  it.each([
    ["absolute", path.join(os.tmpdir(), "outside-authority.json"), /must be relative/i],
    ["escaping", "../outside-authority.json", /escapes bundle/i],
  ])("rejects %s transaction authority references", (_label, planRef, message) => {
    const bundle = tempBundle()
    const request = habitRequest()
    expect(() => executeHabitMigration({
      bundleRoot: bundle.root,
      request,
      fault(point) { if (point === "after-prepared") throw new Error("stop") },
    })).toThrow("stop")
    const transaction = readJson(transactionPath(bundle.root, request))
    writeCanonical(transactionPath(bundle.root, request), { ...transaction, planRef })
    expect(() => executeHabitMigration({ bundleRoot: bundle.root, request })).toThrow(message)
  })

  it("fences invalid terminal and recovery states", () => {
    const request = habitRequest()
    const missingForward = tempBundle()
    executeHabitMigration({ bundleRoot: missingForward.root, request })
    const committed = readJson(transactionPath(missingForward.root, request))
    writeCanonical(transactionPath(missingForward.root, request), { ...committed, forwardResultRef: null })
    expect(() => executeHabitMigration({ bundleRoot: missingForward.root, request })).toThrow(/missing forward authorities/i)

    const invalid = tempBundle()
    expect(() => executeHabitMigration({
      bundleRoot: invalid.root,
      request,
      fault(point) { if (point === "after-prepared") throw new Error("stop") },
    })).toThrow("stop")
    const prepared = readJson(transactionPath(invalid.root, request))
    writeCanonical(transactionPath(invalid.root, request), { ...prepared, state: "foreign" })
    expect(() => executeHabitMigration({ bundleRoot: invalid.root, request })).toThrow(/invalid forward state/i)

    const rolledBack = tempBundle()
    executeHabitMigration({ bundleRoot: rolledBack.root, request })
    rollbackHabitMigration({ bundleRoot: rolledBack.root, requestSha256: request.requestSha256 })
    expect(() => executeHabitMigration({ bundleRoot: rolledBack.root, request })).toThrow(/cannot apply from rolled_back/i)
  })

  it("fences same-byte identity replacement before forward recovery and rollback", () => {
    for (const alreadyCurrent of [false, true]) {
      const bundle = tempBundle()
      const request = alreadyCurrent
        ? createHabitMigrationRequest({ habitId: "queue", expectedBeforeBytes: beforeHabit, targetBytes: beforeHabit })
        : habitRequest()
      expect(() => executeHabitMigration({
        bundleRoot: bundle.root,
        request,
        fault(point) { if (point === "after-prepared") throw new Error("stop") },
      })).toThrow("stop")
      fs.renameSync(bundle.habitPath, `${bundle.habitPath}.old`)
      fs.writeFileSync(bundle.habitPath, beforeHabit, { mode: 0o600 })
      expect(() => executeHabitMigration({ bundleRoot: bundle.root, request })).toThrow(/identity changed/i)
    }

    const rollback = tempBundle()
    const request = habitRequest()
    executeHabitMigration({ bundleRoot: rollback.root, request })
    fs.renameSync(rollback.habitPath, `${rollback.habitPath}.old`)
    fs.writeFileSync(rollback.habitPath, afterHabit, { mode: 0o600 })
    expect(() => rollbackHabitMigration({ bundleRoot: rollback.root, requestSha256: request.requestSha256 })).toThrow(/identity changed/i)
  })

  it("detects a same-parent target replacement immediately before rename", () => {
    const bundle = tempBundle()
    expect(() => executeHabitMigration({
      bundleRoot: bundle.root,
      request: habitRequest(),
      hook(point) {
        if (point === "before-rename") {
          fs.renameSync(bundle.habitPath, `${bundle.habitPath}.old`)
          fs.writeFileSync(bundle.habitPath, beforeHabit, { mode: 0o600 })
        }
      },
    })).toThrow(/identity changed before rename/i)
  })

  it("rejects rollback request, state, forward-result, and terminal-authority drift", () => {
    const request = habitRequest()
    const requestDrift = tempBundle()
    executeHabitMigration({ bundleRoot: requestDrift.root, request })
    writeCanonical(requestPath(requestDrift.root, request), { ...request, requestSha256: "0".repeat(64) })
    expect(() => rollbackHabitMigration({ bundleRoot: requestDrift.root, requestSha256: request.requestSha256 })).toThrow(/request authority/i)

    const wrongState = tempBundle()
    expect(() => executeHabitMigration({
      bundleRoot: wrongState.root,
      request,
      fault(point) { if (point === "after-prepared") throw new Error("stop") },
    })).toThrow("stop")
    expect(() => rollbackHabitMigration({ bundleRoot: wrongState.root, requestSha256: request.requestSha256 })).toThrow(/cannot roll back from prepared/i)

    const noForward = tempBundle()
    executeHabitMigration({ bundleRoot: noForward.root, request })
    const committed = readJson(transactionPath(noForward.root, request))
    writeCanonical(transactionPath(noForward.root, request), { ...committed, forwardResultSha256: null })
    expect(() => rollbackHabitMigration({ bundleRoot: noForward.root, requestSha256: request.requestSha256 })).toThrow(/forward result/i)

    const incompleteForward = tempBundle()
    executeHabitMigration({ bundleRoot: incompleteForward.root, request })
    const incomplete = readJson(transactionPath(incompleteForward.root, request))
    writeCanonical(transactionPath(incompleteForward.root, request), { ...incomplete, forwardResultRef: null })
    expect(() => rollbackHabitMigration({ bundleRoot: incompleteForward.root, requestSha256: request.requestSha256 })).toThrow(/complete committed forward result/i)

    const missingRollback = tempBundle()
    executeHabitMigration({ bundleRoot: missingRollback.root, request })
    rollbackHabitMigration({ bundleRoot: missingRollback.root, requestSha256: request.requestSha256 })
    const terminal = readJson(transactionPath(missingRollback.root, request))
    writeCanonical(transactionPath(missingRollback.root, request), { ...terminal, rollbackReceiptRef: null })
    expect(() => rollbackHabitMigration({ bundleRoot: missingRollback.root, requestSha256: request.requestSha256 })).toThrow(/missing rollback authorities/i)
  })

  it("does not attempt adoption rollback when strict config validation fails before apply", () => {
    const bundle = tempBundle()
    const before = fs.readFileSync(bundle.configPath)
    const bad = Buffer.from(JSON.stringify({ version: 2 }))
    const events: string[] = []
    expect(() => executeRuntimeAdoption({
      bundleRoot: bundle.root,
      agentConfig: configRequest(before, bad),
      habits: [habitRequest()],
      hook(event) { events.push(event) },
      validateCombined() { throw new Error("must not run") },
    })).toThrow(/agent config/i)
    expect(events).toEqual([])
  })
})
