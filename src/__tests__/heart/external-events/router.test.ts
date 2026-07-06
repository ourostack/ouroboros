import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"
import {
  buildExternalEventMessage,
  externalEventRecordPath,
  getExternalEventRoot,
  recordExternalEvent,
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
    })).toBe(path.join(root, "unknown", "app_store_connect", "feedback_1_2.json"))
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
})
