import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

const fault = vi.hoisted(() => ({ fsyncCalls: 0, throwOnFsyncCall: 0, value: "synthetic non-error fsync failure" as unknown }))

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>()
  return {
    ...actual,
    fsyncSync: (descriptor: number) => {
      fault.fsyncCalls += 1
      if (fault.fsyncCalls === fault.throwOnFsyncCall) throw fault.value
      return actual.fsyncSync(descriptor)
    },
  }
})

const event = { ts: "2026-08-21T00:00:00.000Z", level: "info" as const, event: "test.durable_failure", trace_id: "trace", component: "test", message: "durable", meta: {} }
const roots: string[] = []

afterEach(() => {
  fault.fsyncCalls = 0
  fault.throwOnFsyncCall = 0
  fault.value = "synthetic non-error fsync failure"
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("durable sink non-Error failure normalization", () => {
  it("normalizes a non-Error final barrier fsync failure", async () => {
    vi.resetModules()
    const { createNdjsonFileSink } = await import("../../nerves")
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nerves-final-fsync-")); roots.push(root)
    const sink = createNdjsonFileSink(path.join(root, "events.ndjson"))
    fault.throwOnFsyncCall = 1
    sink(event)

    await expect(sink.barrier()).rejects.toThrow("synthetic non-error fsync failure")
  })

  it("normalizes a non-Error pre-append rotation failure", async () => {
    vi.resetModules()
    const { createNdjsonFileSink } = await import("../../nerves")
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nerves-pre-rotate-")); roots.push(root)
    const filePath = path.join(root, "events.ndjson")
    fs.writeFileSync(filePath, "x".repeat(100))
    const sink = createNdjsonFileSink(filePath, { maxSizeBytes: 1, rotationCheckIntervalBytes: 1 })
    fault.throwOnFsyncCall = 1
    sink(event)

    await expect(sink.barrier()).rejects.toThrow("synthetic non-error fsync failure")
  })

  it("normalizes a non-Error post-append durability or rotation failure", async () => {
    vi.resetModules()
    const { createNdjsonFileSink } = await import("../../nerves")
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nerves-post-rotate-")); roots.push(root)
    const sink = createNdjsonFileSink(path.join(root, "events.ndjson"), { maxSizeBytes: 1, rotationCheckIntervalBytes: 1 })
    fault.throwOnFsyncCall = 1
    sink(event)

    await expect(sink.barrier()).rejects.toThrow("synthetic non-error fsync failure")
  })
})
