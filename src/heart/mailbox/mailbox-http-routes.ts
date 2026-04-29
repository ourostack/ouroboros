import * as fs from "fs"
import * as http from "http"
import * as path from "path"
import type { SseBroadcaster } from "./mailbox-http-transport"
import type { MailboxHttpReadHooks } from "./mailbox-http-hooks"
import { writeJson } from "./mailbox-http-response"
import {
  normalizeLegacyMailboxApiPath,
  normalizeMailboxRequestPath,
  resolveSpaDistDir,
  serveStaticFile,
} from "./mailbox-http-static"
import type {
  MailboxAgentState,
  MailboxAgentView,
  MailboxMachineState,
  MailboxMachineView,
} from "./mailbox-types"

export interface MailboxHttpRouteOptions {
  host: string
  getPort(): number
  readMachineState(): MailboxMachineState
  readMachineView?: (input: { origin: string; machine: MailboxMachineState }) => MailboxMachineView
  readAgentState(agentName: string): MailboxAgentState | null
  readAgentView?: (agentName: string) => MailboxAgentView | null
  hooks: MailboxHttpReadHooks
  sse: Pick<SseBroadcaster, "add">
  staticFiles?: MailboxHttpStaticFiles
}

export interface MailboxHttpStaticFiles {
  resolveSpaDistDir(): string | null
  serveStaticFile(response: http.ServerResponse, filePath: string): boolean
}

export function createMailboxHttpRequestHandler(options: MailboxHttpRouteOptions): http.RequestListener {
  const staticFiles = options.staticFiles ?? { resolveSpaDistDir, serveStaticFile }

  return (request, response) => {
    let pathname = normalizeMailboxRequestPath(request.url)
    const origin = `http://${options.host}:${options.getPort()}`

    if (pathname.startsWith("/assets/")) {
      const spaDir = staticFiles.resolveSpaDistDir()
      if (spaDir) {
        const assetPath = path.join(spaDir, pathname)
        if (staticFiles.serveStaticFile(response, assetPath)) return
      }
      writeJson(response, 404, { ok: false, error: "asset not found" })
      return
    }

    if (pathname === "/mailbox" || pathname === "/outlook") {
      response.writeHead(301, { location: "/" })
      response.end()
      return
    }

    pathname = normalizeLegacyMailboxApiPath(pathname)

    if (pathname === "/api/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive", "access-control-allow-origin": "*" })
      response.write(":ok\n\n")
      options.sse.add(response)
      return
    }

    if (pathname === "/api/machine") {
      const machine = options.readMachineState()
      const machineView = options.readMachineView?.({ origin, machine })
      writeJson(response, 200, machineView ?? machine)
      return
    }

    if (pathname === "/api/machine/health") {
      const health = options.hooks.readDaemonHealth()
      writeJson(response, 200, health ?? { status: "unavailable" })
      return
    }

    if (pathname === "/api/machine/logs") {
      writeJson(response, 200, options.hooks.readLogs())
      return
    }

    const agentMatch = /^\/api\/agents\/([^/]+)(?:\/(.+))?$/.exec(pathname)
    if (agentMatch) {
      void handleAgentRoute(request, response, {
        agent: decodeURIComponent(agentMatch[1]!),
        surface: agentMatch[2] ?? null,
        options,
      }).catch((error) => {
        writeJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      })
      return
    }

    const spaDir = staticFiles.resolveSpaDistDir()
    if (spaDir) {
      if (staticFiles.serveStaticFile(response, path.join(spaDir, "index.html"))) return
    }
    writeJson(response, 404, { ok: false, error: `not found: ${pathname}` })
  }
}

interface AgentRouteContext {
  agent: string
  surface: string | null
  options: MailboxHttpRouteOptions
}

