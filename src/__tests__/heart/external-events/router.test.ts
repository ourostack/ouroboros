import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"
import {
  buildExternalEventMessage,
  externalEventRecordPath,
  getExternalEventRoot,
  recordExternalEvent,
  readExternalEventRecord,
  listExternalEventStatus,
} from "../../../heart/external-events/router"

const cleanupPaths: string[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  cleanupPaths.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of cleanupPaths.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("external event router", () => {
  it("resolves the daemon external-event root under an injected CLI home", () => {
    const home = tempDir("ouro-external-event-home-")

    expect(getExternalEventRoot(home)).toBe(path.join(home, ".ouro-cli", "daemon", "external-events"))
  })

  it("sanitizes provider-controlled path segments before writing receipts", () => {
    const root = tempDir("ouro-external-event-root-")

    expect(externalEventRecordPath(root, {
      agent: " !!! ",
      source: "app store/connect",
      eventId: "feedback:1/2",
    })).toMatch(new RegExp(`^${root}/unknown-[a-f0-9]{16}/app_store_connect-[a-f0-9]{16}/feedback_1_2-[a-f0-9]{16}\\.json$`, "u"))
  })

  it("recovers duplicate counting when an existing receipt is corrupt", () => {
    const root = tempDir("ouro-external-event-root-")
    const input = {
      agent: "slugger",
      source: "app-store-connect",
      eventType: "feedback.created",
      eventId: "feedback-1",
      receivedAt: "2026-07-06T00:00:00.000Z",
    }
    const recordPath = externalEventRecordPath(root, input)
    fs.mkdirSync(path.dirname(recordPath), { recursive: true })
    fs.writeFileSync(recordPath, "{not-json", "utf-8")

    const record = recordExternalEvent(input, {
      root,
      now: () => "2026-07-06T00:01:00.000Z",
    })

    expect(record.duplicateCount).toBe(1)
    expect(JSON.parse(fs.readFileSync(recordPath, "utf-8"))).toMatchObject({
      eventId: "feedback-1",
      duplicateCount: 1,
      updatedAt: "2026-07-06T00:01:00.000Z",
    })
  })

  it("falls back to one duplicate when an existing receipt has a nonnumeric count", () => {
    const root = tempDir("ouro-external-event-root-")
    const input = {
      agent: "slugger",
      source: "app-store-connect",
      eventType: "feedback.created",
      eventId: "feedback-1",
      receivedAt: "2026-07-06T00:00:00.000Z",
    }
    const recordPath = externalEventRecordPath(root, input)
    fs.mkdirSync(path.dirname(recordPath), { recursive: true })
    fs.writeFileSync(recordPath, JSON.stringify({ duplicateCount: "one" }), "utf-8")

    expect(recordExternalEvent(input, {
      root,
      now: () => "2026-07-06T00:01:00.000Z",
    }).duplicateCount).toBe(1)
  })

  it("renders a minimal untrusted-event message without optional fields", () => {
    const root = tempDir("ouro-external-event-root-")
    const record = recordExternalEvent({
      agent: "slugger",
      source: "app-store-connect",
      eventType: "feedback.created",
      eventId: "feedback-1",
      receivedAt: "2026-07-06T00:00:00.000Z",
    }, {
      root,
      now: () => "2026-07-06T00:01:00.000Z",
    })

    expect(buildExternalEventMessage(record)).toContain("Evidence:\n- none")
    expect(buildExternalEventMessage(record)).not.toContain("summary:")
    expect(buildExternalEventMessage(record)).not.toContain("payload:")
  })

  it("renders optional evidence, summary, and payload and rejects invalid receipt identity", () => {
    const root = tempDir("ouro-external-event-root-")
    const record = recordExternalEvent({ agent: "slugger", source: "guard", eventType: "health", eventId: "rich", summary: "Summary", payloadPath: "/payload", evidence: ["one", "two"] }, { root })
    expect(buildExternalEventMessage(record)).toContain("- one\n- two")
    expect(buildExternalEventMessage(record)).toContain("summary: Summary")
    expect(buildExternalEventMessage(record)).toContain("payload: /payload")
    fs.writeFileSync(record.recordPath, JSON.stringify({ ...record, recordPath: `${record.recordPath}.other` }))
    expect(() => readExternalEventRecord(record.recordPath)).toThrow("identity")
    fs.writeFileSync(record.recordPath, JSON.stringify({ schemaVersion: 1 }))
    expect(() => readExternalEventRecord(record.recordPath)).toThrow("invalid")
    expect(listExternalEventStatus(path.join(root, "missing"))).toEqual([])
  })

  it("ignores dot directories without entering a disappearing capacity lock", () => {
    const root = tempDir("ouro-external-event-dot-dirs-")
    const hiddenAgent = path.join(root, ".capacity.lock")
    const hiddenSource = path.join(root, "slugger", ".capacity.lock")
    fs.mkdirSync(hiddenAgent, { recursive: true })
    fs.mkdirSync(hiddenSource, { recursive: true })
    fs.mkdirSync(path.join(hiddenAgent, "source"))
    fs.writeFileSync(path.join(hiddenAgent, "source", "lock-race.json"), "{partial")
    fs.writeFileSync(path.join(hiddenSource, "lock-race.json"), "{partial")

    expect(listExternalEventStatus(root)).toEqual([])
  })
})
