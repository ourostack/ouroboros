import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AppSessionRow } from "../../../senses/app-sessions/client"
import * as client from "../../../senses/app-sessions/client"
import { handoffNudge, neverResume, noticeOversizedSessions, OVERSIZE_BYTES, readOversize } from "../../../senses/app-sessions/size-watch"

const NOW = Date.parse("2026-11-15T23:00:00Z")
const GB = 1024 ** 3
let agentRoot: string

const row = (id: string, over: Partial<AppSessionRow> = {}): AppSessionRow => ({
  id, name: id, kind: "workspace", workspaceId: null, workspaceType: null, project: null, projectId: null, sidebarPlacement: "unknown", state: "idle",
  detail: "", isRunning: true, wasInterrupted: false, remote: false, updatedAt: null, lastActivity: null, ...over,
})
const sendOk = () => vi.fn(async () => ({ ok: true, reply: "", messageId: "m", error: null }))

beforeEach(() => { agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "size-watch-")) })
afterEach(() => { fs.rmSync(agentRoot, { recursive: true, force: true }); vi.restoreAllMocks() })

describe("oversized session history", () => {
  it("flags a session over the limit, nudges it once, and says to keep images out of chat", async () => {
    const send = sendOk()
    const notify = vi.fn()
    const sizes: Record<string, number> = { big: 2 * GB, small: 10 }
    const deps = { notify, now: NOW, size: (id: string) => sizes[id]!, send }
    expect(await noticeOversizedSessions(agentRoot, [row("big"), row("small")], deps)).toBe(1)
    expect(send).toHaveBeenCalledWith("big", expect.stringMatching(/2\.0 GB[\s\S]*checkpoint[\s\S]*archive[\s\S]*Keep images out of chat/))
    expect(neverResume(agentRoot)).toEqual(["big"])
    expect(await noticeOversizedSessions(agentRoot, [row("big"), row("small")], deps)).toBe(0)
    expect(send).toHaveBeenCalledTimes(1)
    expect(notify).not.toHaveBeenCalled()
  })

  it("sends the nudge to a smaller coordinator rather than the giant itself", async () => {
    const send = sendOk()
    const sizes: Record<string, number> = { child: 600 * 1024 ** 2, boss: 5 }
    await noticeOversizedSessions(agentRoot, [row("child", { coordinatingCreatorSessionId: "boss" }), row("boss")], { notify: vi.fn(), now: NOW, size: id => sizes[id]!, send })
    expect(send).toHaveBeenCalledWith("boss", expect.stringContaining("600 MB"))
    expect(readOversize(agentRoot).child).toMatchObject({ to: "boss", nudgedAt: new Date(NOW).toISOString() })
  })

  it("never messages a giant that is not running; it tells the owner once instead", async () => {
    const send = sendOk()
    const notify = vi.fn(async () => "sent" as const)
    const deps = { notify, now: NOW, size: () => 2 * GB, send }
    const rows = [row("cold", { isRunning: false })]
    expect(await noticeOversizedSessions(agentRoot, rows, deps)).toBe(1)
    expect(send).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("cannot be nudged"), ["oversize:cold"])
    await noticeOversizedSessions(agentRoot, rows, deps)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it("handles a mix: nudges the running giant and tells the owner about the cold one in the same pass", async () => {
    const send = sendOk()
    const notify = vi.fn(async () => "sent" as const)
    expect(await noticeOversizedSessions(agentRoot, [row("cold", { isRunning: false }), row("live")], { notify, now: NOW, size: () => 2 * GB, send })).toBe(2)
    expect(send).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(expect.any(String), ["oversize:cold"])
  })

  it("tries again when the owner could not be reached, or the send failed", async () => {
    const notify = vi.fn(async () => "pending" as const)
    const send = vi.fn().mockResolvedValueOnce({ ok: false, reply: "", messageId: null, error: "x" }).mockRejectedValueOnce(new Error("down")).mockResolvedValue({ ok: true, reply: "", messageId: null, error: null })
    const deps = { notify, now: NOW, size: () => 2 * GB, send }
    expect(await noticeOversizedSessions(agentRoot, [row("a")], deps)).toBe(0)
    expect(await noticeOversizedSessions(agentRoot, [row("a")], deps)).toBe(0)
    expect(await noticeOversizedSessions(agentRoot, [row("a")], deps)).toBe(1)
    expect(await noticeOversizedSessions(agentRoot, [row("cold", { isRunning: false })], deps)).toBe(0)
    expect(readOversize(agentRoot).cold?.nudgedAt).toBeUndefined()
  })

  it("forgets a session once its history is under the limit again, and skips remote sessions", async () => {
    let big = true
    const deps = { notify: vi.fn(), now: NOW, size: () => (big ? OVERSIZE_BYTES + 1 : 1), send: sendOk() }
    await noticeOversizedSessions(agentRoot, [row("a"), row("far", { remote: true })], deps)
    expect(neverResume(agentRoot)).toEqual(["a"])
    big = false
    await noticeOversizedSessions(agentRoot, [row("a")], deps)
    expect(neverResume(agentRoot)).toEqual([])
  })

  it("measures with the app's event log by default, and sends by default through the client", async () => {
    const spy = vi.spyOn(client, "sendToAppSession").mockResolvedValue({ ok: true, reply: "", messageId: null, error: null })
    vi.spyOn(client, "eventLogSize").mockReturnValue(3 * GB)
    expect(await noticeOversizedSessions(agentRoot, [row("a")], { notify: vi.fn(), now: NOW })).toBe(1)
    expect(spy).toHaveBeenCalledWith("a", expect.any(String), expect.objectContaining({ delivery: "enqueue" }))
  })

  it("words sizes in MB under a gigabyte", () => {
    expect(handoffNudge("A\nname", 700 * 1024 ** 2)).toContain("700 MB history")
  })
})
