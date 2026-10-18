import * as path from "node:path"
import * as fs from "node:fs"
import { getAgentBundlesRoot } from "../../heart/identity"
import { readMachineRuntimeCredentialConfig } from "../../heart/runtime-credentials"
import { resolveShepherdConnection } from "../../heart/shepherd-config"
import type { DaemonResponse } from "../../heart/daemon/daemon"
import type { ShepherdOperationDeps } from "./operations"
import { createShepherdHost } from "./host"
import { localShepherdFriendStore, resolveExistingLocalOwner } from "./surface"

export function createDefaultShepherdOperationDeps(lifecycle: (agent: string) => Promise<DaemonResponse>): ShepherdOperationDeps {
  return {
    agentRoot: agent => path.join(getAgentBundlesRoot(), `${agent}.ouro`),
    resolveOwner: async agent => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agent)) throw new Error("existing local owner requires a safe agent name")
      const root = path.join(getAgentBundlesRoot(), `${agent}.ouro`)
      if (!fs.lstatSync(root, { throwIfNoEntry: false })?.isDirectory()
        || !fs.lstatSync(path.join(root, "friends"), { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error("existing local owner linking is required; no bundle or friends directory was created")
      }
      return { actorId: await resolveExistingLocalOwner(localShepherdFriendStore(agent)) }
    },
    host: async agent => {
      const machine = readMachineRuntimeCredentialConfig(agent)
      if (!machine.ok) throw new Error("machine Shepherd connection configuration is unavailable")
      const connection = resolveShepherdConnection(agent, machine.config)
      if (!connection.ok) throw new Error(connection.error)
      return createShepherdHost(connection.connection, { agentName: agent })
    },
    senseStopped: async agent => {
      const response = await lifecycle(agent)
      if (!response.ok) throw new Error(response.error ?? "daemon lifecycle unavailable")
      const value: unknown = response.data
      if (value === null || typeof value !== "object" || !("kind" in value) || value.kind !== "daemon_lifecycle"
        || !("enabled" in value) || value.enabled !== false || !("processState" in value) || value.processState !== "stopped"
        || !("checkedAt" in value) || typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt))
        || Date.parse(value.checkedAt) > Date.now() || Date.now() - Date.parse(value.checkedAt) > 30_000) {
        throw new Error("fresh disabled and stopped daemon lifecycle proof is unavailable")
      }
      return { kind: "daemon_lifecycle", enabled: false, processState: "stopped", checkedAt: value.checkedAt }
    },
  }
}
