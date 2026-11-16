import WebSocket from "ws"
import { emitNervesEvent } from "../../nerves/runtime"
import { realSchedule } from "../shepherd/cmux"
import { copilotAppUrl } from "./client"
import { defaultStateDir, type Frame, type OpenSocket } from "./client"
import { readPending, writePending, type PendingRequest } from "./store"

/**
 * The questions and plan approvals the app's sessions are blocked on. The app announces each one once, as a frame to
 * the clients connected at that moment, and never repeats it to a client that connects later, so a client that wants
 * to answer one has to be listening when it is asked. This keeps one observer connection open and records what it
 * hears under the sense's state, where the tools read it.
 */
const RECONNECT_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
const KEEP_MS = 24 * 3_600_000

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined)

/** Apply one frame to the open requests. True when they changed. */
export function applyFrame(pending: Record<string, PendingRequest>, frame: Frame, at: string): boolean {
  const session = text(frame.session_id)
  const requestId = text(frame.request_id)
  if (!session || !requestId) return false
  if (frame.type === "user_input_request") {
    pending[session] = {
      kind: "input", requestId, at, ...(text(frame.question) ? { question: text(frame.question) } : {}),
      ...(Array.isArray(frame.choices) ? { choices: frame.choices.filter((choice): choice is string => typeof choice === "string") } : {}),
      ...(typeof frame.allow_freeform === "boolean" ? { allowFreeform: frame.allow_freeform } : {}),
    }
    return true
  }
  if (frame.type === "exit_plan_mode_request") {
    pending[session] = {
      kind: "plan", requestId, at, ...(text(frame.summary) ? { summary: text(frame.summary) } : {}),
      ...(Array.isArray(frame.actions) ? { actions: frame.actions.filter((action): action is string => typeof action === "string") } : {}),
    }
    return true
  }
  if ((frame.type === "user_input_resolved" || frame.type === "exit_plan_mode_resolved") && pending[session]?.requestId === requestId) {
    delete pending[session]
    return true
  }
  return false
}

export interface PromptTrackerOptions {
  agentRoot: string
  stateDir?: string
  openSocket?: OpenSocket
  schedule?: (fn: () => void, ms: number) => () => void
  now?: () => number
}

export function startPromptTracker(options: PromptTrackerOptions): { stop: () => void } {
  const stateDir = options.stateDir ?? defaultStateDir()
  const openSocket = options.openSocket ?? ((url: string) => new WebSocket(url))
  const schedule = options.schedule ?? realSchedule
  const now = options.now ?? Date.now
  const pending = Object.fromEntries(Object.entries(readPending(options.agentRoot)).filter(([, request]) => now() - Date.parse(request.at) < KEEP_MS))
  let stopped = false
  let attempt = 0
  let socket: WebSocket | null = null
  let cancelRetry: (() => void) | null = null

  const retry = (): void => {
    if (stopped || cancelRetry) return
    cancelRetry = schedule(() => { cancelRetry = null; connect() }, RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)]!)
    attempt += 1
  }
  const connect = (): void => {
    try {
      socket = openSocket(copilotAppUrl(stateDir))
    } catch (error) {
      emitNervesEvent({ level: "warn", component: "senses", event: "senses.app_prompts_unavailable", message: "the Copilot app is not reachable; open questions are not tracked until it is", meta: { error: (error as Error).message } })
      return retry()
    }
    socket.on("open", () => { attempt = 0 })
    socket.on("message", (data) => {
      const raw = String(data)
      if (!/^\{"type":"(user_input_re|exit_plan_mode_re)/.test(raw)) return
      let frame: unknown
      try {
        frame = JSON.parse(raw)
      } catch {
        return
      }
      if (applyFrame(pending, frame as Frame, new Date(now()).toISOString())) writePending(options.agentRoot, pending)
    })
    socket.on("error", () => undefined)
    socket.on("close", retry)
  }
  emitNervesEvent({ component: "senses", event: "senses.app_prompts_start", message: "tracking the Copilot app's open questions" })
  connect()
  return {
    stop: () => {
      stopped = true
      cancelRetry?.()
      socket?.close()
    },
  }
}
