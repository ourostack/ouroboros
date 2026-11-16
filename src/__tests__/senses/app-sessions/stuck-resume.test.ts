import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

import * as face from "../../../senses/app-sessions/app-interface"
import type { AppSessionRow } from "../../../senses/app-sessions/client"
import { EMPTY_DIGEST_STATE, type DigestState } from "../../../senses/app-sessions/digest"
import { RESUME_TEXT, RESUMES_PER_DAY, resumeStuck } from "../../../senses/app-sessions/stuck-resume"

/** At 07:49:28 PT the customer tracker lane had stopped between turns half an hour earlier, and the owner was told, not the lane. */
const NOW = Date.parse("2026-11-16T15:49:28Z")
const STOPPED = "2026-11-16T15:20:00.000Z"
const TRACKER = "ad8f4be3-3a5a-4bc7-bb55-7821d8b5934c"
let agentRoot: string

const row = (id: string, over: Partial<AppSessionRow> = {}): AppSessionRow => ({
  id, name: "Ouro migration: customer tracker", kind: "workspace", workspaceId: null, workspaceType: null, project: null, projectId: null, projectRepo: null, branch: null, path: null,
  parentSessionId: null, creatorSessionId: null, coordinatingCreatorSessionId: null, state: "stuck", detail: "not running, but its loop stopped between turns", isRunning: false,
  wasInterrupted: false, remote: false, createdAt: null, updatedAt: null, lastActivity: STOPPED, ...over,
})
const state = (): DigestState => structuredClone(EMPTY_DIGEST_STATE)
const ok = () => vi.fn(async (_id: string, _text: string) => ({ ok: true, frame: null, error: null }))

beforeEach(() => { agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stuck-resume-")) })
afterEach(() => {
  fs.rmSync(agentRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("resumeStuck", () => {
  it("resumes the stopped customer tracker itself, once per stop, and records it for the digest", async () => {
    const send = ok()
    const st = state()
    expect(await resumeStuck(agentRoot, [row(TRACKER)], st, NOW, { send })).toBe(1)
    expect(send).toHaveBeenCalledWith(TRACKER, RESUME_TEXT)
    expect(st.resumed![TRACKER]).toMatchObject({ name: "Ouro migration: customer tracker", lastActivity: STOPPED, ok: true })
    expect(await resumeStuck(agentRoot, [row(TRACKER)], st, NOW + 5 * 60_000, { send })).toBe(0)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("resumes a session that stops again, at most three times a day, then leaves it for the digest's Broken list", async () => {
    const send = ok()
    const st = state()
    for (let stop = 0; stop < RESUMES_PER_DAY + 1; stop += 1) {
      await resumeStuck(agentRoot, [row(TRACKER, { lastActivity: new Date(NOW + stop * 60_000).toISOString() })], st, NOW + stop * 60_000 + 1, { send })
    }
    expect(send).toHaveBeenCalledTimes(RESUMES_PER_DAY)
    await resumeStuck(agentRoot, [row(TRACKER, { lastActivity: new Date(NOW + 25 * 3_600_000).toISOString() })], st, NOW + 25 * 3_600_000, { send })
    expect(send).toHaveBeenCalledTimes(RESUMES_PER_DAY + 1)
    await resumeStuck(agentRoot, [], st, NOW + 50 * 3_600_000, { send })
    expect(st.resumed).toEqual({})
  })

  it("leaves alone a running, hung, remote, waiting, day-old, undated or too-big session", async () => {
    const dir = path.join(agentRoot, "state", "senses", "app-sessions")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "oversize.json"), JSON.stringify({ sessions: { giant: { bytes: 1, name: "giant" } } }))
    const send = ok()
    await resumeStuck(agentRoot, [
      row("running", { isRunning: true }), row("idle", { state: "idle" }), row("remote", { remote: true }), row("asks", { awaiting: "input" }),
      row("old", { lastActivity: "2026-11-15T00:00:00.000Z" }), row("undated", { lastActivity: null }), row("giant"),
    ], state(), NOW, { send })
    expect(send).not.toHaveBeenCalled()
  })

  it("records a resume the app refused or that threw as not done, and sends through the app by default", async () => {
    const st = state()
    await resumeStuck(agentRoot, [row(TRACKER)], st, NOW, { send: async () => { throw new Error("socket closed") } })
    expect(st.resumed![TRACKER]!.ok).toBe(false)
    const deliver = vi.spyOn(face, "deliverMessage").mockResolvedValue({ ok: true, frame: null, error: null })
    expect(await resumeStuck(agentRoot, [row("b")], state(), NOW, { client: { stateDir: agentRoot } })).toBe(1)
    expect(deliver).toHaveBeenCalledWith("b", RESUME_TEXT, "immediate", { stateDir: agentRoot })
  })
})
