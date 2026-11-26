import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const nerves = vi.hoisted(() => ({ events: [] as Array<{ event: string; level?: string; meta?: Record<string, unknown> }> }))
vi.mock("../../../nerves/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../nerves/runtime")>()
  return { ...actual, emitNervesEvent: (event: { event: string; level?: string; meta?: Record<string, unknown> }) => { nerves.events.push(event); actual.emitNervesEvent(event as never) } }
})

import {
  ButlerExternalEventAdoptionError,
  advanceExternalEventsFromAwait,
  claimExternalEvent,
  listExternalEventStatus,
  prepareButlerExternalEvents,
  readExternalEventRecord,
  recordExternalEvent,
} from "../../../heart/external-events/router"

const roots: string[] = []
function eventRoot(): string {
  const value = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "butler-events-")))
  roots.push(value)
  return value
}
afterEach(() => {
  prepareButlerExternalEvents("/nonexistent", [])
  nerves.events.length = 0
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true })
})

function sanctuaryRecord(root: string, eventId = "evt-1") {
  return recordExternalEvent({ agent: "sanctuary", source: "sanctuary-health", eventType: "health.observed", eventId }, { root, now: () => "2026-11-26T00:00:00.000Z" })
}

describe("the running Butler adopts events saved under its other name", () => {
  it("moves the other name's folder to the running Butler, and its records read as the running Butler's", () => {
    const root = eventRoot()
    const saved = sanctuaryRecord(root)
    const raw = fs.readFileSync(saved.recordPath, "utf8")

    expect(prepareButlerExternalEvents(root, ["butler", "slugger"])).toBe("adopted")
    expect(fs.existsSync(path.join(root, "sanctuary"))).toBe(false)
    const moved = path.join(root, "butler", "sanctuary-health", "evt-1.json")
    // The file is moved as is: its `agent` field still says sanctuary.
    expect(fs.readFileSync(moved, "utf8")).toBe(raw)
    expect(readExternalEventRecord(moved)).toMatchObject({ agent: "butler", recordPath: moved })
    expect(listExternalEventStatus(root)).toEqual([expect.objectContaining({ agent: "butler", recordPath: moved, corrupt: false })])
    expect(nerves.events).toContainEqual(expect.objectContaining({ event: "daemon.external_events_adopted" }))

    // A mutation writes the record back under the running Butler.
    const claimed = claimExternalEvent(moved, { owner: "worker", expectedVersion: saved.version, expectedGeneration: saved.generation })
    expect(claimed).toMatchObject({ agent: "butler", recordPath: moved })
    expect(JSON.parse(fs.readFileSync(moved, "utf8"))).toMatchObject({ agent: "butler", recordPath: moved })
  })

  it("a rollback adopts the folder back, and a record written as butler reads as sanctuary", () => {
    const root = eventRoot()
    sanctuaryRecord(root)
    prepareButlerExternalEvents(root, ["butler"])
    const moved = path.join(root, "butler", "sanctuary-health", "evt-1.json")
    claimExternalEvent(moved, { owner: "worker", expectedVersion: 1, expectedGeneration: 1 })

    expect(prepareButlerExternalEvents(root, ["sanctuary"])).toBe("adopted")
    const back = path.join(root, "sanctuary", "sanctuary-health", "evt-1.json")
    expect(readExternalEventRecord(back)).toMatchObject({ agent: "sanctuary", recordPath: back, executionState: "running" })
  })

  it("without a running Butler, a record reads as the Butler whose folder it sits in", () => {
    const root = eventRoot()
    sanctuaryRecord(root)
    fs.renameSync(path.join(root, "sanctuary"), path.join(root, "butler"))
    const moved = path.join(root, "butler", "sanctuary-health", "evt-1.json")
    expect(readExternalEventRecord(moved)).toMatchObject({ agent: "butler", recordPath: moved })
    expect(advanceExternalEventsFromAwait(root, "butler", "no-such-await")).toEqual([])
  })

  it("a new event naming the other Butler name is filed under the running Butler", () => {
    const root = eventRoot()
    prepareButlerExternalEvents(root, ["butler"])
    const record = sanctuaryRecord(root, "evt-new")
    expect(record).toMatchObject({ agent: "butler", recordPath: path.join(root, "butler", "sanctuary-health", "evt-new.json") })
    expect(fs.existsSync(path.join(root, "sanctuary"))).toBe(false)
    // Recording the same event again after adoption keeps one record, under the running Butler.
    const again = sanctuaryRecord(root, "evt-new")
    expect(again).toMatchObject({ agent: "butler", duplicateCount: 1 })
  })

  it("an existing record under the adopted folder is updated in place as the running Butler's", () => {
    const root = eventRoot()
    sanctuaryRecord(root)
    prepareButlerExternalEvents(root, ["butler"])
    const updated = sanctuaryRecord(root)
    expect(updated).toMatchObject({ agent: "butler", duplicateCount: 1, recordPath: path.join(root, "butler", "sanctuary-health", "evt-1.json") })
  })

  it.each([["butler", "sanctuary"], ["sanctuary", "butler"]] as const)("running as %s with both folders present, merges %s's folder into its own", (running, other) => {
    const root = eventRoot()
    const record = (agent: string, eventId: string, source = "sanctuary-health") => recordExternalEvent({ agent, source, eventType: "health.observed", eventId }, { root, now: () => "2026-11-26T00:00:00.000Z" })
    record(other, "evt-1")
    record(running, "evt-2")
    // The same record in both folders, byte for byte: one copy is kept.
    const shared = record(other, "evt-3")
    fs.copyFileSync(shared.recordPath, path.join(root, running, "sanctuary-health", "evt-3.json"))
    // A source only the other folder has moves over whole; a lock its daemon left is dropped.
    record(other, "evt-4", "app-store-connect")
    fs.mkdirSync(path.join(root, other, "sanctuary-health", "evt-1.json.lock"))

    expect(prepareButlerExternalEvents(root, [running], () => "2026-11-26T01:00:00.000Z")).toBe("merged")
    expect(fs.existsSync(path.join(root, other))).toBe(false)
    expect(fs.readdirSync(path.join(root, running, "sanctuary-health")).sort()).toEqual(["evt-1.json", "evt-2.json", "evt-3.json"])
    expect(listExternalEventStatus(root).map((row) => [row.agent, row.eventId]).sort()).toEqual([[running, "evt-1"], [running, "evt-2"], [running, "evt-3"], [running, "evt-4"]])
    expect(nerves.events).toContainEqual(expect.objectContaining({ event: "daemon.external_events_adopted", meta: expect.objectContaining({ butler: running, merging: true, moved: 2 }) }))
  })

  it("refuses to merge a record that differs between the two folders, and leaves both as they were", () => {
    const root = eventRoot()
    sanctuaryRecord(root)
    recordExternalEvent({ agent: "butler", source: "sanctuary-health", eventType: "health.observed", eventId: "evt-1", summary: "a different observation" }, { root })
    sanctuaryRecord(root, "evt-2")

    expect(() => prepareButlerExternalEvents(root, ["butler"])).toThrow(ButlerExternalEventAdoptionError)
    expect(() => prepareButlerExternalEvents(root, ["butler"])).toThrow(/merging .*sanctuary into .*butler failed: 1 event record\(s\) differ .*evt-1\.json[\s\S]*agent-runnable: /u)
    expect(fs.existsSync(path.join(root, "sanctuary", "sanctuary-health", "evt-2.json"))).toBe(true)
    expect(fs.existsSync(path.join(root, "butler", "sanctuary-health", "evt-2.json"))).toBe(false)
    expect(nerves.events).toContainEqual(expect.objectContaining({ event: "daemon.external_events_adoption_failed", level: "error", meta: expect.objectContaining({ butler: "butler", merging: true, error: expect.stringContaining("differ") }) }))
  })

  it("refuses to merge where one folder has a link or a folder and the other a file", () => {
    const root = eventRoot()
    const saved = sanctuaryRecord(root)
    recordExternalEvent({ agent: "butler", source: "sanctuary-health", eventType: "health.observed", eventId: "evt-2" }, { root })
    fs.symlinkSync(saved.recordPath, path.join(root, "sanctuary", "sanctuary-health", "evt-2.json"))
    fs.writeFileSync(path.join(root, "butler", "app-store-connect"), "not a folder")
    fs.mkdirSync(path.join(root, "sanctuary", "app-store-connect"))
    fs.mkdirSync(path.join(root, "butler", "sanctuary-health", "evt-1.json"))

    expect(() => prepareButlerExternalEvents(root, ["butler"])).toThrow(/3 event record\(s\) differ/u)
  })

  it("refuses to merge a corrupt privileged replay manifest", () => {
    const root = eventRoot()
    for (const agent of ["sanctuary", "butler"]) {
      fs.mkdirSync(path.join(root, agent, "sanctuary-usenet"), { recursive: true })
      fs.writeFileSync(path.join(root, agent, "sanctuary-usenet", ".privileged-replay-manifest.json"), agent === "butler" ? "{not json" : "{}")
    }
    expect(() => prepareButlerExternalEvents(root, ["butler"])).toThrow(/privileged replay manifest .*butler.* is corrupt/u)
    expect(fs.existsSync(path.join(root, "sanctuary", "sanctuary-usenet", ".privileged-replay-manifest.json"))).toBe(true)
  })

  it("does nothing with no Butler, or with nothing under the other name", () => {
    const root = eventRoot()
    sanctuaryRecord(root)
    expect(prepareButlerExternalEvents(root, ["slugger"])).toBe("none")
    expect(prepareButlerExternalEvents(root, ["sanctuary"])).toBe("none")
    expect(prepareButlerExternalEvents(root, ["sanctuary", "butler"])).toBe("none")
    expect(fs.existsSync(path.join(root, "sanctuary"))).toBe(true)
    expect(readExternalEventRecord(path.join(root, "sanctuary", "sanctuary-health", "evt-1.json")).agent).toBe("sanctuary")
  })

  it("fails, with an error event, when the folder cannot be moved", () => {
    const root = eventRoot()
    sanctuaryRecord(root)
    fs.chmodSync(root, 0o555)
    try {
      expect(() => prepareButlerExternalEvents(root, ["butler"])).toThrow(/moving .*sanctuary into .*butler failed/u)
    } finally { fs.chmodSync(root, 0o755) }
    expect(nerves.events).toContainEqual(expect.objectContaining({ event: "daemon.external_events_adoption_failed", level: "error", meta: expect.objectContaining({ merging: false, error: expect.any(String) }) }))
    expect(fs.existsSync(path.join(root, "sanctuary"))).toBe(true)
  })

  it("still refuses a record that is not where its identity says", () => {
    const root = eventRoot()
    const saved = sanctuaryRecord(root)
    const elsewhere = path.join(root, "slugger", "sanctuary-health", "evt-1.json")
    fs.mkdirSync(path.dirname(elsewhere), { recursive: true })
    fs.copyFileSync(saved.recordPath, elsewhere)
    expect(() => readExternalEventRecord(elsewhere)).toThrow(/identity is invalid/u)
    const otherEvent = path.join(root, "butler", "sanctuary-health", "evt-9.json")
    fs.mkdirSync(path.dirname(otherEvent), { recursive: true })
    fs.copyFileSync(saved.recordPath, otherEvent)
    expect(() => readExternalEventRecord(otherEvent)).toThrow(/identity is invalid/u)
  })
})
