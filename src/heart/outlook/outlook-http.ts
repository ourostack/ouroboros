import * as http from "http"
import type { AddressInfo } from "net"
import { emitNervesEvent } from "../../nerves/runtime"
import { readOutlookAgentState, readOutlookMachineState } from "./outlook-read"
import { createOutlookHttpReadHooks } from "./outlook-http-hooks"
import { createOutlookHttpRequestHandler } from "./outlook-http-routes"
import { createBundleWatcher, createSseBroadcaster, createStateChangedBroadcast } from "./outlook-http-transport"
import type {
  OutlookAgentState,
  OutlookAgentView,
  OutlookAttentionView,
  OutlookBridgeInventory,
  OutlookCodingDeep,
  OutlookChangesView,
  OutlookContinuityView,
  OutlookDaemonHealthDeep,
  OutlookNoteDecisionView,
  OutlookObligationDetailView,
  OutlookOrientationView,
  OutlookSelfFixView,
  OutlookFriendView,
  OutlookHabitView,
  OutlookLogView,
  OutlookMachineState,
  OutlookMachineView,
  OutlookNotesView,
  OutlookSessionInventory,
  OutlookSessionTranscript,
} from "./outlook-types"

export interface StartOutlookHttpServerOptions {
  host?: string
  port?: number
  bundlesRoot?: string
  healthPath?: string
  logPath?: string | null
  readMachineState?: () => OutlookMachineState
  readMachineView?: (input: { origin: string; machine: OutlookMachineState }) => OutlookMachineView
  readAgentState?: (agentName: string) => OutlookAgentState | null
  readAgentView?: (agentName: string) => OutlookAgentView | null
  readAgentSessions?: (agentName: string) => OutlookSessionInventory
  readAgentTranscript?: (agentName: string, friendId: string, channel: string, key: string) => OutlookSessionTranscript | null
  readAgentCoding?: (agentName: string) => OutlookCodingDeep
  readAgentAttention?: (agentName: string) => OutlookAttentionView
  readAgentBridges?: (agentName: string) => OutlookBridgeInventory
  readAgentNotes?: (agentName: string) => OutlookNotesView
  readAgentFriends?: (agentName: string) => OutlookFriendView
  readAgentContinuity?: (agentName: string) => OutlookContinuityView
  readAgentOrientation?: (agentName: string) => OutlookOrientationView
  readAgentObligations?: (agentName: string) => OutlookObligationDetailView
  readAgentChanges?: (agentName: string) => OutlookChangesView
  readAgentSelfFix?: (agentName: string) => OutlookSelfFixView
  readAgentNoteDecisions?: (agentName: string) => OutlookNoteDecisionView
  readAgentHabits?: (agentName: string) => OutlookHabitView
  readDaemonHealth?: () => OutlookDaemonHealthDeep | null
  readLogs?: () => OutlookLogView
}

export interface OutlookHttpServerHandle {
  origin: string
  broadcast(event: string, data?: Record<string, unknown>): void
  stop(): Promise<void>
}

export async function startOutlookHttpServer(options: StartOutlookHttpServerOptions = {}): Promise<OutlookHttpServerHandle> {
  const host = options.host ?? "127.0.0.1"
  const port = options.port ?? 0
  const bundlesRoot = options.bundlesRoot
  const opts = bundlesRoot ? { bundlesRoot } : undefined
  const readMachineState = options.readMachineState ?? (() => readOutlookMachineState(opts))
  const readMachineView = options.readMachineView
  const readAgentState = options.readAgentState ?? ((agentName: string) => {
    if (opts) return readOutlookAgentState(agentName, opts)
    return readOutlookAgentState(agentName)
  })
  const readAgentView = options.readAgentView
  const hooks = createOutlookHttpReadHooks(options)
  const sse = createSseBroadcaster()
  const bundleWatcher = bundlesRoot ? createBundleWatcher(bundlesRoot, createStateChangedBroadcast(sse)) : null

  let server!: http.Server
  server = http.createServer(createOutlookHttpRequestHandler({
    host,
    getPort: () => (server.address() as AddressInfo).port,
    readMachineState,
    readMachineView,
    readAgentState,
    readAgentView,
    hooks,
    sse,
  }))

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => resolve())
  })

  const address = server.address() as AddressInfo
  const origin = `http://${host}:${address.port}`

  emitNervesEvent({
    component: "daemon",
    event: "daemon.outlook_http_started",
    message: "started Outlook HTTP server",
    meta: { origin },
  })

  return {
    origin,
    broadcast(event: string, data?: Record<string, unknown>): void {
      sse.broadcast(event, data)
    },
    async stop(): Promise<void> {
      bundleWatcher?.stop()
      sse.disconnectAll()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      emitNervesEvent({
        component: "daemon",
        event: "daemon.outlook_http_stopped",
        message: "stopped Outlook HTTP server",
        meta: { origin },
      })
    },
  }
}
