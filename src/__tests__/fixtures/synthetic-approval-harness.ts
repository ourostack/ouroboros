import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import Database from "better-sqlite3"

import { runAgent, resumeApprovalContinuation } from "../../heart/core"
import { openApprovalStore, type JsonObject, type PrepareApprovalInput } from "../../heart/approval-store"
import { buildCanonicalSessionEnvelope, parseSessionEnvelope, projectProviderMessages } from "../../heart/session-events"
import {
  commitApprovalProposal,
  coordinateApprovalDecision,
  digestApprovalSuspensionCheckpointPayload,
  executeApprovalDecision,
  recoverAttemptedApproval,
  recoverClaimedApproval,
  type ApprovalSuspensionCheckpoint,
  type ApprovalSuspensionCheckpointStore,
  type ApprovalTokenStore,
} from "../../heart/tool-approval"
import { digestJson, validateAdvertisedToolArguments } from "../../repertoire/tool-arguments"
import { approvalPolicyForToolName, shellRiskProfile } from "../../repertoire/tools"
import { shellToolDefinitions } from "../../repertoire/tools-shell"

export const syntheticApprovalProductionSeams = {
  runAgent,
  openApprovalStore,
  commitApprovalProposal,
  coordinateApprovalDecision,
  executeApprovalDecision,
  resumeApprovalContinuation,
}

export type SyntheticCrashPoint =
  | "after_journal_prepare"
  | "after_token_persist"
  | "after_checkpoint_write"
  | "after_prompt_accept_before_bind"
  | "after_claim"
  | "after_attempt"
  | "after_handler"
  | "after_terminal_persist"
  | "after_terminal_pair_persist_before_materialized"
  | "after_materialized_marker_before_continuation_attempt"
  | "after_continuation_attempt"

export interface SyntheticApprovalScenario {
  command?: string
  argumentsJson?: string
  liveSchemaMutation?: "require_missing_property" | "wrong_command_type" | "treat_command_as_extra"
  corruptJournalAfterProposal?: "non_object_arguments" | "malformed_record_json"
  decision?: "approve" | "deny"
  delayMs?: number
  restartBeforeDecision?: boolean
  crashAt?: SyntheticCrashPoint
  handlerMode?: "idempotent" | "non_idempotent" | "observable_failure"
  batch?: Array<{ name: string; argumentsJson: string }>
  concurrentDecisionProcesses?: number
  advanceSessionHeadBeforeDecision?: boolean
}

export interface SyntheticApprovalArtifacts {
  root: string
  approvalId: string | null
  approvalDatabasePath: string
  sessionPath: string
  effectsLogPath: string
  providerLogPath: string
  deliveryLogPath: string
  traceLogPath: string
  initialOutcome: "suspended" | "rejected"
  rejectionAt: "pre_proposal_schema" | "protected_batch" | null
  runErrorCode: string | null
  originPid: number
  decisionPids: number[]
  continuationPids: number[]
  callbackOutcomes: Array<{ processPid: number; accepted: boolean; reason: string }>
}

const BASE_REVISION = "d".repeat(64)
const SUSPENDED_REVISION = "f".repeat(64)
const RECORDED_AT = "2026-08-17T17:30:00.000Z"

