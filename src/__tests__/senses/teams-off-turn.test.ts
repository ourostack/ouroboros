import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { TeamsConfig } from "../../heart/config"
import type { Presence } from "../../heart/daemon/presence"

const mocks = vi.hoisted(() => ({
  agentConfig: vi.fn(),
  presence: vi.fn(),
  machine: vi.fn(),
  friendGet: vi.fn(),
  primary: vi.fn(),
  secondary: vi.fn(),
  liveBot: vi.fn(),
  teamsSend: vi.fn(),
  events: [] as Array<{ event: string; level?: string; meta?: Record<string, unknown> }>,
}))

vi.mock("../../heart/identity", async (original) => ({
  ...await original<typeof import("../../heart/identity")>(),
  loadAgentConfig: () => mocks.agentConfig(),
}))
vi.mock("../../heart/daemon/presence", async (original) => ({
  ...await original<typeof import("../../heart/daemon/presence")>(),
  readPresenceForAgent: (...args: unknown[]) => mocks.presence(...args),
}))
vi.mock("../../heart/machine-identity", async (original) => ({
  ...await original<typeof import("../../heart/machine-identity")>(),
  readMachineIdentity: () => mocks.machine(),
}))
vi.mock("@ouro.bot/friends", async (original) => ({
  ...await original<typeof import("@ouro.bot/friends")>(),
  FileFriendStore: class { get(id: string) { return mocks.friendGet(id) } },
}))
vi.mock("../../heart/config", async (original) => ({
  ...await original<typeof import("../../heart/config")>(),
  getTeamsConfig: () => mocks.primary(),
  getTeamsSecondaryConfig: () => mocks.secondary(),
}))
vi.mock("../../senses/shepherd/owner-notice", async (original) => ({
  ...await original<typeof import("../../senses/shepherd/owner-notice")>(),
  liveBotApi: (config: TeamsConfig) => mocks.liveBot(config),
}))
vi.mock("../../senses/teams", () => ({
  sendProactiveTeamsMessageToSession: (...args: unknown[]) => mocks.teamsSend(...args),
}))
vi.mock("../../nerves/runtime", async (original) => ({
  ...await original<typeof import("../../nerves/runtime")>(),
  emitNervesEvent: (event: { event: string; level?: string; meta?: Record<string, unknown> }) => { mocks.events.push(event) },
}))

import {
  OFF_TURN_REPEAT_WINDOW_MS,
  offTurnTeamsBotApi,
  resetOffTurnTeamsBots,
  sendTeamsOffTurn,
} from "../../senses/teams-off-turn"

const primary = { clientId: "bot-primary", tenantId: "t-ouro" } as TeamsConfig
const secondary = { clientId: "bot-secondary", tenantId: "t-msft" } as TeamsConfig
const noSecondary = { clientId: "", tenantId: "" } as TeamsConfig
const bot = { id: "bot", conversations: {} } as never

function presenceOwnedBy(owner: string, peers: Presence["peers"] = []): Presence {
  return {
    block: {
      schemaVersion: 1,
      minVersion: "0.1.0-alpha.1017",
      machines: [
        { machineId: "mini", name: "aris-mac-mini", role: "always-on" },
        { machineId: "laptop", name: "Aris-MacBook-Pro", role: "laptop" },
      ],
      owners: { teams: owner },
    },
    home: null,
    legacy: [],
    peers,
  } as unknown as Presence
}

let agentRoot: string

beforeEach(() => {
  agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teams-off-turn-"))
  resetOffTurnTeamsBots()
  mocks.events.length = 0
  for (const fn of [mocks.agentConfig, mocks.presence, mocks.machine, mocks.friendGet, mocks.primary, mocks.secondary, mocks.liveBot, mocks.teamsSend]) fn.mockReset()
  mocks.agentConfig.mockReturnValue({ senses: { teams: { enabled: true } } })
  mocks.presence.mockReturnValue(presenceOwnedBy("mini"))
  mocks.machine.mockReturnValue({ machineId: "mini" })
  mocks.friendGet.mockResolvedValue({ externalIds: [{ provider: "aad", externalId: "group:x" }, { provider: "aad", externalId: "ari-aad", tenantId: "t-msft" }] })
  mocks.primary.mockReturnValue(primary)
  mocks.secondary.mockReturnValue(secondary)
  mocks.liveBot.mockResolvedValue(bot)
  mocks.teamsSend.mockResolvedValue({ delivered: true })
})

