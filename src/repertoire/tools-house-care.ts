import * as fs from "node:fs"
import { createHash } from "node:crypto"
import { appendReplayNotice, isReplayIdentity, isReplayWindowOpen } from "../a2a/replay-harness"
import { defaultNotifyOwner, type NotifyOwner } from "../heart/awaiting/a2a-await-delivery"
import { emitNervesEvent } from "../nerves/runtime"
import { lastReportPath, readLedger, runHouseSweep, writeLedger, type HouseSweepDeps } from "./house-sweep"
import type { ToolContext, ToolDefinition } from "./tools-base"

/**
 * The Butler's two house-care tools. `house_sweep` is one read-only call that gathers everything the daily sweep
 * covers. `house_digest_send` is the only way the sweep reaches the owner: it refuses an empty digest, sends one short
 * owner notice through the existing owner-notice path (the replay sink when a replay window is open for the asker),
 * and only then records the findings as told, so the same finding is not repeated unless it changed.
 */

export const DIGEST_MAX_CHARS = 1500

export interface HouseCareToolDeps {
  notifyOwner?: (agentName: string) => NotifyOwner
  sweepDeps?: Partial<HouseSweepDeps>
  now?: () => number
}

let injected: HouseCareToolDeps = {}
export function setHouseCareToolDeps(deps: HouseCareToolDeps): void { injected = deps }

/** The friend whose request this turn serves; absent on the Butler's own scheduled turns. */
function askerFriendId(ctx: ToolContext | undefined): string | undefined {
  return ctx?.context?.friend?.id ?? ctx?.relationshipAuthorization?.actor?.friendId
}

function replayAsker(ctx: ToolContext | undefined): boolean {
  const friendId = askerFriendId(ctx)
  return Boolean(friendId && ctx?.agentRoot && isReplayIdentity(ctx.agentRoot, friendId))
}

export const houseSweepToolDefinition: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "house_sweep",
      description: "The daily house-care sweep in one read-only call. It checks stalled or failed downloads, monitored-but-missing episodes and movies, and failed imports in Sonarr and Radarr; disk, array capacity and parity; container state against the steward policy; and delegation, escalation and standing-permission grants that expire or no longer work. It returns a compact report: the queue state, the findings (each says whether a tool may fix it and which), the ids that are new since the owner was last told (fresh), and whether a digest is due. It changes nothing in the house. Run it when the owner asks about the house or for a sweep, and on the daily house-care await.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  handler: async (_args, ctx) => {
    if (!ctx?.agentRoot) return JSON.stringify({ error: "house sweep runtime is unavailable" })
    const report = await runHouseSweep({ agentRoot: ctx.agentRoot, sanctuary: ctx.sanctuary, replay: replayAsker(ctx), now: injected.now, ...injected.sweepDeps })
    return JSON.stringify(report)
  },
  summaryKeys: [],
  riskProfile: { mutates: "none", risk: "low" },
}

