import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const emitNervesEvent = vi.fn()
vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: (...args: unknown[]) => emitNervesEvent(...args),
}))

import {
  getBlueBubblesSendHealthPath,
  readBlueBubblesSendHealth,
  recordBlueBubblesSendBlocked,
  recordBlueBubblesSendDelivered,
} from "../../../senses/bluebubbles/send-health"

const denied = { code: "host_automation_denied", detail: "macOS blocked BlueBubbles from controlling Messages" }

describe("BlueBubbles send health", () => {
  let agentRoot = ""

  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bb-send-health-"))
    emitNervesEvent.mockReset()
  })

  afterEach(() => {
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it("has nothing recorded before any send", () => {
    expect(readBlueBubblesSendHealth("slugger", agentRoot)).toBeNull()
  })

  it("records a block once, keeps when it started, and logs only the first failure", () => {
    let now = Date.parse("2026-11-23T03:47:23.000Z")
    recordBlueBubblesSendBlocked("slugger", denied, agentRoot, () => now)
    now += 35_000
    recordBlueBubblesSendBlocked("slugger", denied, agentRoot, () => now)

    expect(readBlueBubblesSendHealth("slugger", agentRoot)).toEqual({
      status: "blocked",
      ...denied,
      since: "2026-11-23T03:47:23.000Z",
      lastFailureAt: "2026-11-23T03:47:58.000Z",
    })
    expect(fs.statSync(getBlueBubblesSendHealthPath("slugger", agentRoot)).mode & 0o777).toBe(0o600)
    expect(emitNervesEvent.mock.calls.filter(([event]) => event.event === "senses.bluebubbles_send_blocked")).toHaveLength(1)
  })

  it("starts a new block when the failure changes", () => {
    let now = Date.parse("2026-11-23T03:47:23.000Z")
    recordBlueBubblesSendBlocked("slugger", denied, agentRoot, () => now)
    now += 60_000
    recordBlueBubblesSendBlocked("slugger", { code: "other_block", detail: "other" }, agentRoot, () => now)

    expect(readBlueBubblesSendHealth("slugger", agentRoot)).toMatchObject({ code: "other_block", since: "2026-11-23T03:48:23.000Z" })
  })

  it("clears a block on the next delivered send, and keeps when sends last worked", () => {
    let now = Date.parse("2026-11-23T03:40:00.000Z")
    recordBlueBubblesSendBlocked("slugger", denied, agentRoot, () => now)
    now += 60_000
    recordBlueBubblesSendDelivered("slugger", agentRoot, () => now)
    expect(readBlueBubblesSendHealth("slugger", agentRoot)).toEqual({ status: "ok", lastDeliveredAt: "2026-11-23T03:41:00.000Z" })
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_send_unblocked",
      meta: expect.objectContaining({ previousCode: "host_automation_denied", blockedSince: "2026-11-23T03:40:00.000Z" }),
    }))

    now += 60_000
    recordBlueBubblesSendBlocked("slugger", denied, agentRoot, () => now)
    expect(readBlueBubblesSendHealth("slugger", agentRoot)).toMatchObject({ status: "blocked", lastDeliveredAt: "2026-11-23T03:41:00.000Z" })
  })

  it("writes nothing for a delivered send while nothing is blocked", () => {
    recordBlueBubblesSendDelivered("slugger", agentRoot)
    expect(fs.existsSync(getBlueBubblesSendHealthPath("slugger", agentRoot))).toBe(false)
    expect(emitNervesEvent).not.toHaveBeenCalled()
  })

  it.each([
    ["unparseable", "{"],
    ["an unknown status", JSON.stringify({ status: "maybe" })],
  ])("reads an %s file as nothing recorded", (_label, contents) => {
    const filePath = getBlueBubblesSendHealthPath("slugger", agentRoot)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, contents)
    expect(readBlueBubblesSendHealth("slugger", agentRoot)).toBeNull()
  })

  it("drops fields of the wrong type", () => {
    const filePath = getBlueBubblesSendHealthPath("slugger", agentRoot)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify({ status: "blocked", code: 7, detail: null, since: "s", lastFailureAt: "f", lastDeliveredAt: "d" }))
    expect(readBlueBubblesSendHealth("slugger", agentRoot)).toEqual({ status: "blocked", since: "s", lastFailureAt: "f", lastDeliveredAt: "d" })
  })

  it("logs a failed write instead of throwing into the send", () => {
    // A file where the state folder should be makes the write fail.
    fs.writeFileSync(path.join(agentRoot, "state"), "not a folder")
    expect(() => recordBlueBubblesSendBlocked("slugger", denied, agentRoot)).not.toThrow()
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.bluebubbles_send_health_write_error",
      meta: expect.objectContaining({ status: "blocked" }),
    }))
  })

  it("uses the agent's bundle by default", async () => {
    vi.resetModules()
    vi.doMock("../../../heart/identity", () => ({ getAgentRoot: (agent: string) => path.join(agentRoot, `${agent}.ouro`) }))
    try {
      const health = await import("../../../senses/bluebubbles/send-health")
      expect(health.getBlueBubblesSendHealthPath("slugger")).toBe(path.join(agentRoot, "slugger.ouro", "state", "senses", "bluebubbles", "send-health.json"))
      health.recordBlueBubblesSendBlocked("slugger", denied)
      health.recordBlueBubblesSendDelivered("slugger")
      expect(health.readBlueBubblesSendHealth("slugger")).toMatchObject({ status: "ok" })
    } finally {
      vi.doUnmock("../../../heart/identity")
      vi.resetModules()
    }
  })
})