function append(filePath: string, value: unknown): void {
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`)
}

function fileCheckpointStore(filePath: string): ApprovalSuspensionCheckpointStore {
  const readAll = (): Record<string, ApprovalSuspensionCheckpoint> => fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf8"))
    : {}
  const writeAll = (records: Record<string, ApprovalSuspensionCheckpoint>) => fs.writeFileSync(filePath, JSON.stringify(records))
  return {
    write(draft) {
      const checkpoint = { ...structuredClone(draft), checkpointDigest: digestApprovalSuspensionCheckpointPayload(draft), suspendedSessionRevision: SUSPENDED_REVISION }
      const records = readAll()
      records[checkpoint.approvalId] = checkpoint
      writeAll(records)
      return { checkpointDigest: checkpoint.checkpointDigest, suspendedSessionRevision: checkpoint.suspendedSessionRevision }
    },
    read(approvalId) { return structuredClone(readAll()[approvalId] ?? null) },
    list() { return Object.values(readAll()).map((record) => structuredClone(record)) },
    remove(approvalId) { const records = readAll(); delete records[approvalId]; writeAll(records) },
  }
}

function fileTokenStore(filePath: string): ApprovalTokenStore {
  const readAll = (): Record<string, string> => fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf8")) : {}
  const writeAll = (records: Record<string, string>) => fs.writeFileSync(filePath, JSON.stringify(records))
  return {
    put(approvalId, token) { const records = readAll(); records[approvalId] = token; writeAll(records) },
    has(approvalId) { return approvalId in readAll() },
    get(approvalId) { return readAll()[approvalId] ?? null },
    remove(approvalId) { const records = readAll(); delete records[approvalId]; writeAll(records) },
  }
}

function writeSession(sessionPath: string, messages: any[]): void {
  const envelope = buildCanonicalSessionEnvelope({
    existing: null,
    previousMessages: [],
    currentMessages: messages,
    trimmedMessages: messages,
    recordedAt: RECORDED_AT,
    projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
  }).envelope
  fs.writeFileSync(sessionPath, JSON.stringify(envelope))
}

function proposal(sessionPath: string, args: JsonObject): PrepareApprovalInput {
  const definition = shellToolDefinitions[0]!
  const schemaDigest = digestJson(definition.tool.function.parameters as any)
  const policy = approvalPolicyForToolName("shell", args)
  if (policy.kind !== "required") throw new Error("synthetic policy unexpectedly did not require approval")
  return {
    toolCallId: "call_restart", toolName: "shell", arguments: args,
    schemaDigest,
    toolDigest: digestJson({ name: "shell", schemaDigest, policyId: policy.policyId }),
    policyDigest: digestJson({ policyId: policy.policyId, actionClass: policy.actionClass, classification: "required" }),
    policyId: policy.policyId,
    sessionKey: "telegram:chat-7", sessionPath, baseSessionRevision: BASE_REVISION,
    checkpointDigest: "e".repeat(64), requesterId: "friend-ari", transport: "telegram",
    transportUserId: "42", transportChatId: "7", expiresAt: "2099-08-17T18:30:00.000Z",
    frozenAssistantMessage: { role: "assistant", content: null, tool_calls: [{ id: "call_restart", type: "function", function: { name: "shell", arguments: JSON.stringify(args) } }] },
  }
}

function workerScript(): string {
  return String.raw`
const ts = require("typescript")
require.extensions[".ts"] = (module, filename) => {
  const source = require("fs").readFileSync(filename, "utf8")
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename }).outputText, filename)
}
`
}

function originWorkerScript(): string {
  return String.raw`
