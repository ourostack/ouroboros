import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockEmitNervesEvent = vi.fn()
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

const mockGetAgentRoot = vi.fn()
const mockGetAgentName = vi.fn(() => "slugger")
vi.mock("../../heart/identity", () => ({
  getAgentRoot: (...args: any[]) => mockGetAgentRoot(...args),
  getAgentName: (...args: any[]) => mockGetAgentName(...args),
}))

const mockDeliverAwaitAlert = vi.fn()
vi.mock("../../heart/awaiting/await-alert", () => ({
  deliverAwaitAlert: (...args: any[]) => mockDeliverAwaitAlert(...args),
}))

import {
  awaitingToolDefinitions,
  setAwaitToolDeps,
  resetAwaitToolDeps,
} from "../../repertoire/tools-awaiting"
import { expectedCappedContent, expectedTruncationMarker, makeOversizedAgentContent } from "../helpers/content-cap"

const fileAwaitDef = awaitingToolDefinitions.find((d) => d.tool.function.name === "await_condition")!
const resolveAwaitDef = awaitingToolDefinitions.find((d) => d.tool.function.name === "resolve_await")!
const cancelAwaitDef = awaitingToolDefinitions.find((d) => d.tool.function.name === "cancel_await")!

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tools-await-"))
}

function parse(result: string): Record<string, unknown> {
  return JSON.parse(result) as Record<string, unknown>
}

function readDoneFile(agentRoot: string, name: string): string {
  return fs.readFileSync(path.join(agentRoot, "awaiting", ".done", `${name}.md`), "utf-8")
}

