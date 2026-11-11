import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  events: [] as Array<{ event: string; level?: string; meta?: Record<string, unknown> }>,
}))

vi.mock("../../nerves/runtime", async (original) => ({
  ...await original<typeof import("../../nerves/runtime")>(),
  emitNervesEvent: (event: { event: string; level?: string; meta?: Record<string, unknown> }) => { mocks.events.push(event) },
}))

import {
  TEAMS_OUTBOX_MAX_PER_DRAIN,
  TEAMS_OUTBOX_SETTLE_MS,
  drainTeamsOutbox,
  parseTeamsOutboxEntry,
  startTeamsOutboxDrain,
  teamsOutboxDir,
  teamsOutboxFailedDir,
  writeTeamsOutboxEntry,
  type TeamsOutboxNewEntry,
} from "../../senses/teams-outbox"

const entry: TeamsOutboxNewEntry = { friendId: "ari", key: "chat-1", text: "The build is out.", origin: "send_message", fromMachineId: "laptop" }

let agentRoot: string

beforeEach(() => {
  agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "teams-outbox-"))
  mocks.events.length = 0
})

afterEach(() => {
  fs.rmSync(agentRoot, { recursive: true, force: true })
})

const outbox = () => {
  try {
    return fs.readdirSync(teamsOutboxDir(agentRoot)).sort()
  } catch {
    return []
  }
}
const failed = () => {
  try {
    return fs.readdirSync(teamsOutboxFailedDir(agentRoot)).sort()
  } catch {
    return []
  }
}
const eventsNamed = (name: string) => mocks.events.filter((e) => e.event === name)

function writeRaw(name: string, body: string, ageMs = TEAMS_OUTBOX_SETTLE_MS): void {
  fs.mkdirSync(teamsOutboxDir(agentRoot), { recursive: true })
  const file = path.join(teamsOutboxDir(agentRoot), name)
  fs.writeFileSync(file, body)
  const at = new Date(Date.now() - ageMs)
  fs.utimesSync(file, at, at)
}

describe("writeTeamsOutboxEntry", () => {
  it("writes one file named for its time and machine, leaving no temp file", () => {
    const target = writeTeamsOutboxEntry(agentRoot, { ...entry, fromMachineId: "lap top/1" }, 1_700_000_000_000)
    expect(path.basename(target)).toMatch(/^1700000000000-lap_top_1-[0-9a-f]{8}\.json$/)
    expect(parseTeamsOutboxEntry(JSON.parse(fs.readFileSync(target, "utf-8")))).toEqual({
      version: 1,
      ...entry,
      fromMachineId: "lap top/1",
      createdAt: "2023-11-14T22:13:20.000Z",
    })
    expect(fs.readdirSync(path.join(agentRoot, "state", "outbox-tmp"))).toEqual([])
  })
})

describe("parseTeamsOutboxEntry", () => {
  const valid = { version: 1, ...entry, createdAt: "2026-11-10T00:00:00.000Z" }

  it("keeps the optional fields", () => {
    const authorizingSession = { friendId: "ari", channel: "cli", key: "session" }
    expect(parseTeamsOutboxEntry({ ...valid, intent: "explicit_cross_chat", authorizingSession })).toEqual({ ...valid, intent: "explicit_cross_chat", authorizingSession })
    expect(parseTeamsOutboxEntry({ ...valid, authorizingSession: { ...authorizingSession, trustLevel: "family" } })?.authorizingSession).toEqual({ ...authorizingSession, trustLevel: "family" })
  })

  it.each([
    ["not an object", "text"],
    ["an array", []],
    ["another version", { ...valid, version: 2 }],
    ["no text", { ...valid, text: "" }],
    ["no friend", { ...valid, friendId: undefined }],
    ["no key", { ...valid, key: 3 }],
    ["no machine", { ...valid, fromMachineId: "" }],
    ["no time", { ...valid, createdAt: undefined }],
    ["an unknown origin", { ...valid, origin: "carrier-pigeon" }],
    ["an unknown intent", { ...valid, intent: "shout" }],
    ["a malformed authorizing session", { ...valid, authorizingSession: "ari" }],
    ["an authorizing session without a key", { ...valid, authorizingSession: { friendId: "ari", channel: "cli" } }],
    ["an authorizing session without a channel", { ...valid, authorizingSession: { friendId: "ari", key: "s" } }],
    ["an authorizing session without a friend", { ...valid, authorizingSession: { channel: "cli", key: "s" } }],
    ["a non-text trust level", { ...valid, authorizingSession: { friendId: "ari", channel: "cli", key: "s", trustLevel: 3 } }],
  ])("rejects %s", (_label, value) => {
    expect(parseTeamsOutboxEntry(value)).toBeNull()
  })
})

