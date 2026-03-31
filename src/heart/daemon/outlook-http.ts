import * as fs from "fs"
import * as http from "http"
import type { AddressInfo } from "net"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import {
  readAttentionView,
  readBridgeInventory,
  readCodingDeep,
  readDaemonHealthDeep,
  readFriendView,
  readHabitView,
  readDeskPrefs,
  readLogView,
  readMemoryView,
  readNeedsMeView,
  readOutlookAgentState,
  readOutlookMachineState,
  readSessionInventory,
  readSessionTranscript,
} from "./outlook-read"
import { renderOutlookApp } from "./outlook-render"
import type {
  OutlookAgentState,
  OutlookAgentView,
  OutlookAttentionView,
  OutlookBridgeInventory,
  OutlookCodingDeep,
  OutlookDaemonHealthDeep,
  OutlookFriendView,
  OutlookHabitView,
  OutlookLogView,
  OutlookMachineState,
  OutlookMachineView,
  OutlookMemoryView,
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
  readAgentMemory?: (agentName: string) => OutlookMemoryView
  readAgentFriends?: (agentName: string) => OutlookFriendView
  readAgentHabits?: (agentName: string) => OutlookHabitView
  readDaemonHealth?: () => OutlookDaemonHealthDeep | null
  readLogs?: () => OutlookLogView
  renderApp?: (input: { origin: string; machine: OutlookMachineState; machineView?: OutlookMachineView }) => string
}

export interface OutlookHttpServerHandle {
  origin: string
  broadcast(event: string, data?: Record<string, unknown>): void
  stop(): Promise<void>
}

interface SseClient {
  id: number
  response: http.ServerResponse
}

function createSseBroadcaster() {
  let nextId = 1
  const clients = new Set<SseClient>()

  function add(response: http.ServerResponse): SseClient {
    const client: SseClient = { id: nextId++, response }
    clients.add(client)
    response.on("close", () => clients.delete(client))
    return client
  }

  function broadcast(event: string, data: Record<string, unknown> = {}): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of clients) {
      try {
        client.response.write(payload)
      /* v8 ignore start */
      } catch {
        clients.delete(client)
      }
      /* v8 ignore stop */
    }
  }

  function disconnectAll(): void {
    for (const client of clients) {
      try {
        client.response.end()
      /* v8 ignore start */
      } catch {
        /* already closed */
      }
      /* v8 ignore stop */
    }
    clients.clear()
  }

  return { add, broadcast, disconnectAll }
}

/* v8 ignore start — filesystem watcher, tested via integration */
function createBundleWatcher(bundlesRoot: string, onChange: () => void): { stop: () => void } {
  const watchers: fs.FSWatcher[] = []
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  const DEBOUNCE_MS = 500

  function debouncedOnChange(): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(onChange, DEBOUNCE_MS)
  }

  try {
    if (fs.existsSync(bundlesRoot)) {
      const watcher = fs.watch(bundlesRoot, { recursive: true }, debouncedOnChange)
      watchers.push(watcher)
    }
  } catch {
    // watch not available — SSE will rely on manual broadcast
  }

  return {
    stop() {
      if (debounceTimer) clearTimeout(debounceTimer)
      for (const w of watchers) try { w.close() } catch { /* ignore */ }
      watchers.length = 0
    },
  }
}
/* v8 ignore stop */


function writeJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" })
  response.end(`${JSON.stringify(payload, null, 2)}\n`)
}

function writeHtml(response: http.ServerResponse, html: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  response.end(html)
}

function normalizePath(urlValue = "/"): string {
  const parsed = new URL(urlValue, "http://127.0.0.1")
  const normalizedPath = parsed.pathname.replace(/\/+$/, "")
  if (normalizedPath.length === 0) return "/"
  return normalizedPath
}

