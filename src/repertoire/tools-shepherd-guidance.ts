import { readMachineRuntimeCredentialConfig } from "../heart/runtime-credentials"
import { createHash } from "node:crypto"
import { resolveShepherdConnection } from "../heart/shepherd-config"
import { createShepherdHost } from "../senses/shepherd/host"
import {
  applicableGuidance, forgetShepherdPrinciple, readGuidance, recordShepherdCorrection,
  setShepherdSessionPause, shepherdReturnId, updateShepherdPrinciple,
  type ShepherdGuidanceScope, type ShepherdGuidanceTarget,
} from "../senses/shepherd/guidance"
import { redactSecrets } from "../senses/shepherd/redact"
import { readReturns, type ReturnRecord } from "../senses/shepherd/returns"
import { knownNotice, noticeRecordId, readNoticeOutbox, type NoticeDelivery } from "../senses/shepherd/notice-outbox"
import { assertBoundShepherdTarget } from "../senses/shepherd/target-binding"
import { SELF_FRIEND_ID, type ToolContext, type ToolDefinition, type ToolDoorCard, type ToolErrorCard } from "./tools-base"
import { emitNervesEvent } from "../nerves/runtime"

type Args = Record<string, unknown>
type ToolRun = { actorId: string; requestId: string; requestFingerprint: string }
const text = (value: unknown): string => typeof value === "string" ? value.trim() : ""
const json = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => typeof item === "string" ? redactSecrets(item) : item)
const stringProperty = (description: string) => ({ type: "string" as const, description })
const targetProperties = {
  host: stringProperty("Host name from history, when known. Never invent a host."),
  session: stringProperty("Stable session ID from history, or a live session ID/ref from shepherd_overview."),
}
const requestProperty = { request_id: stringProperty("Unique request ID for this human instruction. Reuse it only to retry the identical request.") }
function fingerprint(name: string, args: Args): string {
  const body = JSON.stringify({ name, args }, (_key, value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)
  return createHash("sha256").update(body).digest("hex")
}

/**
 * Resolve history without a terminal connection, including vanished sessions. Only a session with no history needs
 * the existing machine connection primitives. Resolving it never reads a screen, signals, presses a key or sends.
 */
async function targetFor(ctx: ToolContext, args: Args): Promise<{ target: ShepherdGuidanceTarget; live: ShepherdGuidanceTarget[] }> {
  const session = text(args.session) || ctx.currentShepherdSurface?.id || ""
  const hostName = text(args.host) || ctx.currentShepherdSurface?.host || ""
  if (session) assertBoundShepherdTarget(ctx.currentShepherdSurface, session, hostName || undefined)
  const records = readReturns(ctx.agentRoot!)
  const returnId = text(args.return_id)
  if (returnId) {
    const record = records.find(r => shepherdReturnId(r) === returnId)
    if (!record) throw new Error("Shepherd return ID not found")
    assertBoundShepherdTarget(ctx.currentShepherdSurface, record.session, record.host)
    if ((text(args.host) && text(args.host) !== record.host) || (text(args.session) && text(args.session) !== record.session)) throw new Error("target does not match the recorded return")
    return { target: { host: record.host, session: record.session, cwd: record.cwd, task: record.task }, live: [] }
  }
  if (!session) throw new Error("name a session from Shepherd history or overview")
  const matching = records.filter(r => r.session === session && (!hostName || r.host === hostName))
  if (new Set(matching.map(r => r.host)).size > 1) throw new Error("session is ambiguous across hosts; name its host")
  const record = matching.at(-1)
  if (record) {
    assertBoundShepherdTarget(ctx.currentShepherdSurface, record.session, record.host)
    return { target: { host: record.host, session, cwd: record.cwd, task: record.task }, live: [] }
  }
  const machine = readMachineRuntimeCredentialConfig(ctx.agentName!)
  const resolved = resolveShepherdConnection(ctx.agentName!, machine.ok ? machine.config : {})
  if (!resolved.ok) throw new Error(resolved.error)
  const host = createShepherdHost(resolved.connection, { agentName: ctx.agentName! })
  const sessions = await host.list()
  const live = sessions.map(s => ({ host: host.name, session: s.id, cwd: s.cwd ?? null, task: null }))
  const found = sessions.find(s => s.id === session || s.ref === session)
  if (!found || (hostName && hostName !== host.name)) throw new Error("unknown session on the configured Shepherd host")
  assertBoundShepherdTarget(ctx.currentShepherdSurface, found.id, host.name)
  return { target: live.find(t => t.session === found.id)!, live }
}

/** A guidance tool's card: the family gate every one shares, then its own failure and what to do about it. */
function card(name: string, when: string, failed: { means: string; fix: string }, mutates = false): ToolDoorCard {
  const errors: ToolErrorCard[] = [
    { code: "family-only", means: "The person in this conversation isn't a real family member, so Shepherd's private guidance stays closed.", fix: `Tell them ${name} is only for the family; change nothing.` },
    { code: "no-agent-runtime", means: "The call ran outside an agent's runtime, so there is no guidance store to use.", fix: `Don't retry; report that ${name} was called without an agent runtime.` },
    { code: "guidance-failed", ...failed },
  ]
  return { id: `tool:${name}`, group: "turn-shepherd", when, effect: mutates ? "write" : "read", errors, ...(mutates ? { idempotent: true as const } : {}) }
}

function definition(name: string, description: string, ax: ToolDoorCard, properties: Record<string, unknown>, required: string[], run: (args: Args, ctx: ToolContext, request: ToolRun) => Promise<unknown>, mutates = false): ToolDefinition {
  return {
    tool: { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } },
    ax,
    handler: async (args, ctx) => {
      // Same real-family gate as shepherd_send, including rejection of the private runtime's family self.
      const friend = ctx?.context?.friend
      if (!friend || friend.trustLevel !== "family" || !friend.id || friend.id === SELF_FRIEND_ID) return json({ error: "Shepherd private guidance is only for a real family member in this conversation", code: "family-only" })
      if (!ctx?.agentRoot || !ctx.agentName) return json({ error: "Shepherd guidance needs an agent runtime", code: "no-agent-runtime" })
      try {
        const boundDefault = name === "shepherd_correct" && !text(args.session) && !text(args.return_id) && ctx.currentShepherdSurface
        const request: ToolRun = { actorId: friend.id, requestId: text(args.request_id), requestFingerprint: fingerprint(name,
          boundDefault ? { ...args, session: boundDefault.id, host: boundDefault.host } : args) }
        if (mutates) {
          const prior = readGuidance(ctx.agentRoot).requests.find(r => r.actorId === request.actorId && r.requestId === request.requestId)
          if (prior) {
            if (prior.requestFingerprint !== request.requestFingerprint) throw new Error("request ID was already used with a different body")
            return json(prior.receipt)
          }
        }
        const result = await run(args, ctx, request)
        emitNervesEvent({ component: "repertoire", event: "repertoire.shepherd_guidance_tool", message: "executed a private Shepherd guidance tool", meta: { tool: name, mutates } })
        return json(result)
      }
      catch (error) {
        const message = redactSecrets(error instanceof Error ? error.message : String(error))
        emitNervesEvent({ level: "warn", component: "repertoire", event: "repertoire.shepherd_guidance_tool_error", message: "private Shepherd guidance tool failed", meta: { tool: name, error: "private_guidance_operation_failed" } })
        return json({ error: message, code: "guidance-failed" })
      }
    },
    summaryKeys: [],
    riskProfile: mutates ? { mutates: "durable_state_write", risk: "high", reason: "changes private operator preferences or the automatic-reply pause" } : { mutates: "none", risk: "low" },
  }
}

