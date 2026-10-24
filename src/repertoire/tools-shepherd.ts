import * as fs from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { readMachineRuntimeCredentialConfig } from "../heart/runtime-credentials"
import { resolveShepherdConnection } from "../heart/shepherd-config"
import { emitNervesEvent } from "../nerves/runtime"
import { createShepherdHost, type ShepherdHost, type ShepherdKey } from "../senses/shepherd/host"
import { FINGERPRINT_READ_LINES, redactSecrets, screenFingerprint } from "../senses/shepherd/redact"
import { readReturns, type ReturnRecord } from "../senses/shepherd/returns"
import { SELF_FRIEND_ID, type ToolContext, type ToolDefinition } from "./tools-base"
import { shepherdGuidanceToolDefinitions } from "./tools-shepherd-guidance"
import { shepherdReturnId } from "../senses/shepherd/guidance"
import { assertBoundShepherdTarget } from "../senses/shepherd/target-binding"
import { readAgentPresentation } from "../senses/shepherd/agent-presentation"

/**
 * Shepherd's tools: every coding-agent session on this machine's terminal host with a current screen
 * and what Shepherd last decided about it (`shepherd_overview`), a deeper read (`shepherd_read`), a status
 * line or notification for the human (`shepherd_signal`), and a line or key typed for the human
 * who asked for it (`shepherd_send`).
 */
const STATUS_MAX_CHARS = 120
const READ_MAX_CHARS = 16_000
const OVERVIEW_READ_LINES = 80
const OVERVIEW_SCREEN_MAX_CHARS = 4_000
const OVERVIEW_TOTAL_SCREEN_MAX_CHARS = 64_000
export const SEND_TEXT_MAX_CHARS = 2_000
export const SEND_KEYS: readonly ShepherdKey[] = ["enter", "escape", "up", "down", "tab", "ctrl-c", "1", "2", "3", "4", "5", "6", "7", "8", "9", "y", "n"]
/** Keys that can approve or choose something on a prompt: pressed only on the screen the caller last read. */
const CHOOSING_KEYS = new Set<string>(["enter", "tab", "1", "2", "3", "4", "5", "6", "7", "8", "9", "y", "n"])

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function shepherdToolsEnabled(agentRoot: string | undefined): boolean {
  if (!agentRoot) return false
  try {
    const config = JSON.parse(fs.readFileSync(path.join(agentRoot, "agent.json"), "utf-8")) as { senses?: { shepherd?: { enabled?: unknown } } }
    return config.senses?.shepherd?.enabled === true
  } catch {
    return false
  }
}

function hostFor(agentName: string): ShepherdHost | string {
  const machine = readMachineRuntimeCredentialConfig(agentName)
  const resolved = resolveShepherdConnection(agentName, machine.ok ? machine.config : {})
  return resolved.ok ? createShepherdHost(resolved.connection, { agentName }) : resolved.error
}

async function withHost(tool: string, ctx: ToolContext | undefined, run: (host: ShepherdHost) => Promise<Record<string, unknown>>): Promise<string> {
  if (!ctx?.agentName || !ctx.agentRoot) return JSON.stringify({ error: "the Shepherd tools need an agent runtime" })
  const host = hostFor(ctx.agentName)
  if (typeof host === "string") return JSON.stringify({ error: host })
  try {
    if (ctx.currentShepherdSurface) {
      const bound = ctx.currentShepherdSurface
      assertBoundShepherdTarget(bound, bound.id, host.name)
      if (!(await host.list()).some(session => session.id === bound.id)) throw new Error(`bound terminal ${bound.id} is gone; nothing was read or sent`)
    }
    const result = await run(host)
    emitNervesEvent({ component: "repertoire", event: "repertoire.shepherd_tool", message: "ran a Shepherd tool", meta: { tool } })
    return JSON.stringify(result)
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "repertoire", event: "repertoire.shepherd_tool_error", message: "Shepherd tool call failed", meta: { tool, error: (error as Error).message } })
    return JSON.stringify({ error: (error as Error).message })
  }
}

