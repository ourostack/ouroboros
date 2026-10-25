import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { FriendRecord } from "@ouro.bot/friends"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { TeamsConfig } from "../../../heart/config"
import { resetIdentity, setAgentName } from "../../../heart/identity"
import { appendReturn, type ReturnRecord } from "../../../senses/shepherd/returns"
import { noticeDeliveryState, readNoticeOutbox } from "../../../senses/shepherd/notice-outbox"
import {
  NOTICE_COALESCE_MS,
  NOTICE_RETRY_MS,
  chooseTeamsBot,
  createOwnerNotifier,
  createNoticeSender,
  noticeDeliveryId,
  readEnabledReachChannels,
  noticeLine,
  noticeMessage,
  noticeWanted,
  plain,
  resolveNoticeTargets,
  type NoticeTarget,
} from "../../../senses/shepherd/owner-notice"

const mockSend = vi.fn()
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})
vi.mock("../../../senses/teams", () => ({
  sendProactiveTeamsMessageToSession: (...args: unknown[]) => mockSend(...args),
}))
const events: Array<{ event: string; level?: string; meta?: Record<string, unknown> }> = []
vi.mock("../../../nerves/runtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../nerves/runtime")>(),
  emitNervesEvent: (entry: { event: string; level?: string; meta?: Record<string, unknown> }) => { events.push(entry) },
}))

let returnSequence = 0
const record = (overrides: Partial<ReturnRecord> = {}): ReturnRecord => ({
  at: "2026-10-12T20:00:00.000Z", host: "cmux", session: "0a1b2c3d-4e5f", transition: `cmux:B:${++returnSequence}`, agent: "Claude Code", cwd: "/Users/a/code/ouroboros",
  task: null, kind: "premature", action: "respond", reason: "It asked whether to continue a task it was told to finish.", reply: "keep going, run the tests", latencyMs: 900, inputTokens: 1000,
  ...overrides,
})

const friend = (id: string, overrides: Partial<FriendRecord> = {}): FriendRecord => ({
  id, name: `Friend ${id}`, role: "friend", trustLevel: "family", connections: [], externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {},
  totalTokens: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", schemaVersion: 1, ...overrides,
})

const bot = (clientId: string, tenantId: string): TeamsConfig => ({ clientId, clientSecret: "x", tenantId, managedIdentityClientId: "" })

