import * as fs from "node:fs"
import * as net from "node:net"
import * as path from "node:path"

/**
 * A fake Herdr socket for tests: newline-delimited JSON, `{"id","method","params"}` requests,
 * `{"id","result"}` or `{"id","error"}` responses, and `events.subscribe` keeping its connection
 * open for pushed `{"event","data"}` lines. Shapes follow Herdr's published socket schema.
 */
export interface FakeHerdr {
  socketPath: string
  requests: Array<{ method: string; params: Record<string, unknown> }>
  respond: (method: string, handler: (params: Record<string, unknown>) => unknown) => void
  push: (line: unknown) => void
  pushRaw: (text: string) => void
  endStreams: () => void
  streamCount: () => number
  close: () => Promise<void>
}

export class HerdrError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export async function startFakeHerdr(): Promise<FakeHerdr> {
  const dir = fs.mkdtempSync("/tmp/hdr-")
  const socketPath = path.join(dir, "herdr.sock")
  const requests: Array<{ method: string; params: Record<string, unknown> }> = []
  const handlers = new Map<string, (params: Record<string, unknown>) => unknown>()
  const streams = new Set<net.Socket>()

  const server = net.createServer((socket) => {
    let buffer = ""
    socket.on("error", () => undefined)
    socket.on("close", () => streams.delete(socket))
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8")
      let index = buffer.indexOf("\n")
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf("\n")
        const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> }
        requests.push({ method: request.method, params: request.params })
        const handler = handlers.get(request.method)
        try {
          if (!handler) throw new HerdrError("unknown_method", `unknown method ${request.method}`)
          const result = handler(request.params)
          if (result === null) continue
          socket.write(`${JSON.stringify({ id: request.id, result })}\n`)
          if (request.method === "events.subscribe") streams.add(socket)
        } catch (error) {
          const failure = error as HerdrError
          socket.write(`${JSON.stringify({ id: request.id, error: { code: failure.code ?? "internal", message: failure.message } })}\n`)
          if (request.method === "events.subscribe") socket.end()
        }
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))

  return {
    socketPath,
    requests,
    respond: (method, handler) => { handlers.set(method, handler) },
    push: (line) => { for (const socket of streams) socket.write(`${JSON.stringify(line)}\n`) },
    pushRaw: (text) => { for (const socket of streams) socket.write(text) },
    endStreams: () => { for (const socket of streams) socket.destroy(); streams.clear() },
    streamCount: () => streams.size,
    close: () => new Promise<void>((resolve) => {
      for (const socket of streams) socket.destroy()
      server.close(() => resolve())
    }),
  }
}

/** A `PaneInfo` as Herdr's `pane.list` returns it. */
export function paneInfo(paneId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { pane_id: paneId, terminal_id: `term_${paneId.replace(":", "_")}`, workspace_id: paneId.split(":")[0], tab_id: `${paneId.split(":")[0]}:t1`, focused: false, agent_status: "idle", revision: 3, agent: "codex", title: null, terminal_title_stripped: "codex", cwd: "/Users/a/code/app", ...overrides }
}

/** An `AgentInfo` as Herdr's `agent.get` returns it. */
export function agentInfo(paneId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...paneInfo(paneId), interactive_ready: true, launch_pending: false, screen_detection_skipped: false, state_change_seq: 41, completion_seq: 40, foreground_cwd: "/Users/a/code/app/pkg", ...overrides }
}

/** A `pane.agent_status_changed` subscription event. */
export function statusEvent(paneId: string, agentStatus: string, agent: string | null = "codex"): Record<string, unknown> {
  return { event: "pane.agent_status_changed", data: { pane_id: paneId, workspace_id: paneId.split(":")[0], agent_status: agentStatus, agent, display_agent: null, title: null, state_labels: {} } }
}

/** A lifecycle event (`pane_focused`, `pane_created`, `pane_closed`). */
export function paneEvent(kind: "pane_focused" | "pane_created" | "pane_closed", paneId: string): Record<string, unknown> {
  const data = { type: kind, pane_id: paneId, workspace_id: paneId.split(":")[0] }
  return { event: kind, data: kind === "pane_created" ? { ...data, pane: paneInfo(paneId) } : data }
}
