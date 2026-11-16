import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import * as face from "../../../senses/app-sessions/app-interface"

import type { AppSessionRow } from "../../../senses/app-sessions/client"
import { childrenNote, FINISHED_IDLE_MS, HANDOFF_QUIET_MS, retireSessions, type RetireDeps } from "../../../senses/app-sessions/retire"
import { history, TODAYS_PAIRS } from "./successions-fixture"

const NOW = Date.parse("2026-11-16T16:00:00Z")
const iso = (ms: number): string => new Date(ms).toISOString()
const P = "aaaaaaaa-0000-4000-8000-000000000001"
const S = "bbbbbbbb-0000-4000-8000-000000000002"
const CHILD = "cccccccc-0000-4000-8000-000000000003"
const ORPHAN = "dddddddd-0000-4000-8000-000000000004"
const GONE = "eeeeeeee-0000-4000-8000-000000000005"

let agentRoot: string
let stateDir: string

const row = (id: string, over: Partial<AppSessionRow> = {}): AppSessionRow => ({
  id, name: `session ${id.slice(0, 4)}`, kind: "workspace", workspaceId: `w-${id.slice(0, 4)}`, workspaceType: "worktree", project: null, projectId: null, projectRepo: "ourostack/ouroboros", branch: "work",
  path: null, parentSessionId: null, creatorSessionId: null, coordinatingCreatorSessionId: null, state: "idle", detail: "task complete", isRunning: false, wasInterrupted: false, remote: false,
  createdAt: null, updatedAt: iso(NOW - HANDOFF_QUIET_MS - 1), lastActivity: iso(NOW - HANDOFF_QUIET_MS - 1), ...over,
})
const working = { state: "working" as const, isRunning: true, lastActivity: iso(NOW) }
const deps = (over: Partial<RetireDeps> = {}): RetireDeps & { archive: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> } => ({
  now: NOW, client: { stateDir }, archive: vi.fn(async () => true), send: vi.fn(async () => ({ ok: true, frame: null, error: null })), ...over,
}) as RetireDeps & { archive: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> }
const handedOff = (turned = true, first = `Succeeds: ${P}\n\nCarry on.`): void => {
  history(stateDir, P, "Original work.", { turned: true })
  history(stateDir, S, first, { turned })
}

beforeEach(() => {
  agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "retire-"))
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "retire-state-"))
})
afterEach(() => {
  fs.rmSync(agentRoot, { recursive: true, force: true })
  fs.rmSync(stateDir, { recursive: true, force: true })
})

