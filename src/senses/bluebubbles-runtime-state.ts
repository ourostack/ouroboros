import * as fs from "node:fs"
import * as path from "node:path"
import { getAgentRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"

export interface BlueBubblesRuntimeState {
  upstreamStatus: "unknown" | "ok" | "error"
  detail: string
  lastCheckedAt?: string
  pendingRecoveryCount: number
  lastRecoveredAt?: string
  lastRecoveredMessageGuid?: string
}

const DEFAULT_RUNTIME_STATE: BlueBubblesRuntimeState = {
  upstreamStatus: "unknown",
  detail: "startup health probe pending",
  pendingRecoveryCount: 0,
}

export function getBlueBubblesRuntimeStatePath(agentName: string, agentRoot = getAgentRoot(agentName)): string {
  return path.join(
    agentRoot,
    "state",
    "senses",
    "bluebubbles",
    "runtime.json",
  )
}

export function readBlueBubblesRuntimeState(agentName: string, agentRoot?: string): BlueBubblesRuntimeState {
  const filePath = getBlueBubblesRuntimeStatePath(agentName, agentRoot)
  try {
    const raw = fs.readFileSync(filePath, "utf-8")
    const parsed = JSON.parse(raw) as Partial<BlueBubblesRuntimeState>
    return {
      upstreamStatus: parsed.upstreamStatus === "ok" || parsed.upstreamStatus === "error"
        ? parsed.upstreamStatus
        : "unknown",
      detail: typeof parsed.detail === "string" && parsed.detail.trim()
        ? parsed.detail
        : DEFAULT_RUNTIME_STATE.detail,
      lastCheckedAt: typeof parsed.lastCheckedAt === "string" ? parsed.lastCheckedAt : undefined,
      pendingRecoveryCount: typeof parsed.pendingRecoveryCount === "number" && Number.isFinite(parsed.pendingRecoveryCount)
        ? parsed.pendingRecoveryCount
        : 0,
      lastRecoveredAt: typeof parsed.lastRecoveredAt === "string" ? parsed.lastRecoveredAt : undefined,
      lastRecoveredMessageGuid: typeof parsed.lastRecoveredMessageGuid === "string"
        ? parsed.lastRecoveredMessageGuid
        : undefined,
    }
  } catch {
    return { ...DEFAULT_RUNTIME_STATE }
  }
}

export function writeBlueBubblesRuntimeState(agentName: string, state: BlueBubblesRuntimeState, agentRoot?: string): string {
  const filePath = getBlueBubblesRuntimeStatePath(agentName, agentRoot)
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + "\n", "utf-8")
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.bluebubbles_runtime_state_error",
      message: "failed to write bluebubbles runtime state",
      meta: {
        agentName,
        upstreamStatus: state.upstreamStatus,
        reason: error instanceof Error ? error.message : String(error),
      },
    })
    return filePath
  }

  emitNervesEvent({
    component: "senses",
    event: "senses.bluebubbles_runtime_state_written",
    message: "wrote bluebubbles runtime state",
    meta: {
      agentName,
      upstreamStatus: state.upstreamStatus,
      pendingRecoveryCount: state.pendingRecoveryCount,
      path: filePath,
    },
  })

  return filePath
}