let root = ""
beforeEach(() => {
  vi.mocked(fs.renameSync).mockReset()
  root = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-notice-"))
  events.length = 0
  mockSend.mockReset().mockResolvedValue({ delivered: true })
  returnSequence = 0
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("owner notice policy", () => {
  it("reports every return, only what needs the owner, or nothing", () => {
    const kinds: ReturnRecord["kind"][] = ["premature", "gate", "done", "working", "unclear", "loop_guard", "error"]
    expect(kinds.filter((kind) => noticeWanted("every", record({ kind })))).toEqual(kinds)
    expect(kinds.filter((kind) => noticeWanted("needs-me", record({ kind })))).toEqual(["gate", "done", "loop_guard"])
    expect(kinds.filter((kind) => noticeWanted("off", record({ kind })))).toEqual([])
  })
})

describe("owner notice text", () => {
  it("P0: attributes its own failed judgment to Shepherd, not an agent stopping", () => {
    const text = noticeLine(record({
      kind: "error", action: "let_through", reply: null, reason: "Connection error.",
    }))
    expect(text).toContain("Shepherd")
    expect(text).toContain("Connection error.")
    expect(text).not.toMatch(/stopped|waiting for you|needs you/)
  })

  it("P0: an inconclusive observation cannot assert a stop while its evidence says work is running", () => {
    const text = noticeLine(record({
      kind: "unclear", action: "let_through", reply: null,
      reason: "The agent is still mid-task, running a shell inspection; it has not handed control back.",
    }))
    expect(text).toContain("Shepherd")
    expect(text).not.toMatch(/\bstopped\b|waiting for you|needs you/)
    expect(text).toContain("has not handed control back")
  })

  it("reports machine-format refusal without claiming the human must decide", () => {
    const text = noticeLine(record({ action: "let_through", reply: null, actionBlockReason: "reply_invalid", replyIssue: "too_long" }))
    expect(text).toMatch(/no input sent because/)
    expect(text).not.toMatch(/waiting for you|needs you|could not tell/)
  })

  it("reports an outside dependency without calling it done or asking the owner to act", () => {
    expect(noticeLine(record({ kind: "waiting", reason: "PR awaits review." }))).toContain("waiting on an outside dependency")
    expect(noticeLine(record({ kind: "waiting" }))).not.toMatch(/needs you|done|waiting for you/)
    expect(noticeWanted("needs-me", record({ kind: "waiting" }))).toBe(false)
  })
  it("names the foreground agent, folder, workspace and tab for an unhooked return", () => {
    const session = { id: "0a1b2c3d-4e5f", ref: "surface:30", workspace: "workspace:3", workspaceTitle: "workflows",
      title: "Troubleshoot Outlook", agent: "Copilot", cwd: "/Users/a/personal-desk", focused: false }
    expect(noticeMessage([record({ agent: null, cwd: null, kind: "done", reason: "Fixed the error." })], new Map([[session.id, session]])))
      .toBe("Copilot in personal-desk (workflows / Troubleshoot Outlook; surface:30) says it is done. Why: Fixed the error.")
    expect(noticeLine(record({ title: "Saved tab", workspaceTitle: "Saved workspace" }), session))
      .toContain("(Saved workspace / Saved tab; surface:30)")
  })

  it("keeps untrusted terminal text to one plain bounded line", () => {
    expect(plain("a\u0000b\nc‮d e", 50)).toBe("a b c d e")
    expect(plain("**bold** <at>Ari</at> [link](x) `code` #h | ~s~ \\n @everyone", 100)).toBe("bold at Ari /at link (x) code h s n everyone")
    expect(plain('say "hi"', 50)).toBe("say 'hi'")
    expect(plain("abcdefghij", 5)).toBe("abcd…")
    expect(plain("abc d efgh", 6)).toBe("abc d…")
  })

  it("says who returned, what Shepherd did and why, for every kind", () => {
    expect(noticeLine(record({ session: "" }))).toMatch(/^Claude Code in ouroboros stopped early/)
    expect(noticeLine(record(), "surface:12")).toBe('Claude Code in ouroboros (surface:12) stopped early, so I sent it back: "keep going, run the tests". Why: It asked whether to continue a task it was told to finish.')
    expect(noticeLine(record({ reply: "key:2" }), "surface:3")).toBe("Claude Code in ouroboros (surface:3) stopped early, so I pressed 2. Why: It asked whether to continue a task it was told to finish.")
    expect(noticeLine(record({ action: "let_through", reply: null, reason: "Ari is in this session" }))).toBe("Claude Code in ouroboros (0a1b2c3d) stopped early, but I did not answer it, so it is waiting for you. Why: Ari is in this session")
    expect(noticeLine(record({ kind: "gate", action: "let_through", agent: "Copilot", cwd: "/Users/a/desk", reason: "wants to push to main" }), "w1:p2")).toBe("Copilot in desk (w1:p2) needs you. Why: wants to push to main")
    expect(noticeLine(record({ kind: "done", action: "let_through", agent: null, cwd: null, reason: "" }), "s")).toBe("A coding agent (s) says it is done. Why: no reason given")
    expect(noticeLine(record({ kind: "loop_guard", reason: "loop guard: x" }), "s")).toBe("Claude Code in ouroboros (s): I stopped answering it after too many replies, so it is waiting for you. Why: loop guard: x")
    expect(noticeLine(record({ kind: "working", reason: "tests pass" }), "s")).toBe("Claude Code in ouroboros (s) is still working in the background and has news. Why: tests pass")
    expect(noticeLine(record({ kind: "unclear", reason: "a shell" }), "s")).toBe("Shepherd could not determine the current state of Claude Code in ouroboros (s). Why: a shell")
    expect(noticeLine(record({ kind: "error", reason: "the judge timed out" }), "s")).toBe("Shepherd could not complete its observation of Claude Code in ouroboros (s); the agent's state was not determined. Why: the judge timed out")
  })

  it("never lets terminal fields carry markup or a mention", () => {
    const line = noticeLine(record({ agent: "<at>Ari</at>", cwd: "/x/**repo**", reason: "[click](http://e) @Ari\nnext line", reply: 'go "now" @Ari' }), "s:1")
    expect(line).toBe('at Ari /at in repo (s:1) stopped early, so I sent it back: "go \'now\' Ari". Why: click (http://e) Ari next line')
    expect(line).not.toMatch(/[<>[\]*@\n]/)
  })

  it("puts a burst in one message and counts what does not fit", () => {
    expect(noticeMessage([record()], new Map([["0a1b2c3d-4e5f", "surface:12"]]))).toBe(noticeLine(record(), "surface:12"))
    const two = noticeMessage([record(), record({ session: "S2", kind: "gate", agent: "Codex" })], new Map([["S2", "surface:2"]]))
    expect(two.split("\n")).toEqual(["Updates from 2 coding sessions:", `- ${noticeLine(record())}`, `- ${noticeLine(record({ session: "S2", kind: "gate", agent: "Codex" }), "surface:2")}`])
    const many = noticeMessage(Array.from({ length: 9 }, (_, index) => record({ session: `S${index}` })))
    expect(many.split("\n")).toHaveLength(1 + 6 + 1)
    expect(many.split("\n").at(-1)).toBe("- and 3 more.")
  })

  it("counts six observations of one stable target as one session and displays the latest", () => {
    const records = Array.from({ length: 6 }, (_, index) => record({
      at: `2026-10-12T20:0${index}:00.000Z`, reason: `observation-${index}`,
    }))
    const original = structuredClone(records)
    expect(noticeMessage(records)).toBe(noticeLine(records[5]!))
    expect(noticeMessage([...records].reverse())).toBe(noticeLine(records[5]!))
    expect(records).toEqual(original)
    expect(noticeMessage([records[0]!, { ...records[1]!, host: "other-host" }])).toContain("Updates from 2 coding sessions:")
  })

  it("orders distinct targets and treats invalid timestamps conservatively with deterministic ties", () => {
    const valid = record({ transition: "z", reason: "valid", at: "2026-10-12T20:00:00.000Z" })
    const invalid = record({ transition: "a", reason: "unknown", at: "invalid" })
    expect(noticeMessage([invalid, valid])).toBe(noticeLine(valid))
    expect(noticeMessage([valid, invalid])).toBe(noticeLine(valid))
    expect(noticeMessage([valid, { ...valid, transition: "a", reason: "older tie" }])).toBe(noticeLine(valid))
    const lastInvalid = { ...invalid, transition: "z", reason: "later unknown" }
    expect(noticeMessage([invalid, lastInvalid])).toBe(noticeLine(lastInvalid))
    expect(noticeMessage([lastInvalid, invalid])).toBe(noticeLine(lastInvalid))
    const reversed = noticeMessage([record({ session: "Z" }), record({ session: "A" })])
    expect(reversed.indexOf("(A)")).toBeLessThan(reversed.indexOf("(Z)"))
  })

  it("labels recovered observations with their own time, never restart time or live status", () => {
    const message = noticeMessage([record({ at: "invalid-time" })], new Map(), { recovered: true })
    expect(message).toMatch(/historical/i)
    expect(message).toContain("observation time unknown")
    expect(message).not.toContain("invalid-time")
    const dated = noticeMessage([record()], new Map(), { recovered: true })
    expect(dated).toContain("2026-10-12T20:00:00.000Z")
  })
})

describe("owner notice targets", () => {
  it("is every family friend with a Teams id, once per Teams user", async () => {
    fs.mkdirSync(path.join(root, "state", "sessions", "f1", "teams"), { recursive: true })
    fs.writeFileSync(path.join(root, "state", "sessions", "f1", "teams", "conv-1.json"), "{}")
    const store = {
      listAll: async () => [
        friend("f1", { name: "Ari", externalIds: [{ provider: "local", externalId: "ari", linkedAt: "" }, { provider: "aad", externalId: "AAD-1", tenantId: "t1", linkedAt: "" }] }),
        friend("f2", { name: "Ari again", externalIds: [{ provider: "aad", externalId: "aad-1", tenantId: "t1", linkedAt: "" }] }),
        friend("f3", { name: "Group only", externalIds: [{ provider: "aad", externalId: "group:abc", linkedAt: "" }] }),
        friend("f4", { name: "Local only", externalIds: [{ provider: "local", externalId: "ari", linkedAt: "" }] }),
        friend("f5", { name: "A friend", trustLevel: "friend", externalIds: [{ provider: "aad", externalId: "aad-5", linkedAt: "" }] }),
        friend("f6", { name: "Sam", externalIds: [{ provider: "aad", externalId: "aad-6", linkedAt: "" }] }),
      ],
    }
    expect(await resolveNoticeTargets(root, store, new Set(["teams"]), "not-a-linked-user")).toEqual([
      { friendId: "f1", name: "Ari", channel: "teams", key: "conv-1", tenantId: "t1" },
      { friendId: "f6", name: "Sam", channel: "teams", key: "shepherd" },
    ])
    expect(events).toContainEqual(expect.objectContaining({ event: "senses.shepherd_notice_targets", meta: { count: 2 } }))
  })

  it("reads the bundle's friend records by default", async () => {
    fs.mkdirSync(path.join(root, "friends"), { recursive: true })
    fs.writeFileSync(path.join(root, "friends", "f1.json"), JSON.stringify(friend("f1", { name: "Ari", externalIds: [{ provider: "aad", externalId: "aad-1", linkedAt: "" }] })))
    expect(await resolveNoticeTargets(root, undefined, new Set(["teams"]))).toEqual([{ friendId: "f1", name: "Ari", channel: "teams", key: "shepherd" }])
    expect(await resolveNoticeTargets(root)).toEqual([])
  })

  it("targets a family friend on BlueBubbles when reachChannel is bluebubbles", async () => {
    const ari = friend("f1", { name: "Ari", externalIds: [
      { provider: "imessage-handle", externalId: "+15555550123", linkedAt: "" },
      { provider: "aad", externalId: "aad-1", tenantId: "t1", linkedAt: "" },
    ], relationshipPolicy: { schemaVersion: 1, version: 1, preferences: {
      reachChannel: { value: "bluebubbles", provenance: "stated", version: 1, source: "test" },
    } } } as Partial<FriendRecord>)
    expect(await resolveNoticeTargets(root, { listAll: async () => [ari] }, new Set(["bluebubbles", "teams"]))).toEqual([
      { friendId: "f1", name: "Ari", channel: "bluebubbles", key: "shepherd" },
    ])
  })

  it("dedupes two friend records sharing one iMessage handle", async () => {
    const store = { listAll: async () => [
      friend("f1", { name: "Ari", externalIds: [{ provider: "imessage-handle", externalId: "ari@example.com", linkedAt: "" }] }),
      friend("f2", { name: "Ari again", externalIds: [{ provider: "imessage-handle", externalId: "ARI@example.com", linkedAt: "" }] }),
    ] }
    expect(await resolveNoticeTargets(root, store, new Set(["bluebubbles"]))).toEqual([
      { friendId: "f1", name: "Ari", channel: "bluebubbles", key: "shepherd" },
    ])
  })

  it("sends one notice per person even when their iMessage and Teams ids sit on separate records", async () => {
    const store = { listAll: async () => [
      friend("f1", { name: "Ari", externalIds: [{ provider: "imessage-handle", externalId: "+15555550123", linkedAt: "" }, { provider: "aad", externalId: "AAD-1", linkedAt: "" }] }),
      friend("f2", { name: "Ari on Teams", externalIds: [null as never, { provider: "aad", externalId: "aad-1", linkedAt: "" }, { provider: "local", externalId: "", linkedAt: "" }] }),
      friend("f3", { name: "Sam", externalIds: [{ provider: "aad", externalId: "aad-3", linkedAt: "" }, { provider: "aad", externalId: "group:x", linkedAt: "" }] }),
    ] }
    expect(await resolveNoticeTargets(root, store, new Set(["bluebubbles", "teams"]))).toEqual([
      { friendId: "f1", name: "Ari", channel: "bluebubbles", key: "shepherd" },
      { friendId: "f3", name: "Sam", channel: "teams", key: "shepherd" },
    ])
  })

  it("two family members in one iMessage group each get their own notice", async () => {
    const group = { provider: "imessage-handle" as const, externalId: "group:any;+;family-group", linkedAt: "" }
    const store = { listAll: async () => [
      friend("f1", { name: "Ari", externalIds: [group, { provider: "imessage-handle", externalId: "+15555550123", linkedAt: "" }] }),
      friend("f2", { name: "Sam", externalIds: [group, { provider: "imessage-handle", externalId: "+15555550199", linkedAt: "" }] }),
    ] }
    expect(await resolveNoticeTargets(root, store, new Set(["bluebubbles"]))).toEqual([
      { friendId: "f1", name: "Ari", channel: "bluebubbles", key: "shepherd" },
      { friendId: "f2", name: "Sam", channel: "bluebubbles", key: "shepherd" },
    ])
  })

  it("only this machine's own user hears it, not their relatives, when one is linked", async () => {
    const store = { listAll: async () => [
      friend("f1", { name: "Relative", externalIds: [{ provider: "imessage-handle", externalId: "+15555550199", linkedAt: "" }] }),
      friend("f2", { name: "Ari", externalIds: [{ provider: "local", externalId: "ari", linkedAt: "" }, { provider: "imessage-handle", externalId: "+15555550123", linkedAt: "" }] }),
      friend("f3", { name: "Not family", trustLevel: "friend", externalIds: [{ provider: "local", externalId: "ari", linkedAt: "" }, { provider: "imessage-handle", externalId: "+15555550100", linkedAt: "" }] }),
      friend("f4", { name: "No ids", externalIds: undefined as never }),
      friend("f5", { name: "Odd ids", externalIds: [null as never, { provider: "local", externalId: 7 as never, linkedAt: "" }] }),
    ] }
    expect(await resolveNoticeTargets(root, store, new Set(["bluebubbles"]), "ari")).toEqual([
      { friendId: "f2", name: "Ari", channel: "bluebubbles", key: "shepherd" },
    ])
    // With no family friend for this machine's user (a server, say), every family friend hears it.
    expect((await resolveNoticeTargets(root, store, new Set(["bluebubbles"]), "someone-else")).map(target => target.friendId)).toEqual(["f1", "f2"])
    // A user with no account entry, as in some containers, is the same as no linked owner.
    expect((await resolveNoticeTargets(root, store, new Set(["bluebubbles"]), null)).map(target => target.friendId)).toEqual(["f1", "f2"])
  })

  it("recognizes an older user@host owner id, so relatives still do not hear it", async () => {
    const store = { listAll: async () => [
      friend("f1", { name: "Relative", externalIds: [{ provider: "imessage-handle", externalId: "+15555550199", linkedAt: "" }] }),
      friend("f2", { name: "Ari", externalIds: [{ provider: "local", externalId: "ari@macbook", linkedAt: "" }, { provider: "imessage-handle", externalId: "+15555550123", linkedAt: "" }] }),
    ] }
    expect((await resolveNoticeTargets(root, store, new Set(["bluebubbles"]), "ari")).map(target => target.friendId)).toEqual(["f2"])
  })

  it("reaches the owner record that has a channel, and never falls back to relatives when none does", async () => {
    const stray = friend("f0", { name: "Ari (cli)", externalIds: [{ provider: "local", externalId: "ari", linkedAt: "" }] })
    const owner = friend("f2", { name: "Ari", externalIds: [{ provider: "local", externalId: "ari", linkedAt: "" }, { provider: "imessage-handle", externalId: "+15555550123", linkedAt: "" }] })
    const relative = friend("f1", { name: "Relative", externalIds: [{ provider: "imessage-handle", externalId: "+15555550199", linkedAt: "" }] })
    expect((await resolveNoticeTargets(root, { listAll: async () => [stray, relative, owner] }, new Set(["bluebubbles"]), "ari")).map(target => target.friendId)).toEqual(["f2"])
    expect(await resolveNoticeTargets(root, { listAll: async () => [stray, relative] }, new Set(["bluebubbles"]), "ari")).toEqual([])
    expect(events).toContainEqual(expect.objectContaining({ level: "warn", event: "senses.shepherd_notice_owner_unreachable", meta: { owners: 1 } }))
  })

  it("uses only a DM alert key as the BlueBubbles fallback", async () => {
    const write = (id: string, key: string) => {
      fs.mkdirSync(path.join(root, "state", "sessions", id, "bluebubbles"), { recursive: true })
      fs.writeFileSync(path.join(root, "state", "sessions", id, "bluebubbles", `${key}.json`), "{}")
    }
    write("f1", "chat_any;-;+15555550123")
    write("f2", "chat_any;+;group-1")
    const store = { listAll: async () => [
      friend("f1", { name: "Ari", externalIds: [{ provider: "imessage-handle", externalId: "+15555550123", linkedAt: "" }] }),
      friend("f2", { name: "Sam", externalIds: [{ provider: "imessage-handle", externalId: "sam@example.com", linkedAt: "" }] }),
    ] }
    expect(await resolveNoticeTargets(root, store, new Set(["bluebubbles"]))).toEqual([
      { friendId: "f1", name: "Ari", channel: "bluebubbles", key: "chat_any;-;+15555550123" },
      { friendId: "f2", name: "Sam", channel: "bluebubbles", key: "shepherd" },
    ])
  })
})

describe("enabled reach channels", () => {
  it("reads the enabled BlueBubbles and Teams senses from agent.json", () => {
    const attached = () => ({ serverUrl: "http://bb", password: "x" })
    fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({ senses: { bluebubbles: { enabled: true }, teams: { enabled: false } } }))
    expect([...readEnabledReachChannels("notice-test", root, attached)]).toEqual(["bluebubbles"])
    fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({ senses: { bluebubbles: { enabled: true }, teams: { enabled: true } } }))
    expect([...readEnabledReachChannels("notice-test", root, attached)]).toEqual(["bluebubbles", "teams"])
  })

  it("leaves BlueBubbles out when this machine has no BlueBubbles connection, so Teams carries the notice", () => {
    fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({ senses: { bluebubbles: { enabled: true }, teams: { enabled: true } } }))
    const detached = () => { throw new Error("bluebubbles.serverUrl is required in this machine's agent-vault runtime config") }
    expect([...readEnabledReachChannels("notice-test", root, detached)]).toEqual(["teams"])
    expect(events).toContainEqual(expect.objectContaining({ level: "warn", event: "senses.shepherd_notice_bluebubbles_not_attached" }))
    // The default reads this machine's runtime config, which a test machine does not have.
    expect([...readEnabledReachChannels("notice-test", root)]).toEqual(["teams"])
  })

  it("reaches no channel and logs when the config cannot be read", () => {
    fs.writeFileSync(path.join(root, "agent.json"), "{not json")
    expect([...readEnabledReachChannels("notice-test", root)]).toEqual([])
    expect(events).toContainEqual(expect.objectContaining({ level: "warn", event: "senses.shepherd_notice_channels_unreadable" }))
  })
})