export const shepherdGuidanceToolDefinitions: ToolDefinition[] = [
  definition("shepherd_history", "Read private Shepherd return history with stable return IDs, actual judgment/reply/outcome and your own ownerNotice receipts when tracked. Historical, not current status; a vanished terminal remains readable. The session filter is a stable ID, not a short ref. Use to understand 'that was wrong because...' before correcting it, or to check whether a notice was sent. Use displayId as the human-facing return label; never invent a shortened ID suffix. Mutations require the exact full id, not displayId. ownerNotice.state sent means transport acceptance, not proof the human read it; pending awaits a safe retry; unknown may already have arrived and must not be blindly replayed. messageId is the activity ID returned by transport. ownerNotice null means no receipt recorded for this recipient, not proof of non-delivery. ownerNoticeError explicitly identifies unavailable receipt evidence. Never types into a terminal.",
  card("shepherd_history", "Pick this to look back at what Shepherd judged and replied in a session, even one that closed, before anyone corrects it.", { means: "The history couldn't be read; the error says why, such as a session not bound to this chat.", fix: "Drop the session filter, or use the stable id from an earlier shepherd_history, and call again." }),
  targetProperties, [], async (args, ctx, request) => {
    const session = text(args.session) || ctx.currentShepherdSurface?.id
    const host = text(args.host) || ctx.currentShepherdSurface?.host
    if (session) assertBoundShepherdTarget(ctx.currentShepherdSurface, session, host)
    const returns: Array<ReturnRecord & { id: string; displayId: string; ownerNotice?: NoticeDelivery | null }> = readReturns(ctx.agentRoot!)
      .filter(r => (!session || r.session === session) && (!host || r.host === host))
      .map(record => {
        const id = shepherdReturnId(record)
        return { ...record, id, displayId: id.slice("return:".length, "return:".length + 8) }
      })
    try {
      const notices = readNoticeOutbox(ctx.agentRoot!)
      for (const record of returns) {
        const notice = knownNotice(ctx.agentRoot!, noticeRecordId(record), notices)
        if (notice) record.ownerNotice = Object.hasOwn(notice.deliveries, request.actorId) ? notice.deliveries[request.actorId]! : null
      }
      return { returns }
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : String(error))
      emitNervesEvent({ level: "warn", component: "repertoire", event: "repertoire.shepherd_notice_history_error", message: "owner notice receipt evidence is unavailable; return history remains readable", meta: { error: "notice_receipts_unavailable" } })
      return { returns, ownerNoticeError: message }
    }
  }),
  definition("shepherd_correct", "Record the human's post-action correction ('that was wrong because…') or prospective instruction. Optionally learn a principle for 'in future…'. A return_id must name a real history entry; omit it for a prospective instruction, never fabricate one. Session scope is the default; project is the exact recorded folder and optional task; global only when the human deliberately generalizes. Feedback <=2000 characters; principle <=1000; at most 20 active rules. This is not an approval gate and never sends anything. For requested immediate steering use existing shepherd_send.",
  card("shepherd_correct", "Pick this when the human says Shepherd got something wrong or tells it how to behave next time; shepherd_send steers now.", { means: "Nothing was recorded; the error says why: an unknown return_id or session, a reused request_id, or text over its limit.", fix: "Fix what the error names (take ids from shepherd_history) and call again with a new request_id." }, true),
  {
    ...targetProperties, ...requestProperty,
    return_id: stringProperty("Real stable return ID from shepherd_history, if correcting an actual judgment."),
    feedback: stringProperty("The human's explanation or prospective instruction, at most 2000 characters."),
    principle: stringProperty("Optional scoped future preference, at most 1000 characters."),
    scope: { type: "string", enum: ["session", "project", "global"], description: "Default session. Choose global only when the human expressed generalization." },
  }, ["request_id", "feedback"], async (args, ctx, request) => {
    const { target, live } = await targetFor(ctx, args)
    return recordShepherdCorrection(ctx.agentRoot!, {
      ...request, target, feedback: typeof args.feedback === "string" ? args.feedback : "",
      ...(args.return_id !== undefined ? { returnId: text(args.return_id) } : {}),
      ...(args.principle !== undefined ? { principle: typeof args.principle === "string" ? args.principle : "" } : {}),
      ...(args.scope !== undefined ? { scope: args.scope as ShepherdGuidanceScope } : {}),
    }, live)
  }, true),
  definition("shepherd_guidance", "Inspect what Shepherd learned ('what did you learn?'). With a session, returns revision, pause and applicable active principles with IDs, scopes and operator provenance. Omit session to inspect all active principles and pauses, including their exact targets. No send.",
  card("shepherd_guidance", "Pick this when the human asks what Shepherd has learned, or before you change or forget one of its preferences.", { means: "The guidance for that target couldn't be read; the error says why, such as an unknown session.", fix: "Call again without session to see every active principle and pause." }),
  targetProperties, [], async (args, ctx) => {
    if (args.session === undefined && !ctx.currentShepherdSurface) {
      const state = readGuidance(ctx.agentRoot!)
      return { revision: state.revision, principles: state.principles.filter(p => p.active), pauses: state.pauses.filter(p => p.paused) }
    }
    const { target } = await targetFor(ctx, args)
    return applicableGuidance(readGuidance(ctx.agentRoot!), target)
  }),
  definition("shepherd_update_principle", "Change a learned preference ('change that') by its principle ID. Keeps its existing scope, never silently generalizes it. No send.",
  card("shepherd_update_principle", "Pick this when the human wants a preference Shepherd already holds reworded; for a new one use shepherd_correct.", { means: "The preference wasn't changed; the error says why: an unknown or inactive principle_id, empty or long text, or a reused request_id.", fix: "Take the id from shepherd_guidance, keep text under 1000 characters, and call with a new request_id." }, true),
  {
    ...requestProperty, principle_id: stringProperty("Active principle ID from shepherd_guidance."), text: stringProperty("Replacement preference, nonempty and at most 1000 characters."),
  }, ["request_id", "principle_id", "text"], async (args, ctx, request) => updateShepherdPrinciple(ctx.agentRoot!, {
    ...request, principleId: text(args.principle_id), text: typeof args.text === "string" ? args.text : "",
  }), true),
  definition("shepherd_forget_principle", "Forget a learned preference ('forget that') by its ID. Removes only that preference from future judgments but retains the private operator trail. Built-in judgment policy, including legitimate outside dependency waits, and all existing guards remain unchanged: forgetting does not make dependency waits premature or delivered done. No send.",
  card("shepherd_forget_principle", "Pick this when the human wants Shepherd to drop a learned preference entirely, keeping the record of who set it.", { means: "Nothing was forgotten; the error says why: an unknown or inactive principle_id, or a reused request_id.", fix: "Take the principle id from shepherd_guidance and call again with a new request_id." }, true),
  {
    ...requestProperty, principle_id: stringProperty("Active principle ID from shepherd_guidance."),
  }, ["request_id", "principle_id"], async (args, ctx, request) => forgetShepherdPrinciple(ctx.agentRoot!, {
    ...request, principleId: text(args.principle_id),
  }), true),
  ...(["pause", "resume"] as const).map(action => definition(`shepherd_${action}`,
    action === "pause" ? "Leave this one alone: pause automatic Shepherd replies for this session only, durably. Independent judgment/owner notices remain. Never interrupts or types into the terminal."
      : "Resume automatic Shepherd replies for this paused session. All focus, screen, syntax and loop guards still apply; resume is not an immediate send.",
    action === "pause"
      ? card("shepherd_pause", "Pick this when the human says to leave one session alone, so Shepherd stops answering it until resumed.", { means: "The session wasn't paused; the error says why, such as an unknown session or a reused request_id.", fix: "Name the session from shepherd_overview or shepherd_history and call with a new request_id." }, true)
      : card("shepherd_resume", "Pick this when the human wants Shepherd answering a session it was told to leave alone again.", { means: "The session wasn't resumed; the error says why, such as an unknown session or a reused request_id.", fix: "Check the paused session's id with shepherd_guidance and call with a new request_id." }, true),
    { ...targetProperties, ...requestProperty }, ["session", "request_id"], async (args, ctx, request) => {
      const { target, live } = await targetFor(ctx, args)
      return setShepherdSessionPause(ctx.agentRoot!, { ...request, target, paused: action === "pause" }, live)
    }, true)),
]
