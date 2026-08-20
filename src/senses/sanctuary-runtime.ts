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

const sanctuaryToolReceipts = new AsyncLocalStorage<string[]>()

export async function runWithSanctuaryToolReceiptCollection<T>(operation: () => Promise<T>): Promise<{ result: T; toolResultDigests: string[] }> {
  const digests: string[] = []
  const result = await sanctuaryToolReceipts.run(digests, operation)
  return { result, toolResultDigests: [...digests] }
}

function collectToolResult(result: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(result)).digest("hex")
  sanctuaryToolReceipts.getStore()?.push(digest)
  return digest
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

function appendAcceptanceAttempt(agentName: string, attempt: UnraidRestartAttempt): void {
  if (!attempt.scenarioHandleDigest) return
  const filePath = path.join(getAgentRoot(agentName), "state", "acceptance", "restart-attempts.ndjson")
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  let existing: string[] = []
  try { existing = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  const entries = [...existing, JSON.stringify(attempt)].slice(-500)
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`
  fs.writeFileSync(temporary, `${entries.join("\n")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
  fs.renameSync(temporary, filePath)
  fs.chmodSync(filePath, 0o600)
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
      emitNervesEvent({ component: "senses", event: "senses.sanctuary_read_receipt", message: "Sanctuary live read completed", meta: { toolName, success: true, resultDigest: collectToolResult(result), ...sanctuaryAcceptanceEventMeta(agentName) } })
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
    persistAttempt: (attempt) => {
      persistAttempt(path.join(getAgentRoot(agentName), "state", "approvals", "unraid-restart-attempt.json"), attempt)
      appendAcceptanceAttempt(agentName, attempt)
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
