import { emitNervesEvent } from "../../nerves/runtime"
import { loadConfig } from "../../heart/config"
import { getAgentName } from "../../heart/identity"
import { CodingSessionManager } from "./manager"
import { WorkbenchCodingSessionManager } from "./workbench-manager"
import { WorkbenchMcpClient } from "./workbench-client"
import type { CodingSessionManagerApi } from "./types"
import { reportCodingSessionUpdate } from "./feedback"

let manager: CodingSessionManagerApi | null = null

export function getCodingSessionManager(): CodingSessionManagerApi {
  if (!manager) {
    const config = loadConfig()
    const backend = config.features.workbenchCoding ? "workbench" : "process"
    // Every session this manager runs reports to the agent when it finishes, fails, stops or needs input, whatever
    // chat started it. The listener lives on the manager, not on each coding_spawn call, so it also hears sessions
    // found dead when the manager reloads after a restart, and Workbench sessions it picks up again.
    if (config.features.workbenchCoding) {
      const workbench = new WorkbenchCodingSessionManager({ agentName: getAgentName(), client: new WorkbenchMcpClient(), onUpdate: reportCodingSessionUpdate })
      void workbench.watch()
      manager = workbench
    } else {
      manager = new CodingSessionManager({ onUpdate: reportCodingSessionUpdate })
    }
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
export { attachCodingSessionFeedback, formatCodingTail, reportCodingSessionUpdate } from "./feedback"
