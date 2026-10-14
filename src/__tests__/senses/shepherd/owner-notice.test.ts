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
  chooseTeamsBot,
  createOwnerNotifier,
  createTeamsNoticeSender,
  noticeLine,
  noticeMessage,
  noticeWanted,
  plain,
  resolveNoticeTargets,
  type NoticeTarget,
} from "../../../senses/shepherd/owner-notice"

const mockSend = vi.fn()
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
    expect(noticeLine(record({ kind: "unclear", reason: "a shell" }), "s")).toBe("Claude Code in ouroboros (s) stopped and I could not tell what it needs, so I left it. Why: a shell")
    expect(noticeLine(record({ kind: "error", reason: "the judge timed out" }), "s")).toBe("Claude Code in ouroboros (s) stopped but I could not judge it, so I left it. Why: the judge timed out")
  })

  it("never lets terminal fields carry markup or a mention", () => {
    const line = noticeLine(record({ agent: "<at>Ari</at>", cwd: "/x/**repo**", reason: "[click](http://e) @Ari\nnext line", reply: 'go "now" @Ari' }), "s:1")
    expect(line).toBe('at Ari /at in repo (s:1) stopped early, so I sent it back: "go \'now\' Ari". Why: click (http://e) Ari next line')
    expect(line).not.toMatch(/[<>[\]*@\n]/)
  })

  it("puts a burst in one message and counts what does not fit", () => {
    expect(noticeMessage([record()], new Map([["0a1b2c3d-4e5f", "surface:12"]]))).toBe(noticeLine(record(), "surface:12"))
    const two = noticeMessage([record(), record({ session: "S2", kind: "gate", agent: "Codex" })], new Map([["S2", "surface:2"]]))
    expect(two.split("\n")).toEqual(["2 coding agents stopped:", `- ${noticeLine(record())}`, `- ${noticeLine(record({ session: "S2", kind: "gate", agent: "Codex" }), "surface:2")}`])
    const many = noticeMessage(Array.from({ length: 9 }, (_, index) => record({ session: `S${index}` })))
    expect(many.split("\n")).toHaveLength(1 + 6 + 1)
    expect(many.split("\n").at(-1)).toBe("- and 3 more.")
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
    expect(await resolveNoticeTargets(root, store)).toEqual([
      { friendId: "f1", name: "Ari", key: "conv-1", tenantId: "t1" },
      { friendId: "f6", name: "Sam", key: "shepherd" },
    ])
    expect(events).toContainEqual(expect.objectContaining({ event: "senses.shepherd_notice_targets", meta: { count: 2 } }))
  })

  it("reads the bundle's friend records by default", async () => {
    fs.mkdirSync(path.join(root, "friends"), { recursive: true })
    fs.writeFileSync(path.join(root, "friends", "f1.json"), JSON.stringify(friend("f1", { name: "Ari", externalIds: [{ provider: "aad", externalId: "aad-1", linkedAt: "" }] })))
    expect(await resolveNoticeTargets(root)).toEqual([{ friendId: "f1", name: "Ari", key: "shepherd" }])
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
    const send = createTeamsNoticeSender(root, { primary: () => bot("p", "t1"), secondary: () => bot("", ""), botApi })
    const target: NoticeTarget = { friendId: "f1", name: "Ari", key: "conv-1", tenantId: "t1" }
    expect(await send(target, "hello")).toEqual({ delivered: true })
    await send(target, "again")
    expect(botApi).toHaveBeenCalledTimes(1)
    expect(mockSend).toHaveBeenCalledWith(
      { friendId: "f1", sessionKey: "conv-1", text: "hello", textFormat: "plain", intent: "generic_outreach", captureReceipt: true },
      expect.objectContaining({ botApi: { id: "p", conversations: {} } }),
    )
  })

  it("builds a bot client again after one could not be built", async () => {
    const botApi = vi.fn().mockRejectedValueOnce(new Error("no token")).mockResolvedValue({ id: "p", conversations: {} })
    const send = createTeamsNoticeSender(root, { primary: () => bot("p", "t1"), secondary: () => bot("", ""), botApi })
    await expect(send({ friendId: "f1", name: "Ari", key: "k" }, "hi")).rejects.toThrow("no token")
    expect(await send({ friendId: "f1", name: "Ari", key: "k" }, "hi")).toEqual({ delivered: true })
    expect(botApi).toHaveBeenCalledTimes(2)
  })

  it("reports a missing Teams bot without trying to send", async () => {
    const send = createTeamsNoticeSender(root, { primary: () => bot("", ""), secondary: () => bot("", "") })
    expect(await send({ friendId: "f1", name: "Ari", key: "k" }, "hi")).toEqual({ delivered: false, reason: "no_teams_bot" })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it("reads the agent's Teams credentials by default", async () => {
    const home = process.env.HOME
    process.env.HOME = root
    setAgentName("notice-test")
    try {
      const send = createTeamsNoticeSender(root)
      // No runtime credentials in this test: no bot is configured.
      expect(await send({ friendId: "f1", name: "Ari", key: "k" }, "hi")).toEqual({ delivered: false, reason: "no_teams_bot" })
    } finally {
      process.env.HOME = home
      resetIdentity()
    }
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
  const ari: NoticeTarget = { friendId: "f1", name: "Ari", key: "conv-1" }
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

  it("delivers the what and why for every return instead of replacing excess returns with a count", async () => {
    const { instance, sent } = notifier()
    for (let index = 0; index < 9; index++) await instance.notify(record({ session: `S${index}`, reason: `reason-${index}` }))
    await instance.flush()
    expect(sent).toHaveLength(2)
    expect(sent.map(value => value.text).join("\n")).not.toContain("and 3 more")
    for (let index = 0; index < 9; index++) expect(sent.map(value => value.text).join("\n")).toContain(`reason-${index}`)
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

  it("recovers a logged eligible return interrupted before its outbox write", async () => {
    appendReturn(root, record({ noticeEligible: true }))
    const { instance, sent } = notifier()
    await instance.flush()
    expect(sent).toHaveLength(1)
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
    const sam: NoticeTarget = { friendId: "f2", name: "Sam", key: "k" }
    const kim: NoticeTarget = { friendId: "f3", name: "Kim", key: "k" }
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

  it("defaults to the bundle's family friends and the Teams sender", async () => {
    const { instance } = notifier({ resolveTargets: undefined, send: undefined })
    instance.notify(record())
    await instance.flush()
    expect(events).toContainEqual(expect.objectContaining({ event: "senses.shepherd_notice_no_target" }))
  })
})