async function handleAgentRoute(request: http.IncomingMessage, response: http.ServerResponse, context: AgentRouteContext): Promise<void> {
  const { agent, surface, options } = context

  if (!surface) {
    const view = options.readAgentView?.(agent)
    if (view) {
      writeJson(response, 200, view)
      return
    }
    const state = options.readAgentState(agent)
    if (!state) {
      writeJson(response, 404, { ok: false, error: `unknown agent: ${agent}` })
      return
    }
    writeJson(response, 200, state)
    return
  }

  if (surface === "sessions") {
    writeJson(response, 200, options.hooks.readAgentSessions(agent))
    return
  }

  const transcriptMatch = /^sessions\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(surface)
  if (transcriptMatch) {
    const friendId = decodeURIComponent(transcriptMatch[1]!)
    const channel = decodeURIComponent(transcriptMatch[2]!)
    const key = decodeURIComponent(transcriptMatch[3]!)
    const transcript = options.hooks.readAgentTranscript(agent, friendId, channel, key)
    if (!transcript) {
      writeJson(response, 404, { ok: false, error: "session not found" })
      return
    }
    writeJson(response, 200, transcript)
    return
  }

  if (surface === "coding") {
    writeJson(response, 200, options.hooks.readAgentCoding(agent))
    return
  }

  if (surface === "attention") {
    writeJson(response, 200, options.hooks.readAgentAttention(agent))
    return
  }

  if (surface === "bridges") {
    writeJson(response, 200, options.hooks.readAgentBridges(agent))
    return
  }

  if (surface === "notes") {
    writeJson(response, 200, options.hooks.readAgentNotes(agent))
    return
  }

  if (surface === "friends") {
    writeJson(response, 200, options.hooks.readAgentFriends(agent))
    return
  }

  if (surface === "continuity") {
    writeJson(response, 200, options.hooks.readAgentContinuity(agent))
    return
  }

  if (surface === "orientation") {
    writeJson(response, 200, options.hooks.readAgentOrientation(agent))
    return
  }

  if (surface === "obligations") {
    writeJson(response, 200, options.hooks.readAgentObligations(agent))
    return
  }

  if (surface === "changes") {
    writeJson(response, 200, options.hooks.readAgentChanges(agent))
    return
  }

  if (surface === "self-fix") {
    writeJson(response, 200, options.hooks.readAgentSelfFix(agent))
    return
  }

  if (surface === "note-decisions") {
    writeJson(response, 200, options.hooks.readAgentNoteDecisions(agent))
    return
  }

  if (surface === "dismiss-obligation" && request.method === "POST") {
    handleDismissObligation(request, response, options.hooks.agentRoot(agent))
    return
  }

  if (surface === "desk-prefs") {
    writeJson(response, 200, options.hooks.readDeskPrefs(agent))
    return
  }

  if (surface === "needs-me") {
    writeJson(response, 200, options.hooks.readNeedsMe(agent))
    return
  }

  if (surface === "habits") {
    writeJson(response, 200, options.hooks.readAgentHabits(agent))
    return
  }

  if (surface === "mail") {
    writeJson(response, 200, await options.hooks.readAgentMail(agent))
    return
  }

  const mailMessageMatch = /^mail\/([^/]+)$/.exec(surface)
  if (mailMessageMatch) {
    const messageId = decodeURIComponent(mailMessageMatch[1]!)
    writeJson(response, 200, await options.hooks.readAgentMailMessage(agent, messageId))
    return
  }

  if (surface === "inner-transcript") {
    const transcript = options.hooks.readAgentTranscript(agent, "self", "inner", "dialog")
    writeJson(response, 200, transcript ?? { messageCount: 0, messages: [] })
    return
  }

  writeJson(response, 404, { ok: false, error: `unknown agent surface: ${surface}` })
}

function handleDismissObligation(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  agentRoot: string,
): void {
  let body = ""
  request.on("data", (chunk) => {
    body += chunk
  })
  request.on("end", () => {
    try {
      const { obligationId } = JSON.parse(body) as { obligationId: string }
      if (!obligationId) {
        writeJson(response, 400, { ok: false, error: "obligationId required" })
        return
      }
      const prefsPath = path.join(agentRoot, "state", "mailbox-prefs.json")
      const legacyPrefsPath = path.join(agentRoot, "state", "outlook-prefs.json")
      let prefs: Record<string, unknown> = {}
      try {
        const readPath = fs.existsSync(prefsPath) ? prefsPath : legacyPrefsPath
        prefs = JSON.parse(fs.readFileSync(readPath, "utf-8")) as Record<string, unknown>
      } catch {
        // Missing or malformed prefs start from a clean preference object.
      }
      const dismissed = Array.isArray(prefs.dismissedObligations) ? prefs.dismissedObligations as string[] : []
      if (!dismissed.includes(obligationId)) dismissed.push(obligationId)
      prefs.dismissedObligations = dismissed
      fs.mkdirSync(path.dirname(prefsPath), { recursive: true })
      fs.writeFileSync(prefsPath, `${JSON.stringify(prefs, null, 2)}\n`, "utf-8")
      writeJson(response, 200, { ok: true, dismissed: dismissed.length })
    } catch (error) {
      writeJson(response, 500, { ok: false, error: String(error) })
    }
  })
}
