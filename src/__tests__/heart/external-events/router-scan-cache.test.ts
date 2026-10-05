import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), statSync: vi.fn(actual.statSync) }
})

import {
  claimExternalEvent,
  externalEventRecordPath,
  ExternalEventScanCache,
  recordExternalEvent,
} from "../../../heart/external-events/router"

const cleanupPaths: string[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  cleanupPaths.push(dir)
  return dir
}

afterEach(() => {
  vi.mocked(fs.readFileSync).mockClear()
  vi.mocked(fs.statSync).mockClear()
  for (const dir of cleanupPaths.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("ExternalEventScanCache", () => {
  const input = (eventId: string, receivedAt = "2026-07-06T00:00:00.000Z") => ({
    agent: "slugger", source: "app-store-connect", eventType: "feedback.created", eventId, receivedAt,
  })

  it("does not re-read or re-parse unchanged records on later scans", () => {
    const root = tempDir("ouro-external-event-cache-")
    for (let i = 0; i < 60; i += 1) recordExternalEvent(input(`event-${i}`), { root })
    const cache = new ExternalEventScanCache()
    const read = vi.mocked(fs.readFileSync)
    read.mockClear()

    const first = cache.scan(root)
    expect(first).toHaveLength(60)
    expect(first.every((entry) => entry.record !== null && entry.error === null)).toBe(true)
    expect(read).toHaveBeenCalledTimes(60)

    read.mockClear()
    const second = cache.scan(root)
    expect(second).toHaveLength(60)
    expect(read).not.toHaveBeenCalled()
    expect(second[0]!.record).toBe(first[0]!.record)
  })

  it("re-reads only the record whose file changed and returns the new state", () => {
    const root = tempDir("ouro-external-event-cache-")
    const a = recordExternalEvent(input("a"), { root })
    recordExternalEvent(input("b"), { root })
    const cache = new ExternalEventScanCache()
    cache.scan(root)
    const read = vi.mocked(fs.readFileSync)

    claimExternalEvent(a.recordPath, { owner: "test-owner", expectedVersion: a.version, expectedGeneration: a.generation })
    read.mockClear()
    const rows = cache.scan(root)
    const changed = rows.find((row) => row.recordPath === a.recordPath)!
    expect(changed.record).toMatchObject({ executionState: "running", claimOwner: "test-owner" })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("reports corrupt files, caches the failure, and picks up a repaired file", () => {
    const root = tempDir("ouro-external-event-cache-")
    const good = recordExternalEvent(input("good"), { root })
    const badPath = externalEventRecordPath(root, input("bad"))
    fs.mkdirSync(path.dirname(badPath), { recursive: true })
    fs.writeFileSync(badPath, "{not-json", "utf-8")
    const cache = new ExternalEventScanCache()

    const first = cache.scan(root)
    expect(first.find((row) => row.recordPath === badPath)).toMatchObject({ record: null, error: expect.stringContaining("JSON") })
    const read = vi.mocked(fs.readFileSync)
    read.mockClear()
    const second = cache.scan(root)
    expect(read).not.toHaveBeenCalled()
    expect(second.find((row) => row.recordPath === badPath)!.record).toBeNull()

    fs.copyFileSync(good.recordPath, badPath)
    const repaired = cache.scan(root).find((row) => row.recordPath === badPath)!
    // A copy carries the other record's identity, so it is still corrupt, but it was re-read.
    expect(read).toHaveBeenCalled()
    expect(repaired.record).toBeNull()
    expect(repaired.error).toContain("identity is invalid")
  })

  it("drops deleted files, ignores dotfiles and non-json files, and handles a missing root", () => {
    const root = tempDir("ouro-external-event-cache-")
    const cache = new ExternalEventScanCache()
    expect(cache.scan(path.join(root, "missing"))).toEqual([])
    const a = recordExternalEvent(input("a"), { root })
    fs.writeFileSync(path.join(path.dirname(a.recordPath), ".hidden.json"), "{}")
    fs.writeFileSync(path.join(path.dirname(a.recordPath), "note.txt"), "x")
    fs.mkdirSync(path.join(root, ".state"), { recursive: true })
    fs.mkdirSync(path.join(root, "slugger", ".state"), { recursive: true })
    fs.writeFileSync(path.join(root, "stray.json"), "{}")
    expect(cache.scan(root).map((row) => row.recordPath)).toEqual([a.recordPath])
    fs.rmSync(a.recordPath)
    expect(cache.scan(root)).toEqual([])
    recordExternalEvent(input("a"), { root })
    expect(cache.scan(root)).toHaveLength(1)
  })

  it("skips a file that disappears between listing and stat", () => {
    const root = tempDir("ouro-external-event-cache-")
    const a = recordExternalEvent(input("a"), { root })
    vi.mocked(fs.statSync).mockImplementationOnce((() => { throw new Error("ENOENT") }) as unknown as typeof fs.statSync)
    expect(a.recordPath).toContain(root)
    expect(new ExternalEventScanCache().scan(root)).toEqual([])
  })
})