const ts = require("typescript")
require.extensions[".ts"] = (module, filename) => {
  const source = require("fs").readFileSync(filename, "utf8")
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename }).outputText, filename)
}
const fs = require("fs")
const Module = require("module")
const fixture = JSON.parse(fs.readFileSync(process.argv[8], "utf8"))
let providerRequest = null
let providerCall = 0
const stream = chunks => ({ [Symbol.asyncIterator]: async function* () { for (const chunk of chunks) yield chunk } })
class MockOpenAI {
  chat = { completions: { create: async request => {
    providerRequest = structuredClone(request)
    const calls = providerCall++ === 0
      ? (fixture.batch ?? [{ name: "shell", argumentsJson: fixture.argumentsJson }]).map((call, index) => ({ index, id: index === 0 ? "call_restart" : "call_" + index, type: "function", function: { name: call.name, arguments: call.argumentsJson } }))
      : [{ index: 0, id: "call_settle", type: "function", function: { name: "settle", arguments: JSON.stringify({ answer: "rejected safely" }) } }]
    return stream([{ choices: [{ delta: { tool_calls: calls } }] }])
  } } }
  responses = { create: async () => { throw new Error("responses API is not expected") } }
}
const originalLoad = Module._load
Module._load = function(request, parent, isMain) {
  if (request === "openai") return { __esModule: true, default: MockOpenAI, AzureOpenAI: MockOpenAI }
  if (request === "@anthropic-ai/sdk") return { __esModule: true, default: class {} }
  if (request === "./identity" && parent && parent.filename.includes("/heart/")) return {
    loadAgentConfig: () => ({ name: "synthetic", humanFacing: { provider: "minimax", model: "minimax-text-01" }, agentFacing: { provider: "minimax", model: "minimax-text-01" } }),
    DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 }, getAgentName: () => "synthetic",
    getAgentRoot: () => fixture.root, getRepoRoot: () => fixture.root, resetIdentity: () => {},
  }
  return originalLoad.call(this, request, parent, isMain)
}
const core = require(process.argv[1])
const approval = require(process.argv[2])
const storeModule = require(process.argv[3])
const argsModule = require(process.argv[4])
const shellModule = require(process.argv[5])
const config = require(process.argv[6])
const events = require(process.argv[7])
config.patchRuntimeConfig({ providers: { minimax: { apiKey: "synthetic-test-key", model: "minimax-text-01" } } })
const append = (file, value) => fs.appendFileSync(file, JSON.stringify(value) + "\n")
const readAll = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}
const checkpoints = {
  write: draft => { const value = { ...structuredClone(draft), checkpointDigest: approval.digestApprovalSuspensionCheckpointPayload(draft), suspendedSessionRevision: fixture.suspendedRevision }; const all = readAll(fixture.checkpointPath); all[value.approvalId] = value; fs.writeFileSync(fixture.checkpointPath, JSON.stringify(all)); return { checkpointDigest: value.checkpointDigest, suspendedSessionRevision: value.suspendedSessionRevision } },
  read: id => readAll(fixture.checkpointPath)[id] || null, list: () => Object.values(readAll(fixture.checkpointPath)),
  remove: id => { const all = readAll(fixture.checkpointPath); delete all[id]; fs.writeFileSync(fixture.checkpointPath, JSON.stringify(all)) },
}
const tokens = {
  put: (id, token) => { const all = readAll(fixture.tokenPath); all[id] = token; fs.writeFileSync(fixture.tokenPath, JSON.stringify(all)) },
  has: id => id in readAll(fixture.tokenPath), get: id => readAll(fixture.tokenPath)[id] || null,
  remove: id => { const all = readAll(fixture.tokenPath); delete all[id]; fs.writeFileSync(fixture.tokenPath, JSON.stringify(all)) },
}
const store = storeModule.openApprovalStore({ databasePath: fixture.databasePath, now: () => new Date(fixture.originNow) })
const callbacks = { onModelStart() {}, onModelStreamStart() {}, onTextChunk() {}, onReasoningChunk() {}, onToolStart() {}, onToolEnd() {}, onError(error) { throw error } };
(async () => {
  try {
    const messages = [{ role: "user", content: "restart calibre-web" }]
    const result = await core.runAgent(messages, callbacks, "telegram", undefined, {
      tools: fixture.batch ? fixture.batch.map(call => require(process.argv[9]).resolveToolDefinition(call.name).tool) : [shellModule.shellToolDefinitions[0].tool],
      execTool: async () => { append(fixture.traceLogPath, { sequence: 3, pid: process.pid, atMs: 0, type: "handler_start" }); throw new Error("protected handler ran before approval") },
      toolContext: { signin: async () => undefined }, daemonRunning: false, senseStatusLines: [], bundleMeta: null, daemonHealth: null,
      approvalCoordinator: { propose: async request => {
        const policy = require(process.argv[9]).approvalPolicyForToolName("shell", request.arguments)
        const committed = approval.commitApprovalProposal({ approvalStore: store, checkpointStore: checkpoints, tokenStore: tokens,
          proposal: { toolCallId: request.toolCall.id, toolName: "shell", arguments: request.arguments, schemaDigest: request.schemaDigest, toolDigest: request.toolDigest, policyDigest: request.policyDigest, policyId: request.policyId,
            sessionKey: "telegram:chat-7", sessionPath: fixture.sessionPath, baseSessionRevision: fixture.baseRevision, checkpointDigest: "e".repeat(64), requesterId: "friend-ari", transport: "telegram", transportUserId: "42", transportChatId: "7", expiresAt: fixture.expiresAt, frozenAssistantMessage: request.frozenAssistantMessage },
          preCallMessages: request.preCallMessages,
        })
        return { approvalId: committed.record.approvalId, checkpointDigest: committed.record.checkpointDigest, suspendedSessionRevision: committed.record.suspendedSessionRevision }
      } },
    })
    if (fixture.expectRejected) {
      if (result.suspension) throw new Error("rejected origin unexpectedly suspended")
      const rejectionObserved = messages.some(message => message.role === "tool" && typeof message.content === "string" && (message.content.includes("rejected:") || message.content.includes("invalid tool arguments")))
      if (!rejectionObserved) throw new Error("runAgent settled without an explicit pre-handler rejection result: " + JSON.stringify(messages))
      process.stdout.write(JSON.stringify({ pid: process.pid, rejected: true }) + "\n")
      return
    }
    if (result.outcome !== "suspended" || !result.suspension) throw new Error("runAgent did not suspend")
    const checkpoint = checkpoints.read(result.suspension.approvalId)
    const envelope = events.buildCanonicalSessionEnvelope({ existing: null, previousMessages: [], currentMessages: checkpoint.preCallMessages, trimmedMessages: checkpoint.preCallMessages, recordedAt: fixture.originNow, projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null } }).envelope
    fs.writeFileSync(fixture.sessionPath, JSON.stringify(envelope))
    append(fixture.providerLogPath, { pid: process.pid, kind: "origin", invokedBy: "runAgent", approvalId: null, messages: providerRequest.messages })
    append(fixture.traceLogPath, { sequence: 2, pid: process.pid, atMs: 0, type: "proposal_suspended" })
    process.stdout.write(JSON.stringify({ pid: process.pid, approvalId: result.suspension.approvalId }) + "\n")
  } catch (error) { process.stdout.write(JSON.stringify({ pid: process.pid, error: String(error && error.stack || error) }) + "\n") }
  finally { store.close() }
})()
`
}

function runOriginWorker(fixturePath: string): Promise<{ pid: number; approvalId?: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", originWorkerScript(), path.resolve("src/heart/core.ts"), path.resolve("src/heart/tool-approval.ts"), path.resolve("src/heart/approval-store.ts"),
      path.resolve("src/repertoire/tool-arguments.ts"), path.resolve("src/repertoire/tools-shell.ts"), path.resolve("src/heart/config.ts"), path.resolve("src/heart/session-events.ts"), fixturePath,
      path.resolve("src/repertoire/tools.ts")], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""; let stderr = ""
    child.stdout.on("data", chunk => { stdout += String(chunk) }); child.stderr.on("data", chunk => { stderr += String(chunk) })
    child.once("exit", code => { const line = stdout.trim().split("\n").at(-1); if (!line) reject(new Error("origin worker exited " + code + ": " + stderr)); else resolve(JSON.parse(line)) })
  })
}

function workerScriptTail(): string {
  return String.raw`