async function currentScreen(host: ShepherdHost, session: string, maxChars: number) {
  try {
    const raw = await host.read(session, OVERVIEW_READ_LINES)
    // Frame glyphs and padded empty rows otherwise crowd actual work out of a multi-terminal snapshot.
    const content = redactSecrets(raw).split("\n")
      .map(line => line.replace(/[\u2500-\u259f]/g, "").trimEnd())
      .filter(line => line.trim().length > 0).join("\n")
    return { at: new Date().toISOString(), text: content.slice(Math.max(0, content.length - maxChars)), truncated: content.length > maxChars }
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error))
    emitNervesEvent({ level: "warn", component: "repertoire", event: "repertoire.shepherd_overview_read_error", message: "could not read one terminal in the live Shepherd overview", meta: { session, error: message } })
    return { at: new Date().toISOString(), error: message }
  }
}

export const shepherdOverviewToolDefinition: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "shepherd_overview",
      description: "A live, read-only snapshot of every terminal on this machine's host (cmux): agent, folder, workspace and tab, plus a freshly read, redacted, bounded currentScreen with its observation time. Use currentScreen to answer what agents are doing now in one reply; lastReturn is historical and must not be presented as current status. Include every listed terminal exactly once with its complete ref (surface:12), including plain shells and supervisor composers; never omit a row or abbreviate subsequent refs to bare numbers. terminalCount is authoritative; derive disjoint category counts from those same rows. Classify activity as working, needs human, waiting on outside dependency, idle/local work finished, shell, or unknown. An idle prompt does not establish delivered work: do not use a generic Done bucket for locally finished work that still needs review, approval, merge, publication, deployment or verification. State those remaining steps inline. An agent explicitly reporting an outside reviewer wait belongs under waiting even when its prompt is idle; that is neither premature completion nor a request for routine continuation. A currentScreen.error explicitly identifies a terminal that could not be read; explain it inline with the other sessions, not by asking for another turn. For deeper details use shepherd_read. Historical lastReturn includes the prior judgment time, kind, action and reason.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  handler: (_args, ctx) => withHost("shepherd_overview", ctx, async (host) => {
    const last = new Map<string, ReturnRecord>()
    for (const record of readReturns(ctx!.agentRoot!)) last.set(record.session, record)
    const sessions = await host.list()
    const screenLimit = Math.min(OVERVIEW_SCREEN_MAX_CHARS, Math.floor(OVERVIEW_TOTAL_SCREEN_MAX_CHARS / Math.max(1, sessions.length)))
    return {
      host: host.name,
      terminalCount: sessions.length,
      sessions: await Promise.all(sessions.map(async (session) => {
        const record = last.get(session.id)
        return { ...session, currentScreen: await currentScreen(host, session.id, screenLimit), ...(record ? { lastReturn: { id: shepherdReturnId(record), at: record.at, kind: record.kind, action: record.action, reason: record.reason, reply: record.reply, task: record.task } } : {}) }
      })),
    }
  }),
  summaryKeys: [],
  riskProfile: { mutates: "none", risk: "low" },
}

function boundedLines(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(text(value), 10)
  return Number.isFinite(parsed) ? Math.min(400, Math.max(1, Math.trunc(parsed))) : 60
}

export const shepherdReadToolDefinition: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "shepherd_read",
      description: "Read the text of one terminal session (what a coding agent shows now and what it did recently). Secret-shaped strings are redacted and the text is bounded. Read-only. Take the session id or ref from shepherd_overview. It also returns screen, a fingerprint of what the terminal shows now, for shepherd_send.",
      parameters: {
        type: "object",
        properties: {
          session: { type: "string", description: "Session id or ref (surface:12) from shepherd_overview." },
          lines: { type: "number", description: "How many lines, 1-400. Default 60." },
        },
        required: ["session"],
        additionalProperties: false,
      },
    },
  },
  handler: (args, ctx) => {
    const session = text(args.session).trim()
    if (!session) return Promise.resolve(JSON.stringify({ error: "name a session id or ref from shepherd_overview" }))
    return withHost("shepherd_read", ctx, async (host) => {
      assertBoundShepherdTarget(ctx?.currentShepherdSurface, session, host.name)
      const lines = boundedLines(args.lines)
      // A fingerprint needs enough lines to match the one shepherd_send takes, whatever the caller asked to see.
      const raw = await host.read(session, Math.max(lines, FINGERPRINT_READ_LINES))
      const screen = redactSecrets(raw).replace(/\n$/, "").split("\n").slice(-lines).join("\n")
      return { session, text: screen.slice(-READ_MAX_CHARS), truncated: screen.length > READ_MAX_CHARS, screen: screenFingerprint(raw) }
    })
  },
  summaryKeys: ["session"],
  riskProfile: { mutates: "none", risk: "low" },
}

