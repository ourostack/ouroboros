import * as fs from "node:fs"
import * as path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"

import { getAgentRoot } from "../heart/identity"
import { readMachineRuntimeCredentialConfig } from "../heart/runtime-credentials"
import { createApprovedUnraidRestartExecutor, type UnraidRestartAttempt } from "../repertoire/unraid-restart"
import { UnraidClient } from "../repertoire/unraid-client"
import { createUnraidReadTools } from "../repertoire/tools-unraid"
import type { ToolContext } from "../repertoire/tools-base"
import { emitNervesEvent } from "../nerves/runtime"
import { readSanctuaryAcceptanceApproval, readSanctuaryAcceptanceMarker, sanctuaryAcceptanceEventMeta } from "../heart/daemon/sanctuary-acceptance-marker"
import { projectSanctuaryGrounding, sanctuaryGroundingDigest, type SanctuaryToolGrounding } from "./sanctuary-grounding"

const sanctuaryToolReceipts = new AsyncLocalStorage<string[]>()
const sanctuaryToolGroundings = new AsyncLocalStorage<SanctuaryToolGrounding[]>()
const acceptanceLedgerTails = new Map<string, Promise<void>>()

export interface SanctuaryToolReceiptObserver { toolResultDigests: string[]; toolGroundings?: SanctuaryToolGrounding[] }

export async function runWithSanctuaryToolReceiptCollection<T>(operation: () => Promise<T>, observer?: SanctuaryToolReceiptObserver): Promise<{ result: T; toolResultDigests: string[]; toolGroundings?: SanctuaryToolGrounding[] }> {
  const digests = observer?.toolResultDigests ?? []
  const groundings = observer?.toolGroundings ?? []
  const result = await sanctuaryToolReceipts.run(digests, () => sanctuaryToolGroundings.run(groundings, operation))
  return { result, toolResultDigests: [...digests], ...(groundings.length > 0 ? { toolGroundings: structuredClone(groundings) } : {}) }
}

function collectToolResult(result: unknown, toolName?: string): { resultDigest: string; groundingDigest?: string } {
  const digest = createHash("sha256").update(JSON.stringify(result)).digest("hex")
  sanctuaryToolReceipts.getStore()?.push(digest)
  let facts: Record<string, unknown> | null = null
  try { facts = toolName ? projectSanctuaryGrounding(toolName, result) : null } catch { /* validated tool adapters own malformed-result failure */ }
  if (!facts || (toolName !== "unraid_get_system" && toolName !== "unraid_get_storage")) return { resultDigest: digest }
  const groundingDigest = sanctuaryGroundingDigest(facts)
  sanctuaryToolGroundings.getStore()?.push({ toolName, resultDigest: digest, groundingDigest, facts })
  return { resultDigest: digest, groundingDigest }
}

function machineConfig(agentName: string): Record<string, unknown> {
  const result = readMachineRuntimeCredentialConfig(agentName)
  if (!result.ok) throw new Error(`Sanctuary machine runtime config is ${result.reason}`)
  return result.config
}

function required(config: Record<string, unknown>, field: string): string {
  const value = config[field]
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`Sanctuary ${field} is missing`)
  return value.trim()
}

