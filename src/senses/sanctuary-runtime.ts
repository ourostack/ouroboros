import * as fs from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"

import { getAgentRoot } from "../heart/identity"
import { readMachineRuntimeCredentialConfig } from "../heart/runtime-credentials"
import { createApprovedUnraidRestartExecutor, type UnraidRestartAttempt } from "../repertoire/unraid-restart"
import { UnraidClient } from "../repertoire/unraid-client"
import { createUnraidReadTools } from "../repertoire/tools-unraid"
import type { ToolContext } from "../repertoire/tools-base"

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

export function createSanctuaryToolContext(agentName: string): Pick<ToolContext, "sanctuary"> {
  const initial = machineConfig(agentName)
  const endpoint = required(initial, "unraidGraphqlUrl")
  const readClient = new UnraidClient({ endpoint, apiKey: required(initial, "unraidReadApiKey") })
  const reads = createUnraidReadTools(readClient)
  const restart = createApprovedUnraidRestartExecutor({
    endpoint,
    listContainers: reads.listContainers,
    loadWriteApiKey: async () => required(machineConfig(agentName), "unraidWriteApiKey"),
    persistAttempt: (attempt) => persistAttempt(
      path.join(getAgentRoot(agentName), "state", "approvals", "unraid-restart-attempt.json"),
      attempt,
    ),
  })
  return {
    sanctuary: {
      listContainers: reads.listContainers,
      getContainerLogs: reads.getContainerLogs,
      getStorage: reads.getStorage,
      getDisks: reads.getDisks,
      getNotifications: reads.getNotifications,
      getSystem: reads.getSystem,
      restartContainer: restart,
    },
  }
}
