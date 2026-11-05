import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { startShepherdAttention } from "../../../senses/shepherd/attention"
import { ShepherdComposer } from "../../../senses/shepherd/composer"
import { SocketFrontendClient } from "../../../heart/frontend-socket-client"
import { FrontendSessionService } from "../../../heart/frontend-session-service"
import { FrontendJournalStore } from "../../../heart/frontend-journal"
import { startFrontendSocketServer } from "../../../heart/frontend-socket"

const target = { id: "11111111-1111-4111-8111-111111111111", host: "cmux" as const, label: "owned",
  displayLabel: "Owned coding session", selected: true }
const settled = (response: string) => ({ response, ponderDeferred: false, deliveries: [], deliveryFailures: [], turnOutcome: "settled" as const })

describe("graphical composer over the real frontend service", () => {
  it("releases a definitively refused competing view, without cancelling or replaying the terminal composer", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "attention-contention-"))
    const release = Promise.withResolvers<void>()
    const runner = vi.fn(async input => { if (input.userMessage === "terminal first") await release.promise; return settled(input.userMessage) })
    const service = new FrontendSessionService({ runner, shepherdTargets: async () => [target],
      journal: new FrontendJournalStore({ agentRoot: () => root }) })
    const socket = await startFrontendSocketServer({ socketPath: path.join(root, "frontend.sock"), service })
    const terminal = new ShepherdComposer({ agent: "boss", friendId: "owner", target, client: new SocketFrontendClient(socket.socketPath) })
    const app = await startShepherdAttention({ agent: "boss", socketPath: socket.socketPath, resolveOwner: async () => "owner" })
    const url = new URL(app.url)
    const headers = { "X-Ouro-Attention": url.hash.slice(1), "X-Ouro-View": crypto.randomUUID() }
    const api = (route: string, body?: unknown) => fetch(`${url.origin}${route}`, {
      headers: { ...headers, ...(body ? { Origin: url.origin, "Content-Type": "application/json" } : {}) },
      method: body ? "POST" : "GET", ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const first = terminal.submit("terminal first")
    try {
      await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1))
      await api("/send", { id: crypto.randomUUID(), message: "GUI competing" })
      await vi.waitFor(async () => {
        const state = await (await api("/state")).json()
        expect(state.active).toBe(false)
        expect(JSON.stringify(state.messages)).toContain("active turn")
      })
      expect((await (await api("/cancel", {})).json()).cancelled).toBe(false)
      expect(terminal.busy).toBe(true)
      expect(runner).toHaveBeenCalledTimes(1)
      release.resolve()
      await first
      await api("/send", { id: crypto.randomUUID(), message: "GUI after terminal" })
      await vi.waitFor(async () => expect((await (await api("/state")).json()).messages.at(-1)).toEqual({ role: "ouro", text: "GUI after terminal" }))
      expect(runner).toHaveBeenCalledTimes(2)
    } finally {
      release.resolve()
      await first
      terminal.close()
      await app.close()
      await socket.stop()
    }
  })

  it("recovers the same browser request from the durable journal after the HTTP listener restarts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "attention-request-restart-"))
    const runner = vi.fn(async () => settled("the one authoritative result"))
    const service = new FrontendSessionService({ runner, shepherdTargets: async () => [target],
      journal: new FrontendJournalStore({ agentRoot: () => root }) })
    const socket = await startFrontendSocketServer({ socketPath: path.join(root, "frontend.sock"), service })
    const options = { agent: "boss", socketPath: socket.socketPath, resolveOwner: async () => "owner" }
    let app = await startShepherdAttention(options)
    const id = crypto.randomUUID()
    const request = { id, message: "one execution" }
    const api = (route: string, body?: unknown) => {
      const url = new URL(app.url)
      return fetch(`${url.origin}${route}`, { method: body ? "POST" : "GET",
        headers: { "X-Ouro-Attention": url.hash.slice(1), ...(body ? { Origin: url.origin, "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    }
    try {
      await api("/send", request)
      await vi.waitFor(async () => expect((await (await api("/state")).json()).messages.at(-1).role).toBe("ouro"))
      await app.close()
      app = await startShepherdAttention(options)
      await api("/send", request)
      await vi.waitFor(async () => expect((await (await api("/state")).json()).messages.at(-1)).toEqual({ role: "ouro", text: "the one authoritative result" }))
      expect(runner).toHaveBeenCalledTimes(1)
    } finally {
      await app.close()
      await socket.stop()
    }
  })
})