afterEach(() => {
  fs.rmSync(agentRoot, { recursive: true, force: true })
})

const reasons = () => mocks.events.filter((e) => e.event === "senses.teams_off_turn_unavailable").map((e) => e.meta?.reason)

describe("offTurnTeamsBotApi", () => {
  it("builds the bot for the friend's tenant on the machine that owns Teams, once", async () => {
    expect(await offTurnTeamsBotApi({ agentRoot, friendId: "ari" })).toBe(bot)
    expect(await offTurnTeamsBotApi({ agentRoot, friendId: "ari" })).toBe(bot)
    expect(mocks.liveBot).toHaveBeenCalledTimes(1)
    expect(mocks.liveBot).toHaveBeenCalledWith(secondary)
    expect(mocks.presence).toHaveBeenCalledWith(agentRoot)
  })

  it("uses the primary bot when the friend has no tenant", async () => {
    mocks.friendGet.mockResolvedValue({ externalIds: [] })
    expect(await offTurnTeamsBotApi({ agentRoot, friendId: "ari" })).toBe(bot)
    expect(mocks.liveBot).toHaveBeenCalledWith(primary)
  })

  it("treats an unreadable friend as having no tenant", async () => {
    mocks.friendGet.mockRejectedValue(new Error("missing"))
    expect(await offTurnTeamsBotApi({ agentRoot, friendId: "ari" })).toBe(bot)
    expect(mocks.liveBot).toHaveBeenCalledWith(primary)
  })

  it("builds nothing when the Teams sense is off", async () => {
    mocks.agentConfig.mockReturnValue({ senses: {} })
    expect(await offTurnTeamsBotApi({ agentRoot, friendId: "ari" })).toBeNull()
    expect(reasons()).toEqual(["teams_disabled"])
    expect(mocks.liveBot).not.toHaveBeenCalled()
  })

  it("builds nothing on a machine that does not run Teams under the roster", async () => {
    mocks.machine.mockReturnValue({ machineId: "laptop" })
    expect(await offTurnTeamsBotApi({ agentRoot, friendId: "ari" })).toBeNull()
    expect(reasons()).toEqual(["teams_runs_elsewhere"])
  })

  it("waits while the previous owner still says it runs Teams", async () => {
    mocks.presence.mockReturnValue(presenceOwnedBy("mini", [{ machineId: "laptop", owns: ["teams"] } as never]))
    expect(await offTurnTeamsBotApi({ agentRoot, friendId: "ari" })).toBeNull()
    expect(reasons()).toEqual(["teams_runs_elsewhere"])
  })

  it("builds nothing when this machine has no identity under a roster", async () => {
    mocks.machine.mockReturnValue(null)
    expect(await offTurnTeamsBotApi({ agentRoot, friendId: "ari" })).toBeNull()
    expect(reasons()).toEqual(["teams_runs_elsewhere"])
  })

  it("needs no roster when presence is off", async () => {
    mocks.presence.mockReturnValue(null)
    expect(await offTurnTeamsBotApi({ agentRoot, friendId: "ari" })).toBe(bot)
    expect(mocks.machine).not.toHaveBeenCalled()
  })

  it("builds nothing without a configured bot", async () => {
    mocks.primary.mockReturnValue(noSecondary)
    mocks.secondary.mockReturnValue(noSecondary)
    expect(await offTurnTeamsBotApi({ agentRoot, friendId: "ari" })).toBeNull()
    expect(reasons()).toEqual(["no_teams_bot"])
  })

  it("builds a failed client again next time", async () => {
    mocks.liveBot.mockRejectedValueOnce(new Error("token refused")).mockResolvedValueOnce(bot)
    expect(await offTurnTeamsBotApi({ agentRoot, friendId: "ari" })).toBeNull()
    expect(mocks.events.find((e) => e.event === "senses.teams_off_turn_unavailable")).toMatchObject({ level: "warn", meta: { reason: "bot_client_failed", detail: "token refused" } })
    expect(await offTurnTeamsBotApi({ agentRoot, friendId: "ari" })).toBe(bot)
    expect(mocks.liveBot).toHaveBeenCalledTimes(2)
  })

  it("reports a non-Error failure as text", async () => {
    mocks.liveBot.mockRejectedValueOnce("offline")
    expect(await offTurnTeamsBotApi({ agentRoot, friendId: "ari" })).toBeNull()
    expect(mocks.events.at(-1)?.meta).toMatchObject({ detail: "offline" })
  })

  it("takes every input from injected deps", async () => {
    const injectedBot = vi.fn().mockResolvedValue(bot)
    const got = await offTurnTeamsBotApi({
      agentRoot,
      friendId: "ari",
      teamsEnabled: () => true,
      presence: () => presenceOwnedBy("laptop"),
      machineId: () => "laptop",
      friendTenant: async () => undefined,
      primary: () => primary,
      secondary: () => secondary,
      botApi: injectedBot,
    })
    expect(got).toBe(bot)
    expect(injectedBot).toHaveBeenCalledWith(primary)
    expect(mocks.agentConfig).not.toHaveBeenCalled()
    expect(mocks.liveBot).not.toHaveBeenCalled()
  })
})

