import * as fs from "node:fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("node:fs", async (original) => ({ ...await original<typeof fs>() }))
vi.mock("../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

let agentRoot = ""
vi.mock("../../heart/identity", () => ({ getAgentRoot: () => agentRoot, getAgentName: () => "sanctuary" }))

// Telegram dedupes on the owner-notice effect key, as the real sense does.
const telegram = vi.hoisted(() => ({ seen: new Set<string>(), messages: [] as Array<{ noticeId: string; text: string }> }))
vi.mock("../../senses/telegram", () => ({
  sendTelegramOwnerNotice: async (_agent: string, input: { noticeId: string; text: string }) => {
    if (telegram.seen.has(input.noticeId)) return
    telegram.seen.add(input.noticeId)
    telegram.messages.push({ noticeId: input.noticeId, text: input.text })
  },
}))

import { FileFriendStore } from "@ouro.bot/friends"
import { replaySinkPath, replayWindowPath } from "../../a2a/replay-harness"
import { awaitingToolDefinitions, resetAwaitToolDeps, setAwaitToolDeps } from "../../repertoire/tools-awaiting"
import { mockOwners } from "../test-helpers/replay-owners"

const fileAwaitDef = awaitingToolDefinitions.find((d) => d.tool.function.name === "await_condition")!
const resolveAwaitDef = awaitingToolDefinitions.find((d) => d.tool.function.name === "resolve_await")!

const a2aCtx = {
  currentSession: { friendId: "peer", channel: "a2a", key: "conv-1", sessionPath: "" },
  relationshipAuthorization: { requestId: "req-1", authorizedContextScopes: [], advertisedToolNames: ["await_condition", "resolve_await"], authorizeTool: vi.fn() },
} as any
const ASK = {
  name: "chef_show_s2_landed",
  verdict: "ask_owner",
  observation: "Chef S2 stalled at 75.9% with no peers for 4 days",
  question: "Chef S2 has been stuck at 75.9% with no peers for 4 days. What should I do?",
  choices: ["keep waiting", "look for another release", "give up"],
}
const EXPECTED_TEXT = "Chef S2 has been stuck at 75.9% with no peers for 4 days. What should I do?\n\n- keep waiting\n- look for another release\n- give up\n\n(about the request from Claude Code)"

function parse(result: unknown): Record<string, any> {
  return JSON.parse(result as string)
}

function openReplayWindow(): void {
  const dir = path.dirname(replayWindowPath(agentRoot))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(replayWindowPath(agentRoot), JSON.stringify({ friends: { peer: { expiresAt: new Date(Date.now() + 600_000).toISOString() } } }))
  fs.chmodSync(dir, 0o755)
  fs.chmodSync(replayWindowPath(agentRoot), 0o644)
  mockOwners(fs, (file) => (file.startsWith(dir) ? 0 : fs.statSync(file).uid))
}

describe("ask_owner through the real A2A owner deliverer", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    telegram.seen.clear()
    telegram.messages.length = 0
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ask-owner-a2a-"))
    resetAwaitToolDeps()
    setAwaitToolDeps({ buildDeliveryDeps: () => ({ agentName: "sanctuary", queuePending: vi.fn() }) })
    await new FileFriendStore(path.join(agentRoot, "friends")).put("peer", { id: "peer", name: "Claude Code", trustLevel: "family", admissionState: "active", externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", schemaVersion: 1 } as any)
    await fileAwaitDef.handler({ name: "chef_show_s2_landed", condition: "Chef season 2 is in the library", cadence: "30m" }, a2aCtx)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    resetAwaitToolDeps()
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it("scenario: the Chef stall tick asks Ari in his own words, with every choice, and the await closes", async () => {
    const result = parse(await resolveAwaitDef.handler(ASK, a2aCtx))

    expect(result).toMatchObject({ asked: true, alert: { status: "delivered_now" } })
    expect(telegram.messages).toHaveLength(1)
    expect(telegram.messages[0]!.text).toBe(EXPECTED_TEXT)
    expect(telegram.messages[0]!.text).not.toMatch(/Follow-up|asked the owner/u)
    expect(fs.existsSync(path.join(agentRoot, "awaiting", "chef_show_s2_landed.md"))).toBe(false)
    expect(fs.readFileSync(path.join(agentRoot, "awaiting", ".done", "chef_show_s2_landed.md"), "utf-8")).toContain("status: asked_owner")
  })

  it("sends exactly one Telegram message when a crash between send and archive is retried", async () => {
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => { throw new Error("crash before the await was archived") })
    await expect(resolveAwaitDef.handler(ASK, a2aCtx)).rejects.toThrow(/crash/u)
    expect(unlink).toHaveBeenCalled()
    expect(fs.existsSync(path.join(agentRoot, "awaiting", "chef_show_s2_landed.md"))).toBe(true)
    expect(telegram.messages).toHaveLength(1)

    expect(parse(await resolveAwaitDef.handler(ASK, a2aCtx)).asked).toBe(true)
    expect(telegram.messages).toHaveLength(1)
    expect(fs.existsSync(path.join(agentRoot, "awaiting", "chef_show_s2_landed.md"))).toBe(false)
  })

  it("writes exactly one replay sink line, with the same text, when a crash between send and archive is retried", async () => {
    openReplayWindow()
    vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => { throw new Error("crash before the await was archived") })
    await expect(resolveAwaitDef.handler(ASK, a2aCtx)).rejects.toThrow(/crash/u)
    expect(parse(await resolveAwaitDef.handler(ASK, a2aCtx)).asked).toBe(true)

    const lines = fs.readFileSync(replaySinkPath(agentRoot), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ friendId: "peer", text: EXPECTED_TEXT, noticeId: expect.stringMatching(/^await:chef_show_s2_landed:asked_owner:/u) })
    expect(telegram.messages).toHaveLength(0)
  })
})
