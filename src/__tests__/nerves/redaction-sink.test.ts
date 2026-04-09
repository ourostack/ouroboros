import { mkdtempSync, readFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

import { describe, expect, it, vi, afterEach } from "vitest"

import { createNdjsonFileSink } from "../../nerves"
import type { LogEvent } from "../../nerves"

/**
 * Helper: wait for the NDJSON sink's async appendFile to flush.
 * The sink writes asynchronously, so we poll the file briefly.
 */
async function waitForLines(filePath: string, expectedCount: number): Promise<string[]> {
  let lines: string[] = []
  for (let i = 0; i < 40; i++) {
    try {
      const content = readFileSync(filePath, "utf8").trim()
      if (content) {
        lines = content.split("\n")
        if (lines.length >= expectedCount) break
      }
    } catch {
      // File not yet written; retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return lines
}

describe("nerves/redaction-sink integration", () => {
  afterEach(() => {
    // Clean up OURO_LOG_VERBOSE between tests
    delete process.env.OURO_LOG_VERBOSE
  })

  it("redacts sensitive meta keys in NDJSON output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ouro-redact-sink-"))
    const filePath = join(dir, "events.ndjson")
    const sink = createNdjsonFileSink(filePath)

    const entry: LogEvent = {
      ts: "2026-04-08T00:00:00.000Z",
      level: "info",
      event: "provider.init",
      trace_id: "trace-1",
      component: "test",
      message: "provider initialized",
      meta: { apiKey: "sk-ant-api03-realkey123", user: "alice" },
    }
    sink(entry)

    const lines = await waitForLines(filePath, 1)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0] as string)
    expect(parsed.meta.apiKey).toBe("[REDACTED:apiKey]")
    expect(parsed.meta.user).toBe("alice")
    // The anthropic key pattern in the serialized output should also be caught
    expect(lines[0]).not.toContain("sk-ant-api03-realkey123")
  })

  it("writes unredacted output when OURO_LOG_VERBOSE=1", async () => {
    process.env.OURO_LOG_VERBOSE = "1"
    const dir = mkdtempSync(join(tmpdir(), "ouro-redact-verbose-"))
    const filePath = join(dir, "events.ndjson")
    const sink = createNdjsonFileSink(filePath)

    const entry: LogEvent = {
      ts: "2026-04-08T00:00:00.000Z",
      level: "info",
      event: "provider.init",
      trace_id: "trace-1",
      component: "test",
      message: "provider initialized",
      meta: { apiKey: "sk-ant-api03-realkey123" },
    }
    sink(entry)

    const lines = await waitForLines(filePath, 1)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0] as string)
    expect(parsed.meta.apiKey).toBe("sk-ant-api03-realkey123")
  })

  it("does not mutate the in-memory LogEvent object", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ouro-redact-nomutate-"))
    const filePath = join(dir, "events.ndjson")
    const sink = createNdjsonFileSink(filePath)

    const entry: LogEvent = {
      ts: "2026-04-08T00:00:00.000Z",
      level: "info",
      event: "test.event",
      trace_id: "trace-1",
      component: "test",
      message: "test message with Bearer eyJtoken.payload.sig",
      meta: { password: "hunter2", user: "alice" },
    }
    const originalMeta = { ...entry.meta }
    const originalMessage = entry.message

    sink(entry)
    await waitForLines(filePath, 1)

    // The original entry should NOT have been mutated
    expect(entry.meta).toEqual(originalMeta)
    expect(entry.message).toBe(originalMessage)
  })

  it("independently redacts multiple entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ouro-redact-multi-"))
    const filePath = join(dir, "events.ndjson")
    const sink = createNdjsonFileSink(filePath)

    const entry1: LogEvent = {
      ts: "2026-04-08T00:00:00.000Z",
      level: "info",
      event: "auth.start",
      trace_id: "trace-1",
      component: "test",
      message: "auth",
      meta: { token: "abc123" },
    }
    const entry2: LogEvent = {
      ts: "2026-04-08T00:00:01.000Z",
      level: "info",
      event: "auth.end",
      trace_id: "trace-1",
      component: "test",
      message: "done",
      meta: { password: "secret456" },
    }
    sink(entry1)
    sink(entry2)

    const lines = await waitForLines(filePath, 2)
    expect(lines).toHaveLength(2)
    const parsed1 = JSON.parse(lines[0] as string)
    const parsed2 = JSON.parse(lines[1] as string)
    expect(parsed1.meta.token).toBe("[REDACTED:token]")
    expect(parsed2.meta.password).toBe("[REDACTED:password]")
  })
})
