import { createHash } from "node:crypto"
import { appendReplayNotice, isReplayIdentity, isReplayWindowOpen } from "../a2a/replay-harness"
import { defaultNotifyOwner, type NotifyOwner } from "../heart/awaiting/a2a-await-delivery"
import { emitNervesEvent } from "../nerves/runtime"
import { clip, readLastDigestAt, readLedger, recallSweep, REMIND_DAYS, runHouseSweep, safe, sameUtcDay, writeLedger, type HouseSweepDeps } from "./house-sweep"
import type { ToolContext, ToolDefinition } from "./tools-base"

/**
 * The Butler's two house-care tools. `house_sweep` is one read-only call that gathers everything the daily sweep
 * covers. `house_digest_send` is the only way the sweep reaches the owner: it refuses an empty digest, sends one short
 * owner notice through the existing owner-notice path (the replay sink when a replay window is open for the asker),
 * and only then records the findings as told, so the same finding is not repeated unless it changed.
 */

export const LEAD_IN_MAX_CHARS = 140
const DAY_MS = 86_400_000
const HOUSE_CARE_AWAIT = "house-care-sweep"
const PEER_NAME_MAX = 40
/** Addresses a lead-in must not carry: a bare domain (word.tld), an @mention, mailto:, or any bidi, zero-width or invisible character. */
const LEAD_IN_FORBIDDEN = /\b[a-z0-9-]+\.[a-z]{2,}\b|@\w|mailto:|[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/iu

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
      description: "Send the owner ONE short house-care digest, only when the latest house_sweep left findings that need their choice. Give finding_ids from that sweep (never a finding the owner was already told about unchanged). The digest body is always the findings' own summaries; you cannot change them. lead_in is an optional single line of at most 140 characters placed above them. It is refused when no valid finding id is given, when a finding was already told unchanged within 7 days, and when a digest already went out today. Delivery goes through the owner-notice path; for a replay request it goes to the replay sink, never to the owner.",
      parameters: {
        type: "object",
        properties: {
          finding_ids: { type: "array", items: { type: "string" }, description: "Ids from the latest house_sweep." },
          lead_in: { type: "string", description: `Optional one-line lead-in, at most ${LEAD_IN_MAX_CHARS} characters.` },
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
    // The digest comes only from the sweep THIS process ran. Files under state/house-sweep/ are writable by the resident's uid: untrusted bookkeeping, never a source of owner-facing text.
    const last = recallSweep(agentRoot, scope)
    if (!last) return JSON.stringify({ sent: false, error: "no sweep has run in this session: run house_sweep first and use its finding ids." })
    const known = new Map(last.map((finding) => [finding.id, finding]))
    const unknown = ids.filter((id) => !known.has(id))
    if (unknown.length > 0) return JSON.stringify({ sent: false, error: `unknown finding ids: ${unknown.join(", ")}. Run house_sweep first and use its ids.` })
    const chosen = ids.map((id) => known.get(id)!)
    const rawLead = (args as unknown as { lead_in?: unknown }).lead_in
    const leadIn = typeof rawLead === "string" ? rawLead.trim() : ""
    if (leadIn.length > LEAD_IN_MAX_CHARS || safe(leadIn) !== leadIn || LEAD_IN_FORBIDDEN.test(leadIn)) return JSON.stringify({ sent: false, error: `lead_in must be one plain line of at most ${LEAD_IN_MAX_CHARS} characters, with no links, addresses, mentions or hidden characters` })
    const now = (injected.now ?? Date.now)()
    const digest = createHash("sha256").update(chosen.map((finding) => finding.fingerprint).sort().join(",")).digest("hex").slice(0, 12)
    const friendId = askerFriendId(ctx)
    const agentName = ctx.agentName ?? "sanctuary"
    // A peer's digest says whose it is; the body is only ever the stored finding summaries.
    const peer = ctx.relationshipAuthorization?.profileId === "sanctuary-agent-peer" ? `From ${clip(safe(ctx.context?.friend?.name ?? friendId ?? "a peer"), PEER_NAME_MAX) || "a peer"}:\n` : ""
    const body = `${peer}${leadIn ? `${leadIn}\n` : ""}${chosen.map((finding) => `- ${clip(safe(finding.summary), 220)}`).join("\n")}`

    if (replay) {
      // A replay identity's digest never reaches the owner: it goes to the sink while the window is open, and is refused when it is not.
      if (!friendId || !isReplayWindowOpen(agentRoot, friendId, now)) return JSON.stringify({ sent: false, error: "this is a replay request and no replay window is open for it, so nothing was sent to the owner" })
      appendReplayNotice(agentRoot, { noticeId: `house-sweep:replay:${now}:${digest}`, text: body, friendId }, now)
      emitNervesEvent({ component: "repertoire", event: "repertoire.house_digest_sent", message: "house digest written to the replay sink", meta: { findings: ids.length, destination: "replay-sink" } })
      return JSON.stringify({ sent: true, destination: "replay sink", findings: ids.length })
    }

    // Enforced here, not only in the sweep: the ledger is reloaded at send time.
    const ledger = readLedger(agentRoot)
    const priorStamp = readLastDigestAt(agentRoot)
    const stamp = new Date(now).toISOString()
    const told = chosen.filter((finding) => {
      const entry = ledger[finding.id]
      return entry !== undefined && entry.fingerprint === finding.fingerprint && now - Date.parse(entry.reportedAt) < REMIND_DAYS * DAY_MS
    })
    if (told.length > 0) return JSON.stringify({ sent: false, error: `the owner was already told about ${told.map((finding) => finding.id).join(", ")} unchanged in the last ${REMIND_DAYS} days; leave ${told.length === 1 ? "it" : "them"} out` })
    // Only the daily house-care await's own tick, with no friend or relationship behind it, is "scheduled" and takes the one-per-day slot; on-demand digests are limited by the per-finding dedupe above.
    const kind = ctx.autonomousTurnKind === "await" && ctx.autonomousAwaitName === HOUSE_CARE_AWAIT && !ctx.relationshipAuthorization && !friendId ? "scheduled" : "ondemand"
    if (kind === "scheduled" && sameUtcDay(priorStamp, stamp)) return JSON.stringify({ sent: false, error: "the daily house digest already went out today; at most one scheduled digest is sent per day" })
    const day = stamp.slice(0, 10)
    // Reserve before sending so a crash or a concurrent turn cannot send twice; a failed send rolls the reservation back.
    const reserved = { ...ledger }
    for (const finding of chosen) reserved[finding.id] = { fingerprint: finding.fingerprint, reportedAt: stamp }
    writeLedger(agentRoot, reserved, kind === "scheduled" ? stamp : priorStamp)
    try {
      await (injected.notifyOwner ? injected.notifyOwner(agentName) : defaultNotifyOwner(agentName))({ noticeId: `house-sweep:${kind}:${day}:${digest}`, text: body })
    } catch (error) {
      writeLedger(agentRoot, ledger, priorStamp)
      return JSON.stringify({ sent: false, error: `the owner notice could not be sent: ${error instanceof Error ? error.message : String(error)}. Nothing was recorded as told, so the next sweep will try again.` })
    }
    emitNervesEvent({ component: "repertoire", event: "repertoire.house_digest_sent", message: "house digest sent to the owner", meta: { findings: ids.length, destination: "owner", kind } })
    return JSON.stringify({ sent: true, destination: "owner", findings: ids.length })
  },
  summaryKeys: ["finding_ids"],
  riskProfile: { mutates: "external_side_effect", risk: "high", reason: "sends the owner a Telegram notice" },
}

export const houseCareToolDefinitions: ToolDefinition[] = [houseSweepToolDefinition, houseDigestToolDefinition]