export const shepherdSignalToolDefinition: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "shepherd_signal",
      description: `Tell the human something through the terminal host. status sets Shepherd's one-line status on that session's workspace (at most ${STATUS_MAX_CHARS} characters; an empty string clears it). notify_title with notify_body also posts a desktop notification there. It never types into a terminal.`,
      parameters: {
        type: "object",
        properties: {
          session: { type: "string", description: "Session id or ref from shepherd_overview." },
          status: { type: "string", description: "One line for the status, or an empty string to clear it." },
          notify_title: { type: "string", description: "Desktop notification title." },
          notify_body: { type: "string", description: "Desktop notification body." },
        },
        required: ["session", "status"],
        additionalProperties: false,
      },
    },
  },
  handler: (args, ctx) => {
    const session = text(args.session).trim()
    const status = text(args.status).trim()
    const title = text(args.notify_title).trim()
    if (!session) return Promise.resolve(JSON.stringify({ error: "name a session id or ref from shepherd_overview" }))
    if (status.length > STATUS_MAX_CHARS || /[\r\n]/.test(status)) return Promise.resolve(JSON.stringify({ error: `status must be one line of at most ${STATUS_MAX_CHARS} characters` }))
    return withHost("shepherd_signal", ctx, async (host) => {
      assertBoundShepherdTarget(ctx?.currentShepherdSurface, session, host.name)
      await host.signal(session, status || null, title ? { title, body: text(args.notify_body) } : undefined)
      return { session, status: status ? "set" : "cleared", notified: !!title }
    })
  },
  summaryKeys: ["session", "status"],
  riskProfile: { mutates: "external_side_effect", risk: "high", reason: "changes what the terminal host shows the human (a status line or a desktop notification)" },
}

function refused(reason: string, meta: Record<string, unknown>): Record<string, unknown> {
  emitNervesEvent({ level: "warn", component: "repertoire", event: "repertoire.shepherd_send_refused", message: "refused to type into a terminal", meta: { ...meta, reason } })
  return { error: reason }
}

