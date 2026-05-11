import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockEmitNervesEvent = vi.fn()
vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

const mockDeliver = vi.fn()
vi.mock("../../../heart/cross-chat-delivery", () => ({
  deliverCrossChatMessage: (...args: any[]) => mockDeliver(...args),
}))

import type { AwaitFile } from "../../../heart/awaiting/await-parser"
import {
  buildAlertContent,
  buildAwaitDeliveryDeps,
  deliverAwaitAlert,
  resolveAlertKey,
} from "../../../heart/awaiting/await-alert"

function makeAwaitFile(overrides: Partial<AwaitFile> = {}): AwaitFile {
  return {
    name: "hey_export",
    condition: "HEY export download visible",
    cadence: "5m",
    alert: "bluebubbles",
    mode: "full",
    max_age: "24h",
    status: "pending",
    created_at: "2026-05-10T20:00:00.000Z",
    filed_from: "cli",
    filed_for_friend_id: "ari",
    body: "",
    resolved_at: null,
    resolution_observation: null,
    expired_at: null,
    last_observation_at_expiry: null,
    canceled_at: null,
    cancel_reason: null,
    ...overrides,
  }
}

describe("buildAlertContent", () => {
  it("formats resolved with observation", () => {
    expect(buildAlertContent(makeAwaitFile(), "resolved", "download appeared")).toBe(
      "HEY export download visible — ready. download appeared",
    )
  })

  it("formats resolved without observation", () => {
    expect(buildAlertContent(makeAwaitFile(), "resolved", null)).toBe(
      "HEY export download visible — ready.",
    )
  })

  it("formats expired with last observation", () => {
    expect(buildAlertContent(makeAwaitFile(), "expired", "still no sign")).toBe(
      "HEY export download visible — timed out. last seen: still no sign",
    )
  })

  it("formats expired without observation", () => {
    expect(buildAlertContent(makeAwaitFile(), "expired", null)).toBe(
      "HEY export download visible — timed out. last seen: never observed",
    )
  })

  it("falls back to await name when condition is null", () => {
    expect(buildAlertContent(makeAwaitFile({ condition: null }), "resolved", "ok")).toBe(
      "hey_export — ready. ok",
    )
  })

  it("treats whitespace-only observation as empty", () => {
    expect(buildAlertContent(makeAwaitFile(), "resolved", "   ")).toBe(
      "HEY export download visible — ready.",
    )
  })
})

describe("resolveAlertKey", () => {
  const cleanup: string[] = []
  afterEach(() => {
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (entry) fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  it("returns null when sessions dir is missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "await-alert-"))
    cleanup.push(tmp)
    expect(resolveAlertKey(tmp, "ari", "bluebubbles")).toBeNull()
  })

  it("returns null when sessions dir is empty", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "await-alert-"))
    cleanup.push(tmp)
    fs.mkdirSync(path.join(tmp, "state", "sessions", "ari", "bluebubbles"), { recursive: true })
    expect(resolveAlertKey(tmp, "ari", "bluebubbles")).toBeNull()
  })

  it("prefers DM key (containing ;-;)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "await-alert-"))
    cleanup.push(tmp)
    const dir = path.join(tmp, "state", "sessions", "ari", "bluebubbles")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "+15551112222;+;abc.json"), "{}")
    fs.writeFileSync(path.join(dir, "+15551112222;-;ari.json"), "{}")
    expect(resolveAlertKey(tmp, "ari", "bluebubbles")).toBe("+15551112222;-;ari")
  })

  it("falls back to first session when no DM key present", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "await-alert-"))
    cleanup.push(tmp)
    const dir = path.join(tmp, "state", "sessions", "ari", "teams")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "primary.json"), "{}")
    fs.writeFileSync(path.join(dir, "other.json"), "{}")
    const key = resolveAlertKey(tmp, "ari", "teams")
    expect(key === "primary" || key === "other").toBe(true)
  })
})

