import { emitNervesEvent } from "../../nerves/runtime"
import { loadConfig } from "../../heart/config"
import { getAgentName } from "../../heart/identity"
import { CodingSessionManager } from "./manager"
import { WorkbenchCodingSessionManager } from "./workbench-manager"
import type { CodingSessionManagerApi } from "./types"

let manager: CodingSessionManagerApi | null = null

export function getCodingSessionManager(): CodingSessionManagerApi {
  if (!manager) {
    const config = loadConfig()
    const backend = config.features.workbenchCoding ? "workbench" : "process"
    manager = config.features.workbenchCoding
      ? new WorkbenchCodingSessionManager({ agentName: getAgentName() })
      : new CodingSessionManager({})
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_manager_init",
      message: "initialized coding session manager singleton",
      meta: { backend },
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
export type {
  CodingActionResult,
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
export { attachCodingSessionFeedback, formatCodingTail } from "./feedback"
