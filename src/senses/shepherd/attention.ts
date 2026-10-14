import { randomBytes } from "node:crypto"
import * as http from "node:http"
import { spawnSync } from "node:child_process"
import * as os from "node:os"
import * as path from "node:path"
import { SocketFrontendClient, type FrontendProtocolClient } from "../../heart/frontend-socket-client"
import { emitNervesEvent } from "../../nerves/runtime"
import { ShepherdComposer, selectShepherdTarget } from "./composer"
import { localShepherdFriendStore, resolveExistingLocalOwner, SHEPHERD_UUID, type ShepherdSession } from "./surface"
import { attentionPage, MAX_ATTENTION_BODY_BYTES } from "./attention-page"
import { installAttentionSidebar } from "./attention-sidebar"

interface Message { role: "you" | "ouro" | "notice"; text: string }
interface AttentionView {
  target: ShepherdSession | null
  composer: ShepherdComposer | null
  messages: Message[]
}

function suggestedTarget(targets: ShepherdSession[]): ShepherdSession | null {
  const hints = targets.filter(target => target.selected)
  return hints.length === 1 ? hints[0]! : targets.length === 1 ? targets[0]! : null
}

/** An owner-only loopback view of the existing fixed-target composer, not another model runtime. */
export async function startShepherdAttention(options: {
  agent: string
  session?: string
  socketPath: string
  resolveOwner?: () => Promise<string>
  client?: () => FrontendProtocolClient
}): Promise<{ url: string; close(): Promise<void> }> {
  const friendId = await (options.resolveOwner ?? (() => resolveExistingLocalOwner(localShepherdFriendStore(options.agent))))()
  const makeClient = options.client ?? (() => new SocketFrontendClient(options.socketPath))
  const discovery = makeClient()
  let targets: ShepherdSession[]
  try {
    targets = (await discovery.request("shepherd.targets", { agent: options.agent, friendId })).targets
  } finally { discovery.close() }
  const selected = options.session
    ? selectShepherdTarget(targets, options.session)
    : suggestedTarget(targets)
  const views = new Map<string, AttentionView>()
  const submissions = new Map<string, { view: string; target: string; message: string }>()
  const token = randomBytes(32).toString("hex")
  const nonce = randomBytes(24).toString("base64")
  let origin = ""
  const append = (view: AttentionView, role: Message["role"], text: string) => {
    view.messages.push({ role, text })
    view.messages = view.messages.slice(-40)
  }
  const getComposer = (view: AttentionView, target: ShepherdSession) => {
    if (!view.composer) view.composer = new ShepherdComposer({
      client: makeClient(), agent: options.agent, friendId, target,
      notice: text => append(view, "notice", text), answer: text => append(view, "ouro", text),
    })
    return view.composer
  }
  const state = (view: AttentionView, viewId: string, requestId?: string) => ({
    targets: targets.map(item => ({ id: item.id, label: item.displayLabel ?? "Coding session" })),
    target: view.target?.id ?? null, active: view.composer?.busy ?? false, messages: view.messages,
    acknowledged: requestId && submissions.get(requestId)?.view === viewId
      ? { id: requestId, target: submissions.get(requestId)!.target } : null,
  })
  const server = http.createServer((request, response) => {
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" })
      response.end(JSON.stringify(value))
    }
    void (async () => {
      if (request.headers.host !== new URL(origin).host) return json(403, { error: "Invalid attention host." })
      if (request.method === "GET" && request.url === "/") {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
          "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
          "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff",
        })
        return response.end(attentionPage(nonce))
      }
      if (request.headers["x-ouro-attention"] !== token) return json(403, { error: "Open attention from its local entry." })
      const viewId = request.headers["x-ouro-view"] ?? "default"
      if (typeof viewId !== "string" || (viewId !== "default" && !SHEPHERD_UUID.test(viewId))) return json(400, { error: "Invalid attention view." })
      let view = views.get(viewId)
      if (!view) {
        if (views.size >= 64) return json(409, { error: "Attention reached its view limit. Restart Shepherd before opening another view." })
        view = { target: selected ?? null, composer: null, messages: [] }
        views.set(viewId, view)
      }
      const pendingId = typeof request.headers["x-ouro-pending"] === "string" ? request.headers["x-ouro-pending"] : undefined
      if (request.method === "GET" && request.url === "/state") return json(200, state(view, viewId, pendingId))
      if (request.method !== "POST" || request.headers.origin !== origin
        || request.headers["content-type"] !== "application/json") return json(403, { error: "Invalid attention origin or content type." })
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > MAX_ATTENTION_BODY_BYTES) return json(413, { error: "Message is too large." })
        chunks.push(buffer)
      }
      const body = Buffer.concat(chunks).toString("utf8")
      let input: unknown
      try { input = JSON.parse(body) } catch { return json(400, { error: "Invalid JSON." }) }
      if (!input || typeof input !== "object" || Array.isArray(input)) return json(400, { error: "Invalid request." })
      const fields = input as Record<string, unknown>
      if (request.url === "/targets") {
        const refresh = makeClient()
        try { targets = (await refresh.request("shepherd.targets", { agent: options.agent, friendId })).targets } finally { refresh.close() }
        return json(200, state(view, viewId, pendingId))
      }
      if (request.url === "/select") {
        if (view.composer?.busy) return json(409, { error: "Wait for or cancel Ouro before changing the session." })
        if (typeof fields.target !== "string") return json(400, { error: "Choose a session." })
        const refresh = makeClient()
        try { targets = (await refresh.request("shepherd.targets", { agent: options.agent, friendId })).targets } finally { refresh.close() }
        if (view.composer?.busy) return json(409, { error: "Ouro started replying while the session list refreshed; the conversation was not changed." })
        const next = fields.target === "current" ? suggestedTarget(targets) : selectShepherdTarget(targets, fields.target)
        if (view.target?.id !== next?.id) {
          view.composer?.close()
          view.composer = null
          view.target = next
          view.messages = []
        }
        return json(200, state(view, viewId, pendingId))
      }
      if (request.url === "/send") {
        if (typeof fields.id !== "string" || !SHEPHERD_UUID.test(fields.id)
          || typeof fields.message !== "string" || !fields.message.replace(/^@ouro(?:\s+|$)/i, "").trim()) return json(400, { error: "Enter a message for Ouro." })
        if (!view.target) return json(409, { error: "Choose the session you want to discuss." })
        if (fields.target !== undefined && fields.target !== view.target.id) return json(409, { error: "This pending message is pinned to another session." })
        const prior = submissions.get(fields.id)
        if (prior) {
          if (prior.view !== viewId || prior.target !== view.target.id || prior.message !== fields.message) return json(409, { error: "This request id belongs to a different message or session." })
          return json(202, state(view, viewId, fields.id))
        }
        if (view.composer?.busy) return json(409, { error: "Ouro is already replying. Your draft has not been sent." })
        if (submissions.size >= 2_000) return json(409, { error: "Attention reached its message limit. Restart Shepherd before sending more messages." })
        const bound = getComposer(view, view.target)
        submissions.set(fields.id, { view: viewId, target: view.target.id, message: fields.message })
        append(view, "you", fields.message)
        const submittedView = view
        void bound.submit(fields.message, fields.id).catch(error => append(submittedView, "notice", String(error)))
        return json(202, state(view, viewId, fields.id))
      }
      if (request.url === "/cancel") {
        const cancelled = await view.composer?.cancel() ?? false
        return json(200, { cancelled })
      }
      if (request.url === "/recover") {
        await view.composer?.recover()
        return json(200, state(view, viewId, pendingId))
      }
      return json(404, { error: "Unknown attention action." })
    })().catch(error => {
      emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_attention_error", message: "attention action failed", meta: { error: String(error) } })
      if (!response.headersSent) json(400, { error: String(error) })
      else response.destroy(error instanceof Error ? error : new Error(String(error)))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    server.close()
    throw new Error("Attention did not bind a loopback port.")
  }
  origin = `http://127.0.0.1:${address.port}`
  emitNervesEvent({ component: "senses", event: "senses.shepherd_attention_started", message: "opened independent graphical session attention", meta: { agent: options.agent } })
  return {
    url: `${origin}/#${token}`,
    async close() {
      try { await Promise.all([...views.values()].map(view => view.composer?.cancel())) } finally {
        for (const view of views.values()) view.composer?.close()
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      }
    },
  }
}

