import * as http from "http"
import type { AddressInfo } from "net"
import { emitNervesEvent } from "../../nerves/runtime"
import { readMailboxAgentState, readMailboxMachineState } from "./mailbox-read"
import { createMailboxHttpReadHooks } from "./mailbox-http-hooks"
import { createMailboxHttpRequestHandler } from "./mailbox-http-routes"
import { createBundleWatcher, createSseBroadcaster, createStateChangedBroadcast } from "./mailbox-http-transport"
import type {
  MailboxAgentState,
  MailboxAgentView,
  MailboxAttentionView,
  MailboxBridgeInventory,
  MailboxCodingDeep,
  MailboxChangesView,
  MailboxContinuityView,
  MailboxDaemonHealthDeep,
  MailboxNoteDecisionView,
  MailboxObligationDetailView,
  MailboxOrientationView,
  MailboxSelfFixView,
  MailboxFriendView,
  MailboxHabitView,
  MailboxLogView,
  MailboxMailMessageView,
  MailboxMailView,
  MailboxMachineState,
  MailboxMachineView,
  MailboxNotesView,
  MailboxSessionInventory,
  MailboxSessionTranscript,
} from "./mailbox-types"

export interface StartMailboxHttpServerOptions {
  host?: string
  port?: number
  bundlesRoot?: string
  healthPath?: string
  logPath?: string | null
  readMachineState?: () => MailboxMachineState
  readMachineView?: (input: { origin: string; machine: MailboxMachineState }) => MailboxMachineView
  readAgentState?: (agentName: string) => MailboxAgentState | null
  readAgentView?: (agentName: string) => MailboxAgentView | null
  readAgentSessions?: (agentName: string) => MailboxSessionInventory
  readAgentTranscript?: (agentName: string, friendId: string, channel: string, key: string) => MailboxSessionTranscript | null
  readAgentCoding?: (agentName: string) => MailboxCodingDeep
  readAgentAttention?: (agentName: string) => MailboxAttentionView
  readAgentBridges?: (agentName: string) => MailboxBridgeInventory
  readAgentNotes?: (agentName: string) => MailboxNotesView
  readAgentFriends?: (agentName: string) => MailboxFriendView
  readAgentContinuity?: (agentName: string) => MailboxContinuityView
  readAgentOrientation?: (agentName: string) => MailboxOrientationView
  readAgentObligations?: (agentName: string) => MailboxObligationDetailView
  readAgentChanges?: (agentName: string) => MailboxChangesView
  readAgentSelfFix?: (agentName: string) => MailboxSelfFixView
  readAgentNoteDecisions?: (agentName: string) => MailboxNoteDecisionView
  readAgentHabits?: (agentName: string) => MailboxHabitView
  readAgentMail?: (agentName: string) => Promise<MailboxMailView> | MailboxMailView
  readAgentMailMessage?: (agentName: string, messageId: string) => Promise<MailboxMailMessageView> | MailboxMailMessageView
  readDaemonHealth?: () => MailboxDaemonHealthDeep | null
  readLogs?: () => MailboxLogView
}

export interface MailboxHttpServerHandle {
  origin: string
  broadcast(event: string, data?: Record<string, unknown>): void
  stop(): Promise<void>
}

export async function startMailboxHttpServer(options: StartMailboxHttpServerOptions = {}): Promise<MailboxHttpServerHandle> {
  const host = options.host ?? "127.0.0.1"
  const port = options.port ?? 0
  const bundlesRoot = options.bundlesRoot
  const opts = bundlesRoot ? { bundlesRoot } : undefined
  const readMachineState = options.readMachineState ?? (() => readMailboxMachineState(opts))
  const readMachineView = options.readMachineView
  const readAgentState = options.readAgentState ?? ((agentName: string) => {
    if (opts) return readMailboxAgentState(agentName, opts)
    return readMailboxAgentState(agentName)
  })
  const readAgentView = options.readAgentView
  const hooks = createMailboxHttpReadHooks(options)
  const sse = createSseBroadcaster()
  const bundleWatcher = bundlesRoot ? createBundleWatcher(bundlesRoot, createStateChangedBroadcast(sse)) : null

  let server!: http.Server
  server = http.createServer(createMailboxHttpRequestHandler({
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
    event: "daemon.mailbox_http_started",
    message: "started Mailbox HTTP server",
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
        event: "daemon.mailbox_http_stopped",
        message: "stopped Mailbox HTTP server",
        meta: { origin },
      })
    },
  }
}
