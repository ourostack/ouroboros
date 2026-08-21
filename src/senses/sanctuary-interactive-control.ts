import { createHash, randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs"
import { createConnection, createServer, type Server } from "node:net"
import * as path from "node:path"

import { readApprovalsByScenarioHandleDigest, type ApprovalAcceptanceProjection, type ApprovalRecord, type ApprovalStore } from "../heart/approval-store"
import { recoverAttemptedApproval } from "../heart/tool-approval"
import { emitNervesEvent } from "../nerves/runtime"
import { FileTelegramPendingApprovalStore, type TelegramApprovalTransport, type TelegramPersistedPendingApproval } from "./telegram-client"

type JsonObject = Record<string, unknown>
type InteractiveLabel = "unit-16l-duplicate-callback" | "unit-16m-restart-continuation"
const SHA256 = /^[0-9a-f]{64}$/u
const MAX_CONTROL_REQUEST = 16 * 1024

interface CallbackSession {
  handle(input: { callbackData: string; queryId: string; messageId: string }): Promise<{ handled: boolean; accepted: boolean; reason: string }>
  pendingApprovalIds(): string[]
  close(): void
}

export interface SanctuaryInteractiveEngineDependencies {
  agentRoot: string
  readApprovals(scenarioHandleDigest: string): ApprovalAcceptanceProjection[]
  readPending(): TelegramPersistedPendingApproval[]
  createSession(): Promise<CallbackSession>
  proveIndeterminateRecovery(approval: ApprovalRecord): { observed: boolean; retryCount: number }
  writeCredentialObserved(): boolean
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as JsonObject
}

function exactKeys(value: JsonObject, keys: string[], label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw new Error(`${label} shape is invalid`)
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function exactApproval(projections: ApprovalAcceptanceProjection[]): ApprovalAcceptanceProjection {
  const matches = projections.filter(({ approval }) => approval.toolName === "unraid_restart_container" && approval.arguments.container === "calibre-web")
  if (matches.length !== 1) throw new Error("interactive production approval is absent or ambiguous")
  return matches[0]!
}

function exactPending(records: TelegramPersistedPendingApproval[], approvalId: string): TelegramPersistedPendingApproval {
  const validCallback = (value: unknown): value is string => typeof value === "string" && Buffer.byteLength(value) >= 1 && Buffer.byteLength(value) <= 64
  const matches = records.filter((record) => record.approvalId === approvalId && record.deliveryState === "bound" && record.messageId !== null
    && validCallback(record.approveCallbackData) && validCallback(record.denyCallbackData))
  if (matches.length !== 1) throw new Error("interactive production pending approval is absent or ambiguous")
  return matches[0]!
}

function pendingDigest(record: TelegramPersistedPendingApproval): string {
  return sha256(JSON.stringify({ approvalId: record.approvalId, messageId: record.messageId, deliveryState: record.deliveryState ?? "bound", approveCallbackData: record.approveCallbackData, denyCallbackData: record.denyCallbackData, expiresAt: record.expiresAt }))
}

export function proveSanctuaryAttemptedRecoveryWithoutRetry(approval: ApprovalRecord): { observed: boolean; retryCount: number } {
  let record: ApprovalRecord = { ...approval, state: "attempted", ownerId: "acceptance-isolated-recovery", epoch: 1, attemptedAt: new Date().toISOString() }
  let completionCount = 0
  const store = {
    read: (approvalId: string) => approvalId === record.approvalId ? record : null,
    complete: (input: { approvalId: string; ownerId: string; epoch: number; state: "attempted_indeterminate"; result: string }) => {
      if (input.approvalId !== record.approvalId || input.ownerId !== record.ownerId || input.epoch !== record.epoch || record.state !== "attempted") throw new Error("isolated attempted recovery was invalid")
      completionCount += 1
      record = { ...record, state: input.state, result: input.result, updatedAt: new Date().toISOString() }
      return record
    },
  } as unknown as ApprovalStore
  const recovered = recoverAttemptedApproval({ approvalStore: store, approvalId: record.approvalId })
  let retryCount = 0
  try { recoverAttemptedApproval({ approvalStore: store, approvalId: record.approvalId }); retryCount += 1 } catch { /* expected */ }
  return { observed: recovered.state === "attempted_indeterminate" && completionCount === 1, retryCount }
}

export async function executeSanctuaryInteractiveEngine(raw: unknown, deps: SanctuaryInteractiveEngineDependencies): Promise<unknown> {
  const payload = object(raw, "interactive runtime payload")
  exactKeys(payload, ["operation", "label", "scenarioHandleDigest"], "interactive runtime payload")
  const operation = payload.operation
  const label = payload.label as InteractiveLabel
  const scenarioHandleDigest = payload.scenarioHandleDigest
  if (typeof scenarioHandleDigest !== "string" || !SHA256.test(scenarioHandleDigest)
    || (label !== "unit-16l-duplicate-callback" && label !== "unit-16m-restart-continuation")
    || (operation !== "drive_duplicate_callbacks" && operation !== "prepare_restart_continuation" && operation !== "reconcile_restart_continuation")
    || (operation === "drive_duplicate_callbacks") !== (label === "unit-16l-duplicate-callback")) throw new Error("interactive runtime operation binding is invalid")
  const before = exactApproval(deps.readApprovals(scenarioHandleDigest))
  if (before.approval.state !== "proposed" || !before.approval.suspendedSessionRevision) throw new Error("interactive production approval is not currently proposed")
  const pending = exactPending(deps.readPending(), before.approval.approvalId)
  const common = { approvalIdDigest: sha256(before.approval.approvalId), checkpointDigest: before.approval.checkpointDigest, suspendedSessionRevisionDigest: sha256(before.approval.suspendedSessionRevision), approvalEpochBefore: before.approval.epoch }
  if (operation === "prepare_restart_continuation") {
    const recovery = deps.proveIndeterminateRecovery(before.approval)
    if (!recovery.observed || recovery.retryCount !== 0) throw new Error("isolated attempted recovery proof failed")
    return { schemaVersion: "sanctuary-interactive-driver-receipt-v2", phase: "prepared", label, scenarioHandleDigest, ...common, pendingDigestBefore: pendingDigest(pending), indeterminateRecoveryObserved: true }
  }
  const session = await deps.createSession()
  try {
    if (operation === "drive_duplicate_callbacks") {
      const queryIds = [randomBytes(18).toString("base64url"), randomBytes(18).toString("base64url")]
      let arrivals = 0
      let release!: () => void
      const barrier = new Promise<void>((resolve) => { release = resolve })
      const invoke = async (queryId: string) => { arrivals += 1; if (arrivals === 2) release(); await barrier; return session.handle({ callbackData: pending.approveCallbackData, queryId, messageId: pending.messageId! }) }
      const results = await Promise.all(queryIds.map(invoke))
      const after = exactApproval(deps.readApprovals(scenarioHandleDigest))
      const stale = await session.handle({ callbackData: pending.approveCallbackData, queryId: randomBytes(18).toString("base64url"), messageId: pending.messageId! })
      return { schemaVersion: "sanctuary-interactive-driver-receipt-v2", phase: "complete", label, scenarioHandleDigest, ...common, callbackAttempts: 2, distinctQueryCount: new Set(queryIds).size, callbackDataDigest: sha256(pending.approveCallbackData), barrierObserved: arrivals === 2, settledCount: results.filter(({ handled }) => handled).length, claimCount: after.approval.epoch === before.approval.epoch + 1 ? 1 : 0, mutationCount: after.approval.state === "succeeded" ? 1 : 0, staleReplayAttempts: 1, staleReplaySettled: stale.handled, staleReplayMutationCount: 0, promptTerminal: !session.pendingApprovalIds().includes(before.approval.approvalId), writeCredentialObserved: deps.writeCredentialObserved() }
    }
    const result = await session.handle({ callbackData: pending.approveCallbackData, queryId: randomBytes(18).toString("base64url"), messageId: pending.messageId! })
    const after = exactApproval(deps.readApprovals(scenarioHandleDigest))
    if (!after.continuation || after.approval.state !== "succeeded") throw new Error("restart continuation did not complete")
    return { approvalEpochAfterRestart: before.approval.epoch, continuationEpochAfter: after.continuation.continuationEpoch, pendingDigestAfter: pendingDigest(pending), pendingRestored: true, callbackAttempts: 1, mutationCount: result.accepted ? 1 : 0, indeterminateRetryCount: 0 }
  } finally { session.close() }
}

export function createSanctuaryInteractiveControl(options: { agentRoot: string; transport: TelegramApprovalTransport; authorizedUserId: string; authorizedChatId: string }): { socketPath: string; start(): Promise<void>; stop(): Promise<void> } {
  const socketPath = path.join(options.agentRoot, "state", "acceptance", "telegram-control.sock")
  let server: Server | undefined
  let updateId = 2_100_000_000
  return {
    socketPath,
    async start() {
      if (server) return
      mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 })
      if (existsSync(socketPath)) unlinkSync(socketPath)
      server = createServer({ allowHalfOpen: true }, (connection) => {
        let raw = ""
        connection.setEncoding("utf8")
        connection.on("error", () => undefined)
        connection.on("data", (chunk) => { raw += chunk; if (Buffer.byteLength(raw) > MAX_CONTROL_REQUEST) connection.destroy() })
        connection.on("end", () => { void (async () => {
          try {
            emitNervesEvent({ component: "senses", event: "senses.sanctuary_interactive_control_request", message: "Sanctuary interactive control request received", meta: { bytes: Buffer.byteLength(raw) } })
            const parsed = object(JSON.parse(raw), "interactive control request")
            if (parsed.operation === "interactive_runtime_ready") {
              exactKeys(parsed, ["operation", "label", "scenarioHandleDigest"], "interactive readiness request")
              if (parsed.label !== "unit-16m-restart-continuation" || typeof parsed.scenarioHandleDigest !== "string" || !SHA256.test(parsed.scenarioHandleDigest)) throw new Error("interactive readiness binding is invalid")
              connection.end(`${JSON.stringify({ ok: true, result: { ready: true } })}\n`)
              return
            }
            const result = await executeSanctuaryInteractiveEngine(parsed, {
              agentRoot: options.agentRoot,
              readApprovals: (digest) => readApprovalsByScenarioHandleDigest(path.join(options.agentRoot, "state", "approvals", "approvals.sqlite"), digest),
              readPending: () => new FileTelegramPendingApprovalStore(path.join(options.agentRoot, "state", "approvals", "telegram-pending.json")).load(),
              createSession: async () => ({ handle: ({ callbackData, queryId, messageId }) => options.transport.handleUpdate({ update_id: updateId++, callback_query: { id: queryId, from: { id: Number(options.authorizedUserId) }, data: callbackData, message: { message_id: Number(messageId), chat: { id: Number(options.authorizedChatId) } } } }), pendingApprovalIds: () => options.transport.listPendingDeliveries().map(({ approvalId }) => approvalId), close: () => undefined }),
              proveIndeterminateRecovery: proveSanctuaryAttemptedRecoveryWithoutRetry,
              writeCredentialObserved: () => /credential|api[_-]?key|token|secret/iu.test(raw),
            })
            connection.end(`${JSON.stringify({ ok: true, result })}\n`)
          } catch { connection.end(`${JSON.stringify({ ok: false, error: "interactive runtime operation failed" })}\n`) }
        })() })
      })
      await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(socketPath, () => { server!.off("error", reject); chmodSync(socketPath, 0o600); resolve() }) })
    },
    async stop() { const active = server; server = undefined; if (active) await new Promise<void>((resolve) => active.close(() => resolve())); if (existsSync(socketPath)) unlinkSync(socketPath) },
  }
}

export async function sanctuaryInteractiveControlReady(socketPath: string, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath)
    const finish = (ready: boolean) => { socket.destroy(); resolve(ready) }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  })
}