describe("retiring a handed-off session", () => {
  it("archives the predecessor named by a Succeeds line once the successor took a turn and it is idle, keeping a note", async () => {
    handedOff()
    const d = deps()
    expect(await retireSessions(agentRoot, [row(P, { name: "Old coordinator" }), row(S, { ...working, name: "New coordinator" })], d)).toEqual([P])
    expect(d.archive).toHaveBeenCalledTimes(1)
    expect(d.archive).toHaveBeenCalledWith(expect.objectContaining({ id: P }), "handed-off", expect.stringContaining(`succeeded by "New coordinator" (${S.slice(0, 8)}); branch work in ourostack/ouroboros`))
    expect(d.send).not.toHaveBeenCalled()
  })

  it("waits for the successor's first turn", async () => {
    handedOff(false)
    const d = deps()
    expect(await retireSessions(agentRoot, [row(P), row(S, working)], d)).toEqual([])
    history(stateDir, S, `Succeeds: ${P}\n\nCarry on.`, { turned: true })
    expect(await retireSessions(agentRoot, [row(P), row(S, working)], d)).toEqual([P])
  })

  it("never archives a predecessor that is busy, waiting on a person or a plan, stuck, remote, or just went quiet", async () => {
    handedOff()
    const d = deps()
    for (const over of [
      working,
      { state: "waiting" as const, awaiting: "input" as const },
      { state: "waiting" as const, awaiting: "plan" as const },
      { state: "waiting" as const, awaiting: "permission" as const },
      { state: "stuck" as const },
      { remote: true },
      { lastActivity: iso(NOW - 60_000), updatedAt: iso(NOW - 60_000) },
    ]) expect(await retireSessions(agentRoot, [row(P, over), row(S, working)], d)).toEqual([])
    expect(d.archive).not.toHaveBeenCalled()
  })

  it("holds the predecessor while a session it coordinates still works, then tells the successor about its children", async () => {
    handedOff()
    const d = deps()
    const coordinatedBy = { coordinatingCreatorSessionId: P }
    expect(await retireSessions(agentRoot, [row(P), row(S, { ...working, ...coordinatedBy }), row(CHILD, { ...working, ...coordinatedBy, name: "Lane" })], d)).toEqual([])
    expect(await retireSessions(agentRoot, [row(P), row(S, working), row(CHILD, { state: "waiting", awaiting: "input", ...coordinatedBy })], d)).toEqual([])
    expect(d.archive).not.toHaveBeenCalled()
    expect(await retireSessions(agentRoot, [row(P), row(S, { ...working, ...coordinatedBy }), row(CHILD, { ...coordinatedBy, name: "Lane" })], d)).toEqual([P])
    expect(d.send).toHaveBeenCalledWith(S, expect.stringContaining(`It coordinated "Lane" (${CHILD})`))
    fs.rmSync(path.join(agentRoot, "state"), { recursive: true })
    const unreachable = deps({ send: vi.fn(async () => { throw new Error("app closed") }) })
    expect(await retireSessions(agentRoot, [row(P), row(S, working), row(CHILD, coordinatedBy)], unreachable)).toEqual([P])
  })

  it("counts a chat's parent as its coordinator, and an idle remote child as settled", async () => {
    handedOff()
    const d = deps()
    expect(await retireSessions(agentRoot, [row(P), row(S, working), row(CHILD, { kind: "chat", workspaceId: null, parentSessionId: P, ...working })], d)).toEqual([])
    expect(await retireSessions(agentRoot, [row(P), row(S, working), row(CHILD, { remote: true, coordinatingCreatorSessionId: P })], d)).toEqual([P])
  })

  it("retires today's predecessors still in the sidebar, holding desk epoch 3 for its live quota balancer lane", async () => {
    const [epoch3, epoch3Two, kickoff] = TODAYS_PAIRS[0]!
    for (const [predecessor, successor, first] of TODAYS_PAIRS) {
      history(stateDir, predecessor, "Original work.", { turned: true })
      history(stateDir, successor, first, { turned: true })
    }
    const balancer = "61f91411-ed1c-4de0-8bdf-217cadee4219"
    const sidebar = (balancerOver: Partial<AppSessionRow>): AppSessionRow[] => [
      row(epoch3, { name: "desk epoch 3" }),
      row(epoch3Two, { ...working, name: "desk epoch 3 (2)" }),
      row(balancer, { ...balancerOver, coordinatingCreatorSessionId: epoch3, name: "Quota balancer: unlimited and resume" }),
      ...TODAYS_PAIRS.slice(1).map(([, successor]) => row(successor, working)),
    ]
    const d = deps()
    expect(kickoff).toContain(epoch3)
    expect(await retireSessions(agentRoot, sidebar(working), d)).toEqual([])
    expect(await retireSessions(agentRoot, sidebar({}), d)).toEqual([epoch3])
    expect(d.send).toHaveBeenCalledWith(epoch3Two, expect.stringContaining(balancer))
  })

  it("leaves both alone when two sessions claim to succeed each other, and survives a failed archive", async () => {
    history(stateDir, P, `Succeeds: ${S}`, { turned: true })
    history(stateDir, S, `Succeeds: ${P}`, { turned: true })
    const d = deps()
    expect(await retireSessions(agentRoot, [row(P), row(S)], d)).toEqual([])
    fs.rmSync(path.join(agentRoot, "state"), { recursive: true })
    handedOff()
    const failing = deps({ archive: vi.fn(async () => { throw new Error("app closed") }) })
    expect(await retireSessions(agentRoot, [row(P), row(S, working)], failing)).toEqual([])
    expect(failing.archive).toHaveBeenCalledTimes(1)
  })

  it("archives through the app keeping the worktree, and tells the successor through it, by default", async () => {
    handedOff()
    const archive = vi.spyOn(face, "archiveRow").mockResolvedValue({ ok: true })
    const deliver = vi.spyOn(face, "deliverMessage").mockResolvedValue({ ok: true, frame: null, error: null })
    const lane = row(CHILD, { coordinatingCreatorSessionId: P })
    expect(await retireSessions(agentRoot, [row(P), row(S, working), lane], { now: NOW, client: { stateDir } })).toEqual([P])
    expect(archive).toHaveBeenCalledWith(agentRoot, expect.objectContaining({ id: P }), "handed-off", { stateDir }, { note: expect.stringContaining(`succeeded by "session bbbb"`), keepWorktree: true })
    expect(deliver).toHaveBeenCalledWith(S, expect.stringContaining(CHILD), "immediate", { stateDir })
    archive.mockRestore()
    deliver.mockRestore()
  })

  it("names a successor that has left the sidebar by its id, and tells it nothing", async () => {
    handedOff()
    const d = deps()
    expect(await retireSessions(agentRoot, [row(P, { automation: true }), row(CHILD, { coordinatingCreatorSessionId: P })], d)).toEqual([P])
    expect(d.archive).toHaveBeenCalledWith(expect.anything(), "handed-off", expect.stringMatching(/^succeeded by \(bbbbbbbb\); .*; its automation was removed with it$/))
    expect(d.send).not.toHaveBeenCalled()
  })

  it("words the children notice plainly", () => {
    expect(childrenNote(row(P, { name: "Old\nname" }), [row(CHILD, { name: "Lane" })])).toBe(`I archived "Old name" (${P}), the session you succeed, now that you have taken over and it is idle. It coordinated "Lane" (${CHILD}). They are idle and can no longer report to it; message them by id if their work continues. The archive is reversible from the app.`)
  })
})

