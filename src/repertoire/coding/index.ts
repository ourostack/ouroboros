import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentName, loadAgentConfig } from "../../heart/identity"
import { CodingSessionManager } from "./manager"
import { OrcaCodingSessionManager } from "./orca-manager"
import { WorkbenchCodingSessionManager } from "./workbench-manager"
import { WorkbenchMcpClient } from "./workbench-client"
import { CODING_BACKENDS, CodingSessionRouter } from "./router"
import type { CodingBackend, CodingSessionManagerApi } from "./types"
import { reportCodingSessionUpdate } from "./feedback"

/** Ouro's current choice for where coding agents run when agent.json names none. */
export const DEFAULT_CODING_BACKEND: CodingBackend = "orca"

let manager: CodingSessionRouter | null = null

/** The agent's preferred coding backend: agent.json `coding.backend`, else orca. An unknown value is an error, never a quiet default. */
export function preferredCodingBackend(): CodingBackend {
  const configured: unknown = loadAgentConfig().coding?.backend
  if (configured === undefined) return DEFAULT_CODING_BACKEND
  if (CODING_BACKENDS.includes(configured as CodingBackend)) return configured as CodingBackend
  throw new Error(`agent.json coding.backend is ${JSON.stringify(configured)}; use one of ${CODING_BACKENDS.join(", ")} (or remove it for ${DEFAULT_CODING_BACKEND})`)
}

/**
 * Every session a backend runs reports to the agent when it finishes, fails, stops or needs input, whatever chat
 * started it. The listener lives on the backend's manager, not on each coding_spawn call, so it also hears sessions
 * the manager restores after a restart (found dead locally, or still open in Orca or Workbench).
 */
export function createBackendManager(backend: CodingBackend, agentName: string): CodingSessionManagerApi {
  switch (backend) {
    case "orca":
      return new OrcaCodingSessionManager({ agentName, onUpdate: reportCodingSessionUpdate })
    case "workbench": {
      const workbench = new WorkbenchCodingSessionManager({ agentName, client: new WorkbenchMcpClient(), onUpdate: reportCodingSessionUpdate })
      void workbench.watch()
      return workbench
    }
    case "local":
      return new CodingSessionManager({ agentName, onUpdate: reportCodingSessionUpdate })
  }
}

export function getCodingSessionManager(): CodingSessionRouter {
  if (!manager) {
    const agentName = getAgentName()
    const preferredBackend = preferredCodingBackend()
    // Local and Orca sessions restore from files under the bundle, so they are read at start;
    // Workbench is only reached when it is preferred or a spawn names it.
    const eagerBackends = [...new Set<CodingBackend>(["local", "orca", preferredBackend])]
    manager = new CodingSessionRouter({
      preferredBackend,
      eagerBackends,
      createManager: (backend) => createBackendManager(backend, agentName),
    })
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_manager_init",
      message: "initialized coding session manager singleton",
      meta: { preferredBackend },
    })
  }
  return manager
}

export function resetCodingSessionManager(): void {
  manager?.shutdown()
  manager = null
  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.coding_manager_reset",
    message: "reset coding session manager singleton",
    meta: {},
  })
}

export { CodingSessionManager } from "./manager"
export { WorkbenchCodingSessionManager } from "./workbench-manager"
export { WorkbenchMcpClient } from "./workbench-client"
export { OrcaCodingSessionManager } from "./orca-manager"
export { OrcaCli } from "./orca-client"
export { CodingSessionRouter } from "./router"
export type {
  CodingActionResult,
  CodingBackend,
  CodingFailureDiagnostics,
  CodingRunner,
  CodingSession,
  CodingSessionManagerApi,
  CodingSessionRequest,
  CodingSessionStatus,
  RefreshableCodingSessionManagerApi,
} from "./types"
export { CodingSessionMonitor } from "./monitor"
export type { CodingMonitorReport, CodingMonitorSummary, CodingRecoveryAction, CodingRecoveryActionType } from "./monitor"
export { formatCodingMonitorReport } from "./reporter"
export { attachCodingSessionFeedback, formatCodingTail, reportCodingSessionUpdate } from "./feedback"