export async function startManagedShepherdAttention(options: { agent: string; session?: string; socketPath: string }): Promise<{ url: string; close(): Promise<void> }> {
  const app = await startShepherdAttention(options)
  try {
    installAttentionSidebar(path.join(os.homedir(), ".config/cmux/sidebars"), app.url, options.agent)
    const validated = spawnSync("cmux", ["sidebar", "validate", `ouro-attention-${options.agent}`], { encoding: "utf8" })
    if (validated.error || validated.status !== 0) throw new Error(`Could not validate Ouro's native entry: ${validated.error?.message ?? validated.stderr}`)
    return app
  } catch (error) {
    await app.close()
    throw error
  }
}

export async function runShepherdAttention(options: { agent: string; session?: string; socketPath: string }): Promise<void> {
  const app = await startShepherdAttention(options)
  try {
    const opened = spawnSync("cmux", ["browser", "open", app.url + (options.session ? `&session=${options.session}` : ""), "--focus", "false"], { encoding: "utf8" })
    if (opened.error || opened.status !== 0) throw new Error(`Could not open Ouro attention in cmux: ${opened.error?.message ?? opened.stderr}`)
    await new Promise<void>(resolve => {
      const stop = () => {
        process.removeListener("SIGINT", stop)
        process.removeListener("SIGTERM", stop)
        resolve()
      }
      process.once("SIGINT", stop)
      process.once("SIGTERM", stop)
    })
  } finally { await app.close() }
}
