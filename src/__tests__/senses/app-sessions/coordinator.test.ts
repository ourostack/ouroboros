import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

import type { AppSessionRow } from "../../../senses/app-sessions/client"
import { coordinatorOf, handoffSuccessors, reportTargets } from "../../../senses/app-sessions/coordinator"

/**
 * The CIT Pages coordinator 84b913b0 handed off to 16caf80c (its project session 9fe74d72) at 16:20 PT on 2026-11-15
 * and was archived. Its two lanes, the customer tracker ad8f4be3 and the React apps 6870545c, reported to the successor
 * all night, but the app still names 84b913b0 as their coordinator and will not let anyone change it; the 07:42 note
 * then told the owner "the coordinator for the Ouro migration lanes is gone".
 */
const OLD = "84b913b0-eff7-44d0-a951-be5f3764b2a9"
const NEW = "16caf80c-46df-4dcf-8ccd-f2c4b909a507"
const NEW_WORKSPACE = "9fe74d72-2d96-472a-a016-47f5966614a2"
const TRACKER = "ad8f4be3-3a5a-4bc7-bb55-7821d8b5934c"
const REACT = "6870545c-12d0-4514-b427-8c4e4436ec6e"
let stateDir: string

const row = (id: string, over: Partial<AppSessionRow> = {}): AppSessionRow => ({
  id, name: id.slice(0, 8), kind: "workspace", workspaceId: null, workspaceType: null, project: null, projectId: null, projectRepo: null, branch: null, path: null,
  parentSessionId: null, creatorSessionId: null, coordinatingCreatorSessionId: null, state: "idle", detail: "", isRunning: false, wasInterrupted: false, remote: false,
  createdAt: null, updatedAt: null, lastActivity: null, ...over,
})

const send = (target: string, asString = false) => JSON.stringify({ type: "assistant.message", data: { toolRequests: [{ name: "send_session_message", arguments: asString ? JSON.stringify({ session_id: target, message: "status" }) : { session_id: target, message: "status" } }] } })

function history(id: string, lines: string[]): void {
  const dir = path.join(stateDir, "session-state", id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "events.jsonl"), `${lines.join("\n")}\n`)
}

// The sidebar after 84b913b0 was archived: the successor is listed under its project-session id too.
const sidebar = (): AppSessionRow[] => [
  row(NEW, { name: "CIT Pages coordinator", workspaceId: NEW_WORKSPACE, isRunning: true, state: "working" }),
  row(TRACKER, { name: "Ouro migration: customer tracker", coordinatingCreatorSessionId: OLD }),
  row(REACT, { name: "Ouro migration: React apps", coordinatingCreatorSessionId: OLD }),
]

beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "coordinator-")) })
afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }))

describe("coordinatorOf, replaying the CIT Pages hand-off", () => {
  it("finds the successor from where each lane sends its reports, by session id or project-session id", () => {
    history(TRACKER, [send(OLD), "not json send_session_message", send(NEW), send(NEW_WORKSPACE, true)])
    history(REACT, [send(OLD), send(NEW_WORKSPACE), send(NEW)])
    const rows = sidebar()
    expect(coordinatorOf(rows[1]!, rows, { client: { stateDir } })).toEqual({ id: NEW, name: "CIT Pages coordinator", via: "reports" })
    expect(coordinatorOf(rows[2]!, rows, { client: { stateDir } })).toEqual({ id: NEW, name: "CIT Pages coordinator", via: "reports" })
  })

  it("follows a hand-off to a listed successor before reading reports", () => {
    const rows = sidebar()
    expect(coordinatorOf(rows[1]!, rows, { client: { stateDir }, successorOf: id => (id === OLD ? NEW_WORKSPACE : null) })).toEqual({ id: NEW, name: "CIT Pages coordinator", via: "hand-off" })
  })

  it("says the coordinator is gone only when the app's, the hand-off's and the reports' all fail", () => {
    history(TRACKER, [send(OLD), send(TRACKER), JSON.stringify({ type: "user.message", data: { content: "use send_session_message" } }), JSON.stringify({ note: "send_session_message" }), JSON.stringify({ data: { toolRequests: [{ name: "other_tool" }, { name: "send_session_message", arguments: "{bad" }, { name: "send_session_message", arguments: null }, { name: 7 }] } })])
    const rows = sidebar()
    expect(coordinatorOf(rows[1]!, rows, { client: { stateDir }, successorOf: () => "not-listed" })).toEqual({ gone: true, recorded: OLD })
    expect(coordinatorOf(rows[2]!, rows, { client: { stateDir } })).toEqual({ gone: true, recorded: OLD })
  })

  it("reads hand-offs from the successors' first messages once per pass, following the Succeeds: line", () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "coordinator-agent-"))
    history(OLD, [JSON.stringify({ type: "user.message", data: { content: "Coordinate CIT Pages." } })])
    history(NEW, [JSON.stringify({ type: "user.message", timestamp: "2026-11-16T00:11:31Z", data: { content: `Succeeds: ${OLD}\n\nYou coordinate CIT Pages now.` } })])
    const successors = handoffSuccessors(agentRoot, { stateDir })
    expect(successors(OLD)).toBe(NEW)
    expect(successors(TRACKER)).toBeNull()
    const rows = sidebar()
    expect(coordinatorOf(rows[1]!, rows, { client: { stateDir }, successorOf: successors })).toEqual({ id: NEW, name: "CIT Pages coordinator", via: "hand-off" })
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it("keeps the app's coordinator while it is listed, and has none for a session made without one", () => {
    const rows = [row("boss", { name: "Boss" }), row("lane", { coordinatingCreatorSessionId: "boss" }), row("self", { coordinatingCreatorSessionId: "self" })]
    expect(coordinatorOf(rows[1]!, rows)).toEqual({ id: "boss", name: "Boss", via: "app" })
    expect(coordinatorOf(rows[0]!, rows)).toBeNull()
    expect(coordinatorOf(rows[2]!, rows, { client: { stateDir } })).toEqual({ gone: true, recorded: "self" })
  })

  it("reads report targets from the end of the history only, and none from a session with no log", () => {
    history(REACT, [send("early"), send("late")])
    expect(reportTargets(REACT, { stateDir })).toEqual(["early", "late"])
    expect(reportTargets(REACT, { stateDir }, send("late").length + 1)).toEqual(["late"])
    expect(reportTargets(TRACKER, { stateDir })).toEqual([])
  })
})
