import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { beforeEach, describe, expect, it } from "vitest"

import { openDatabase } from "../../../heart/sqlite"
import { CHILD_RECENT_MS, copilotAppHold, databaseHold, type ConversationFacts } from "../../../senses/shepherd/copilot-app-holds"

const NOW = Date.parse("2026-11-10T17:00:00Z")
const ME = "11111111-aaaa-bbbb-cccc-000000000001"
const CHILD = "22222222-aaaa-bbbb-cccc-000000000002"
const CHAT = "33333333-aaaa-bbbb-cccc-000000000003"
const quiet: ConversationFacts = { humanAt: NOW - 3_600_000, shepherdAt: null, lastTurnTools: ["bash", "view"] }

let stateDir: string

function database(): ReturnType<typeof openDatabase> {
  const db = openDatabase(path.join(stateDir, "data.db"))
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, is_running INTEGER, updated_at TEXT, archived_at TEXT);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, session_id TEXT, creator_session_id TEXT, coordinating_creator_session_id TEXT, archived_at TEXT);
    CREATE TABLE chat_parent_links (session_id TEXT, parent_session_id TEXT, coordinating_creator_session_id TEXT);
    CREATE TABLE session_automations (id TEXT, session_id TEXT, owner_session_id TEXT, name TEXT, paused_at TEXT);
  `)
  db.prepare("INSERT INTO sessions VALUES (?, 'Coordinator', 0, ?, NULL)").run(ME, new Date(NOW).toISOString())
  return db
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-holds-"))
})

describe("Copilot app holds", () => {
  it("lets a genuinely stalled session through to judgment", () => {
    database().close()
    expect(copilotAppHold(stateDir, ME, quiet, "Done with step 2; step 3 is next.", NOW)).toBeNull()
  })

  it("lets a session through when the app has no database", () => {
    expect(copilotAppHold(stateDir, ME, quiet, "Done with step 2.", NOW)).toBeNull()
  })

  it("holds after one nudge until the human writes again", () => {
    const nudged = { ...quiet, shepherdAt: NOW - 60_000 }
    expect(copilotAppHold(stateDir, ME, nudged, "Done.", NOW)).toMatch(/already nudged it once/)
    expect(copilotAppHold(stateDir, ME, { ...nudged, humanAt: null }, "Done.", NOW)).toMatch(/already nudged it once/)
    expect(copilotAppHold(stateDir, ME, { ...nudged, humanAt: NOW - 30_000 }, "Done.", NOW)).toBeNull()
  })

  it("holds a session whose last turn handed work to another session", () => {
    expect(copilotAppHold(stateDir, ME, { ...quiet, lastTurnTools: ["bash", "send_session_message"] }, "Sent.", NOW)).toMatch(/send_session_message/)
    expect(copilotAppHold(stateDir, ME, { ...quiet, lastTurnTools: ["create_session"] }, "Started.", NOW)).toMatch(/create_session/)
  })

  it.each([
    "Lanes are running; I'm waiting on their reports.",
    "Holding. Auto-merge is paused until #1215 is in.",
    "I'll report back once the release lands.",
    "Waiting for the coordinator's reply.",
    "Need a background result before proceeding; I'm waiting.",
    "The background agents are still running.",
    "I'll wait until it merges.",
  ])("holds a session that says it is waiting: %s", (body) => {
    expect(copilotAppHold(stateDir, ME, quiet, body, NOW)).toMatch(/says it is waiting/)
  })

  it("holds a session with an unpaused automation, and only that", () => {
    const db = database()
    db.prepare("INSERT INTO session_automations VALUES ('a1', ?, NULL, 'Hourly check', NULL)").run(ME)
    expect(databaseHold(stateDir, ME, NOW)).toMatch(/session automation \("Hourly check"\)/)
    db.prepare("UPDATE session_automations SET paused_at = 'x'").run()
    expect(databaseHold(stateDir, ME, NOW)).toBeNull()
    db.prepare("INSERT INTO session_automations VALUES ('a2', ?, ?, NULL, NULL)").run(CHILD, ME)
    expect(databaseHold(stateDir, ME, NOW)).toMatch(/session automation,/)
    db.close()
  })

  it("holds a coordinator while a session it coordinates runs or moved recently", () => {
    const db = database()
    db.prepare("INSERT INTO sessions VALUES (?, 'Fleet lane', 1, ?, NULL)").run(CHILD, new Date(NOW - 5 * CHILD_RECENT_MS).toISOString())
    db.prepare("INSERT INTO workspaces VALUES ('w2', ?, NULL, ?, NULL)").run(CHILD, ME)
    expect(databaseHold(stateDir, ME, NOW)).toMatch(/coordinates 1 live session \("Fleet lane"\)/)
    db.prepare("UPDATE sessions SET is_running = 0 WHERE id = ?").run(CHILD)
    expect(databaseHold(stateDir, ME, NOW)).toBeNull()
    db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(new Date(NOW - 60_000).toISOString(), CHILD)
    expect(databaseHold(stateDir, ME, NOW)).toMatch(/coordinates 1 live session/)
    db.prepare("UPDATE workspaces SET archived_at = 'x'").run()
    expect(databaseHold(stateDir, ME, NOW)).toBeNull()
    db.prepare("INSERT INTO sessions VALUES (?, NULL, 1, NULL, NULL)").run(CHAT)
    db.prepare("INSERT INTO chat_parent_links VALUES (?, ?, NULL)").run(CHAT, ME)
    expect(databaseHold(stateDir, ME, NOW)).toMatch(/\(33333333\)/)
    db.close()
  })

  it("names at most three coordinated sessions", () => {
    const db = database()
    for (let index = 0; index < 4; index += 1) {
      const id = `4444444${index}-aaaa-bbbb-cccc-00000000000${index}`
      db.prepare("INSERT INTO sessions VALUES (?, ?, 1, NULL, NULL)").run(id, `Lane ${index}`)
      db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, NULL, NULL)").run(`w${index}`, id, ME)
    }
    expect(databaseHold(stateDir, ME, NOW)).toMatch(/coordinates 4 live sessions \(.*, …\)/)
    db.close()
  })

  it("reads older databases without the newer tables or columns", () => {
    const db = openDatabase(path.join(stateDir, "data.db"))
    db.exec("CREATE TABLE sessions (id TEXT, title TEXT, is_running INTEGER, updated_at TEXT, archived_at TEXT); CREATE TABLE workspaces (id TEXT, archived_at TEXT); CREATE TABLE chat_parent_links (session_id TEXT)")
    db.close()
    expect(databaseHold(stateDir, ME, NOW)).toBeNull()
  })

  it("reads an app database with none of these tables", () => {
    openDatabase(path.join(stateDir, "data.db")).close()
    expect(databaseHold(stateDir, ME, NOW)).toBeNull()
  })

  it("does not count a stopped coordinated session with no update time", () => {
    const db = database()
    db.prepare("INSERT INTO sessions VALUES (?, 'Old lane', 0, NULL, NULL)").run(CHILD)
    db.prepare("INSERT INTO workspaces VALUES ('w2', ?, ?, NULL, NULL)").run(CHILD, ME)
    expect(databaseHold(stateDir, ME, NOW)).toBeNull()
    db.close()
  })

  it("holds when the database cannot even be opened", () => {
    fs.mkdirSync(path.join(stateDir, "data.db"))
    expect(databaseHold(stateDir, ME, NOW)).toMatch(/could not be read/)
  })

  it("holds when the database exists but cannot be read", () => {
    fs.writeFileSync(path.join(stateDir, "data.db"), "not a database at all, just text that is long enough to be read as a header")
    expect(databaseHold(stateDir, ME, NOW)).toMatch(/could not be read/)
  })
})
