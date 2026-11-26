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

  const NOW = "2026-11-26T01:00:00.000Z"
  const quarantineOf = (root: string, other: string) => path.join(root, ".adoption-conflicts", other, NOW)

  it.each([["butler", "sanctuary"], ["sanctuary", "butler"]] as const)("running as %s, keeps its own copy of a record both folders have and quarantines %s's, and still starts", (running, other) => {
    const root = eventRoot()
    const record = (agent: string, eventId: string, source = "sanctuary-health") => recordExternalEvent({ agent, source, eventType: "health.observed", eventId }, { root, now: () => "2026-11-26T00:00:00.000Z" })
    // The same event recorded under each name: the copies differ only in their own agent and recordPath.
    const theirs = record(other, "evt-1")
    const ours = record(running, "evt-1")
    const theirBytes = fs.readFileSync(theirs.recordPath, "utf8")
    const ourBytes = fs.readFileSync(ours.recordPath, "utf8")
    expect(theirBytes).not.toBe(ourBytes)
    // A lock-like name that is not one of the store's own lock forms is an ordinary entry, and moves.
    fs.mkdirSync(path.join(root, other, "foo.lock"))
    fs.writeFileSync(path.join(root, other, "foo.lock", "kept.txt"), "kept")
    // The store's locks are dropped with the folder.
    fs.mkdirSync(path.join(root, other, ".capacity.lock"))
    fs.writeFileSync(path.join(root, other, ".capacity.lock", "owner"), "stale")
    fs.mkdirSync(path.join(root, other, "sanctuary-health", ".capacity.lock"))

    expect(prepareButlerExternalEvents(root, [running], () => NOW)).toBe("merged")
    expect(fs.existsSync(path.join(root, other))).toBe(false)
    expect(fs.readFileSync(ours.recordPath, "utf8")).toBe(ourBytes)
    expect(fs.readFileSync(path.join(quarantineOf(root, other), "sanctuary-health", "evt-1.json"), "utf8")).toBe(theirBytes)
    expect(fs.readFileSync(path.join(root, running, "foo.lock", "kept.txt"), "utf8")).toBe("kept")
    expect(fs.existsSync(path.join(root, running, ".capacity.lock"))).toBe(false)
    // The quarantine folder is not read as an agent.
    expect(listExternalEventStatus(root).map((row) => [row.agent, row.eventId])).toEqual([[running, "evt-1"]])
    expect(nerves.events).toContainEqual(expect.objectContaining({ event: "daemon.external_events_adoption_quarantined", level: "warn", meta: expect.objectContaining({ butler: running, quarantined: 1, quarantine: quarantineOf(root, other) }) }))
    expect(nerves.events).toContainEqual(expect.objectContaining({ event: "daemon.external_events_adopted", meta: expect.objectContaining({ merging: true, moved: 1, quarantined: 1 }) }))
  })

  it("quarantines a link, or a folder where the other has a file, without stopping the start", () => {
    const root = eventRoot()
    const saved = sanctuaryRecord(root)
    recordExternalEvent({ agent: "butler", source: "sanctuary-health", eventType: "health.observed", eventId: "evt-2" }, { root })
    fs.symlinkSync(saved.recordPath, path.join(root, "sanctuary", "sanctuary-health", "evt-2.json"))
    fs.writeFileSync(path.join(root, "butler", "app-store-connect"), "not a folder")
    fs.mkdirSync(path.join(root, "sanctuary", "app-store-connect"))
    fs.mkdirSync(path.join(root, "butler", "sanctuary-health", "evt-1.json"))

    expect(prepareButlerExternalEvents(root, ["butler"], () => NOW)).toBe("merged")
    const quarantine = quarantineOf(root, "sanctuary")
    expect(fs.lstatSync(path.join(quarantine, "sanctuary-health", "evt-2.json")).isSymbolicLink()).toBe(true)
    expect(fs.lstatSync(path.join(quarantine, "app-store-connect")).isDirectory()).toBe(true)
    expect(fs.lstatSync(path.join(quarantine, "sanctuary-health", "evt-1.json")).isFile()).toBe(true)
    expect(nerves.events).toContainEqual(expect.objectContaining({ event: "daemon.external_events_adoption_quarantined", meta: expect.objectContaining({ quarantined: 3 }) }))
  })

  it("combines the replay manifests, keeping a quarantined privileged record's envelope refused", () => {
    const root = eventRoot()
    const usenet = (agent: string) => path.join(root, agent, "sanctuary-usenet")
    const manifest = (agent: string, observedCount: number) => ({ schemaVersion: 1, agent, source: "sanctuary-usenet", algorithm: "sha256-bloom-v1", bitCount: 65_536, hashCount: 7, bits: Buffer.alloc(8192).toString("base64"), observedCount, updatedAt: "2026-11-26T00:00:00.000Z" })
    for (const agent of ["sanctuary", "butler"]) {
      fs.mkdirSync(usenet(agent), { recursive: true })
      fs.writeFileSync(path.join(usenet(agent), ".privileged-replay-manifest.json"), JSON.stringify(manifest(agent, agent === "butler" ? 2 : 3)))
      fs.writeFileSync(path.join(usenet(agent), "evt-nonce.json"), JSON.stringify({ agent, privilegedIngressNonce: "nonce-1" }))
      fs.writeFileSync(path.join(usenet(agent), "evt-plain.json"), JSON.stringify({ agent }))
      fs.writeFileSync(path.join(usenet(agent), "evt-corrupt.json"), `{${agent}`)
    }
    expect(prepareButlerExternalEvents(root, ["butler"], () => NOW)).toBe("merged")
    const combined = JSON.parse(fs.readFileSync(path.join(usenet("butler"), ".privileged-replay-manifest.json"), "utf8"))
    // 2 + 3 from the two manifests, and one more for the quarantined record's nonce.
    expect(combined).toMatchObject({ agent: "butler", observedCount: 6, updatedAt: NOW })
    expect(fs.readdirSync(path.join(quarantineOf(root, "sanctuary"), "sanctuary-usenet")).sort()).toEqual(["evt-corrupt.json", "evt-nonce.json", "evt-plain.json"])
  })

  it.each(["butler", "sanctuary"] as const)("quarantines the other manifest when the %s copy is corrupt, rather than stopping the start", (corrupt) => {
    const root = eventRoot()
    for (const agent of ["sanctuary", "butler"]) {
      fs.mkdirSync(path.join(root, agent, "sanctuary-usenet"), { recursive: true })
      fs.writeFileSync(path.join(root, agent, "sanctuary-usenet", ".privileged-replay-manifest.json"), agent === corrupt ? "{not json" : JSON.stringify({ schemaVersion: 1, agent, source: "sanctuary-usenet", algorithm: "sha256-bloom-v1", bitCount: 65_536, hashCount: 7, bits: Buffer.alloc(8192).toString("base64"), observedCount: 1, updatedAt: "2026-11-26T00:00:00.000Z" }))
    }
    const running = fs.readFileSync(path.join(root, "butler", "sanctuary-usenet", ".privileged-replay-manifest.json"), "utf8")
    expect(prepareButlerExternalEvents(root, ["butler"], () => NOW)).toBe("merged")
    expect(fs.readFileSync(path.join(root, "butler", "sanctuary-usenet", ".privileged-replay-manifest.json"), "utf8")).toBe(running)
    expect(fs.existsSync(path.join(quarantineOf(root, "sanctuary"), "sanctuary-usenet", ".privileged-replay-manifest.json"))).toBe(true)
  })

  it.each([["a symlink", true], ["a file", false]] as const)("leaves the other name's entry alone when it is %s, warns, and starts", (_kind, symlink) => {
    const root = eventRoot()
    const elsewhere = path.join(root, "elsewhere")
    fs.mkdirSync(path.join(elsewhere, "sanctuary-health"), { recursive: true })
    if (symlink) fs.symlinkSync(elsewhere, path.join(root, "sanctuary"))
    else fs.writeFileSync(path.join(root, "sanctuary"), "not a folder")
    expect(prepareButlerExternalEvents(root, ["butler"])).toBe("skipped")
    expect(fs.lstatSync(path.join(root, "sanctuary")).isSymbolicLink()).toBe(symlink)
    expect(fs.existsSync(path.join(elsewhere, "sanctuary-health"))).toBe(true)
    expect(nerves.events).toContainEqual(expect.objectContaining({ event: "daemon.external_events_adoption_skipped", level: "warn", meta: expect.objectContaining({ symlink }) }))
  })

  it("fails the start, naming the container and host paths, when a record cannot be moved into quarantine", () => {
    const root = eventRoot()
    sanctuaryRecord(root)
    recordExternalEvent({ agent: "butler", source: "sanctuary-health", eventType: "health.observed", eventId: "evt-1" }, { root })
    fs.writeFileSync(path.join(root, ".adoption-conflicts"), "in the way")
    expect(() => prepareButlerExternalEvents(root, ["butler"], () => NOW)).toThrow(ButlerExternalEventAdoptionError)
    let message = ""
    try { prepareButlerExternalEvents(root, ["butler"], () => NOW) } catch (error) { message = (error as Error).message }
    expect(message).toContain(`merging ${path.join(root, "sanctuary")} into ${path.join(root, "butler")} failed`)
    expect(message).toContain(`agent-runnable: move what is left in ${path.join(root, "sanctuary")}`)
    expect(message).toContain("/mnt/user/appdata/ouro-butler/runtime/.ouro-cli/daemon/external-events/sanctuary")
    expect(message).toContain(`/mnt/user/appdata/ouro-butler/runtime/.ouro-cli/daemon/external-events/.adoption-conflicts/sanctuary/${NOW}`)
    expect(fs.existsSync(path.join(root, "sanctuary", "sanctuary-health", "evt-1.json"))).toBe(true)
    expect(nerves.events).toContainEqual(expect.objectContaining({ event: "daemon.external_events_adoption_failed", level: "error", meta: expect.objectContaining({ butler: "butler", merging: true, error: expect.any(String) }) }))
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
