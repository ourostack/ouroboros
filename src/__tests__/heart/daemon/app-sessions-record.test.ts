import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { appSessionsRecord } from "../../../heart/daemon/app-sessions-record"
import { appSessionsStateDir } from "../../../senses/app-sessions/store"

let root: string
const NOW = Date.parse("2026-11-24T12:00:00.000Z")
const put = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)) }
const snapshot = (at: string) => put(path.join(appSessionsStateDir(root), "snapshot.json"), { at, counts: { working: 2 }, sessions: [{ id: "a", name: "fix sync", state: "working" }, { id: "b", name: "other", state: "working" }] })
const digest = (at: string) => put(path.join(appSessionsStateDir(root), "digest.json"), { at, sessions: [{ id: "a", card: { track: "ouro", slug: "fix-sync", status: "in-progress" } }, { id: "b" }] })
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "app-record-")) })
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe("appSessionsRecord", () => {
  it("publishes sessions with their desk card, and drops to nothing as the data ages, over two cycles", () => {
    snapshot("2026-11-24T11:58:00.000Z"); digest("2026-11-24T11:55:00.000Z")
    const first = appSessionsRecord(root, NOW).appSessions!
    expect(first.sessions).toEqual([
      { id: "a", name: "fix sync", state: "working", desk: { track: "ouro", slug: "fix-sync", status: "in-progress", via: "desk" } },
      { id: "b", name: "other", state: "working" },
    ])
    snapshot("2026-11-24T12:20:00.000Z"); digest("2026-11-24T10:00:00.000Z")
    const second = appSessionsRecord(root, NOW + 25 * 60_000).appSessions!
    expect(second.sessions![0]).toEqual({ id: "a", name: "fix sync", state: "working" })
    expect(appSessionsRecord(root, NOW + 60 * 60_000)).toEqual({})
  })

  it("publishes nothing without a snapshot, and tolerates a snapshot without sessions", () => {
    expect(appSessionsRecord(root, NOW)).toEqual({})
    put(path.join(appSessionsStateDir(root), "snapshot.json"), { at: "2026-11-24T11:58:00.000Z", counts: {} })
    expect(appSessionsRecord(root, NOW).appSessions!.sessions).toEqual([])
    snapshot("2026-11-24T11:58:00.000Z"); put(path.join(appSessionsStateDir(root), "digest.json"), { at: "2026-11-24T11:55:00.000Z" })
    expect(appSessionsRecord(root, NOW).appSessions!.sessions![0]).not.toHaveProperty("desk")
  })
})
