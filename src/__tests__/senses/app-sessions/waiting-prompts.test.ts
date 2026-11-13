import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AppSessionRow } from "../../../senses/app-sessions/client"
import { appSessionsStateDir, SNAPSHOT_STALE_MS, writeSnapshot, type SenseSnapshot, type WaitingPrompt } from "../../../senses/app-sessions/store"
import {
  noticeWaitingPrompts, ownerNotifier, promptKey, waitingMessage, waitingPromptsOf, WAITING_LIST_MAX, WAITING_MAX_AGE_MS,
  WAITING_NOTICE_MS, type NotifyOwner,
} from "../../../senses/app-sessions/waiting-prompts"
import { waitingStatusLines } from "../../../senses/app-sessions/waiting-status"

const NOW = Date.parse("2026-11-12T10:00:00Z")
let agentRoot: string

const prompt = (over: Partial<WaitingPrompt> = {}): WaitingPrompt => ({ session: "aaaaaaaa-1111", name: "Babysitter", requestId: "r1", what: "run a shell command (Run required Desk boot)", since: NOW - 5 * 60_000, ...over })
const picture = (waitingPrompts: WaitingPrompt[], over: Partial<SenseSnapshot> = {}): SenseSnapshot => ({
  at: new Date(NOW).toISOString(), appRunning: true, counts: { working: 0, idle: 0, waiting: waitingPrompts.length, stuck: 0 }, sessions: [], stuck: [], waitingPrompts, ...over,
})
const row = (id: string, name: string, promptAt: string | null | undefined, requestId = "r1"): AppSessionRow => ({
  id, name, kind: "chat", workspaceId: null, workspaceType: null, project: null, projectId: null, sidebarPlacement: "unknown", state: "waiting",
  detail: "waiting for a permission answer", isRunning: false, wasInterrupted: false, remote: false, updatedAt: null, lastActivity: null,
  ...(promptAt === undefined ? {} : { prompt: { requestId, what: "open a web address", at: promptAt } }),
})
const stateFile = () => path.join(appSessionsStateDir(agentRoot), "waiting-prompts.json")

beforeEach(() => {
  agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "waiting-prompts-"))
})
afterEach(() => {
  fs.rmSync(agentRoot, { recursive: true, force: true })
})

describe("finding the open prompts", () => {
  it("takes each open prompt with the app's time, and ignores sessions that wait on nothing", () => {
    const rows = [row("s1", "One", "2026-11-12T09:50:00.000Z"), row("s2", "Quiet", undefined)]
    expect(waitingPromptsOf(agentRoot, rows, NOW)).toEqual([
      { session: "s1", name: "One", requestId: "r1", what: "open a web address", since: Date.parse("2026-11-12T09:50:00.000Z") },
    ])
  })

  it("keeps the first time it saw a prompt the app gave no time", () => {
    writeSnapshot(agentRoot, picture([prompt({ session: "s1", requestId: "r1", since: NOW - 600_000 })]))
    const [again, fresh] = waitingPromptsOf(agentRoot, [row("s1", "One", null), row("s2", "Two", null)], NOW)
    expect(again!.since).toBe(NOW - 600_000)
    expect(fresh!.since).toBe(NOW)
  })
})