export const houseDigestToolDefinition: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "house_digest_send",
      description: "Send the owner ONE short house-care digest, only when the latest house_sweep left findings that need their choice. Give finding_ids from that sweep (never a finding the owner was already told about unchanged). text is optional: omitted, the digest is the findings' own summaries; supply a short plain version if you prefer, naming each item. It is refused when no valid finding id is given, so an empty digest cannot be sent. Delivery goes through the owner-notice path; for a replay request it goes to the replay sink, never to the owner.",
      parameters: {
        type: "object",
        properties: {
          finding_ids: { type: "array", items: { type: "string" }, description: "Ids from the latest house_sweep." },
          text: { type: "string", description: `Optional digest text, at most ${DIGEST_MAX_CHARS} characters.` },
        },
        required: ["finding_ids"],
        additionalProperties: false,
      },
    },
  },
  handler: async (args, ctx) => {
    const agentRoot = ctx?.agentRoot
    if (!agentRoot) return JSON.stringify({ error: "house sweep runtime is unavailable" })
    const rawIds = (args as unknown as { finding_ids?: unknown }).finding_ids
    const ids = Array.isArray(rawIds) ? [...new Set(rawIds.filter((id): id is string => typeof id === "string" && id.length > 0))] : []
    if (ids.length === 0) return JSON.stringify({ sent: false, error: "no digest: name at least one finding id from the latest house_sweep. When nothing needs the owner, say nothing." })
    const replay = replayAsker(ctx)
    const scope = replay ? "replay" : "live"
    let last: { findings?: { id: string; fingerprint: string; summary: string }[] } = {}
    try { last = JSON.parse(fs.readFileSync(lastReportPath(agentRoot, scope), "utf8")) } catch { /* no sweep yet */ }
    const known = new Map((last.findings ?? []).map((finding) => [finding.id, finding]))
    const unknown = ids.filter((id) => !known.has(id))
    if (unknown.length > 0) return JSON.stringify({ sent: false, error: `unknown finding ids: ${unknown.join(", ")}. Run house_sweep first and use its ids.` })
    const chosen = ids.map((id) => known.get(id)!)
    const supplied = typeof args.text === "string" ? args.text.trim() : ""
    if (supplied.length > DIGEST_MAX_CHARS) return JSON.stringify({ sent: false, error: `digest is too long (${supplied.length} characters, at most ${DIGEST_MAX_CHARS}); make it shorter` })
    const body = supplied || chosen.map((finding) => `- ${finding.summary}`).join("\n")
    const now = (injected.now ?? Date.now)()
    const digest = createHash("sha256").update(chosen.map((finding) => finding.fingerprint).sort().join(",")).digest("hex").slice(0, 12)
    const friendId = askerFriendId(ctx)
    const agentName = ctx.agentName ?? "sanctuary"

    if (replay) {
      // A replay identity's digest never reaches the owner: it goes to the sink while the window is open, and is refused when it is not.
      if (!friendId || !isReplayWindowOpen(agentRoot, friendId, now)) return JSON.stringify({ sent: false, error: "this is a replay request and no replay window is open for it, so nothing was sent to the owner" })
      appendReplayNotice(agentRoot, { noticeId: `house-sweep:replay:${now}:${digest}`, text: body, friendId }, now)
      emitNervesEvent({ component: "repertoire", event: "repertoire.house_digest_sent", message: "house digest written to the replay sink", meta: { findings: ids.length, destination: "replay-sink" } })
      return JSON.stringify({ sent: true, destination: "replay sink", findings: ids.length })
    }

    const kind = ctx.autonomousTurnKind === "await" ? "scheduled" : "ondemand"
    const day = new Date(now).toISOString().slice(0, 10)
    try {
      await (injected.notifyOwner ? injected.notifyOwner(agentName) : defaultNotifyOwner(agentName))({ noticeId: `house-sweep:${kind}:${day}:${digest}`, text: body })
    } catch (error) {
      return JSON.stringify({ sent: false, error: `the owner notice could not be sent: ${error instanceof Error ? error.message : String(error)}. Nothing was recorded as told, so the next sweep will try again.` })
    }
    const ledger = readLedger(agentRoot)
    for (const finding of chosen) ledger[finding.id] = { fingerprint: finding.fingerprint, reportedAt: new Date(now).toISOString() }
    writeLedger(agentRoot, ledger)
    emitNervesEvent({ component: "repertoire", event: "repertoire.house_digest_sent", message: "house digest sent to the owner", meta: { findings: ids.length, destination: "owner", kind } })
    return JSON.stringify({ sent: true, destination: "owner", findings: ids.length })
  },
  summaryKeys: ["finding_ids"],
  riskProfile: { mutates: "external_side_effect", risk: "high", reason: "sends the owner a Telegram notice" },
}

export const houseCareToolDefinitions: ToolDefinition[] = [houseSweepToolDefinition, houseDigestToolDefinition]
