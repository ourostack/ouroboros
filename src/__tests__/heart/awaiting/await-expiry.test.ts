import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockEmitNervesEvent = vi.fn()
vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

const mockDeliver = vi.fn()
vi.mock("../../../heart/awaiting/await-alert", () => ({
  deliverAwaitAlert: (...args: any[]) => mockDeliver(...args),
}))

import { archiveAndAlertExpiredAwait } from "../../../heart/awaiting/await-expiry"
import { writeAwaitRuntimeState } from "../../../heart/awaiting/await-runtime-state"
import { createObligation, readVerifiedPendingObligations } from "../../../arc/obligations"

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "await-expiry-"))
}

function writePending(root: string, name: string): void {
  const dir = path.join(root, "awaiting")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${name}.md`), [
    "---",
    "condition: thing visible",
    "cadence: 5m",
    "alert: bluebubbles",
    "mode: full",
    "max_age: 24h",
    "status: pending",
    "created_at: 2026-05-09T20:00:00.000Z",
    "filed_from: cli",
    "filed_for_friend_id: ari",
    "---",
    "",
    "what would count as ready",
  ].join("\n"), "utf-8")
}

function writeRequestPending(root: string, name: string): void {
  writePending(root, name)
  const filePath = path.join(root, "awaiting", `${name}.md`)
  const content = fs.readFileSync(filePath, "utf8").replace("filed_from: cli", [
    "filed_from: telegram",
    "filed_from_key: telegram:777:888",
    "request_id: request-1",
  ].join("\n"))
  fs.writeFileSync(filePath, content)
}

describe("archiveAndAlertExpiredAwait", () => {
  const cleanup: string[] = []

  beforeEach(() => {
    mockEmitNervesEvent.mockReset()
    mockDeliver.mockReset()
    mockDeliver.mockResolvedValue({ attempted: true, delivery: { status: "delivered_now", detail: "ok" } })
  })

  afterEach(() => {
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (entry) fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  it("archives the file and fires expiry alert", async () => {
    const root = makeTempRoot()
    cleanup.push(root)
    writePending(root, "hey_export")
    writeAwaitRuntimeState(root, "hey_export", {
      last_checked: "2026-05-10T19:00:00.000Z",
      last_observation: "still nothing",
      checked_count: 5,
    })

    const result = await archiveAndAlertExpiredAwait({
      agentRoot: root,
      agentName: "slugger",
      awaitName: "hey_export",
      deliveryDeps: { agentName: "slugger", queuePending: () => {} },
      now: () => new Date("2026-05-10T20:00:00.000Z"),
    })

    expect(result.archived).toBe(true)
    expect(result.alerted).toBe(true)
    expect(fs.existsSync(path.join(root, "awaiting", "hey_export.md"))).toBe(false)
    expect(fs.existsSync(path.join(root, "awaiting", ".done", "hey_export.md"))).toBe(true)

    const archived = fs.readFileSync(path.join(root, "awaiting", ".done", "hey_export.md"), "utf-8")
    expect(archived).toContain("status: expired")
    expect(archived).toContain("expired_at: 2026-05-10T20:00:00.000Z")
    expect(archived).toContain("last_observation_at_expiry: still nothing")

    expect(mockDeliver).toHaveBeenCalledWith(expect.objectContaining({
      reason: "expired",
      observation: "still nothing",
    }))
  })

  it("returns archived=false when the file is missing", async () => {
    const root = makeTempRoot()
    cleanup.push(root)
    const result = await archiveAndAlertExpiredAwait({
      agentRoot: root,
      agentName: "slugger",
      awaitName: "missing",
      deliveryDeps: { agentName: "slugger", queuePending: () => {} },
    })
    expect(result.archived).toBe(false)
    expect(result.alerted).toBe(false)
    expect(mockDeliver).not.toHaveBeenCalled()
  })

  it("handles missing runtime state (passes null observation through)", async () => {
    const root = makeTempRoot()
    cleanup.push(root)
    writePending(root, "fresh_one")

    const result = await archiveAndAlertExpiredAwait({
      agentRoot: root,
      agentName: "slugger",
      awaitName: "fresh_one",
      deliveryDeps: { agentName: "slugger", queuePending: () => {} },
      now: () => new Date("2026-05-10T20:00:00.000Z"),
    })

    expect(result.archived).toBe(true)
    expect(mockDeliver).toHaveBeenCalledWith(expect.objectContaining({
      reason: "expired",
      observation: null,
    }))
  })

  it("keeps a request-bound expiry active until delivery is accepted, then archives on retry", async () => {
    const root = makeTempRoot()
    cleanup.push(root)
    writeRequestPending(root, "movie")
    mockDeliver.mockImplementationOnce(async () => {
      expect(fs.existsSync(path.join(root, "awaiting", "movie.md"))).toBe(true)
      const staged = fs.readFileSync(path.join(root, "awaiting", "movie.md"), "utf8")
      expect(staged).toContain("status: pending")
      expect(staged).toContain("expired_at: 2026-05-10T20:00:00.000Z")
      return { attempted: true, delivery: { status: "blocked", detail: "revoked" } }
    })
    const first = await archiveAndAlertExpiredAwait({ agentRoot: root, agentName: "slugger", awaitName: "movie", deliveryDeps: { agentName: "slugger", queuePending: () => {} }, now: () => new Date("2026-05-10T20:00:00.000Z") })
    expect(first).toMatchObject({ archived: false, alerted: true, reason: "blocked" })
    expect(fs.existsSync(path.join(root, "awaiting", "movie.md"))).toBe(true)

    mockDeliver.mockResolvedValueOnce({ attempted: true, delivery: { status: "delivered_now", detail: "accepted" } })
    const second = await archiveAndAlertExpiredAwait({ agentRoot: root, agentName: "slugger", awaitName: "movie", deliveryDeps: { agentName: "slugger", queuePending: () => {} }, now: () => new Date("2026-05-10T21:00:00.000Z") })
    expect(second).toEqual({ archived: true, alerted: true })
    expect(fs.readFileSync(path.join(root, "awaiting", ".done", "movie.md"), "utf8")).toContain("expired_at: 2026-05-10T20:00:00.000Z")
  })

  it.each([
    [{ attempted: false, skipped: "no route" }, "no route"],
    [{ attempted: false }, "delivery not accepted"],
  ] as const)("keeps request-bound expiry pending when no delivery was attempted (%s)", async (delivery, reason) => {
    const root = makeTempRoot()
    cleanup.push(root)
    writeRequestPending(root, `undelivered_${cleanup.length}`)
    mockDeliver.mockResolvedValueOnce(delivery)
    const result = await archiveAndAlertExpiredAwait({
      agentRoot: root,
      agentName: "slugger",
      awaitName: `undelivered_${cleanup.length}`,
      deliveryDeps: { agentName: "slugger", queuePending: () => {} },
    })
    expect(result).toMatchObject({ archived: false, alerted: false, reason })
  })

  it("uses default now when not provided", async () => {
    const root = makeTempRoot()
    cleanup.push(root)
    writePending(root, "x")
    const result = await archiveAndAlertExpiredAwait({
      agentRoot: root,
      agentName: "slugger",
      awaitName: "x",
      deliveryDeps: { agentName: "slugger", queuePending: () => {} },
    })
    expect(result.archived).toBe(true)
  })

  it("propagates alerted=false when delivery is skipped", async () => {
    mockDeliver.mockResolvedValueOnce({ attempted: false, skipped: "no session key" })
    const root = makeTempRoot()
    cleanup.push(root)
    writePending(root, "x")
    const result = await archiveAndAlertExpiredAwait({
      agentRoot: root,
      agentName: "slugger",
      awaitName: "x",
      deliveryDeps: { agentName: "slugger", queuePending: () => {} },
      now: () => new Date("2026-05-10T20:00:00.000Z"),
    })
    expect(result.archived).toBe(true)
    expect(result.alerted).toBe(false)
  })

  it("removes a failed request-bound staging file and propagates the write failure", async () => {
    const root = makeTempRoot()
    cleanup.push(root)
    writeRequestPending(root, "write_failure")
    fs.chmodSync(path.join(root, "awaiting"), 0o500)
    await expect(archiveAndAlertExpiredAwait({
      agentRoot: root,
      agentName: "slugger",
      awaitName: "write_failure",
      deliveryDeps: { agentName: "slugger", queuePending: () => {} },
    })).rejects.toThrow()
    fs.chmodSync(path.join(root, "awaiting"), 0o700)
    expect(fs.readdirSync(path.join(root, "awaiting"))).toEqual(["write_failure.md"])
  })

  it("fulfills the durable obligation after a legacy expiry is archived", async () => {
    const root = makeTempRoot()
    cleanup.push(root)
    const obligation = createObligation(root, {
      origin: { friendId: "ari", channel: "telegram", key: "telegram:ari" },
      owedTo: { friendId: "ari", channel: "telegram", key: "telegram:ari" },
      requestId: "request-obligation",
      content: "wait for it",
    })
    writePending(root, "obligated")
    const filePath = path.join(root, "awaiting", "obligated.md")
    fs.writeFileSync(filePath, fs.readFileSync(filePath, "utf8").replace("filed_from: cli", `filed_from: cli\nobligation_id: ${obligation.id}`))

    await archiveAndAlertExpiredAwait({
      agentRoot: root,
      agentName: "slugger",
      awaitName: "obligated",
      deliveryDeps: { agentName: "slugger", queuePending: () => {} },
    })

    expect(readVerifiedPendingObligations(root)).toEqual([])
  })
})
