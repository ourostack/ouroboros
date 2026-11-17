import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { rowOf, sessionMessages, sessionRows } from "../../../senses/app-sessions/shepherd-rows"

const FAKE = fileURLToPath(new URL("./fake-shepherd.mjs", import.meta.url))
const SAVED = process.env.SHEPHERD_BIN
let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-rows-"))
  fs.copyFileSync(FAKE, path.join(dir, "shepherd.mjs"))
  process.env.SHEPHERD_BIN = path.join(dir, "shepherd.mjs")
})
afterEach(() => {
  if (SAVED === undefined) delete process.env.SHEPHERD_BIN
  else process.env.SHEPHERD_BIN = SAVED
  fs.rmSync(dir, { recursive: true, force: true })
})

const replies = (map: Record<string, unknown>): void => fs.writeFileSync(path.join(dir, "reply.json"), JSON.stringify(map))
const calls = (): Array<{ argv: string[]; input?: unknown }> =>
  fs.existsSync(path.join(dir, "calls.jsonl")) ? fs.readFileSync(path.join(dir, "calls.jsonl"), "utf-8").trim().split("\n").map(line => JSON.parse(line)) : []

describe("mapping Shepherd's session rows", () => {
  it("maps a busy project session with its project, branch, activity and times", () => {
    expect(rowOf({
      id: "s1", name: "Build", type: "session", project_id: "p1", project_name: "app", project_repo: "org/app", branch: "b", path: "/w", parent_session_id: "p0",
      creator_session_id: "c1", coordinating_creator_session_id: "c2", is_running: true, was_interrupted: true, remote: true, created_at: "t0", updated_at: "t1",
      activity: { status: "busy", why: "the app says it is running", last_activity: "t2" },
    })).toEqual({
      id: "s1", name: "Build", kind: "workspace", workspaceId: null, workspaceType: null, project: "app", projectId: "p1", projectRepo: "org/app", branch: "b", path: "/w",
      parentSessionId: "p0", creatorSessionId: "c1", coordinatingCreatorSessionId: "c2", state: "working", detail: "the app says it is running", isRunning: true,
      wasInterrupted: true, remote: true, createdAt: "t0", updatedAt: "t1", lastActivity: "t2",
    })
  })

  it("names what a session waits on, and a permission request the person must answer as its prompt", () => {
    const base = { id: "s2", activity: { status: "waiting" } }
    expect(rowOf({ ...base, awaiting_input: { kind: "user_input", request_id: "q1", question: "ok?" } })).toMatchObject({ state: "waiting", awaiting: "input" })
    expect(rowOf({ ...base, awaiting_input: { kind: "plan", request_id: "p1" } })).toMatchObject({ awaiting: "plan" })
    expect(rowOf({ ...base, awaiting_input: { kind: "permission", request_id: "r1", what: "run a shell command" } })).toMatchObject({
      awaiting: "permission", prompt: { requestId: "r1", what: "run a shell command", at: null },
    })
    expect(rowOf({ ...base, awaiting_input: { kind: "permission" } })).not.toHaveProperty("prompt")
    expect(rowOf({ ...base, awaiting_input: { kind: "permission", request_id: "r2" } })).toMatchObject({ prompt: { what: "a permission" } })
  })

  it("fills the defaults for a chat with no activity, and reads an unknown state as idle", () => {
    expect(rowOf({ id: "c1", type: "chat", activity: { status: "napping" }, updated_at: "t9" })).toEqual({
      id: "c1", name: "(unnamed)", kind: "chat", workspaceId: null, workspaceType: null, project: null, projectId: null, projectRepo: null, branch: null, path: null,
      parentSessionId: null, creatorSessionId: null, coordinatingCreatorSessionId: null, state: "idle", detail: "", isRunning: false, wasInterrupted: false,
      remote: false, createdAt: null, updatedAt: "t9", lastActivity: "t9",
    })
    expect(rowOf({ id: "c2" })).toMatchObject({ state: "idle", kind: "workspace", lastActivity: null })
  })
})

describe("reading through the Shepherd CLI", () => {
  it("lists the sidebar's sessions as rows, and none when Shepherd lists none", async () => {
    replies({ sessions: { body: { summary: {}, sessions: [{ id: "s1", name: "Now", activity: { status: "stuck", why: "stopped" } }] } } })
    expect(await sessionRows()).toMatchObject([{ id: "s1", name: "Now", state: "stuck", detail: "stopped" }])
    replies({ sessions: { body: { summary: {} } } })
    expect(await sessionRows()).toEqual([])
  })

  it("reads a session's last messages, oldest first, with a count, and none when Shepherd sends none", async () => {
    replies({ messages: { body: { messages: [{ at: "t1", role: "assistant", text: "hi", truncated: true }, { at: null, role: "user" }] } } })
    expect(await sessionMessages("s1", 50)).toEqual([
      { at: "t1", role: "assistant", text: "hi", truncated: true },
      { at: null, role: "user", text: "" },
    ])
    expect(calls()).toEqual([{ argv: ["messages", "s1", "--json", "--input", "-"], input: { count: 50 } }])
    replies({ messages: { body: {} } })
    expect(await sessionMessages("s1", 5)).toEqual([])
  })
})
