import { createHash } from "crypto"
import * as fs from "fs"
import * as path from "path"
import { FileFriendStore } from "@ouro.bot/friends"
import { getTeamsConfig, getTeamsSecondaryConfig, type TeamsConfig } from "../heart/config"
import { loadAgentConfig } from "../heart/identity"
import { mayRunSense, readPresenceForAgent, type Presence } from "../heart/daemon/presence"
import { readMachineIdentity } from "../heart/machine-identity"
import { emitNervesEvent } from "../nerves/runtime"
import { chooseTeamsBot, liveBotApi } from "./shepherd/owner-notice"
import type { ProactiveTeamsSessionSendParams, ProactiveTeamsSessionSendResult, TeamsBotApi } from "./teams"
import type { OutboundOrigin } from "../heart/session-events"

/**
 * A Teams bot client for a turn that did not arrive on Teams (an `ouro msg`, a habit, an inner turn), so a send
 * to a Teams friend goes out now instead of waiting for that friend's next Teams message. It is built only where
 * the Teams sense runs: the sense is enabled and, under a presence roster, this machine may run it, so the agent
 * never speaks on Teams from two machines. Like Shepherd's owner notices, the client listens on no port: it only
 * acquires a bot token and calls the Bot Framework.
 */
export interface OffTurnTeamsDeps {
  agentRoot: string
  friendId: string
  teamsEnabled?: () => boolean
  presence?: () => Presence | null
  machineId?: () => string | null
  friendTenant?: (friendId: string) => Promise<string | undefined>
  primary?: () => TeamsConfig
  secondary?: () => TeamsConfig
  botApi?: (config: TeamsConfig) => Promise<TeamsBotApi>
}

const bots = new Map<string, Promise<TeamsBotApi>>()

/** Forget built clients (tests). */
export function resetOffTurnTeamsBots(): void {
  bots.clear()
}

function skip(friendId: string, reason: string, level: "info" | "warn" = "info", detail?: string): null {
  emitNervesEvent({
    level,
    component: "senses",
    event: "senses.teams_off_turn_unavailable",
    message: "no Teams bot client for a send from outside a Teams turn; the message stays queued",
    meta: { friendId, reason, ...(detail ? { detail } : {}) },
  })
  return null
}

async function friendTenantFromStore(agentRoot: string, friendId: string): Promise<string | undefined> {
  const friend = await new FileFriendStore(path.join(agentRoot, "friends")).get(friendId).catch(() => null)
  return friend?.externalIds.find((identity) => identity.provider === "aad" && !identity.externalId.startsWith("group:"))?.tenantId
}

export async function offTurnTeamsBotApi(deps: OffTurnTeamsDeps): Promise<TeamsBotApi | null> {
  const enabled = deps.teamsEnabled ? deps.teamsEnabled() : loadAgentConfig().senses?.teams?.enabled === true
  if (!enabled) return skip(deps.friendId, "teams_disabled")
  const presence = deps.presence ? deps.presence() : readPresenceForAgent(deps.agentRoot)
  if (presence) {
    const machineId = deps.machineId ? deps.machineId() : readMachineIdentity()?.machineId ?? null
    if (!machineId || !mayRunSense(presence, machineId, "teams")) return skip(deps.friendId, "teams_runs_elsewhere")
  }
  const tenantId = await (deps.friendTenant ?? ((id: string) => friendTenantFromStore(deps.agentRoot, id)))(deps.friendId)
  const config = chooseTeamsBot(tenantId, (deps.primary ?? getTeamsConfig)(), (deps.secondary ?? getTeamsSecondaryConfig)())
  if (!config) return skip(deps.friendId, "no_teams_bot")
  let bot = bots.get(config.clientId)
  if (!bot) {
    bot = (deps.botApi ?? liveBotApi)(config)
    bots.set(config.clientId, bot)
  }
  try {
    return await bot
  } catch (error) {
    // A client that could not be built is built again for the next send.
    bots.delete(config.clientId)
    return skip(deps.friendId, "bot_client_failed", "warn", error instanceof Error ? error.message : String(error))
  }
}

/** A retried turn sends the same text again; within this window it counts as already sent. */
export const OFF_TURN_REPEAT_WINDOW_MS = 15 * 60_000

export interface OffTurnTeamsSend {
  friendId: string
  key: string
  text: string
  origin: OutboundOrigin
  intent?: "generic_outreach" | "explicit_cross_chat"
  authorizingSession?: { friendId: string; channel: string; key: string; trustLevel?: string }
}

export interface OffTurnTeamsSendDeps extends Omit<OffTurnTeamsDeps, "friendId"> {
  now?: () => number
  send?: (params: ProactiveTeamsSessionSendParams, deps: { botApi: TeamsBotApi }) => Promise<ProactiveTeamsSessionSendResult>
}

function ledgerPath(agentRoot: string): string {
  return path.join(agentRoot, "state", "teams", "off-turn-sent.json")
}

function readLedger(agentRoot: string, now: number): Record<string, number> {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(agentRoot), "utf-8")) as Record<string, unknown>
    const kept: Record<string, number> = {}
    for (const [key, at] of Object.entries(parsed)) {
      if (typeof at === "number" && now - at < OFF_TURN_REPEAT_WINDOW_MS) kept[key] = at
    }
    return kept
  } catch {
    return {}
  }
}

function writeLedger(agentRoot: string, ledger: Record<string, number>): void {
  const target = ledgerPath(agentRoot)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(ledger)}\n`, { mode: 0o600 })
  fs.renameSync(temp, target)
}

/**
 * Sends to a Teams friend from outside a Teams turn. Null when this machine has no Teams client to send with, so
 * the caller queues as before. The same text to the same friend within the repeat window is not sent twice.
 */
export async function sendTeamsOffTurn(request: OffTurnTeamsSend, deps: OffTurnTeamsSendDeps): Promise<ProactiveTeamsSessionSendResult | null> {
  const now = (deps.now ?? Date.now)()
  const repeatKey = createHash("sha256").update(`${request.friendId}\0${request.text}`).digest("hex").slice(0, 32)
  const ledger = readLedger(deps.agentRoot, now)
  if (ledger[repeatKey] !== undefined) {
    emitNervesEvent({
      component: "senses",
      event: "senses.teams_off_turn_repeat_skipped",
      message: "the same Teams message went to this friend moments ago; not sending it twice",
      meta: { friendId: request.friendId },
    })
    return { delivered: true }
  }
  const botApi = await offTurnTeamsBotApi({ ...deps, friendId: request.friendId })
  if (!botApi) return null
  const send = deps.send ?? (await import("./teams")).sendProactiveTeamsMessageToSession
  const result = await send({
    friendId: request.friendId,
    sessionKey: request.key,
    text: request.text,
    intent: request.intent ?? "generic_outreach",
    ...(request.authorizingSession ? { authorizingSession: request.authorizingSession } : {}),
    deliveryId: `off-turn:${repeatKey}`,
    origin: request.origin,
  }, { botApi })
  if (result.delivered) {
    ledger[repeatKey] = now
    writeLedger(deps.agentRoot, ledger)
  }
  return result
}