export async function startOutlookHttpServer(options: StartOutlookHttpServerOptions = {}): Promise<OutlookHttpServerHandle> {
  const host = options.host ?? "127.0.0.1"
  const port = options.port ?? 0
  const bundlesRoot = options.bundlesRoot
  const opts = bundlesRoot ? { bundlesRoot } : undefined
  const readMachineState = options.readMachineState ?? (() => readOutlookMachineState(opts))
  const readMachineView = options.readMachineView
  /* v8 ignore start */
  const readAgentState = options.readAgentState ?? ((agentName: string) => {
    if (opts) return readOutlookAgentState(agentName, opts)
    return readOutlookAgentState(agentName)
  })
  /* v8 ignore stop */
  const readAgentView = options.readAgentView
  const renderApp = options.renderApp ?? renderOutlookApp

  /* v8 ignore start — default hook wiring, tested via integration */
  const agentRoot = (agentName: string) => {
    const base = bundlesRoot ?? ""
    return path.join(base, `${agentName}.ouro`)
  }

  const hooks = {
    readAgentSessions: options.readAgentSessions ?? ((agentName: string) => readSessionInventory(agentName, bundlesRoot ? { bundlesRoot } : undefined)),
    readAgentTranscript: options.readAgentTranscript ?? ((agentName: string, friendId: string, channel: string, key: string) => readSessionTranscript(agentName, friendId, channel, key, bundlesRoot ? { bundlesRoot } : undefined)),
    readAgentCoding: options.readAgentCoding ?? ((agentName: string) => readCodingDeep(agentRoot(agentName))),
    readAgentAttention: options.readAgentAttention ?? ((agentName: string) => readAttentionView(agentName, bundlesRoot ? { bundlesRoot } : undefined)),
    readAgentBridges: options.readAgentBridges ?? ((agentName: string) => readBridgeInventory(agentRoot(agentName))),
    readAgentMemory: options.readAgentMemory ?? ((agentName: string) => readMemoryView(agentRoot(agentName))),
    readAgentFriends: options.readAgentFriends ?? ((agentName: string) => readFriendView(agentName, bundlesRoot ? { bundlesRoot } : undefined)),
    readAgentHabits: options.readAgentHabits ?? ((agentName: string) => readHabitView(agentRoot(agentName))),
    readDaemonHealth: options.readDaemonHealth ?? (() => readDaemonHealthDeep(options.healthPath)),
    readLogs: options.readLogs ?? (() => readLogView(options.logPath ?? null)),
  }
  /* v8 ignore stop */

  const sse = createSseBroadcaster()
  /* v8 ignore start — watcher callback fires on filesystem changes */
  const bundleWatcher = bundlesRoot ? createBundleWatcher(bundlesRoot, () => {
    sse.broadcast("state-changed", { at: new Date().toISOString() })
  }) : null
  /* v8 ignore stop */

  const server = http.createServer((request, response) => {
    const pathname = normalizePath(request.url)
    const origin = `http://${host}:${(server.address() as AddressInfo).port}`

    if (pathname === "/outlook/api/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive", "access-control-allow-origin": "*" })
      response.write(":ok\n\n")
      sse.add(response)
      return
    }

    if (pathname === "/outlook") {
      const machine = readMachineState()
      const machineView = readMachineView?.({ origin, machine })
      writeHtml(response, renderApp({ origin, machine, machineView }))
      return
    }

    if (pathname === "/outlook/api/machine") {
      const machine = readMachineState()
      const machineView = readMachineView?.({ origin, machine })
      writeJson(response, 200, machineView ?? machine)
      return
    }

    if (pathname === "/outlook/api/machine/health") {
      const health = hooks.readDaemonHealth()
      writeJson(response, 200, health ?? { status: "unavailable" })
      return
    }

    if (pathname === "/outlook/api/machine/logs") {
      writeJson(response, 200, hooks.readLogs())
      return
    }

    // Agent-level endpoints: /outlook/api/agents/:agent[/:surface[/:params...]]
    const agentMatch = /^\/outlook\/api\/agents\/([^/]+)(?:\/(.+))?$/.exec(pathname)
    if (agentMatch) {
      const agent = decodeURIComponent(agentMatch[1]!)
      const surface = agentMatch[2] ?? null

      if (!surface) {
        const view = readAgentView?.(agent)
        if (view) { writeJson(response, 200, view); return }
        const state = readAgentState(agent)
        if (!state) { writeJson(response, 404, { ok: false, error: `unknown agent: ${agent}` }); return }
        writeJson(response, 200, state)
        return
      }

      if (surface === "sessions") {
        writeJson(response, 200, hooks.readAgentSessions(agent))
        return
      }

      const transcriptMatch = /^sessions\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(surface)
      if (transcriptMatch) {
        const friendId = decodeURIComponent(transcriptMatch[1]!)
        const channel = decodeURIComponent(transcriptMatch[2]!)
        const key = decodeURIComponent(transcriptMatch[3]!)
        const transcript = hooks.readAgentTranscript(agent, friendId, channel, key)
        if (!transcript) { writeJson(response, 404, { ok: false, error: "session not found" }); return }
        writeJson(response, 200, transcript)
        return
      }

      if (surface === "coding") {
        writeJson(response, 200, hooks.readAgentCoding(agent))
        return
      }

      if (surface === "attention") {
        writeJson(response, 200, hooks.readAgentAttention(agent))
        return
      }

      if (surface === "bridges") {
        writeJson(response, 200, hooks.readAgentBridges(agent))
        return
      }

      if (surface === "memory") {
        writeJson(response, 200, hooks.readAgentMemory(agent))
        return
      }

      if (surface === "friends") {
        writeJson(response, 200, hooks.readAgentFriends(agent))
        return
      }

      /* v8 ignore start — desk prefs + needs-me use direct reads */
      if (surface === "desk-prefs") {
        writeJson(response, 200, readDeskPrefs(agentRoot(agent)))
        return
      }

      if (surface === "needs-me") {
        writeJson(response, 200, readNeedsMeView(agent, opts))
        return
      }
      /* v8 ignore stop */

      if (surface === "habits") {
        writeJson(response, 200, hooks.readAgentHabits(agent))
        return
      }

      if (surface === "inner-transcript") {
        const transcript = hooks.readAgentTranscript(agent, "self", "inner", "dialog")
        writeJson(response, 200, transcript ?? { messageCount: 0, messages: [] })
        return
      }

      writeJson(response, 404, { ok: false, error: `unknown agent surface: ${surface}` })
      return
    }

    writeJson(response, 404, { ok: false, error: `unknown outlook path: ${pathname}` })
  })

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