describe("drainTeamsOutbox", () => {
  it("does nothing without an outbox", async () => {
    const send = vi.fn()
    expect(await drainTeamsOutbox(agentRoot, send)).toEqual({ delivered: 0, quarantined: 0, kept: 0 })
    expect(send).not.toHaveBeenCalled()
  })

  it("sends oldest first and deletes what was delivered", async () => {
    const authorizingSession = { friendId: "ari", channel: "cli", key: "session", trustLevel: "family" }
    writeTeamsOutboxEntry(agentRoot, { ...entry, text: "second", intent: "explicit_cross_chat", authorizingSession }, 2_000)
    writeTeamsOutboxEntry(agentRoot, { ...entry, text: "first" }, 1_000)
    writeRaw("ignored.tmp", "partial")
    const send = vi.fn().mockResolvedValue({ delivered: true })
    expect(await drainTeamsOutbox(agentRoot, send)).toEqual({ delivered: 2, quarantined: 0, kept: 0 })
    expect(send.mock.calls.map(([request]) => request)).toEqual([
      { friendId: "ari", key: "chat-1", text: "first", origin: "send_message" },
      { friendId: "ari", key: "chat-1", text: "second", origin: "send_message", intent: "explicit_cross_chat", authorizingSession },
    ])
    expect(outbox()).toEqual(["ignored.tmp"])
    expect(eventsNamed("senses.teams_outbox_delivered").map((e) => e.meta)).toEqual([
      { friendId: "ari", fromMachineId: "laptop" },
      { friendId: "ari", fromMachineId: "laptop" },
    ])
    expect(JSON.stringify(mocks.events)).not.toContain("first")
  })

  it("keeps a message Teams could not take this time", async () => {
    writeTeamsOutboxEntry(agentRoot, entry, 1_000)
    writeTeamsOutboxEntry(agentRoot, { ...entry, text: "two" }, 2_000)
    const send = vi.fn().mockResolvedValueOnce({ delivered: false, reason: "send_error" }).mockResolvedValueOnce({ delivered: false })
    expect(await drainTeamsOutbox(agentRoot, send)).toEqual({ delivered: 0, quarantined: 0, kept: 2 })
    expect(outbox()).toHaveLength(2)
    expect(failed()).toEqual([])
  })

  it("moves a message Teams refused for good out of the outbox", async () => {
    const target = writeTeamsOutboxEntry(agentRoot, entry, 1_000)
    const send = vi.fn().mockResolvedValue({ delivered: false, reason: "missing_target" })
    expect(await drainTeamsOutbox(agentRoot, send)).toEqual({ delivered: 0, quarantined: 1, kept: 0 })
    expect(outbox()).toEqual([])
    expect(failed()).toEqual([path.basename(target)])
    expect(eventsNamed("senses.teams_outbox_quarantined")[0]).toMatchObject({ level: "warn", meta: { file: path.basename(target), reason: "missing_target", friendId: "ari" } })
  })

  it("quarantines a settled file that does not parse or has another version, and waits on a fresh one", async () => {
    writeRaw("1-laptop-bad.json", "{ not json")
    writeRaw("2-laptop-old.json", JSON.stringify({ version: 99 }))
    writeRaw("3-laptop-fresh.json", "{ arriving", 0)
    const send = vi.fn()
    expect(await drainTeamsOutbox(agentRoot, send)).toEqual({ delivered: 0, quarantined: 2, kept: 1 })
    expect(send).not.toHaveBeenCalled()
    expect(outbox()).toEqual(["3-laptop-fresh.json"])
    expect(failed()).toEqual(["1-laptop-bad.json", "2-laptop-old.json"])
    expect(eventsNamed("senses.teams_outbox_quarantined").map((e) => e.meta)).toEqual([
      { file: "1-laptop-bad.json", reason: "unreadable" },
      { file: "2-laptop-old.json", reason: "unreadable" },
    ])
  })

  it("stops when this machine has no Teams client, keeping the rest", async () => {
    for (const at of [1_000, 2_000, 3_000]) writeTeamsOutboxEntry(agentRoot, { ...entry, text: `at ${at}` }, at)
    const send = vi.fn().mockResolvedValueOnce({ delivered: true }).mockResolvedValue(null)
    expect(await drainTeamsOutbox(agentRoot, send)).toEqual({ delivered: 1, quarantined: 0, kept: 2 })
    expect(send).toHaveBeenCalledTimes(2)
    expect(outbox()).toHaveLength(2)
  })

  it("sends at most a capped number per drain", async () => {
    for (let index = 0; index < TEAMS_OUTBOX_MAX_PER_DRAIN + 5; index++) writeTeamsOutboxEntry(agentRoot, { ...entry, text: `n${index}` }, 1_000 + index)
    const send = vi.fn().mockResolvedValue({ delivered: true })
    expect(await drainTeamsOutbox(agentRoot, send)).toEqual({ delivered: TEAMS_OUTBOX_MAX_PER_DRAIN, quarantined: 0, kept: 5 })
    expect(outbox()).toHaveLength(5)
    expect(await drainTeamsOutbox(agentRoot, send, { max: 2 })).toEqual({ delivered: 2, quarantined: 0, kept: 3 })
  })

  it("keeps a message whose send throws and goes on to the next", async () => {
    writeTeamsOutboxEntry(agentRoot, entry, 1_000)
    writeTeamsOutboxEntry(agentRoot, { ...entry, text: "two" }, 2_000)
    writeTeamsOutboxEntry(agentRoot, { ...entry, text: "three" }, 3_000)
    const send = vi.fn().mockRejectedValueOnce(new Error("socket closed")).mockRejectedValueOnce("offline").mockResolvedValue({ delivered: true })
    expect(await drainTeamsOutbox(agentRoot, send)).toEqual({ delivered: 1, quarantined: 0, kept: 2 })
    expect(eventsNamed("senses.teams_outbox_send_error").map((e) => e.meta?.error)).toEqual(["socket closed", "offline"])
  })

  it("never throws", async () => {
    writeTeamsOutboxEntry(agentRoot, entry, 1_000)
    fs.mkdirSync(path.join(agentRoot, "state"), { recursive: true })
    fs.writeFileSync(teamsOutboxFailedDir(agentRoot), "not a directory")
    const send = vi.fn().mockResolvedValue({ delivered: false, reason: "trust_skip" })
    expect(await drainTeamsOutbox(agentRoot, send)).toBeNull()
    expect(eventsNamed("senses.teams_outbox_drain_error")).toHaveLength(1)
    expect(outbox()).toHaveLength(1)
  })

  it("waits on a fresh file by the injected clock", async () => {
    writeRaw("1-laptop-bad.json", "{ not json", 0)
    expect(await drainTeamsOutbox(agentRoot, vi.fn(), { now: () => Date.now() + TEAMS_OUTBOX_SETTLE_MS })).toEqual({ delivered: 0, quarantined: 1, kept: 0 })
  })
})

describe("startTeamsOutboxDrain", () => {
  it("drains now and on each interval, one drain at a time, until stopped", async () => {
    writeTeamsOutboxEntry(agentRoot, entry, 1_000)
    let release: (() => void) | undefined
    const send = vi.fn(() => new Promise<{ delivered: boolean }>((resolve) => { release = () => resolve({ delivered: true }) }))
    const stop = startTeamsOutboxDrain(agentRoot, send, 5)
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(send).toHaveBeenCalledTimes(1)
    release!()
    await vi.waitFor(() => expect(outbox()).toEqual([]))
    writeTeamsOutboxEntry(agentRoot, { ...entry, text: "later" }, 2_000)
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    release!()
    await vi.waitFor(() => expect(outbox()).toEqual([]))
    stop()
    writeTeamsOutboxEntry(agentRoot, { ...entry, text: "after stop" }, 3_000)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(send).toHaveBeenCalledTimes(2)
  })

  it("uses the default interval", () => {
    const stop = startTeamsOutboxDrain(agentRoot, vi.fn())
    stop()
  })
})
