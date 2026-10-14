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
import { readReturns } from "../senses/shepherd/returns"
import { assertBoundShepherdTarget } from "../senses/shepherd/target-binding"
import { SELF_FRIEND_ID, type ToolContext, type ToolDefinition } from "./tools-base"
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
  if (text(args.session)) assertBoundShepherdTarget(ctx.currentShepherdSurface, text(args.session), text(args.host) || undefined)
  const records = readReturns(ctx.agentRoot!)
  const returnId = text(args.return_id)
  if (returnId) {
    const record = records.find(r => shepherdReturnId(r) === returnId)
    if (!record) throw new Error("Shepherd return ID not found")
    assertBoundShepherdTarget(ctx.currentShepherdSurface, record.session, record.host)
    if ((text(args.host) && text(args.host) !== record.host) || (text(args.session) && text(args.session) !== record.session)) throw new Error("target does not match the recorded return")
    return { target: { host: record.host, session: record.session, cwd: record.cwd, task: record.task }, live: [] }
  }
  const session = text(args.session)
  if (!session) throw new Error("name a session from Shepherd history or overview")
  const hostName = text(args.host)
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

function definition(name: string, description: string, properties: Record<string, unknown>, required: string[], run: (args: Args, ctx: ToolContext, request: ToolRun) => Promise<unknown>, mutates = false): ToolDefinition {
  return {
    tool: { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } },
    handler: async (args, ctx) => {
      // Same real-family gate as shepherd_send, including rejection of the private runtime's family self.
      const friend = ctx?.context?.friend
      if (!friend || friend.trustLevel !== "family" || !friend.id || friend.id === SELF_FRIEND_ID) return json({ error: "Shepherd private guidance is only for a real family member in this conversation" })
      if (!ctx?.agentRoot || !ctx.agentName) return json({ error: "Shepherd guidance needs an agent runtime" })
      try {
        const request: ToolRun = { actorId: friend.id, requestId: text(args.request_id), requestFingerprint: fingerprint(name, args) }
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
        emitNervesEvent({ level: "warn", component: "repertoire", event: "repertoire.shepherd_guidance_tool_error", message: "private Shepherd guidance tool failed", meta: { tool: name, error: message } })
        return json({ error: message })
      }
    },
    summaryKeys: [],
    riskProfile: mutates ? { mutates: "durable_state_write", risk: "high", reason: "changes private operator preferences or the automatic-reply pause" } : { mutates: "none", risk: "low" },
  }
}

export const shepherdGuidanceToolDefinitions: ToolDefinition[] = [
  definition("shepherd_history", "Read private Shepherd return history with stable return IDs, the actual judgment, reply and outcome. Historical, not current status; a vanished terminal remains readable. Use to understand 'that was wrong because…' before correcting it. Never types into a terminal.", targetProperties, [], async (args, ctx) => ({
    returns: readReturns(ctx.agentRoot!).filter(r => (!text(args.session) || r.session === text(args.session)) && (!text(args.host) || r.host === text(args.host))).map(record => ({ id: shepherdReturnId(record), ...record })),
  })),
  definition("shepherd_correct", "Record the human's post-action correction ('that was wrong because…') or prospective instruction. Optionally learn a principle for 'in future…'. A return_id must name a real history entry; omit it for a prospective instruction, never fabricate one. Session scope is the default; project is the exact recorded folder and optional task; global only when the human deliberately generalizes. Feedback <=2000 characters; principle <=1000; at most 20 active rules. This is not an approval gate and never sends anything. For requested immediate steering use existing shepherd_send.", {
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
  definition("shepherd_guidance", "Inspect what Shepherd learned ('what did you learn?'). With a session, returns revision, pause and applicable active principles with IDs, scopes and operator provenance. Omit session to inspect all active principles and pauses, including their exact targets. No send.", targetProperties, [], async (args, ctx) => {
    if (args.session === undefined) {
      const state = readGuidance(ctx.agentRoot!)
      return { revision: state.revision, principles: state.principles.filter(p => p.active), pauses: state.pauses.filter(p => p.paused) }
    }
    const { target } = await targetFor(ctx, args)
    return applicableGuidance(readGuidance(ctx.agentRoot!), target)
  }),
  definition("shepherd_update_principle", "Change a learned preference ('change that') by its principle ID. Keeps its existing scope, never silently generalizes it. No send.", {
    ...requestProperty, principle_id: stringProperty("Active principle ID from shepherd_guidance."), text: stringProperty("Replacement preference, nonempty and at most 1000 characters."),
  }, ["request_id", "principle_id", "text"], async (args, ctx, request) => updateShepherdPrinciple(ctx.agentRoot!, {
    ...request, principleId: text(args.principle_id), text: typeof args.text === "string" ? args.text : "",
  }), true),
  definition("shepherd_forget_principle", "Forget a learned preference ('forget that') by its ID. Removes it from future judgments but retains the private operator trail. No send.", {
    ...requestProperty, principle_id: stringProperty("Active principle ID from shepherd_guidance."),
  }, ["request_id", "principle_id"], async (args, ctx, request) => forgetShepherdPrinciple(ctx.agentRoot!, {
    ...request, principleId: text(args.principle_id),
  }), true),
  ...(["pause", "resume"] as const).map(action => definition(`shepherd_${action}`,
    action === "pause" ? "Leave this one alone: pause automatic Shepherd replies for this session only, durably. Independent judgment/owner notices remain. Never interrupts or types into the terminal."
      : "Resume automatic Shepherd replies for this paused session. All focus, screen, syntax and loop guards still apply; resume is not an immediate send.",
    { ...targetProperties, ...requestProperty }, ["session", "request_id"], async (args, ctx, request) => {
      const { target, live } = await targetFor(ctx, args)
      return setShepherdSessionPause(ctx.agentRoot!, { ...request, target, paused: action === "pause" }, live)
    }, true)),
]