describe("tools-awaiting", () => {
  const cleanup: string[] = []
  let agentRoot: string

  beforeEach(() => {
    vi.clearAllMocks()
    agentRoot = makeTempRoot()
    cleanup.push(agentRoot)
    mockGetAgentRoot.mockReturnValue(agentRoot)
    mockGetAgentName.mockReturnValue("slugger")
    resetAwaitToolDeps()
    setAwaitToolDeps({ buildDeliveryDeps: () => ({ agentName: "slugger", queuePending: vi.fn() }) })
    mockDeliverAwaitAlert.mockResolvedValue({ attempted: true, delivery: { status: "delivered_now", detail: "ok" } })
  })

  afterEach(() => {
    resetAwaitToolDeps()
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (entry) fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  describe("await_condition", () => {
    it("files a new await with required fields", async () => {
      const ctx = { currentSession: { friendId: "ari", channel: "bluebubbles", key: "+15551112222;-;ari", sessionPath: "" } }
      const result = parse(await fileAwaitDef.handler(
        { name: "hey_export", condition: "HEY export visible", cadence: "5m" },
        ctx as any,
      ) as string)
      expect(result.filed).toBe("hey_export")

      const filePath = path.join(agentRoot, "awaiting", "hey_export.md")
      expect(fs.existsSync(filePath)).toBe(true)
      const content = fs.readFileSync(filePath, "utf-8")
      expect(content).toContain("condition: HEY export visible")
      expect(content).toContain("cadence: 5m")
      expect(content).toContain("status: pending")
      expect(content).toContain("alert: bluebubbles") // inherited from currentSession.channel
      expect(content).toContain("filed_for_friend_id: ari")
    })

    it("uses explicit alert + mode + max_age + body", async () => {
      const result = parse(await fileAwaitDef.handler(
        {
          name: "hey_export",
          condition: "x",
          cadence: "5m",
          alert: "teams",
          mode: "quick",
          max_age: "24h",
          body: "what would count as ready",
        },
        undefined,
      ) as string)
      expect(result.filed).toBe("hey_export")

      const content = fs.readFileSync(path.join(agentRoot, "awaiting", "hey_export.md"), "utf-8")
      expect(content).toContain("alert: teams")
      expect(content).toContain("mode: quick")
      expect(content).toContain("max_age: 24h")
      expect(content).toContain("what would count as ready")
    })

    it("caps oversized agent-authored condition and body text while preserving markdown", async () => {
      const oversizedCondition = makeOversizedAgentContent("await condition ")
      const oversizedBody = makeOversizedAgentContent("await body ")
      const result = parse(await fileAwaitDef.handler(
        {
          name: "oversized",
          condition: oversizedCondition,
          cadence: "5m",
          body: oversizedBody,
        },
        undefined,
      ) as string)
      expect(result.filed).toBe("oversized")

      const content = fs.readFileSync(path.join(agentRoot, "awaiting", "oversized.md"), "utf-8")
      expect(content.includes(expectedTruncationMarker(oversizedCondition))).toBe(true)
      expect(content.includes(expectedTruncationMarker(oversizedBody))).toBe(true)
      expect(content).toContain(`condition: ${expectedCappedContent(oversizedCondition)}`)
      expect(content).toContain("---\n")
      expect(content).toContain(expectedCappedContent(oversizedBody))
    })

    it("falls back to mode=full for unknown mode", async () => {
      await fileAwaitDef.handler({ name: "x", condition: "c", cadence: "5m", mode: "weird" }, undefined)
      const content = fs.readFileSync(path.join(agentRoot, "awaiting", "x.md"), "utf-8")
      expect(content).toContain("mode: full")
    })

    it("rejects empty name", async () => {
      const result = parse(await fileAwaitDef.handler({ name: "", condition: "c", cadence: "5m" }, undefined) as string)
      expect(result.error).toMatch(/required/)
    })

    it("rejects name with invalid chars", async () => {
      const result = parse(await fileAwaitDef.handler({ name: "bad name!", condition: "c", cadence: "5m" }, undefined) as string)
      expect(result.error).toMatch(/alphanumeric/)
    })

    it("rejects missing condition", async () => {
      const result = parse(await fileAwaitDef.handler({ name: "x", condition: "  ", cadence: "5m" }, undefined) as string)
      expect(result.error).toMatch(/condition is required/)
    })

    it("rejects missing cadence", async () => {
      const result = parse(await fileAwaitDef.handler({ name: "x", condition: "c", cadence: "" }, undefined) as string)
      expect(result.error).toMatch(/cadence is required/)
    })

    it("rejects duplicate name", async () => {
      await fileAwaitDef.handler({ name: "x", condition: "c", cadence: "5m" }, undefined)
      const result = parse(await fileAwaitDef.handler({ name: "x", condition: "c", cadence: "5m" }, undefined) as string)
      expect(result.error).toMatch(/already exists/)
    })

    it("defaults filed_from to 'unknown' when no session context", async () => {
      await fileAwaitDef.handler({ name: "x", condition: "c", cadence: "5m" }, undefined)
      const content = fs.readFileSync(path.join(agentRoot, "awaiting", "x.md"), "utf-8")
      expect(content).toContain("filed_from: unknown")
    })
  })

  describe("resolve_await", () => {
    async function file(name: string) {
      await fileAwaitDef.handler(
        { name, condition: "c", cadence: "5m", alert: "bluebubbles" },
        { currentSession: { friendId: "ari", channel: "bluebubbles", key: "+15551112222;-;ari", sessionPath: "" } } as any,
      )
    }

    it("verdict=yes archives + alerts", async () => {
      await file("hey_export")
      const result = parse(await resolveAwaitDef.handler(
        { name: "hey_export", verdict: "yes", observation: "download appeared" },
        undefined,
      ) as string)
      expect(result.verdict).toBe("yes")
      expect(result.archived).toContain("/.done/hey_export.md")
      expect(fs.existsSync(path.join(agentRoot, "awaiting", "hey_export.md"))).toBe(false)
      expect(fs.existsSync(path.join(agentRoot, "awaiting", ".done", "hey_export.md"))).toBe(true)
      const content = readDoneFile(agentRoot, "hey_export")
      expect(content).toContain("status: resolved")
      expect(content).toContain("resolution_observation: download appeared")
      expect(mockDeliverAwaitAlert).toHaveBeenCalledWith(expect.objectContaining({
        reason: "resolved",
        observation: "download appeared",
      }))
    })

    it("verdict=no records observation, does not archive", async () => {
      await file("hey_export")
      const result = parse(await resolveAwaitDef.handler(
        { name: "hey_export", verdict: "no", observation: "no sign yet" },
        undefined,
      ) as string)
      expect(result.verdict).toBe("no")
      expect(result.recorded).toBe(true)
      expect(fs.existsSync(path.join(agentRoot, "awaiting", "hey_export.md"))).toBe(true)

      // runtime state recorded
      const state = JSON.parse(fs.readFileSync(path.join(agentRoot, "state", "awaits", "hey_export.json"), "utf-8")) as Record<string, unknown>
      expect(state.last_observation).toBe("no sign yet")
      expect(state.checked_count).toBe(1)
    })

    it("rejects unknown await", async () => {
      const result = parse(await resolveAwaitDef.handler(
        { name: "nope", verdict: "yes", observation: "x" },
        undefined,
      ) as string)
      expect(result.error).toMatch(/not found/)
    })

    it("rejects invalid name", async () => {
      const result = parse(await resolveAwaitDef.handler(
        { name: "bad name!", verdict: "yes", observation: "x" },
        undefined,
      ) as string)
      expect(result.error).toMatch(/alphanumeric/)
    })

    it("rejects invalid verdict", async () => {
      await file("hey_export")
      const result = parse(await resolveAwaitDef.handler(
        { name: "hey_export", verdict: "maybe", observation: "x" },
        undefined,
      ) as string)
      expect(result.error).toMatch(/verdict/)
    })

    it("rejects missing observation", async () => {
      await file("hey_export")
      const result = parse(await resolveAwaitDef.handler(
        { name: "hey_export", verdict: "yes", observation: "" },
        undefined,
      ) as string)
      expect(result.error).toMatch(/observation is required/)
    })

    it("rejects resolving an already-archived await", async () => {
      await file("hey_export")
      await resolveAwaitDef.handler({ name: "hey_export", verdict: "yes", observation: "ok" }, undefined)
      // Second call: file no longer exists in awaiting/
      const result = parse(await resolveAwaitDef.handler(
        { name: "hey_export", verdict: "yes", observation: "ok" },
        undefined,
      ) as string)
      expect(result.error).toMatch(/not found/)
    })

    it("catches alert delivery errors without failing the resolution", async () => {
      mockDeliverAwaitAlert.mockRejectedValueOnce(new Error("delivery boom"))
      await file("hey_export")
      const result = parse(await resolveAwaitDef.handler(
        { name: "hey_export", verdict: "yes", observation: "ok" },
        undefined,
      ) as string)
      expect(result.verdict).toBe("yes")
      expect(result.alert).toBeNull()
      expect(fs.existsSync(path.join(agentRoot, "awaiting", ".done", "hey_export.md"))).toBe(true)
    })

    it("rejects resolving a non-pending await (manually-edited file)", async () => {
      // Write a non-pending file directly to simulate a tampered/stuck file
      fs.mkdirSync(path.join(agentRoot, "awaiting"), { recursive: true })
      fs.writeFileSync(
        path.join(agentRoot, "awaiting", "weird.md"),
        ["---", "condition: c", "cadence: 5m", "status: resolved", "---", "", ""].join("\n"),
        "utf-8",
      )
      const result = parse(await resolveAwaitDef.handler(
        { name: "weird", verdict: "yes", observation: "ok" },
        undefined,
      ) as string)
      expect(result.error).toMatch(/not pending/)
    })

    it("reports skipped alert (attempted=false)", async () => {
      mockDeliverAwaitAlert.mockResolvedValueOnce({ attempted: false, skipped: "no session key" })
      await file("hey_export")
      const result = parse(await resolveAwaitDef.handler(
        { name: "hey_export", verdict: "yes", observation: "ok" },
        undefined,
      ) as string)
      expect(result.verdict).toBe("yes")
      const alert = result.alert as Record<string, unknown>
      expect(alert.attempted).toBe(false)
      expect(alert.status).toBeNull()
      expect(alert.skipped).toBe("no session key")
    })

    it("catches alert delivery errors (non-Error throw)", async () => {
      mockDeliverAwaitAlert.mockRejectedValueOnce("string-error")
      await file("hey_export")
      const result = parse(await resolveAwaitDef.handler(
        { name: "hey_export", verdict: "yes", observation: "ok" },
        undefined,
      ) as string)
      expect(result.verdict).toBe("yes")
    })
  })

  describe("cancel_await", () => {
    async function file(name: string) {
      await fileAwaitDef.handler(
        { name, condition: "c", cadence: "5m", alert: "bluebubbles" },
        { currentSession: { friendId: "ari", channel: "bluebubbles", key: "x", sessionPath: "" } } as any,
      )
    }

    it("cancels with reason", async () => {
      await file("hey_export")
      const result = parse(cancelAwaitDef.handler({ name: "hey_export", reason: "nevermind" }, undefined) as string)
      expect(result.canceled).toBe("hey_export")
      const content = readDoneFile(agentRoot, "hey_export")
      expect(content).toContain("status: canceled")
      expect(content).toContain("cancel_reason: nevermind")
    })

    it("cancels without reason", async () => {
      await file("hey_export")
      const result = parse(cancelAwaitDef.handler({ name: "hey_export" }, undefined) as string)
      expect(result.canceled).toBe("hey_export")
      const content = readDoneFile(agentRoot, "hey_export")
      expect(content).toContain("status: canceled")
      expect(content).not.toContain("cancel_reason:")
    })

    it("cancels with whitespace reason (treated as no reason)", async () => {
      await file("hey_export")
      cancelAwaitDef.handler({ name: "hey_export", reason: "   " }, undefined)
      const content = readDoneFile(agentRoot, "hey_export")
      expect(content).not.toContain("cancel_reason:")
    })

    it("rejects unknown await", () => {
      const result = parse(cancelAwaitDef.handler({ name: "nope" }, undefined) as string)
      expect(result.error).toMatch(/not found/)
    })

    it("rejects invalid name", () => {
      const result = parse(cancelAwaitDef.handler({ name: "bad name!" }, undefined) as string)
      expect(result.error).toMatch(/alphanumeric/)
    })

    it("rejects canceling a non-pending await (manually-edited file)", async () => {
      fs.mkdirSync(path.join(agentRoot, "awaiting"), { recursive: true })
      fs.writeFileSync(
        path.join(agentRoot, "awaiting", "weird.md"),
        ["---", "condition: c", "cadence: 5m", "status: resolved", "---", "", ""].join("\n"),
        "utf-8",
      )
      const result = parse(cancelAwaitDef.handler({ name: "weird" }, undefined) as string)
      expect(result.error).toMatch(/not pending/)
    })

    it("rejects double-cancel", async () => {
      await file("hey_export")
      cancelAwaitDef.handler({ name: "hey_export" }, undefined)
      const result = parse(cancelAwaitDef.handler({ name: "hey_export" }, undefined) as string)
      expect(result.error).toMatch(/not found/)
    })
  })

  describe("delivery deps injection", () => {
    it("resetAwaitToolDeps clears injection and uses default writer", async () => {
      resetAwaitToolDeps()
      // file an await
      await fileAwaitDef.handler(
        { name: "hey_export", condition: "c", cadence: "5m", alert: "bluebubbles" },
        { currentSession: { friendId: "ari", channel: "bluebubbles", key: "x", sessionPath: "" } } as any,
      )
      // mock identity for default deps
      const { getInnerDialogPendingDir } = await import("../../mind/pending")
      const pendingDir = getInnerDialogPendingDir("slugger")
      cleanup.push(path.dirname(path.dirname(pendingDir))) // catch parent dirs

      // make alert path go through buildAwaitDeliveryDeps -> default
      mockDeliverAwaitAlert.mockImplementationOnce(async ({ deliveryDeps }) => {
        // exercise queuePending to ensure default writer works
        deliveryDeps.queuePending({
          from: "slugger",
          friendId: "ari",
          channel: "bluebubbles",
          key: "x",
          content: "msg",
          timestamp: 123,
        })
        return { attempted: true, delivery: { status: "queued_for_later", detail: "queued" } }
      })

      const result = parse(await resolveAwaitDef.handler(
        { name: "hey_export", verdict: "yes", observation: "ok" },
        undefined,
      ) as string)
      expect(result.verdict).toBe("yes")
      // a pending envelope was queued
      const files = fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir) : []
      expect(files.length).toBeGreaterThan(0)
    })

    it("default writer caps oversized pending message content before queueing", async () => {
      resetAwaitToolDeps()
      await fileAwaitDef.handler(
        { name: "hey_export", condition: "c", cadence: "5m", alert: "bluebubbles" },
        { currentSession: { friendId: "ari", channel: "bluebubbles", key: "x", sessionPath: "" } } as any,
      )
      const { getInnerDialogPendingDir } = await import("../../mind/pending")
      const pendingDir = getInnerDialogPendingDir("slugger")
      cleanup.push(path.dirname(path.dirname(pendingDir)))
      const oversized = makeOversizedAgentContent("await fallback pending ")

      mockDeliverAwaitAlert.mockImplementationOnce(async ({ deliveryDeps }) => {
        deliveryDeps.queuePending({
          from: "slugger",
          friendId: "ari",
          channel: "bluebubbles",
          key: "x",
          content: oversized,
          timestamp: 123,
        })
        return { attempted: true, delivery: { status: "queued_for_later", detail: "queued" } }
      })

      await resolveAwaitDef.handler(
        { name: "hey_export", verdict: "yes", observation: "ok" },
        undefined,
      )

      const [queuedFile] = fs.readdirSync(pendingDir)
      const queued = JSON.parse(fs.readFileSync(path.join(pendingDir, queuedFile), "utf-8")) as { content: string }
      const expected = expectedCappedContent(oversized)
      const marker = expectedTruncationMarker(oversized)
      expect({
        equalsExpected: queued.content === expected,
        includesMarker: queued.content.includes(marker),
      }).toEqual({ equalsExpected: true, includesMarker: true })
    })

    it("setAwaitToolDeps overrides delivery deps factory", async () => {
      const customQueue = vi.fn()
      setAwaitToolDeps({
        buildDeliveryDeps: () => ({ agentName: "custom-agent", queuePending: customQueue }),
      })

      await fileAwaitDef.handler(
        { name: "hey_export", condition: "c", cadence: "5m", alert: "bluebubbles" },
        { currentSession: { friendId: "ari", channel: "bluebubbles", key: "x", sessionPath: "" } } as any,
      )

      mockDeliverAwaitAlert.mockImplementationOnce(async ({ deliveryDeps }) => {
        expect(deliveryDeps.agentName).toBe("custom-agent")
        deliveryDeps.queuePending({ from: "x", friendId: "ari", channel: "bluebubbles", key: "x", content: "y", timestamp: 1 })
        return { attempted: true, delivery: { status: "queued_for_later", detail: "ok" } }
      })

      await resolveAwaitDef.handler({ name: "hey_export", verdict: "yes", observation: "ok" }, undefined)
      expect(customQueue).toHaveBeenCalled()
    })
  })

  describe("tool registration shape", () => {
    it("exposes three tools with the expected names and required params", () => {
      const names = awaitingToolDefinitions.map((d) => d.tool.function.name).sort()
      expect(names).toEqual(["await_condition", "cancel_await", "resolve_await"])
    })
  })
})
