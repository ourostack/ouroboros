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

  it("with both folders present, leaves both and warns without crashing", () => {
    const root = eventRoot()
    sanctuaryRecord(root)
    recordExternalEvent({ agent: "butler", source: "sanctuary-health", eventType: "health.observed", eventId: "evt-2" }, { root })

    expect(prepareButlerExternalEvents(root, ["butler"])).toBe("both-present")
    expect(fs.existsSync(path.join(root, "sanctuary"))).toBe(true)
    expect(fs.existsSync(path.join(root, "butler"))).toBe(true)
    expect(nerves.events).toContainEqual(expect.objectContaining({ event: "daemon.external_events_adoption_conflict", level: "warn" }))
    // Records left under the other name still belong to the running Butler.
    expect(listExternalEventStatus(root).map((row) => row.agent)).toEqual(["butler", "butler"])
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

  it("warns and carries on when the folder cannot be moved", () => {
    const root = eventRoot()
    sanctuaryRecord(root)
    fs.chmodSync(root, 0o555)
    try {
      expect(prepareButlerExternalEvents(root, ["butler"])).toBe("failed")
    } finally { fs.chmodSync(root, 0o755) }
    expect(nerves.events).toContainEqual(expect.objectContaining({ event: "daemon.external_events_adoption_failed", level: "warn" }))
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