function persistAttempt(filePath: string, attempt: UnraidRestartAttempt): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  fs.writeFileSync(temporary, `${JSON.stringify(attempt)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, filePath)
}

async function appendAcceptanceAttempt(agentName: string, attempt: UnraidRestartAttempt): Promise<void> {
  if (!attempt.scenarioHandleDigest) return
  const filePath = path.join(getAgentRoot(agentName), "state", "acceptance", "restart-attempts.ndjson")
  const previous = acceptanceLedgerTails.get(filePath) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(() => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
    let existing: string[] = []
    try {
      if (fs.statSync(filePath).size > 4 * 1024 * 1024) throw new Error("restart ledger exceeds its bound")
      existing = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean)
      if (existing.length > 500 || existing.some((line) => Buffer.byteLength(line) > 8 * 1024)) throw new Error("restart ledger rows exceed their bound")
      for (const line of existing) {
        const value = JSON.parse(line) as Partial<UnraidRestartAttempt>
        if (!value || typeof value !== "object" || !value.container || typeof value.container.id !== "string" || !value.container.id || value.container.id.length > 128
          || typeof value.container.name !== "string" || !value.container.name || value.container.name.length > 128
          || !["attempt_not_started", "attempting", "succeeded", "attempted_or_indeterminate"].includes(String(value.state))
          || typeof value.observedAt !== "string" || !Number.isFinite(Date.parse(value.observedAt)) || new Date(Date.parse(value.observedAt)).toISOString() !== value.observedAt
          || !/^[0-9a-f]{64}$/u.test(String(value.actionDigest)) || !/^[0-9a-f]{64}$/u.test(String(value.argumentDigest))
          || !/^[0-9a-f]{64}$/u.test(String(value.scenarioHandleDigest)) || typeof value.approvalId !== "string" || !value.approvalId || value.approvalId.length > 128
          || typeof value.attemptId !== "string" || !value.attemptId || value.attemptId.length > 128 || typeof value.mutationAcknowledged !== "boolean"
          || (value.afterState !== null && (typeof value.afterState !== "string" || value.afterState.length > 64))) throw new Error("restart ledger row is invalid")
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Sanctuary acceptance restart ledger is corrupt", { cause: error })
    }
    const entries = [...existing, JSON.stringify(attempt)].slice(-500)
    const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
    fs.writeFileSync(temporary, `${entries.join("\n")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
    const handle = fs.openSync(temporary, "r")
    try { fs.fsyncSync(handle) } finally { fs.closeSync(handle) }
    fs.renameSync(temporary, filePath)
    fs.chmodSync(filePath, 0o600)
    const directory = fs.openSync(path.dirname(filePath), "r")
    try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
  })
  acceptanceLedgerTails.set(filePath, current)
  try { await current } finally { if (acceptanceLedgerTails.get(filePath) === current) acceptanceLedgerTails.delete(filePath) }
}

export function createSanctuaryToolContext(agentName: string): Pick<ToolContext, "sanctuary"> {
  emitNervesEvent({
    component: "senses",
    event: "senses.sanctuary_runtime_create",
    message: "creating typed Sanctuary tool context",
    meta: { agentName },
  })
  const initial = machineConfig(agentName)
  const endpoint = required(initial, "unraidGraphqlUrl")
  const readClient = new UnraidClient({ endpoint, apiKey: required(initial, "unraidReadApiKey") })
  const reads = createUnraidReadTools(readClient)
  const acceptanceRead = <TArgs extends unknown[], TResult>(toolName: string, read: (...args: TArgs) => Promise<TResult>) => async (...args: TArgs): Promise<TResult> => {
    try {
      const result = await read(...args)
      const receipt = collectToolResult(result, toolName)
      emitNervesEvent({ component: "senses", event: "senses.sanctuary_read_receipt", message: "Sanctuary live read completed", meta: { toolName, success: true, ...receipt, ...sanctuaryAcceptanceEventMeta(agentName) } })
      return result
    } catch (error) {
      emitNervesEvent({ level: "error", component: "senses", event: "senses.sanctuary_read_receipt_error", message: "Sanctuary live read failed", meta: { toolName, success: false, category: error instanceof Error ? error.name : "unknown", ...sanctuaryAcceptanceEventMeta(agentName) } })
      throw error
    }
  }
  const restart = createApprovedUnraidRestartExecutor({
    endpoint,
    listContainers: reads.listContainers,
    loadWriteApiKey: async () => required(machineConfig(agentName), "unraidWriteApiKey"),
    persistAttempt: async (attempt) => {
      persistAttempt(path.join(getAgentRoot(agentName), "state", "approvals", "unraid-restart-attempt.json"), attempt)
      await appendAcceptanceAttempt(agentName, attempt)
    },
    acceptanceScenarioHandleDigest: () => readSanctuaryAcceptanceMarker(agentName)?.scenarioHandleDigest,
    acceptanceApproval: readSanctuaryAcceptanceApproval,
  })
  return {
    sanctuary: {
      listContainers: acceptanceRead("unraid_list_containers", reads.listContainers),
      getContainerLogs: acceptanceRead("unraid_get_container_logs", reads.getContainerLogs),
      getStorage: acceptanceRead("unraid_get_storage", reads.getStorage),
      getDisks: acceptanceRead("unraid_get_disks", reads.getDisks),
      getNotifications: acceptanceRead("unraid_get_notifications", reads.getNotifications),
      getSystem: acceptanceRead("unraid_get_system", reads.getSystem),
      restartContainer: async (args) => {
        const result = await restart(args)
        collectToolResult(result)
        return result
      },
    },
  }
}
