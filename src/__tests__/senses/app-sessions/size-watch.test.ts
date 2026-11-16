import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AppSessionRow } from "../../../senses/app-sessions/client"
import * as face from "../../../senses/app-sessions/app-interface"
import {
  archivedNote, handoffNudge, IDLE_ARCHIVE_MS, neverResume, noticeOversizedSessions, OVERSIZE_BYTES, readMemory, readOversize, shortOfMemory, whereItLeftOff, type SizeWatchDeps,
} from "../../../senses/app-sessions/size-watch"

const MB = 1024 ** 2
const GB = 1024 ** 3
const CALM = { swapUsedBytes: 0, freeBytes: 16 * GB }
/** The Mac mini at 01:44 PT on 2026-11-16: 37 GB of swap in use and 278 MB free. */
const SWAMPED = { swapUsedBytes: 37 * GB, freeBytes: 278 * MB }
const NOW = Date.parse("2026-11-16T09:45:00Z")
const iso = (ms: number): string => new Date(ms).toISOString()

// Tonight's sessions, with the sizes their histories had.
const OB_HOME = "5b7e15ca-b9ee-4f09-857c-447404c74002"
const MANIFEST = "f157e8cb-3b82-492e-b892-4a11e878589d"
const OURO_MD = "a4289312-84ef-42bb-949a-87f3a8f5e4f6"
const LABS = "05779719-148f-4d21-8571-96fea606dd20"
const COORDINATOR = "e4c75498-0000-4000-8000-000000000000"
const SKILLS = "4d39a995-6ee9-444c-b978-dc0d64cb79ad"
const MISSED: Record<string, number> = {
  "1028f746-7bc2-46ae-a729-a447fd315c84": 1_435_032_300,
  [SKILLS]: 599_567_562,
  "d11fe8a0-eabd-4ea3-a703-c16fd9cb5def": 565_332_152,
  "49d3a291-82c1-408f-88ec-77ff9ed10651": 533_438_608,
  "1e81d0cc-06bf-47d6-9038-545331508fdc": 525_538_898,
}

let agentRoot: string
let stateDir: string

/** A sparse `events.jsonl` of `bytes`, ending in `tail`, with an optional saved name. */
function log(id: string, bytes: number, tail = "", name?: string): void {
  const dir = path.join(stateDir, "session-state", id)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "events.jsonl")
  fs.writeFileSync(file, "")
  fs.truncateSync(file, bytes - Buffer.byteLength(tail))
  if (tail) fs.appendFileSync(file, tail)
  if (name !== undefined) fs.writeFileSync(path.join(dir, "workspace.yaml"), `id: ${id}\nname: '${name}'\nuser_named: true\n`)
}

const row = (id: string, over: Partial<AppSessionRow> = {}): AppSessionRow => ({
  id, name: id, kind: "chat", workspaceId: null, workspaceType: null, project: null, projectId: null, projectRepo: null, branch: null, path: null,
  parentSessionId: null, creatorSessionId: null, coordinatingCreatorSessionId: null, state: "working", detail: "", isRunning: true, wasInterrupted: false, remote: false,
  createdAt: null, updatedAt: null, lastActivity: null, ...over,
})
const idle = (id: string, over: Partial<AppSessionRow> = {}): AppSessionRow => row(id, { state: "idle", isRunning: false, ...over })
const sendOk = () => vi.fn(async (_id: string, _text: string) => ({ ok: true, frame: null, error: null }))
const deps = (over: Partial<SizeWatchDeps> = {}): SizeWatchDeps => ({ notify: vi.fn(async () => "sent" as const), now: NOW, send: sendOk(), archive: vi.fn(async () => true), memory: () => CALM, client: { stateDir }, ...over })
const seed = (sessions: Record<string, unknown>): void => {
  const dir = path.join(agentRoot, "state", "senses", "app-sessions")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "oversize.json"), JSON.stringify({ sessions }))
}