const fs = require("fs")
const approval = require(process.argv[1])
const core = require(process.argv[2])
const storeModule = require(process.argv[3])
const argsModule = require(process.argv[4])
const shellModule = require(process.argv[5])
const fixture = JSON.parse(fs.readFileSync(process.argv[6], "utf8"))
const append = (file, value) => fs.appendFileSync(file, JSON.stringify(value) + "\n")
const readCheckpoints = () => JSON.parse(fs.readFileSync(fixture.checkpointPath, "utf8"))
const checkpoints = { read: id => readCheckpoints()[id] || null, list: () => Object.values(readCheckpoints()), write: () => { throw new Error("worker cannot write checkpoint") }, remove: () => {} }
const store = storeModule.openApprovalStore({ databasePath: fixture.databasePath, now: () => new Date(fixture.decisionNow) })
const trace = (type, detail) => append(fixture.traceLogPath, { sequence: Date.now(), pid: process.pid, atMs: fixture.decisionAtMs, type, ...(detail ? { detail } : {}) })
let continuationClaim
let accepted = false
let reason = "already claimed"
const ownerId = "decision-" + process.pid
const liveDefinition = () => {
  const original = shellModule.shellToolDefinitions[0]
  if (!fixture.liveSchemaMutation) return original
  const clone = { ...original, tool: { ...original.tool, function: { ...original.tool.function, parameters: structuredClone(original.tool.function.parameters) } } }
  const schema = clone.tool.function.parameters
  if (fixture.liveSchemaMutation === "require_missing_property") { schema.properties.confirmation = { type: "string" }; schema.required.push("confirmation") }
  if (fixture.liveSchemaMutation === "wrong_command_type") schema.properties.command = { type: "number" }
  if (fixture.liveSchemaMutation === "treat_command_as_extra") { delete schema.properties.command; schema.required = []; schema.additionalProperties = false }
  return clone
}
const persist = messages => {
  const events = require(process.argv[7])
  const envelope = events.buildCanonicalSessionEnvelope({ existing: null, previousMessages: [], currentMessages: messages, trimmedMessages: messages, recordedAt: "2026-08-17T17:30:00.000Z", projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null } }).envelope
  fs.writeFileSync(fixture.sessionPath, JSON.stringify(envelope))
}
async function resume(record) {
  if (fixture.crashAt === "after_terminal_persist") throw new Error("synthetic_crash")
  await core.resumeApprovalContinuation({
    record, checkpoint: checkpoints.read(fixture.approvalId), currentSessionRevision: fixture.currentRevision,
    sessionMessages: fixture.preCallMessages, callbacks: { onTextChunk: () => {} }, channel: "telegram",
    claimContinuation: () => { continuationClaim = store.claimContinuation({ approvalId: fixture.approvalId, ownerId: "continuation-" + process.pid, ownerPid: process.pid }); return continuationClaim },
    markContinuationMaterialized: () => {
      if (fixture.crashAt === "after_terminal_pair_persist_before_materialized") throw new Error("synthetic_crash")
      const value = store.markContinuationMaterialized({ approvalId: fixture.approvalId, ownerId: "continuation-" + process.pid, epoch: continuationClaim.record.continuationEpoch })
      if (fixture.crashAt === "after_materialized_marker_before_continuation_attempt") throw new Error("synthetic_crash")
      return value
    },
    markContinuationAttempted: () => store.markContinuationAttempted({ approvalId: fixture.approvalId, ownerId: "continuation-" + process.pid, epoch: continuationClaim.record.continuationEpoch }),
    completeContinuation: () => store.completeContinuation({ approvalId: fixture.approvalId, ownerId: "continuation-" + process.pid, epoch: continuationClaim.record.continuationEpoch }),
    runAgent: async (messages, callbacks) => {
      trace("continuation_provider_start")
      const providerMessages = [...fixture.originProviderMessages.slice(0, -fixture.preCallMessages.length), ...structuredClone(messages)]
      append(fixture.providerLogPath, { pid: process.pid, kind: "continuation", invokedBy: "resumeApprovalContinuation", approvalId: fixture.approvalId, messages: providerMessages })
      if (fixture.crashAt === "after_continuation_attempt") throw new Error("synthetic_crash")
      const text = record.state === "denied" ? "I did not restart calibre-web." : record.state === "failed" ? "calibre-web restart failed safely." : "calibre-web is back up"
      callbacks.onTextChunk(text); messages.push({ role: "assistant", content: text }); return { outcome: "settled" }
    },
    persist,
    deliver: text => append(fixture.deliveryLogPath, { pid: process.pid, kind: text.includes("indeterminate") ? "indeterminate" : (record.state === "succeeded" || record.state === "failed" || record.state === "denied") ? "provider" : "direct", text }),
  })
}
(async () => {
  try {
    if (fixture.resumeOnly) {
      await resume(store.read(fixture.approvalId))
      process.stdout.write(JSON.stringify({ pid: process.pid, accepted: false, reason: "continuation recovery" }) + "\n")
      return
    }
    const coordinated = await approval.coordinateApprovalDecision({
      withSessionLease: work => work({ ownerId, ownerToken: ownerId + "-token" }),
      readCurrentRevision: () => fixture.currentRevision,
      decideAndExecute: async ({ currentSessionRevision, hooks }) => approval.executeApprovalDecision({
        approvalStore: store, checkpointStore: checkpoints,
        decision: fixture.decision, ownerId, currentSessionRevision,
        resolveTool: liveDefinition,
        liveGuard: () => ({ ok: true }), liveRisk: () => ({ ok: true }),
        execute: async () => {
          trace("handler_start")
          if (fixture.handlerMode === "observable_failure") throw new approval.ApprovalExecutionFailedError("restart failed")
          append(fixture.effectsLogPath, { pid: process.pid, command: "docker restart calibre-web" }); return "restarted"
        },
        hooks: {
          afterClaim: async () => { accepted = true; reason = "claimed"; trace("decision_received"); await hooks.afterClaim(); if (fixture.crashAt === "after_claim") throw new Error("synthetic_crash") },
          afterAttempt: () => { trace("attempted_committed"); if (fixture.crashAt === "after_attempt") throw new Error("synthetic_crash") },
          afterHandler: () => { if (fixture.crashAt === "after_handler") throw new Error("synthetic_crash") },
        },
      }),
      persist: record => trace("terminal_persisted", record.state),
      resume,
    })
    process.stdout.write(JSON.stringify({ pid: process.pid, accepted, reason, state: coordinated.record.state }) + "\n")
  } catch (error) {
    const message = String(error && error.message || error)
    process.stdout.write(JSON.stringify({ pid: process.pid, accepted, reason: accepted ? reason : message, error: message }) + "\n")
  } finally { store.close() }
})()
`
}

function runWorker(fixturePath: string): Promise<{ pid: number; accepted: boolean; reason: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", workerScript() + workerScriptTail(),
      path.resolve("src/heart/tool-approval.ts"), path.resolve("src/heart/core.ts"), path.resolve("src/heart/approval-store.ts"),
      path.resolve("src/repertoire/tool-arguments.ts"), path.resolve("src/repertoire/tools-shell.ts"), fixturePath,
      path.resolve("src/heart/session-events.ts"),
    ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""; let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += String(chunk) })
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.once("exit", (code) => {
      const line = stdout.trim().split("\n").at(-1)
      if (!line) reject(new Error(`synthetic worker exited ${code}: ${stderr}`))
      else resolve(JSON.parse(line))
    })
  })
}

export async function runSyntheticApprovalScenario(scenario: SyntheticApprovalScenario): Promise<SyntheticApprovalArtifacts> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-synthetic-approval-"))
  const approvalDatabasePath = path.join(root, "approvals.sqlite")
  const sessionPath = path.join(root, "session.json")
  const effectsLogPath = path.join(root, "effects.ndjson")
  const providerLogPath = path.join(root, "providers.ndjson")
  const deliveryLogPath = path.join(root, "deliveries.ndjson")
  const traceLogPath = path.join(root, "trace.ndjson")
  const checkpointPath = path.join(root, "checkpoints.json")
  const tokenPath = path.join(root, "tokens.json")
  for (const file of [effectsLogPath, providerLogPath, deliveryLogPath, traceLogPath]) fs.writeFileSync(file, "")
  const base = { root, approvalId: null, approvalDatabasePath, sessionPath, effectsLogPath, providerLogPath, deliveryLogPath, traceLogPath,
    initialOutcome: "rejected" as const, rejectionAt: null, runErrorCode: null, originPid: process.pid, decisionPids: [] as number[], continuationPids: [] as number[], callbackOutcomes: [] as Array<{ processPid: number; accepted: boolean; reason: string }> }
  const preCallMessages = [{ role: "user" as const, content: "restart calibre-web" }]
  writeSession(sessionPath, preCallMessages)

  const argumentsJson = scenario.argumentsJson ?? JSON.stringify({ command: scenario.command ?? "docker restart calibre-web" })
  const rejectedOrigin = async (rejectionAt: "pre_proposal_schema" | "protected_batch", batch?: SyntheticApprovalScenario["batch"]): Promise<SyntheticApprovalArtifacts> => {
    const originFixturePath = path.join(root, "origin-rejection-worker.json")
    fs.writeFileSync(originFixturePath, JSON.stringify({ root, databasePath: approvalDatabasePath, checkpointPath, tokenPath, sessionPath, providerLogPath, traceLogPath,
      argumentsJson, batch, expectRejected: true, baseRevision: BASE_REVISION, suspendedRevision: SUSPENDED_REVISION, originNow: RECORDED_AT, expiresAt: "2099-08-17T18:30:00.000Z" }))
    const origin = await runOriginWorker(originFixturePath)
    if (origin.error) throw new Error(`synthetic rejection origin failed: ${origin.error}`)
    return { ...base, originPid: origin.pid, rejectionAt }
  }
  if (scenario.batch) return rejectedOrigin("protected_batch", scenario.batch)
  const validated = validateAdvertisedToolArguments(argumentsJson, shellToolDefinitions[0]!.tool.function.parameters as any)
  if (!validated.ok) return rejectedOrigin("pre_proposal_schema")
  const args = validated.value.arguments
  const risk = shellRiskProfile(args as Record<string, string>)
  append(traceLogPath, { sequence: 1, pid: process.pid, atMs: 0, type: "classification", detail: `required:${risk.risk}` })

  let store = openApprovalStore({ databasePath: approvalDatabasePath })
  const checkpoints = fileCheckpointStore(checkpointPath)
  const tokens = fileTokenStore(tokenPath)
  let approvalId: string | null = null
  let decisionToken = ""
  let originPid = process.pid
  const commitCrash = ["after_journal_prepare", "after_token_persist", "after_checkpoint_write"].includes(scenario.crashAt ?? "")
  try {
    if (!commitCrash) {
      store.close()
      const originFixturePath = path.join(root, "origin-worker.json")
      fs.writeFileSync(originFixturePath, JSON.stringify({ root, databasePath: approvalDatabasePath, checkpointPath, tokenPath, sessionPath, providerLogPath, traceLogPath,
        argumentsJson, baseRevision: BASE_REVISION, suspendedRevision: SUSPENDED_REVISION, originNow: RECORDED_AT, expiresAt: "2099-08-17T18:30:00.000Z" }))
      const origin = await runOriginWorker(originFixturePath)
      if (origin.error || !origin.approvalId) throw new Error(`synthetic origin worker failed: ${origin.error ?? "missing approval id"}`)
      originPid = origin.pid
      approvalId = origin.approvalId
      decisionToken = tokens.get(approvalId) ?? ""
      store = openApprovalStore({ databasePath: approvalDatabasePath })
    } else {
    const committed = commitApprovalProposal({ approvalStore: store, checkpointStore: checkpoints, tokenStore: tokens,
      proposal: proposal(sessionPath, args), preCallMessages,
      hooks: {
        afterJournalPrepare: scenario.crashAt === "after_journal_prepare" ? () => { throw new Error("synthetic_crash") } : undefined,
        afterTokenPersist: scenario.crashAt === "after_token_persist" ? () => { throw new Error("synthetic_crash") } : undefined,
        afterCheckpointWrite: scenario.crashAt === "after_checkpoint_write" ? () => { throw new Error("synthetic_crash") } : undefined,
      },
    })
    approvalId = committed.record.approvalId; decisionToken = committed.decisionToken
    append(traceLogPath, { sequence: 2, pid: process.pid, atMs: 0, type: "proposal_suspended" })
    }
  } catch (error) {
    if (!commitCrash) {
      throw error
    }
    const prepared = store.listPreparing().at(0) ?? null
    approvalId = prepared?.approvalId ?? null
    if (approvalId && scenario.crashAt === "after_checkpoint_write") {
      const checkpoint = checkpoints.read(approvalId)!
      store.activate({ approvalId, checkpointDigest: checkpoint.checkpointDigest, suspendedSessionRevision: checkpoint.suspendedSessionRevision })
    } else if (approvalId) {
      store.recoverPreparing({ approvalId, state: "abandoned_before_attempt", reason: "crash before durable suspension" })
      append(traceLogPath, { sequence: 3, pid: process.pid, atMs: 1, type: "fresh_approval_required" })
      append(deliveryLogPath, { pid: process.pid, kind: "direct", text: "request a fresh approval" })
    }
    store.close()
    return { ...base, approvalId, originPid, initialOutcome: "suspended", rejectionAt: null }
  }
  if (!approvalId) throw new Error("approval proposal did not produce an id")
  if (scenario.crashAt !== "after_prompt_accept_before_bind") {
    store.bindPrompt({ approvalId, transport: "telegram", transportChatId: "7", transportMessageId: "99" })
  }

  if (!scenario.decision && !scenario.crashAt) {
    store.close()
    return { ...base, approvalId, originPid, initialOutcome: "suspended", rejectionAt: null }
  }

  if (scenario.corruptJournalAfterProposal) {
    store.close()
    const database = new Database(approvalDatabasePath)
    const row = database.prepare("SELECT record_json FROM approval_actions WHERE approval_id = ?").get(approvalId) as { record_json: string }
    const corrupted = scenario.corruptJournalAfterProposal === "non_object_arguments"
      ? JSON.stringify({ ...JSON.parse(row.record_json), arguments: [] })
      : "{"
    database.prepare("UPDATE approval_actions SET record_json = ? WHERE approval_id = ?").run(corrupted, approvalId)
    database.close()
    let runErrorCode: string | null = null
    const corruptedStore = openApprovalStore({ databasePath: approvalDatabasePath })
    try { corruptedStore.read(approvalId) } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? String(error.code) : String(error)
      runErrorCode = scenario.corruptJournalAfterProposal === "non_object_arguments" ? `invalid_arguments:${code}` : code
    } finally { corruptedStore.close() }
    return { ...base, approvalId, originPid, initialOutcome: "suspended", rejectionAt: null, runErrorCode }
  }
  store.close()

  const decisionAtMs = scenario.delayMs ?? 1
  const decisionNow = new Date(Date.parse(RECORDED_AT) + decisionAtMs).toISOString()
  if (scenario.restartBeforeDecision && originPid === process.pid) throw new Error("restart scenario did not exit the origin process")
  const committedPreCallMessages = checkpoints.read(approvalId)?.preCallMessages ?? preCallMessages
  const originProviderMessages = fs.readFileSync(providerLogPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((entry) => entry.kind === "origin")?.messages ?? committedPreCallMessages
  const fixturePath = path.join(root, "worker.json")
  fs.writeFileSync(fixturePath, JSON.stringify({ approvalId, databasePath: approvalDatabasePath, checkpointPath, sessionPath, effectsLogPath, providerLogPath, deliveryLogPath, traceLogPath,
    preCallMessages: committedPreCallMessages, originProviderMessages, decisionNow, currentRevision: scenario.advanceSessionHeadBeforeDecision ? "a".repeat(64) : SUSPENDED_REVISION,
    decisionAtMs, liveSchemaMutation: scenario.liveSchemaMutation, crashAt: scenario.crashAt, handlerMode: scenario.handlerMode,
    decision: { approvalId, decisionToken, decision: scenario.decision ?? "approve", requesterId: "friend-ari", transport: "telegram", transportUserId: "42", transportChatId: "7", transportMessageId: "99", sessionKey: "telegram:chat-7" } }))
  const workerCount = scenario.concurrentDecisionProcesses ?? 1
  const results = await Promise.all(Array.from({ length: workerCount }, () => runWorker(fixturePath)))
  const decisionPids = results.map((result) => result.pid)
  let runErrorCode: string | null = results.find((result) => result.error)?.error ?? null

  const recoveryStore = openApprovalStore({ databasePath: approvalDatabasePath })
  let record = recoveryStore.read(approvalId)
  if (scenario.crashAt === "after_claim" && record?.state === "claimed") {
    record = recoverClaimedApproval({ approvalStore: recoveryStore, approvalId, reason: "worker crashed after claim" })
    append(traceLogPath, { sequence: 90, pid: process.pid, atMs: decisionAtMs + 1, type: "fresh_approval_required" })
    append(deliveryLogPath, { pid: process.pid, kind: "direct", text: "request a fresh approval" })
  }
  if ((scenario.crashAt === "after_attempt" || scenario.crashAt === "after_handler") && record?.state === "attempted") {
    record = recoverAttemptedApproval({ approvalStore: recoveryStore, approvalId })
    let continuationClaim: ReturnType<typeof recoveryStore.claimContinuation>
    await resumeApprovalContinuation({
      record,
      checkpoint: checkpoints.read(approvalId)!,
      currentSessionRevision: SUSPENDED_REVISION,
      sessionMessages: committedPreCallMessages,
      callbacks: {},
      claimContinuation: () => {
        continuationClaim = recoveryStore.claimContinuation({ approvalId, ownerId: `recovery-${process.pid}`, ownerPid: process.pid })
        return continuationClaim
      },
      markContinuationMaterialized: () => recoveryStore.markContinuationMaterialized({ approvalId, ownerId: `recovery-${process.pid}`, epoch: continuationClaim.record.continuationEpoch }),
      markContinuationAttempted: () => recoveryStore.markContinuationAttempted({ approvalId, ownerId: `recovery-${process.pid}`, epoch: continuationClaim.record.continuationEpoch }),
      completeContinuation: () => recoveryStore.completeContinuation({ approvalId, ownerId: `recovery-${process.pid}`, epoch: continuationClaim.record.continuationEpoch }),
      runAgent: async () => { throw new Error("indeterminate approval must not invoke provider") },
      persist: (messages) => writeSession(sessionPath, messages),
      deliver: (text) => append(deliveryLogPath, { pid: process.pid, kind: "indeterminate", text }),
    })
  }
  if (["after_terminal_persist", "after_terminal_pair_persist_before_materialized", "after_materialized_marker_before_continuation_attempt", "after_continuation_attempt"].includes(scenario.crashAt ?? "")) {
    record = recoveryStore.read(approvalId)
    if (!record) throw new Error("terminal recovery lost approval record")
    const envelope = parseSessionEnvelope(JSON.parse(fs.readFileSync(sessionPath, "utf8")))
    if (!envelope) throw new Error("terminal recovery lost canonical session")
    const recoveryMessages = projectProviderMessages(envelope)
    let continuationClaim: ReturnType<typeof recoveryStore.claimContinuation>
    await resumeApprovalContinuation({
      record,
      checkpoint: checkpoints.read(approvalId)!,
      currentSessionRevision: SUSPENDED_REVISION,
      sessionMessages: recoveryMessages,
      callbacks: {},
      claimContinuation: () => {
        continuationClaim = recoveryStore.claimContinuation({ approvalId, ownerId: `terminal-recovery-${process.pid}`, ownerPid: process.pid })
        return continuationClaim
      },
      markContinuationMaterialized: () => recoveryStore.markContinuationMaterialized({ approvalId, ownerId: `terminal-recovery-${process.pid}`, epoch: continuationClaim.record.continuationEpoch }),
      markContinuationAttempted: () => recoveryStore.markContinuationAttempted({ approvalId, ownerId: `terminal-recovery-${process.pid}`, epoch: continuationClaim.record.continuationEpoch }),
      completeContinuation: () => recoveryStore.completeContinuation({ approvalId, ownerId: `terminal-recovery-${process.pid}`, epoch: continuationClaim.record.continuationEpoch }),
      runAgent: async (messages, callbacks) => {
        append(traceLogPath, { sequence: 99, pid: process.pid, atMs: decisionAtMs + 2, type: "continuation_provider_start" })
        const providerMessages = [...originProviderMessages.slice(0, -committedPreCallMessages.length), ...structuredClone(messages)]
        append(providerLogPath, { pid: process.pid, kind: "continuation", invokedBy: "resumeApprovalContinuation", approvalId, messages: providerMessages })
        const text = record!.state === "failed" ? "calibre-web restart failed safely." : "calibre-web is back up"
        callbacks.onTextChunk(text)
        messages.push({ role: "assistant", content: text })
        return { outcome: "settled" }
      },
      persist: (messages) => writeSession(sessionPath, messages),
      deliver: (text) => append(deliveryLogPath, { pid: process.pid, kind: text.includes("indeterminate") ? "indeterminate" : "provider", text }),
    })
    if (scenario.crashAt === "after_continuation_attempt") runErrorCode = null
  }
  recoveryStore.close()

  const providers = fs.readFileSync(providerLogPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  return { ...base, approvalId, originPid, initialOutcome: "suspended", rejectionAt: null, runErrorCode,
    decisionPids: decisionPids.slice(0, workerCount), continuationPids: providers.filter((entry) => entry.kind === "continuation").map((entry) => entry.pid),
    callbackOutcomes: results.map((result) => ({ processPid: result.pid, accepted: result.accepted, reason: result.reason })) }
}