describe("deliverAwaitAlert", () => {
  const cleanup: string[] = []

  beforeEach(() => {
    mockEmitNervesEvent.mockReset()
    mockDeliver.mockReset()
  })

  afterEach(() => {
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (entry) fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  it("delivers a resolved alert with full context", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "await-deliver-"))
    cleanup.push(tmp)
    const dir = path.join(tmp, "state", "sessions", "ari", "bluebubbles")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "+15551112222;-;ari.json"), "{}")

    mockDeliver.mockResolvedValue({ status: "delivered_now", detail: "ok" })

    const result = await deliverAwaitAlert({
      awaitFile: makeAwaitFile(),
      reason: "resolved",
      observation: "download appeared",
      agentRoot: tmp,
      agentName: "slugger",
      deliveryDeps: { agentName: "slugger", queuePending: () => {} },
    })

    expect(result.attempted).toBe(true)
    expect(result.delivery?.status).toBe("delivered_now")
    expect(mockDeliver).toHaveBeenCalledWith(
      expect.objectContaining({
        friendId: "ari",
        channel: "bluebubbles",
        key: "+15551112222;-;ari",
        intent: "generic_outreach",
        content: "HEY export download visible — ready. download appeared",
      }),
      expect.any(Object),
    )
  })

  it("delivers an expired alert with last_observation fallback", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "await-deliver-"))
    cleanup.push(tmp)
    const dir = path.join(tmp, "state", "sessions", "ari", "bluebubbles")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "+15551112222;-;ari.json"), "{}")

    mockDeliver.mockResolvedValue({ status: "queued_for_later", detail: "queued" })

    const result = await deliverAwaitAlert({
      awaitFile: makeAwaitFile(),
      reason: "expired",
      observation: null,
      agentRoot: tmp,
      agentName: "slugger",
      deliveryDeps: { agentName: "slugger", queuePending: () => {} },
    })

    expect(result.attempted).toBe(true)
    expect(mockDeliver).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "HEY export download visible — timed out. last seen: never observed",
      }),
      expect.any(Object),
    )
  })

  it("skips when no alert channel configured", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "await-deliver-"))
    cleanup.push(tmp)

    const result = await deliverAwaitAlert({
      awaitFile: makeAwaitFile({ alert: null }),
      reason: "resolved",
      observation: "ok",
      agentRoot: tmp,
      agentName: "slugger",
      deliveryDeps: { agentName: "slugger", queuePending: () => {} },
    })

    expect(result.attempted).toBe(false)
    expect(result.skipped).toBe("no alert channel")
    expect(mockDeliver).not.toHaveBeenCalled()
  })

  it("skips when no friend id configured", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "await-deliver-"))
    cleanup.push(tmp)

    const result = await deliverAwaitAlert({
      awaitFile: makeAwaitFile({ filed_for_friend_id: null }),
      reason: "resolved",
      observation: "ok",
      agentRoot: tmp,
      agentName: "slugger",
      deliveryDeps: { agentName: "slugger", queuePending: () => {} },
    })

    expect(result.attempted).toBe(false)
    expect(result.skipped).toBe("no friend id")
  })

  it("skips when no session key is resolvable", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "await-deliver-"))
    cleanup.push(tmp)

    const result = await deliverAwaitAlert({
      awaitFile: makeAwaitFile(),
      reason: "resolved",
      observation: "ok",
      agentRoot: tmp,
      agentName: "slugger",
      deliveryDeps: { agentName: "slugger", queuePending: () => {} },
    })

    expect(result.attempted).toBe(false)
    expect(result.skipped).toBe("no session key")
  })

  it("trims whitespace alert/friend values to null", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "await-deliver-"))
    cleanup.push(tmp)

    const result = await deliverAwaitAlert({
      awaitFile: makeAwaitFile({ alert: "   " }),
      reason: "resolved",
      observation: "ok",
      agentRoot: tmp,
      agentName: "slugger",
      deliveryDeps: { agentName: "slugger", queuePending: () => {} },
    })

    expect(result.skipped).toBe("no alert channel")
  })
})

describe("buildAwaitDeliveryDeps", () => {
  it("constructs deps with agentName, queuePending, deliverers, and now", () => {
    const queuePending = vi.fn()
    const now = () => 42
    const deliverers = { bluebubbles: async () => ({ status: "delivered_now", detail: "ok" } as const) }
    const deps = buildAwaitDeliveryDeps({
      agentName: "slugger",
      queuePending,
      deliverers,
      now,
    })
    expect(deps.agentName).toBe("slugger")
    expect(deps.queuePending).toBe(queuePending)
    expect(deps.deliverers).toBe(deliverers)
    expect(deps.now).toBe(now)
  })

  it("omits optional fields when not provided", () => {
    const deps = buildAwaitDeliveryDeps({
      agentName: "slugger",
      queuePending: () => {},
    })
    expect(deps.agentName).toBe("slugger")
    expect(deps.deliverers).toBeUndefined()
    expect(deps.now).toBeUndefined()
  })
})