describe("retiring a finished session", () => {
  const day = { lastActivity: iso(NOW - FINISHED_IDLE_MS - 1), updatedAt: iso(NOW - FINISHED_IDLE_MS - 1) }

  it("archives an idle session whose coordinator is gone, after a day with no turn, noting its last state", async () => {
    const d = deps()
    expect(await retireSessions(agentRoot, [row(ORPHAN, { ...day, coordinatingCreatorSessionId: GONE, detail: "its turn ended" })], d)).toEqual([ORPHAN])
    expect(d.archive).toHaveBeenCalledWith(expect.objectContaining({ id: ORPHAN }), "finished", "its turn ended; branch work in ourostack/ouroboros")
  })

  it("keeps one with a live coordinator, no coordinator, an open pull request, an automation, a busy child, or a turn within a day", async () => {
    const d = deps()
    const gone = { ...day, coordinatingCreatorSessionId: GONE }
    for (const rows of [
      [row(ORPHAN, { ...day, coordinatingCreatorSessionId: P }), row(P, working)],
      [row(ORPHAN, day)],
      [row(ORPHAN, { ...gone, openPullRequest: "https://github.com/ourostack/ouroboros/pull/1" })],
      [row(ORPHAN, { ...gone, automation: true })],
      [row(ORPHAN, gone), row(CHILD, { ...working, coordinatingCreatorSessionId: ORPHAN })],
      [row(ORPHAN, { ...gone, lastActivity: iso(NOW - FINISHED_IDLE_MS + 60_000) })],
      [row(ORPHAN, { ...gone, state: "waiting", awaiting: "input" })],
      [row(ORPHAN, { ...gone, state: "stuck" })],
    ]) expect(await retireSessions(agentRoot, rows, d)).toEqual([])
    expect(d.archive).not.toHaveBeenCalled()
  })

  it("treats a coordinator archived in the same pass as gone, and survives a failed archive", async () => {
    handedOff()
    const lane = row(ORPHAN, { ...day, coordinatingCreatorSessionId: P, detail: "" })
    const d = deps()
    expect(await retireSessions(agentRoot, [row(P), row(S, working), lane], d)).toEqual([P, ORPHAN])
    expect(d.archive).toHaveBeenLastCalledWith(expect.objectContaining({ id: ORPHAN }), "finished", "idle; branch work in ourostack/ouroboros")
    for (const archive of [vi.fn(async () => false), vi.fn(async () => { throw new Error("app closed") })]) {
      expect(await retireSessions(agentRoot, [row(ORPHAN, { ...day, coordinatingCreatorSessionId: GONE })], deps({ archive }))).toEqual([])
    }
  })
})