describe("owner notice over Teams", () => {
  it("uses the bot that serves the friend's tenant", () => {
    const primary = bot("p", "t1")
    const secondary = bot("s", "t2")
    expect(chooseTeamsBot("t2", primary, secondary)).toBe(secondary)
    expect(chooseTeamsBot("t1", primary, secondary)).toBe(primary)
    expect(chooseTeamsBot(undefined, primary, secondary)).toBe(primary)
    expect(chooseTeamsBot("t2", primary, bot("", "t2"))).toBe(primary)
    expect(chooseTeamsBot("t1", bot("", "t1"), secondary)).toBeNull()
  })

  it("sends plain text through the Teams proactive path and reuses its bot client", async () => {
    const botApi = vi.fn(async (config: TeamsConfig) => ({ id: config.clientId, conversations: {} }))
    const send = createNoticeSender(root, { primary: () => bot("p", "t1"), secondary: () => bot("", ""), botApi })
    const target: NoticeTarget = { friendId: "f1", name: "Ari", channel: "teams", key: "conv-1", tenantId: "t1" }
    expect(await send(target, "hello", ["n1"])).toEqual({ delivered: true })
    await send(target, "again", ["n2"])
    expect(botApi).toHaveBeenCalledTimes(1)
    expect(mockSend).toHaveBeenCalledWith(
      { friendId: "f1", sessionKey: "conv-1", text: "hello", textFormat: "plain", intent: "generic_outreach", captureReceipt: true, deliveryId: noticeDeliveryId("f1", ["n1"]), origin: "shepherd" },
      expect.objectContaining({ botApi: { id: "p", conversations: {} } }),
    )
  })

  it("builds a bot client again after one could not be built", async () => {
    const botApi = vi.fn().mockRejectedValueOnce(new Error("no token")).mockResolvedValue({ id: "p", conversations: {} })
    const send = createNoticeSender(root, { primary: () => bot("p", "t1"), secondary: () => bot("", ""), botApi })
    await expect(send({ friendId: "f1", name: "Ari", channel: "teams", key: "k" }, "hi", ["n1"])).rejects.toThrow("no token")
    expect(await send({ friendId: "f1", name: "Ari", channel: "teams", key: "k" }, "hi", ["n1"])).toEqual({ delivered: true })
    expect(botApi).toHaveBeenCalledTimes(2)
  })

  it("reports a missing Teams bot without trying to send", async () => {
    const send = createNoticeSender(root, { primary: () => bot("", ""), secondary: () => bot("", "") })
    expect(await send({ friendId: "f1", name: "Ari", channel: "teams", key: "k" }, "hi", ["n1"])).toEqual({ delivered: false, reason: "no_teams_bot" })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it("reads the agent's Teams credentials by default", async () => {
    const home = process.env.HOME
    process.env.HOME = root
    setAgentName("notice-test")
    try {
      const send = createNoticeSender(root)
      // No runtime credentials in this test: no bot is configured.
      expect(await send({ friendId: "f1", name: "Ari", channel: "teams", key: "k" }, "hi", ["n1"])).toEqual({ delivered: false, reason: "no_teams_bot" })
    } finally {
      process.env.HOME = home
      resetIdentity()
    }
  })
})

describe("owner notice over BlueBubbles", () => {
  const target: NoticeTarget = { friendId: "f1", name: "Ari", channel: "bluebubbles", key: "chat:any;-;+15555550123" }

  it("sends through the BlueBubbles proactive path with the batch's delivery id and origin shepherd", async () => {
    const client = { marker: "client" }
    const sendBlueBubbles = vi.fn(async () => ({ delivered: true }))
    const send = createNoticeSender(root, { createBlueBubblesClient: () => client as never, sendBlueBubbles: sendBlueBubbles as never })
    expect(await send(target, "hello", ["n2", "n1"])).toEqual({ delivered: true })
    expect(sendBlueBubbles).toHaveBeenCalledWith(
      { friendId: "f1", sessionKey: "chat:any;-;+15555550123", text: "hello", intent: "generic_outreach", deliveryId: noticeDeliveryId("f1", ["n1", "n2"]), origin: "shepherd" },
      expect.objectContaining({ createClient: expect.any(Function), createFriendStore: expect.any(Function) }),
    )
    const deps = (sendBlueBubbles.mock.calls[0] as unknown[])[1] as { createClient: () => unknown; createFriendStore: () => unknown }
    expect(deps.createClient()).toBe(client)
    expect(deps.createFriendStore()).toBeDefined()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it("a BlueBubbles setup throw returns the notice to pending", async () => {
    const sendBlueBubbles = vi.fn()
    const send = createNoticeSender(root, { createBlueBubblesClient: () => { throw new Error("missing bluebubbles credentials") }, sendBlueBubbles })
    expect(await send(target, "hello", ["n1"])).toEqual({ delivered: false, reason: "bluebubbles_unavailable" })
    expect(sendBlueBubbles).not.toHaveBeenCalled()
    expect(events).toContainEqual(expect.objectContaining({ level: "warn", event: "senses.shepherd_notice_bluebubbles_unavailable", meta: { friendId: "f1", error: "missing bluebubbles credentials" } }))
  })

  it("uses the BlueBubbles sense's own proactive sender by default", async () => {
    const sendText = vi.fn()
    const send = createNoticeSender(root, { createBlueBubblesClient: () => ({ sendText }) as never })
    // No friend record in this bundle: the sense refuses before it sends anything.
    expect(await send(target, "hello", ["n1"])).toMatchObject({ delivered: false })
    expect(sendText).not.toHaveBeenCalled()
  })

  it("names one delivery id per person and batch, whatever order the ids arrive in", () => {
    expect(noticeDeliveryId("f1", ["b", "a"])).toBe(noticeDeliveryId("f1", ["a", "b"]))
    expect(noticeDeliveryId("f1", ["a"])).not.toBe(noticeDeliveryId("f2", ["a"]))
    expect(noticeDeliveryId("f1", ["a"])).toMatch(/^shepherd:[0-9a-f]{64}$/)
  })
})

describe("owner notifier", () => {
  interface Task { fn: () => void; ms: number }
  let tasks: Task[] = []
  const schedule = (fn: () => void, ms: number) => {
    const task = { fn, ms }
    tasks.push(task)
    return () => { tasks = tasks.filter((entry) => entry !== task) }
  }
  const ari: NoticeTarget = { friendId: "f1", name: "Ari", channel: "teams", key: "conv-1" }
  beforeEach(() => { tasks = [] })

  function notifier(overrides: Partial<Parameters<typeof createOwnerNotifier>[0]> = {}) {
    const sent: Array<{ target: NoticeTarget; text: string }> = []
    const instance = createOwnerNotifier({
      agent: "ouroboros", agentRoot: root, policy: "every", schedule,
      listSessions: async () => [{ id: "0a1b2c3d-4e5f", ref: "surface:12", workspace: null, title: "", agent: null, focused: false }],
      resolveTargets: async () => [ari],
      send: async (target, text) => { sent.push({ target, text }); return { delivered: true } },
      ...overrides,
    })
    return { instance, sent }
  }

  it("rejects failed enqueue instead of reporting queued custody, then retries safely", async () => {
    const { instance, sent } = notifier()
    vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error("outbox publication unavailable") })
    await expect(instance.notify(record())).rejects.toThrow("outbox publication unavailable")
    expect(sent).toEqual([])
    expect(events).toContainEqual(expect.objectContaining({ level: "error", message: "could not persist a Shepherd owner notice intent; it remains waiting" }))
    await instance.flush()
    expect(sent).toHaveLength(1)
    expect(readNoticeOutbox(root)[0]!.deliveries[ari.friendId]!.state).toBe("sent")
  })

  it("returns explicit queued and policy/stopped suppression acceptance", async () => {
    const { instance } = notifier()
    const value = record()
    await expect(instance.notify(value)).resolves.toEqual({ state: "queued", noticeId: expect.any(String) })
    const off = notifier({ policy: "off" })
    await expect(off.instance.notify(record())).resolves.toEqual({ state: "suppressed", reason: "policy" })
    instance.stop()
    await expect(instance.notify(record())).resolves.toEqual({ state: "suppressed", reason: "stopped" })
    expect(readNoticeOutbox(root)).toHaveLength(1)
  })

  it("handles a failed write observed by a scheduled flush without an unhandled rejection", async () => {
    const { instance, sent } = notifier()
    vi.mocked(fs.renameSync).mockImplementation(() => { throw new Error("disk unavailable") })
    const accepted = instance.notify(record())
    const rejected = expect(accepted).rejects.toThrow("disk unavailable")
    tasks[0]!.fn()
    await rejected
    await instance.flush()
    expect(sent).toEqual([])
    expect(tasks.map(task => task.ms)).toEqual([NOTICE_RETRY_MS])
    vi.mocked(fs.renameSync).mockRestore()
    tasks[0]!.fn()
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    instance.stop()
  })

  it("reports a corrupt outbox at startup and keeps a retry scheduled without initiating transport", async () => {
    fs.mkdirSync(path.join(root, "state", "senses", "shepherd"), { recursive: true })
    fs.writeFileSync(path.join(root, "state", "senses", "shepherd", "notice-outbox.json"), "{invalid")
    const { instance, sent } = notifier()
    expect(events).toContainEqual(expect.objectContaining({ level: "error", message: "could not read waiting Shepherd owner notices" }))
    await instance.flush()
    expect(sent).toEqual([])
    expect(tasks.map(task => task.ms)).toEqual([NOTICE_RETRY_MS])
    instance.stop()
  })

  it("shares an in-flight flush and leaves a definite failure durable without rescheduling after stop", async () => {
    const started = Promise.withResolvers<void>()
    const receipt = Promise.withResolvers<{ delivered: boolean; delivery: { state: "not_sent" } }>()
    const { instance } = notifier({ send: async () => { started.resolve(); return receipt.promise } })
    await instance.notify(record())
    const first = instance.flush()
    expect(instance.flush()).toBe(first)
    await started.promise
    instance.stop()
    receipt.resolve({ delivered: false, delivery: { state: "not_sent" } })
    await first
    expect(tasks).toEqual([])
    expect(readNoticeOutbox(root)[0]!.deliveries[ari.friendId]!.state).toBe("pending")
  })

  it("retains the actual accepted Teams activity ID with the notice receipt", async () => {
    const { instance } = notifier({ send: async () => ({ delivered: true, delivery: { state: "accepted", messageId: "activity-accepted", conversationId: "conversation-accepted" } }) })
    await instance.notify(record())
    await instance.flush()
    expect(readNoticeOutbox(root)[0]!.deliveries[ari.friendId]).toMatchObject({ state: "sent", messageId: "activity-accepted", attempts: 1 })
  })

  it.each(["sent", "unknown"] as const)("only one concurrent notifier can initiate transport when the winner becomes %s", async outcome => {
    const loaded = Promise.withResolvers<void>()
    let readers = 0
    const targets = async () => {
      if (++readers === 2) loaded.resolve()
      await loaded.promise
      return [ari]
    }
    const transport: string[] = []
    const send = async (_target: NoticeTarget, message: string) => {
      transport.push(message)
      return outcome === "sent" ? { delivered: true } : { delivered: false, delivery: { state: "unknown" as const } }
    }
    const first = notifier({ resolveTargets: targets, send })
    await first.instance.notify(record())
    const second = notifier({ resolveTargets: targets, send })
    await Promise.all([first.instance.flush(), second.instance.flush()])
    expect(transport).toHaveLength(1)
    expect(readNoticeOutbox(root)[0]!.deliveries[ari.friendId]!.state).toBe(outcome)
    expect(readNoticeOutbox(root)[0]!.deliveries[ari.friendId]!.attempts).toBe(1)
  })

  it("retains an eligible return across stop and a fresh notifier before any send", async () => {
    const first = notifier()
    await first.instance.notify(record())
    first.instance.stop()
    expect(first.sent).toEqual([])
    const second = notifier()
    await second.instance.flush()
    expect(second.sent).toHaveLength(1)
    expect(noticeDeliveryState(readNoticeOutbox(root)[0]!, ari.friendId)).toBe("sent")
    expect(readNoticeOutbox(root)[0]!.deliveries[ari.friendId]!.attempts).toBe(1)
  })

  it("keeps a definite failed delivery pending and retries it from a fresh notifier", async () => {
    const first = notifier({ send: async () => ({ delivered: false, reason: "not ready", delivery: { state: "not_sent" } }) })
    await first.instance.notify(record())
    await first.instance.flush()
    expect(noticeDeliveryState(readNoticeOutbox(root)[0]!, ari.friendId)).toBe("pending")
    first.instance.stop()
    const recovered = notifier()
    await recovered.instance.flush()
    expect(recovered.sent).toHaveLength(1)
    expect(noticeDeliveryState(readNoticeOutbox(root)[0]!, ari.friendId)).toBe("sent")
  })

  it("does not blindly retry an uncertain send acknowledgement", async () => {
    const send = vi.fn().mockResolvedValue({ delivered: false, reason: "send_error", delivery: { state: "unknown" } })
    const first = notifier({ send })
    await first.instance.notify(record())
    await first.instance.flush()
    first.instance.stop()
    const recovered = notifier({ send })
    await recovered.instance.flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(noticeDeliveryState(readNoticeOutbox(root)[0]!, ari.friendId)).toBe("unknown")
  })

  it("does not let a friendly error label override an explicit uncertain receipt", async () => {
    const send = vi.fn().mockResolvedValue({ delivered: false, reason: "network trouble", delivery: { state: "unknown" } })
    const { instance } = notifier({ send })
    await instance.notify(record())
    await instance.flush()
    await instance.flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(noticeDeliveryState(readNoticeOutbox(root)[0]!, ari.friendId)).toBe("unknown")
  })

  it("bounds a burst to one digest while preserving receipts for undisplayed sessions", async () => {
    const { instance, sent } = notifier()
    for (let index = 0; index < 9; index++) await instance.notify(record({ session: `S${index}`, reason: `reason-${index}` }))
    await instance.flush()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain("Updates from 9 coding sessions:")
    expect(sent[0]!.text).toContain("and 3 more")
    expect(readNoticeOutbox(root).every(entry => entry.deliveries[ari.friendId]?.state === "sent")).toBe(true)
  })

  it("turns a recovered 207-observation backlog into one historical digest with one receipt relationship", async () => {
    const first = notifier()
    for (let index = 0; index < 207; index++) await first.instance.notify(record({ session: `S${index % 7}` }))
    first.instance.stop()
    const send = vi.fn(async () => ({ delivered: true, delivery: { state: "accepted" as const, messageId: "digest-accepted" } }))
    const recovered = notifier({ send })
    await recovered.instance.flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]).toEqual([ari, expect.stringContaining("Updates from 7 coding sessions:"), expect.any(Array)])
    expect(send.mock.calls[0]).toEqual([ari, expect.stringMatching(/historical/i), expect.any(Array)])
    expect((send.mock.calls[0] as unknown[])[2]).toHaveLength(207)
    const entries = readNoticeOutbox(root)
    expect(entries).toHaveLength(207)
    expect(entries.every(entry => entry.deliveries[ari.friendId]?.messageId === "digest-accepted")).toBe(true)
  })

  it("drains work accepted while an earlier send and its scheduled callback are in flight", async () => {
    const begun = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const send = vi.fn(async () => {
      if (send.mock.calls.length === 1) { begun.resolve(); await release.promise }
      return { delivered: true }
    })
    const { instance } = notifier({ send })
    await instance.notify(record())
    const active = instance.flush()
    await begun.promise
    await instance.notify(record({ session: "new-session" }))
    const fired = tasks.shift()!
    fired.fn()
    release.resolve()
    await active
    expect(tasks).toHaveLength(1)
    tasks.shift()!.fn()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    await instance.flush()
    expect(readNoticeOutbox(root).every(entry => entry.deliveries[ari.friendId]?.state === "sent")).toBe(true)
    instance.stop()
  })

  it("does not start a send when stopped during an asynchronous claim", async () => {
    const { instance, sent } = notifier()
    await instance.notify(record())
    const rename = vi.mocked(fs.renameSync).getMockImplementation()!
    let publications = 0
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      rename(from, to)
      if (++publications === 2) instance.stop()
    })
    await instance.flush()
    expect(sent).toEqual([])
    expect(readNoticeOutbox(root)[0]!.deliveries[ari.friendId]?.state).toBe("pending")
  })

  it.each(["targets", "declaration"] as const)("does not send after stopping during %s", async boundary => {
    const { instance, sent } = notifier({ resolveTargets: async () => {
      if (boundary === "targets") instance.stop()
      return [ari]
    } })
    await instance.notify(record())
    if (boundary === "declaration") {
      const rename = vi.mocked(fs.renameSync).getMockImplementation()!
      vi.mocked(fs.renameSync).mockImplementationOnce((from, to) => { rename(from, to); instance.stop() })
    }
    await instance.flush()
    expect(sent).toEqual([])
    expect(readNoticeOutbox(root)).toHaveLength(1)
    expect(Object.values(readNoticeOutbox(root)[0]!.deliveries).every(delivery => delivery.state === "pending")).toBe(true)
  })

  it("persists no-target returns for delivery after linking an owner", async () => {
    const first = notifier({ resolveTargets: async () => [] })
    await first.instance.notify(record())
    await first.instance.flush()
    first.instance.stop()
    const recovered = notifier()
    await recovered.instance.flush()
    expect(recovered.sent).toHaveLength(1)
  })

  it("keeps retrying a pending owner absent from the current target list without replaying accepted owners", async () => {
    const sam: NoticeTarget = { friendId: "f2", name: "Sam", channel: "teams", key: "conv-2" }
    const first = notifier({
      resolveTargets: async () => [ari, sam],
      send: async target => target.friendId === sam.friendId
        ? { delivered: false, delivery: { state: "not_sent" } }
        : { delivered: true },
    })
    await first.instance.notify(record())
    await first.instance.flush()
    first.instance.stop()
    let targets = [ari]
    const recovered = notifier({ resolveTargets: async () => targets })
    await recovered.instance.flush()
    expect(recovered.sent).toEqual([])
    expect(tasks.map(task => task.ms)).toEqual([NOTICE_RETRY_MS])
    targets = [ari, sam]
    tasks[0]!.fn()
    await vi.waitFor(() => expect(recovered.sent).toHaveLength(1))
    expect(recovered.sent[0]!.target.friendId).toBe(sam.friendId)
    expect(readNoticeOutbox(root)[0]!.deliveries[sam.friendId]!.state).toBe("sent")
    expect(tasks).toEqual([])
  })

  it("startup does not import 207 eligible audit records as new notice intent", async () => {
    for (let index = 0; index < 207; index++) appendReturn(root, record({ noticeEligible: true }))
    const { instance, sent } = notifier()
    await instance.flush()
    expect(sent).toEqual([])
    expect(readNoticeOutbox(root)).toEqual([])
    expect(tasks).toEqual([])
  })

  it("does not replay legacy or explicitly suppressed returns when recovering", async () => {
    appendReturn(root, record())
    appendReturn(root, record({ noticeEligible: false }))
    const { instance, sent } = notifier()
    await instance.flush()
    expect(sent).toEqual([])
  })

  it("sends a burst of returns as one message after the coalescing window", async () => {
    const { instance, sent } = notifier()
    instance.notify(record())
    instance.notify(record({ session: "S2", kind: "gate" }))
    expect(tasks.map((task) => task.ms)).toEqual([NOTICE_COALESCE_MS])
    tasks[0]!.fn()
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]!.target).toBe(ari)
    expect(sent[0]!.text).toBe(noticeMessage([record(), record({ session: "S2", kind: "gate" })], new Map([["0a1b2c3d-4e5f", "surface:12"]])))
    expect(tasks).toEqual([])
    expect(events).toContainEqual(expect.objectContaining({ event: "senses.shepherd_notice_sent", meta: { agent: "ouroboros", friendId: "f1", returns: 2 } }))
    instance.notify(record())
    expect(tasks).toHaveLength(1)
  })

  it("sends each return at most once", async () => {
    const { instance, sent } = notifier()
    instance.notify(record())
    await instance.flush()
    await instance.flush()
    expect(sent).toHaveLength(1)
    expect(tasks).toEqual([])
  })

  it("follows the policy", async () => {
    const { instance, sent } = notifier({ policy: "needs-me" })
    instance.notify(record())
    expect(tasks).toEqual([])
    instance.notify(record({ kind: "gate" }))
    await instance.flush()
    expect(sent.map((entry) => entry.text)).toEqual([noticeLine(record({ kind: "gate" }), "surface:12")])
    const off = notifier({ policy: "off" })
    off.instance.notify(record({ kind: "gate" }))
    await off.instance.flush()
    expect(off.sent).toEqual([])
  })

  it("names the session by a short id when the host cannot list its sessions", async () => {
    const { instance, sent } = notifier({ listSessions: async () => { throw new Error("socket closed") } })
    instance.notify(record())
    await instance.flush()
    expect(sent[0]!.text).toContain("(0a1b2c3d)")
  })

  it("logs a warning and sends nothing when no family friend is reachable", async () => {
    const send = vi.fn()
    const { instance } = notifier({ resolveTargets: async () => [], send })
    instance.notify(record())
    await instance.flush()
    expect(send).not.toHaveBeenCalled()
    expect(events).toContainEqual(expect.objectContaining({ level: "warn", event: "senses.shepherd_notice_no_target" }))
  })

  it("logs a send that fails or is refused and still tries the next owner, without throwing", async () => {
    const sam: NoticeTarget = { friendId: "f2", name: "Sam", channel: "teams", key: "k" }
    const kim: NoticeTarget = { friendId: "f3", name: "Kim", channel: "bluebubbles", key: "k" }
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("Bot Framework 503"))
      .mockResolvedValueOnce({ delivered: false, reason: "internal_content_blocked" })
      .mockResolvedValueOnce({ delivered: false })
    const { instance } = notifier({ resolveTargets: async () => [ari, sam, kim], send })
    instance.notify(record())
    await expect(instance.flush()).resolves.toBeUndefined()
    expect(send).toHaveBeenCalledTimes(3)
    expect(events).toContainEqual(expect.objectContaining({ level: "error", event: "senses.shepherd_notice_error", meta: { agent: "ouroboros", friendId: "f1", error: "Bot Framework 503" } }))
    expect(events).toContainEqual(expect.objectContaining({ level: "warn", event: "senses.shepherd_notice_not_sent", meta: { agent: "ouroboros", friendId: "f2", returns: 1, reason: "internal_content_blocked" } }))
    expect(events).toContainEqual(expect.objectContaining({ level: "warn", event: "senses.shepherd_notice_not_sent", meta: { agent: "ouroboros", friendId: "f3", returns: 1, reason: "unknown" } }))
  })

  it("logs a failure to find the owners without throwing", async () => {
    const { instance } = notifier({ resolveTargets: async () => { throw new Error("friends unreadable") } })
    instance.notify(record())
    await expect(instance.flush()).resolves.toBeUndefined()
    expect(events).toContainEqual(expect.objectContaining({ level: "error", event: "senses.shepherd_notice_error", meta: { agent: "ouroboros", error: "friends unreadable" } }))
  })

  it("cancels a waiting notice when stopped", () => {
    const { instance } = notifier()
    instance.notify(record())
    instance.stop()
    expect(tasks).toEqual([])
    instance.stop()
  })

  it("host_account_refused keeps the notice pending and schedules a retry", async () => {
    const send = vi.fn().mockResolvedValue({ delivered: false, reason: "host_account_refused" })
    const { instance } = notifier({ send })
    await instance.notify(record())
    tasks = []
    await instance.flush()
    expect(noticeDeliveryState(readNoticeOutbox(root)[0]!, ari.friendId)).toBe("pending")
    expect(tasks.map(task => task.ms)).toEqual([NOTICE_RETRY_MS])
    instance.stop()
  })

  it("the same batch retried uses the same deliveryId", async () => {
    const ids: string[] = []
    const send = vi.fn(async (target: NoticeTarget, _text: string, noticeIds: string[]) => {
      ids.push(noticeDeliveryId(target.friendId, noticeIds))
      return ids.length === 1 ? { delivered: false, reason: "bluebubbles_unavailable" } : { delivered: true }
    })
    const { instance } = notifier({ send })
    await instance.notify(record())
    await instance.flush()
    await instance.flush()
    expect(send).toHaveBeenCalledTimes(2)
    expect(ids[1]).toBe(ids[0])
    expect(noticeDeliveryState(readNoticeOutbox(root)[0]!, ari.friendId)).toBe("sent")
    instance.stop()
  })

  it("Teams target still receives the messageId receipt", async () => {
    const send = vi.fn(async () => ({ delivered: true, delivery: { state: "accepted" as const, messageId: "teams-activity-1" } }))
    const { instance } = notifier({ send })
    await instance.notify(record())
    await instance.flush()
    expect((send.mock.calls[0] as unknown[])[0]).toMatchObject({ channel: "teams" })
    expect(readNoticeOutbox(root)[0]!.deliveries[ari.friendId]).toMatchObject({ state: "sent", messageId: "teams-activity-1" })
  })

  it("a not-delivered result writes nothing to state/pending", async () => {
    const { instance } = notifier({ send: async () => ({ delivered: false, reason: "bluebubbles_unavailable" }) })
    await instance.notify(record())
    await instance.flush()
    expect(fs.existsSync(path.join(root, "state", "pending"))).toBe(false)
    expect(noticeDeliveryState(readNoticeOutbox(root)[0]!, ari.friendId)).toBe("pending")
    instance.stop()
  })

  it("reads enabled channels from agent.json for the default targets", async () => {
    fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({ senses: { teams: { enabled: true } } }))
    fs.mkdirSync(path.join(root, "friends"), { recursive: true })
    fs.writeFileSync(path.join(root, "friends", "f1.json"), JSON.stringify(friend("f1", { name: "Ari", externalIds: [{ provider: "aad", externalId: "aad-1", linkedAt: "" }] })))
    const targets: NoticeTarget[] = []
    const { instance } = notifier({ resolveTargets: undefined, send: async target => { targets.push(target); return { delivered: true } } })
    await instance.notify(record())
    await instance.flush()
    expect(targets).toEqual([{ friendId: "f1", name: "Ari", channel: "teams", key: "shepherd" }])
  })

  it("defaults to the bundle's family friends and the Teams sender", async () => {
    const { instance } = notifier({ resolveTargets: undefined, send: undefined })
    instance.notify(record())
    await instance.flush()
    expect(events).toContainEqual(expect.objectContaining({ event: "senses.shepherd_notice_no_target" }))
  })
})