beforeEach(() => {
  agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "size-watch-"))
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "size-watch-state-"))
})
afterEach(() => {
  fs.rmSync(agentRoot, { recursive: true, force: true })
  fs.rmSync(stateDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("flagging every session over the limit", () => {
  it("flags tonight's giants that the sidebar no longer listed, without messaging them", async () => {
    for (const [id, bytes] of Object.entries(MISSED)) log(id, bytes, "", id === SKILLS ? "Ouro fix: ouroboros-skills" : undefined)
    log("cafe0000-small", 10 * MB)
    log("unnamed", OVERSIZE_BYTES + 1, "", "")
    log("no-name-line", OVERSIZE_BYTES + 1)
    fs.writeFileSync(path.join(stateDir, "session-state", "no-name-line", "workspace.yaml"), "id: no-name-line\n")
    fs.mkdirSync(path.join(stateDir, "session-state", "no-log-yet"))
    const d = deps()
    expect(await noticeOversizedSessions(agentRoot, [row("cafe0000-small")], d)).toEqual({ nudged: 0, archived: 0 })
    expect(neverResume(agentRoot).sort()).toEqual([...Object.keys(MISSED), "no-name-line", "unnamed"].sort())
    expect(readOversize(agentRoot).unnamed!.name).toBe("unnamed")
    expect(readOversize(agentRoot)[SKILLS]).toEqual({ bytes: 599_567_562, name: "Ouro fix: ouroboros-skills", unlisted: true })
    expect(readOversize(agentRoot)["1e81d0cc-06bf-47d6-9038-545331508fdc"]!.name).toBe("1e81d0cc-06bf-47d6-9038-545331508fdc")
    expect(d.send).not.toHaveBeenCalled()
    expect(d.notify).not.toHaveBeenCalled()
    expect(d.archive).not.toHaveBeenCalled()
  })

  it("keeps a flagged session flagged after it leaves the sidebar, and forgets it once its history is under the limit", async () => {
    log(OB_HOME, 1_097_701_558)
    const d = deps()
    await noticeOversizedSessions(agentRoot, [row(OB_HOME, { name: "ob home catch-up" })], d)
    const asked = readOversize(agentRoot)[OB_HOME]!
    expect(asked).toMatchObject({ name: "ob home catch-up", nudges: 1, to: OB_HOME })
    await noticeOversizedSessions(agentRoot, [], d)
    expect(readOversize(agentRoot)[OB_HOME]).toEqual({ ...asked, unlisted: true })
    await noticeOversizedSessions(agentRoot, [row(OB_HOME, { name: "ob home catch-up" })], d)
    expect(readOversize(agentRoot)[OB_HOME]).not.toHaveProperty("unlisted")
    fs.truncateSync(path.join(stateDir, "session-state", OB_HOME, "events.jsonl"), 1)
    await noticeOversizedSessions(agentRoot, [], d)
    expect(neverResume(agentRoot)).toEqual([])
  })

  it("treats a remote session's local copy as unlisted, and finds nothing without a state directory", async () => {
    log("far", OVERSIZE_BYTES + 1)
    const d = deps()
    await noticeOversizedSessions(agentRoot, [row("far", { remote: true })], d)
    expect(readOversize(agentRoot).far).toMatchObject({ unlisted: true })
    expect(d.send).not.toHaveBeenCalled()
    expect(await noticeOversizedSessions(agentRoot, [], deps({ client: { stateDir: path.join(stateDir, "missing") } }))).toEqual({ nudged: 0, archived: 0 })
  })
})

describe("asking for a hand-off, and again as a session grows", () => {
  it("asks a running giant and its smaller coordinator at once, and not again until it grows by half", async () => {
    log(LABS, 538_939_637)
    const d = deps()
    const rows = [row(LABS, { name: "Ouro fix: labs, desk, ouroboros send-bac", coordinatingCreatorSessionId: COORDINATOR }), row(COORDINATOR)]
    expect(await noticeOversizedSessions(agentRoot, rows, d)).toEqual({ nudged: 1, archived: 0 })
    expect(d.send).toHaveBeenNthCalledWith(1, COORDINATOR, expect.stringMatching(/514 MB[\s\S]*checkpoint[\s\S]*archive[\s\S]*Keep images out of chat/))
    expect(d.send).toHaveBeenNthCalledWith(2, LABS, expect.any(String))
    expect(readOversize(agentRoot)[LABS]).toMatchObject({ nudgedAt: iso(NOW), nudgedBytes: 538_939_637, nudges: 1, to: `${COORDINATOR},${LABS}` })
    log(LABS, Math.floor(538_939_637 * 1.49))
    await noticeOversizedSessions(agentRoot, rows, d)
    expect(d.send).toHaveBeenCalledTimes(2)
  })

  it("re-asks tonight's ouro-md session, asked once at 07:16 and still growing, and keeps asking each time it grows by half", async () => {
    seed({ [OURO_MD]: { bytes: 731_144_375, name: "Ouro header: ouro-md re-set", nudgedAt: "2026-11-16T07:16:35.771Z", to: COORDINATOR } })
    log(OURO_MD, 742_100_323)
    const rows = [row(OURO_MD, { name: "Ouro header: ouro-md re-set", coordinatingCreatorSessionId: COORDINATOR }), row(COORDINATOR)]
    const d = deps()
    expect(await noticeOversizedSessions(agentRoot, rows, d)).toEqual({ nudged: 1, archived: 0 })
    expect(d.send).toHaveBeenCalledWith(COORDINATOR, expect.stringContaining("This is ask 2."))
    expect(d.send).toHaveBeenCalledWith(OURO_MD, expect.stringContaining("This is ask 2."))
    log(OURO_MD, 1024 * MB)
    await noticeOversizedSessions(agentRoot, rows, d)
    expect(d.send).toHaveBeenCalledTimes(2)
    log(OURO_MD, Math.ceil(742_100_323 * 1.5))
    expect(await noticeOversizedSessions(agentRoot, rows, d)).toEqual({ nudged: 1, archived: 0 })
    expect(d.send).toHaveBeenLastCalledWith(OURO_MD, expect.stringContaining("This is ask 3: it was 708 MB at the last one and is still growing."))
    expect(readOversize(agentRoot)[OURO_MD]).toMatchObject({ nudges: 3, nudgedBytes: Math.ceil(742_100_323 * 1.5) })
  })

  it("asks only the giant when its coordinator is a cold giant too, and the coordinator when the giant is cold", async () => {
    log("child", 600 * MB)
    log("cold-boss", 2 * GB)
    log("cold-child", 700 * MB)
    log("boss", 5)
    const d = deps({ archive: vi.fn(async () => false) })
    await noticeOversizedSessions(agentRoot, [row("child", { coordinatingCreatorSessionId: "cold-boss" }), idle("cold-boss"), idle("cold-child", { coordinatingCreatorSessionId: "boss" }), row("boss")], d)
    expect(d.send).toHaveBeenCalledWith("child", expect.stringContaining("600 MB"))
    expect(d.send).toHaveBeenCalledWith("boss", expect.stringContaining("700 MB"))
    expect(d.send).toHaveBeenCalledTimes(2)
    expect(d.notify).toHaveBeenCalledWith(expect.stringContaining("cannot be nudged"), ["oversize:cold-boss"])
  })

  it("tells the owner once about a cold giant with no coordinator, and tries again when the owner or every recipient could not be reached", async () => {
    log("cold", 2 * GB)
    log("live", 2 * GB)
    const notify = vi.fn().mockResolvedValueOnce("pending").mockResolvedValue("sent")
    const send = vi.fn().mockResolvedValueOnce({ ok: false, frame: null, error: "x" }).mockRejectedValueOnce(new Error("down")).mockResolvedValue({ ok: true, frame: null, error: null })
    const d = deps({ notify, send })
    const rows = [idle("cold"), row("live")]
    expect(await noticeOversizedSessions(agentRoot, rows, d)).toEqual({ nudged: 0, archived: 0 })
    expect(readOversize(agentRoot).cold).toMatchObject({ to: "owner" })
    expect(readOversize(agentRoot).cold?.nudgedAt).toBeUndefined()
    expect(await noticeOversizedSessions(agentRoot, rows, d)).toEqual({ nudged: 1, archived: 0 })
    expect(await noticeOversizedSessions(agentRoot, rows, d)).toEqual({ nudged: 1, archived: 0 })
    expect(await noticeOversizedSessions(agentRoot, rows, d)).toEqual({ nudged: 0, archived: 0 })
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it("sends with immediate delivery by default, since a queued ask waits behind a busy coordinator's work", async () => {
    const spy = vi.spyOn(face, "deliverMessage").mockResolvedValue({ ok: true, frame: null, error: null })
    log("a", 3 * GB)
    expect(await noticeOversizedSessions(agentRoot, [row("a")], { notify: vi.fn(), now: NOW, memory: () => CALM, client: { stateDir } })).toEqual({ nudged: 1, archived: 0 })
    expect(spy).toHaveBeenCalledWith("a", expect.any(String), "immediate", { stateDir })
  })

  it("words sizes in MB under a gigabyte", () => {
    expect(handoffNudge("A\nname", 700 * MB)).toContain("700 MB history")
    expect(handoffNudge("A", 2 * GB, 1)).toContain("This is ask 2.")
  })
})

describe("archiving idle giants", () => {
  const PUSH = `{"type":"tool.execution_start","data":{"arguments":{"command":"cd ~/code/ouroboros-skills && git push -q -u origin HEAD:skills-fix 2>&1 | tail -1"}}}\n{"data":{"content":"https://github.com/ourostack/ouroboros-skills/pull/412"}}\n`

  it("archives tonight's skills session 30 minutes after its ask, and tells its coordinator where it left off", async () => {
    const askedAt = NOW - 40 * 60_000
    seed({ [SKILLS]: { bytes: 599_567_562, name: "Ouro fix: ouroboros-skills", nudgedAt: iso(askedAt), nudgedBytes: 599_567_562, nudges: 1, to: COORDINATOR } })
    log(SKILLS, 599_567_562, PUSH)
    const rows = (lastActivity: number): AppSessionRow[] => [idle(SKILLS, { name: "Ouro fix: ouroboros-skills", coordinatingCreatorSessionId: COORDINATOR, lastActivity: iso(lastActivity) }), row(COORDINATOR)]
    const d = deps({ now: askedAt + IDLE_ARCHIVE_MS - 1 })
    expect(await noticeOversizedSessions(agentRoot, rows(askedAt - 60_000), d)).toEqual({ nudged: 0, archived: 0 })
    expect(await noticeOversizedSessions(agentRoot, rows(askedAt + 5 * 60_000), { ...d, now: askedAt + IDLE_ARCHIVE_MS + 60_000 })).toEqual({ nudged: 0, archived: 0 })
    expect(await noticeOversizedSessions(agentRoot, rows(askedAt - 60_000), { ...d, now: askedAt + IDLE_ARCHIVE_MS })).toEqual({ nudged: 0, archived: 1 })
    const where = "last push `git push -q -u origin HEAD:skills-fix`; last pull request https://github.com/ourostack/ouroboros-skills/pull/412"
    expect(d.archive).toHaveBeenCalledWith(expect.objectContaining({ id: SKILLS }), "oversize-idle", `572 MB; ${where}`)
    expect(d.send).toHaveBeenCalledWith(COORDINATOR, archivedNote("Ouro fix: ouroboros-skills", SKILLS, 599_567_562, where))
    expect(readOversize(agentRoot)[SKILLS]).toMatchObject({ archivedAt: iso(askedAt + IDLE_ARCHIVE_MS) })
  })

  it("leaves a session that was never asked, or that the app would not archive, for the next pass", async () => {
    log("never-asked", 600 * MB)
    seed({ refused: { bytes: 600 * MB, name: "refused", nudgedAt: iso(NOW - 2 * IDLE_ARCHIVE_MS), nudgedBytes: 600 * MB, to: "owner" } })
    log("refused", 600 * MB)
    const notify = vi.fn(async () => "pending" as const)
    const archive = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("socket"))
    const d = deps({ notify, archive })
    expect(await noticeOversizedSessions(agentRoot, [idle("never-asked"), idle("refused")], d)).toEqual({ nudged: 0, archived: 0 })
    expect(await noticeOversizedSessions(agentRoot, [idle("refused")], d)).toEqual({ nudged: 0, archived: 0 })
    expect(archive).toHaveBeenCalledTimes(2)
    expect(readOversize(agentRoot).refused).not.toHaveProperty("archivedAt")
  })

  it("under memory pressure archives the idle giants at once, largest first, and never a running or waiting one", async () => {
    log(OB_HOME, 1_097_701_558)
    log(MANIFEST, 565_450_422)
    log(OURO_MD, 742_100_323)
    log("waiting-giant", 900 * MB)
    const order: string[] = []
    const d = deps({ memory: () => SWAMPED, archive: vi.fn(async (archived: AppSessionRow) => { order.push(archived.id); return true }) })
    const rows = [idle(MANIFEST, { name: "Surface manifest runner" }), idle(OB_HOME, { name: "ob home catch-up" }), row(OURO_MD), idle("waiting-giant", { state: "waiting" })]
    expect(await noticeOversizedSessions(agentRoot, rows, d)).toMatchObject({ archived: 2 })
    expect(order).toEqual([OB_HOME, MANIFEST])
    expect(d.archive).toHaveBeenCalledWith(expect.anything(), "memory-pressure", "1.0 GB; no push or pull request in the end of its history")
    expect(d.send).toHaveBeenCalledTimes(1)
    expect(d.send).toHaveBeenCalledWith(OURO_MD, expect.any(String))
  })

  it("reads the machine's own memory when none is injected", async () => {
    log("cold", 600 * MB)
    const archived = shortOfMemory(readMemory()) ? 1 : 0
    expect(await noticeOversizedSessions(agentRoot, [idle("cold")], { ...deps(), memory: undefined })).toMatchObject({ archived })
  })

  it("reads the machine's memory only when an idle giant could be archived", async () => {
    log(OURO_MD, 742_100_323)
    const memory = vi.fn(() => SWAMPED)
    await noticeOversizedSessions(agentRoot, [row(OURO_MD)], deps({ memory }))
    expect(memory).not.toHaveBeenCalled()
  })

  it("archives through the app, keeping the worktree, when no archive is injected", async () => {
    const spy = vi.spyOn(face, "archiveRow").mockResolvedValue({ ok: true })
    log("w", 600 * MB)
    const d = { ...deps({ memory: () => SWAMPED }), archive: undefined }
    expect(await noticeOversizedSessions(agentRoot, [idle("w")], d)).toMatchObject({ archived: 1 })
    expect(spy).toHaveBeenCalledWith(agentRoot, expect.objectContaining({ id: "w" }), "memory-pressure", { stateDir }, { note: "600 MB; no push or pull request in the end of its history", keepWorktree: true })
    spy.mockResolvedValue({ ok: false, error: "busy" })
    expect(await noticeOversizedSessions(agentRoot, [idle("w")], d)).toMatchObject({ archived: 0 })
  })
})

describe("where a session left off", () => {
  it("names the workspace branch, cuts credentials from a push URL, and looks back past the last chunk", () => {
    log("ws", 20 * MB, `{"command":"git push -q https://x-access-token:$GH_TOKEN@github.com/ourostack/ouroboros-website.git home/slugger-sticky 2>&1 | grep -v x"}\n${" ".repeat(5 * MB)}\n`)
    expect(whereItLeftOff({ id: "ws", branch: "home-sticky", projectRepo: "ourostack/ouroboros-website" }, { stateDir }))
      .toBe("branch home-sticky in ourostack/ouroboros-website; last push `git push -q https://github.com/ourostack/ouroboros-website.git home/slugger-sticky`")
    expect(whereItLeftOff({ id: "missing", branch: "b", projectRepo: null }, { stateDir })).toBe("branch b")
  })
})

describe("memory pressure", () => {
  it("reads swap from sysctl on macOS and from /proc/meminfo elsewhere, and counts an unreadable one as none", () => {
    expect(readMemory("darwin", () => "total = 26624.00M  used = 25629.12M  free = 994.88M  (encrypted)\n").swapUsedBytes).toBe(25629.12 * MB)
    expect(readMemory("linux", () => "MemTotal: 100 kB\nSwapTotal:     4096 kB\nSwapFree:      1024 kB\n").swapUsedBytes).toBe(3072 * 1024)
    expect(readMemory("linux", () => "MemTotal: 100 kB\n").swapUsedBytes).toBe(0)
    expect(readMemory("darwin", () => { throw new Error("no sysctl") }).swapUsedBytes).toBe(0)
    expect(readMemory("darwin", () => "odd").swapUsedBytes).toBe(0)
    expect(readMemory().freeBytes).toBeGreaterThan(0)
    // The default readers run on any machine; the one for the other platform fails and counts as no swap.
    expect(readMemory("linux").swapUsedBytes).toBeGreaterThanOrEqual(0)
    expect(readMemory("darwin").swapUsedBytes).toBeGreaterThanOrEqual(0)
  })

  it("is short of memory past 8 GB of swap or under 1 GB free", () => {
    expect(shortOfMemory(SWAMPED)).toBe(true)
    expect(shortOfMemory({ swapUsedBytes: 9 * GB, freeBytes: 16 * GB })).toBe(true)
    expect(shortOfMemory({ swapUsedBytes: 0, freeBytes: 900 * MB })).toBe(true)
    expect(shortOfMemory({ swapUsedBytes: 7 * GB, freeBytes: 2 * GB })).toBe(false)
  })
})