describe("sendTeamsOffTurn", () => {
  const request = { friendId: "ari", key: "chat-1", text: "Ari is at the office.", origin: "send_message" as const }

  it("sends now with a stable delivery id and remembers it", async () => {
    const result = await sendTeamsOffTurn(request, { agentRoot, now: () => 1_000 })
    expect(result).toEqual({ delivered: true })
    expect(mocks.teamsSend).toHaveBeenCalledWith(
      expect.objectContaining({ friendId: "ari", sessionKey: "chat-1", text: request.text, intent: "generic_outreach", origin: "send_message", deliveryId: expect.stringMatching(/^off-turn:[0-9a-f]{32}$/) }),
      { botApi: bot },
    )
    const ledger = JSON.parse(fs.readFileSync(path.join(agentRoot, "state", "teams", "off-turn-sent.json"), "utf-8"))
    expect(Object.values(ledger)).toEqual([1_000])
  })

  it("passes the intent and authorizing session through", async () => {
    const authorizingSession = { friendId: "ari", channel: "cli", key: "session", trustLevel: "family" }
    const send = vi.fn().mockResolvedValue({ delivered: true })
    await sendTeamsOffTurn({ ...request, intent: "explicit_cross_chat", authorizingSession }, { agentRoot, send })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ intent: "explicit_cross_chat", authorizingSession }), { botApi: bot })
  })

  it("does not send the same text twice inside the window, and does after it", async () => {
    await sendTeamsOffTurn(request, { agentRoot, now: () => 1_000 })
    expect(await sendTeamsOffTurn(request, { agentRoot, now: () => 1_000 + OFF_TURN_REPEAT_WINDOW_MS - 1 })).toEqual({ delivered: true })
    expect(mocks.teamsSend).toHaveBeenCalledTimes(1)
    expect(mocks.events.some((e) => e.event === "senses.teams_off_turn_repeat_skipped")).toBe(true)
    await sendTeamsOffTurn(request, { agentRoot, now: () => 1_000 + OFF_TURN_REPEAT_WINDOW_MS })
    expect(mocks.teamsSend).toHaveBeenCalledTimes(2)
  })

  it("sends different text to the same friend", async () => {
    await sendTeamsOffTurn(request, { agentRoot, now: () => 1_000 })
    await sendTeamsOffTurn({ ...request, text: "Something else." }, { agentRoot, now: () => 1_001 })
    expect(mocks.teamsSend).toHaveBeenCalledTimes(2)
  })

  it("remembers nothing when Teams did not take it", async () => {
    mocks.teamsSend.mockResolvedValue({ delivered: false, reason: "send_error" })
    expect(await sendTeamsOffTurn(request, { agentRoot, now: () => 1_000 })).toEqual({ delivered: false, reason: "send_error" })
    expect(fs.existsSync(path.join(agentRoot, "state", "teams", "off-turn-sent.json"))).toBe(false)
  })

  it("returns null so the caller queues when there is no client here", async () => {
    mocks.machine.mockReturnValue({ machineId: "laptop" })
    expect(await sendTeamsOffTurn(request, { agentRoot })).toBeNull()
    expect(mocks.teamsSend).not.toHaveBeenCalled()
  })

  it("ignores an unreadable ledger and drops non-numeric entries", async () => {
    const dir = path.join(agentRoot, "state", "teams")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "off-turn-sent.json"), "not json")
    expect(await sendTeamsOffTurn(request, { agentRoot, now: () => 5 })).toEqual({ delivered: true })
    fs.writeFileSync(path.join(dir, "off-turn-sent.json"), JSON.stringify({ stale: "x" }))
    await sendTeamsOffTurn({ ...request, text: "two" }, { agentRoot, now: () => 6 })
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "off-turn-sent.json"), "utf-8")))).not.toContain("stale")
  })
})