describe("telling the owner", () => {
  it("is quiet when nothing waits", async () => {
    const notify = vi.fn<NotifyOwner>()
    expect(await noticeWaitingPrompts(agentRoot, picture([]), { notify, now: NOW })).toBe(0)
    expect(await noticeWaitingPrompts(agentRoot, picture([], { waitingPrompts: undefined }), { notify, now: NOW })).toBe(0)
    expect(notify).not.toHaveBeenCalled()
    expect(fs.existsSync(stateFile())).toBe(false)
  })

  it("waits out the first two minutes, then tells the owner which session waits on what", async () => {
    const notify = vi.fn<NotifyOwner>(async () => "sent")
    const young = prompt({ since: NOW - WAITING_NOTICE_MS })
    expect(await noticeWaitingPrompts(agentRoot, picture([young]), { notify, now: NOW })).toBe(0)
    expect(notify).not.toHaveBeenCalled()
    expect(await noticeWaitingPrompts(agentRoot, picture([young]), { notify, now: NOW + 1_000 })).toBe(1)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(
      "\"Babysitter\" waits on run a shell command (Run required Desk boot), for 2 min. Only you can answer it, in the Copilot app: open that session and approve or decline.",
      ["aaaaaaaa-1111:r1"],
    )
  })

  it("tells the owner once per prompt, and again only for a new prompt", async () => {
    const notify = vi.fn<NotifyOwner>(async () => "sent")
    const first = prompt()
    for (let tick = 0; tick < 3; tick += 1) await noticeWaitingPrompts(agentRoot, picture([first]), { notify, now: NOW + tick * 60_000 })
    expect(notify).toHaveBeenCalledTimes(1)
    const second = prompt({ requestId: "r2" })
    expect(await noticeWaitingPrompts(agentRoot, picture([first, second]), { notify, now: NOW + 240_000 })).toBe(1)
    expect(notify).toHaveBeenCalledTimes(2)
    expect(notify.mock.calls[1]![1]).toEqual(["aaaaaaaa-1111:r2"])
  })

  it("forgets an answered prompt, so the record does not grow", async () => {
    const notify = vi.fn<NotifyOwner>(async () => "sent")
    await noticeWaitingPrompts(agentRoot, picture([prompt()]), { notify, now: NOW })
    expect(Object.keys(JSON.parse(fs.readFileSync(stateFile(), "utf-8")).notified)).toEqual(["aaaaaaaa-1111:r1"])
    await noticeWaitingPrompts(agentRoot, picture([]), { notify, now: NOW + 60_000 })
    expect(JSON.parse(fs.readFileSync(stateFile(), "utf-8")).notified).toEqual({})
  })

  it("tries again next minute when nothing reached the owner, but not when the send's outcome is unknown", async () => {
    const notify = vi.fn<NotifyOwner>(async () => "pending")
    expect(await noticeWaitingPrompts(agentRoot, picture([prompt()]), { notify, now: NOW })).toBe(0)
    notify.mockResolvedValueOnce("unknown")
    expect(await noticeWaitingPrompts(agentRoot, picture([prompt()]), { notify, now: NOW + 60_000 })).toBe(1)
    expect(await noticeWaitingPrompts(agentRoot, picture([prompt()]), { notify, now: NOW + 120_000 })).toBe(0)
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it("keeps its record through a snapshot that could not read the app", async () => {
    const notify = vi.fn<NotifyOwner>(async () => "sent")
    await noticeWaitingPrompts(agentRoot, picture([prompt()]), { notify, now: NOW })
    expect(await noticeWaitingPrompts(agentRoot, picture([], { error: "no database" }), { notify, now: NOW + 60_000 })).toBe(0)
    await noticeWaitingPrompts(agentRoot, picture([prompt()]), { notify, now: NOW + 120_000 })
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it("does not announce a prompt older than a day", async () => {
    const notify = vi.fn<NotifyOwner>(async () => "sent")
    expect(await noticeWaitingPrompts(agentRoot, picture([prompt({ since: NOW - WAITING_MAX_AGE_MS - 1 })]), { notify, now: NOW })).toBe(0)
    expect(notify).not.toHaveBeenCalled()
  })

  it("sends several new prompts as one message", async () => {
    const notify = vi.fn<NotifyOwner>(async () => "sent")
    const prompts = [prompt({ requestId: "a" }), prompt({ session: "bbbbbbbb-2222", name: "Other", requestId: "b" })]
    expect(await noticeWaitingPrompts(agentRoot, picture(prompts), { notify, now: NOW })).toBe(2)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![1]).toEqual(prompts.map(promptKey))
  })
})

describe("the message and the status lines", () => {
  it("names up to six sessions, counts the rest, and strips anything Teams could read as markup", () => {
    const many = Array.from({ length: WAITING_LIST_MAX + 2 }, (_, index) => prompt({ requestId: `r${index}`, name: index === 0 ? "<b>Bold</b> @everyone" : `S${index}`, since: NOW - 100 * 60_000 }))
    const text = waitingMessage(many, NOW)
    expect(text).toContain("8 sessions wait on prompts only you can answer")
    expect(text).toContain("\"b Bold /b everyone\" waits on run a shell command (Run required Desk boot), for 2 h")
    expect(text).toContain("- and 2 more")
    expect(text.split("\n")).toHaveLength(1 + WAITING_LIST_MAX + 1)
  })

  it("lists waiting sessions oldest first for ouro status, and lists none from a stale or failed snapshot", () => {
    const snapshot = picture([prompt({ since: NOW - 3 * 60_000, session: "bbbbbbbb-2" }), prompt({ since: NOW - 9 * 60_000 })])
    expect(waitingStatusLines(snapshot, NOW)).toEqual([
      "waiting on you: aaaaaaaa (Babysitter) for 9 min: run a shell command (Run required Desk boot)",
      "waiting on you: bbbbbbbb (Babysitter) for 3 min: run a shell command (Run required Desk boot)",
    ])
    expect(waitingStatusLines(picture(Array.from({ length: 10 }, (_, index) => prompt({ requestId: `r${index}` }))), NOW)).toHaveLength(9)
    expect(waitingStatusLines(picture([prompt()], { waitingPrompts: undefined }), NOW)).toEqual([])
    expect(waitingStatusLines(snapshot, NOW + SNAPSHOT_STALE_MS + 1)).toEqual([])
    expect(waitingStatusLines(picture([prompt()], { error: "x" }), NOW)).toEqual([])
    expect(waitingStatusLines(null, NOW)).toEqual([])
  })
})

describe("the owner notifier", () => {
  const target = { friendId: "f1", name: "Ari", channel: "teams" as const, key: "k" }

  it("holds the notice when no one is reachable", async () => {
    const send = vi.fn()
    expect(await ownerNotifier("slugger", agentRoot, { resolveTargets: async () => [], send })("hi", ["k1"])).toBe("pending")
    expect(send).not.toHaveBeenCalled()
  })

  it("finds the owner in the agent's own friends and channels by default", async () => {
    expect(await ownerNotifier("slugger", agentRoot)("hi", ["k1"])).toBe("pending")
  })

  it("sends through the proactive path and maps how each send ended", async () => {
    const run = async (results: Array<unknown>) => {
      const send = vi.fn()
      for (const result of results) {
        if (result instanceof Error) send.mockRejectedValueOnce(result)
        else send.mockResolvedValueOnce(result)
      }
      const outcome = await ownerNotifier("slugger", agentRoot, { resolveTargets: async () => results.map(() => target), send })("hi", ["k1"])
      expect(send).toHaveBeenCalledWith(target, "hi", ["k1"])
      return outcome
    }
    expect(await run([{ delivered: true }])).toBe("sent")
    expect(await run([{ delivered: false, delivery: { state: "not_sent" } }])).toBe("pending")
    expect(await run([{ delivered: false, delivery: { state: "unknown" } }])).toBe("unknown")
    expect(await run([{ delivered: false, reason: "no_teams_bot" }])).toBe("pending")
    expect(await run([{ delivered: false, reason: "send_error" }])).toBe("unknown")
    expect(await run([{ delivered: false }])).toBe("unknown")
    expect(await run([new Error("boom")])).toBe("unknown")
    expect(await run([{ delivered: false, reason: "no_teams_bot" }, { delivered: true }])).toBe("sent")
    expect(await run([{ delivered: false, reason: "no_teams_bot" }, new Error("boom")])).toBe("unknown")
  })
})