export const shepherdSendToolDefinition: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "shepherd_send",
      description: `Type into one coding agent's terminal on this machine for the human you are talking with, because they asked you to. Use it only to submit that human's own instruction or keypress ("tell it to run the tests", "approve that", "stop it"): never on your own initiative, and never for anyone else. Give exactly one of text or key. text is one line (at most ${SEND_TEXT_MAX_CHARS} characters, no control characters), typed as "[<your configured name> for <their name>] <text>" and submitted with Enter. key is pressed alone: one of ${SEND_KEYS.join(", ")} (a menu or permission prompt, escape to interrupt, ctrl-c to cancel). enter, tab, a digit, y and n can approve or choose on a prompt, so they need screen from a shepherd_read made just before, and nothing is sent if the terminal changed since; tell the human what a prompt asks before approving it unless they have seen it. Pass screen with text too when the text answers what is on screen. To interrupt and then instruct, send escape, read again, then send the text. It also types into the terminal the human has focused on this machine. submission.state accepted means only that the terminal host accepted input; it may still be queued behind credential approval or a busy agent. It does not prove receiver receipt, resumed execution, restored capability or useful progress. Report those as unverified, never "unblocked" or "all unblocked" from this result or an unchanged screen. Each stronger claim needs fresh evidence from the exact target instance after this attempt, tied to this instruction; receipt alone is not progress or restored credentials. unknown may already have arrived: preserve the attempt and do not blindly resend.`,
      parameters: {
        type: "object",
        properties: {
          session: { type: "string", description: "Session id or ref (surface:12) from shepherd_overview." },
          text: { type: "string", description: "The human's instruction, one line. Sent with [<your configured name> for <their name>] and Enter." },
          key: { type: "string", enum: [...SEND_KEYS], description: "One key to press instead of text." },
          screen: { type: "string", description: "The screen fingerprint from the shepherd_read just before. Required for enter, tab, a digit, y and n." },
        },
        required: ["session"],
        additionalProperties: false,
      },
    },
  },
  handler: (args, ctx) => {
    const session = text(args.session).trim()
    const line = text(args.text).trim()
    const key = text(args.key).trim().toLowerCase()
    const seen = text(args.screen).trim()
    const friend = ctx?.context?.friend
    const meta = { session, chars: line.length, key: key || null, friendId: friend?.id ?? null }
    const refuse = (reason: string): Promise<string> => Promise.resolve(JSON.stringify(refused(reason, meta)))
    // The private runtime talks to itself as a family "friend"; only a real family member's request may type.
    if (!friend || friend.trustLevel !== "family" || friend.id === SELF_FRIEND_ID) return refuse("shepherd_send types only for a family member who asked for it in this conversation")
    if (!session) return refuse("name a session id or ref from shepherd_overview")
    if (!line === !key) return refuse("give exactly one of text or key")
    if (key && !(SEND_KEYS as readonly string[]).includes(key)) return refuse(`key must be one of ${SEND_KEYS.join(", ")}`)
    if (line.length > SEND_TEXT_MAX_CHARS) return refuse(`text must be at most ${SEND_TEXT_MAX_CHARS} characters`)
    if (/[\p{Cc}\u2028\u2029]/u.test(line)) return refuse("text must be one line with no control characters; press enter, escape or ctrl-c with key")
    if (CHOOSING_KEYS.has(key) && !seen) return refuse(`${key} can approve or choose on a prompt, so pass screen from a shepherd_read made just before`)
    return withHost("shepherd_send", ctx, async (host) => {
      assertBoundShepherdTarget(ctx?.currentShepherdSurface, session, host.name)
      const target = (await host.list()).find((entry) => entry.id === session || entry.ref === session)
      if (!target) return refused(`session ${session} is gone; check shepherd_overview`, meta)
      // Read again right before typing, as Shepherd does before its own answers: a gone or changed screen gets nothing.
      const now = screenFingerprint(await host.read(target.id, FINGERPRINT_READ_LINES))
      if (seen && seen !== now) return refused("the terminal changed since it was read, so nothing was sent; read it again", meta)
      const typed = key ? null : `[${readAgentPresentation(ctx!.agentName!, ctx!.agentRoot!).name} for ${friend.name}] ${line}`
      const input = key ? { key } : { text: typed }
      const attemptId = randomUUID()
      const attemptedAt = new Date().toISOString()
      const receiptTarget = { host: host.name, id: target.id, ref: target.ref, instance: target.instance ?? null }
      const verification = { received: "unverified", execution: "unverified", capability: "unverified", progress: "unverified" }
      const retry = "Do not resend blindly; reconcile this attempt with the exact receiver first."
      // A rejected/expired call can follow a partial paste or an accepted key.
      // Neither host provides an agent-receipt or progress acknowledgement here.
      try {
        if (key) await host.key(target.id, key as ShepherdKey)
        else await host.prompt(target.id, typed!)
      } catch (error) {
        const message = redactSecrets(error instanceof Error ? error.message : String(error))
        emitNervesEvent({
          level: "warn", component: "repertoire", event: "repertoire.shepherd_send_unknown",
          message: "terminal input outcome is unknown; do not blindly resend",
          meta: { ...meta, session: target.id, ref: target.ref, instance: target.instance ?? null, attemptId, attemptedAt, error: message },
        })
        return {
          error: message, session: target.ref, attempted: input,
          submission: { state: "unknown", attemptId, attemptedAt, reportedAt: new Date().toISOString(), target: receiptTarget },
          verification, retry,
        }
      }
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.shepherd_send",
        message: "terminal host accepted input; receiver receipt and progress unverified",
        meta: { ...meta, session: target.id, ref: target.ref, instance: target.instance ?? null, attemptId, attemptedAt, agent: target.agent, focused: target.focused, screenChecked: !!seen },
      })
      await host.signal(target.id, `submitted for ${friend.name}; receipt unverified`.slice(0, STATUS_MAX_CHARS)).catch(() => undefined)
      return {
        session: target.ref, submitted: input, focused: target.focused,
        submission: { state: "accepted", attemptId, attemptedAt, reportedAt: new Date().toISOString(), target: receiptTarget },
        verification, retry,
      }
    })
  },
  summaryKeys: ["session", "key"],
  riskProfile: { mutates: "external_side_effect", risk: "high", reason: "types into a coding agent's terminal for the human, which can answer or approve its prompts" },
}

export const shepherdToolDefinitions: ToolDefinition[] = [shepherdOverviewToolDefinition, shepherdReadToolDefinition, shepherdSignalToolDefinition, shepherdSendToolDefinition, ...shepherdGuidanceToolDefinitions]
