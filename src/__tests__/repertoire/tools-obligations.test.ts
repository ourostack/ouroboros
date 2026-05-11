import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Obligation, ReturnObligation } from "../../arc/obligations"

const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

const mockGetAgentRoot = vi.fn(() => "/bundles/slugger.ouro")
const mockGetAgentName = vi.fn(() => "slugger")
vi.mock("../../heart/identity", () => ({
  getAgentRoot: () => mockGetAgentRoot(),
  getAgentName: () => mockGetAgentName(),
}))

const mockReadReturnObligation = vi.fn<(agentName: string, id: string) => ReturnObligation | null>()
const mockAdvanceReturnObligation = vi.fn()
const mockFulfillObligation = vi.fn()
const mockAdvanceObligation = vi.fn()
vi.mock("../../arc/obligations", () => ({
  readReturnObligation: (a: string, i: string) => mockReadReturnObligation(a, i),
  advanceReturnObligation: (...args: unknown[]) => mockAdvanceReturnObligation(...args),
  fulfillObligation: (...args: unknown[]) => mockFulfillObligation(...args),
  advanceObligation: (...args: unknown[]) => mockAdvanceObligation(...args),
}))

const mockReadJsonFile = vi.fn<(dir: string, name: string) => Obligation | null>()
vi.mock("../../arc/json-store", () => ({
  readJsonFile: (dir: string, name: string) => mockReadJsonFile(dir, name),
}))

import { obligationToolDefinitions } from "../../repertoire/tools-obligations"

function findTool(name: string) {
  const def = obligationToolDefinitions.find((d) => d.tool.function.name === name)
  if (!def) throw new Error(`Tool "${name}" not found`)
  return def
}

function makeReturnObligation(overrides: Partial<ReturnObligation> = {}): ReturnObligation {
  return {
    id: "1775976317954-s5pno43r",
    origin: { friendId: "ari", channel: "bluebubbles", key: "chat:any;-;ari@mendelow.me" },
    status: "queued",
    delegatedContent: "stale: investigate inner-dialog leak",
    createdAt: 1775976317954,
    ...overrides,
  }
}

function makeObligation(overrides: Partial<Obligation> = {}): Obligation {
  return {
    id: "1775976317954-2gkm4pz0",
    origin: { friendId: "ari", channel: "bluebubbles", key: "chat:any;-;ari@mendelow.me" },
    content: "investigate inner-dialog leak",
    status: "pending",
    createdAt: "2026-04-12T06:45:17.954Z",
    ...overrides,
  }
}

describe("let_go tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
    mockReadReturnObligation.mockReturnValue(null)
    mockReadJsonFile.mockReturnValue(null)
  })

  describe("schema", () => {
    it("is registered with the correct name", () => {
      const t = findTool("let_go")
      expect(t.tool.function.name).toBe("let_go")
    })

    it("description is first-person and explains the use case", () => {
      const t = findTool("let_go")
      const desc = t.tool.function.description ?? ""
      expect(desc.length).toBeGreaterThan(0)
      expect(/(\bmay\b|\bshould\b|\bprefer\b|if relevant)/i.test(desc)).toBe(false)
      expect(desc).toContain("release")
      expect(desc).toContain("held work items")
    })

    it("requires id, accepts optional reason", () => {
      const t = findTool("let_go")
      const params = t.tool.function.parameters as { properties: Record<string, unknown>; required: string[] }
      expect(Object.keys(params.properties).sort()).toEqual(["id", "reason"])
      expect(params.required).toEqual(["id"])
    })
  })

  describe("input validation", () => {
    it("returns error when id is missing", async () => {
      const t = findTool("let_go")
      const result = JSON.parse(await t.handler({}))
      expect(result).toEqual({ error: "id is required" })
    })

    it("returns error when id is empty/whitespace", async () => {
      const t = findTool("let_go")
      const r1 = JSON.parse(await t.handler({ id: "" }))
      const r2 = JSON.parse(await t.handler({ id: "   " }))
      expect(r1).toEqual({ error: "id is required" })
      expect(r2).toEqual({ error: "id is required" })
    })

    it("returns not-found error when id matches no obligation in either store", async () => {
      const t = findTool("let_go")
      const result = JSON.parse(await t.handler({ id: "ghost-id" }))
      expect(result).toEqual({ error: 'no obligation found with id "ghost-id"' })
      expect(mockAdvanceReturnObligation).not.toHaveBeenCalled()
      expect(mockFulfillObligation).not.toHaveBeenCalled()
    })
  })

  describe("ReturnObligation (inner) path", () => {
    it("advances queued return obligation to 'returned' with returnedAt + returnTarget", async () => {
      mockReadReturnObligation.mockReturnValue(makeReturnObligation({ status: "queued" }))
      const t = findTool("let_go")

      const result = JSON.parse(await t.handler({ id: "1775976317954-s5pno43r", reason: "fixed by PR #701" }))

      expect(result.kind).toBe("return_obligation")
      expect(result.let_go).toBe("1775976317954-s5pno43r")
      expect(result.reason).toBe("fixed by PR #701")
      expect(mockAdvanceReturnObligation).toHaveBeenCalledWith(
        "slugger",
        "1775976317954-s5pno43r",
        expect.objectContaining({ status: "returned", returnTarget: "surface" }),
      )
      const update = mockAdvanceReturnObligation.mock.calls[0][2] as { returnedAt: number }
      expect(typeof update.returnedAt).toBe("number")
      expect(update.returnedAt).toBeGreaterThan(0)
    })

    it("advances running return obligation too (not only queued)", async () => {
      mockReadReturnObligation.mockReturnValue(makeReturnObligation({ status: "running" }))
      const t = findTool("let_go")
      const result = JSON.parse(await t.handler({ id: "1775976317954-s5pno43r" }))
      expect(result.let_go).toBe("1775976317954-s5pno43r")
      expect(mockAdvanceReturnObligation).toHaveBeenCalled()
    })

    it("emits a repertoire.obligation_let_go nerves event with the reason", async () => {
      mockReadReturnObligation.mockReturnValue(makeReturnObligation())
      const t = findTool("let_go")
      await t.handler({ id: "1775976317954-s5pno43r", reason: "stale" })
      const evt = nervesEvents.find((e) => e.event === "repertoire.obligation_let_go")
      expect(evt).toBeDefined()
      expect(evt?.meta).toMatchObject({ kind: "return_obligation", id: "1775976317954-s5pno43r", reason: "stale" })
    })

    it("emits the nerves event with reason: null when no reason given", async () => {
      mockReadReturnObligation.mockReturnValue(makeReturnObligation())
      const t = findTool("let_go")
      await t.handler({ id: "1775976317954-s5pno43r" })
      const evt = nervesEvents.find((e) => e.event === "repertoire.obligation_let_go")
      expect((evt?.meta as Record<string, unknown>).reason).toBeNull()
    })

    it("is idempotent: returns existing status (not error) when already returned", async () => {
      mockReadReturnObligation.mockReturnValue(makeReturnObligation({ status: "returned" }))
      const t = findTool("let_go")
      const result = JSON.parse(await t.handler({ id: "1775976317954-s5pno43r" }))
      expect(result).toEqual({ kind: "return_obligation", id: "1775976317954-s5pno43r", already: "returned" })
      expect(mockAdvanceReturnObligation).not.toHaveBeenCalled()
    })

    it("is idempotent: returns existing status when already deferred", async () => {
      mockReadReturnObligation.mockReturnValue(makeReturnObligation({ status: "deferred" }))
      const t = findTool("let_go")
      const result = JSON.parse(await t.handler({ id: "1775976317954-s5pno43r" }))
      expect(result.already).toBe("deferred")
      expect(mockAdvanceReturnObligation).not.toHaveBeenCalled()
    })

    it("trims whitespace from id and reason", async () => {
      mockReadReturnObligation.mockReturnValue(makeReturnObligation())
      const t = findTool("let_go")
      await t.handler({ id: "  1775976317954-s5pno43r  ", reason: "  stale  " })
      expect(mockReadReturnObligation).toHaveBeenLastCalledWith("slugger", "1775976317954-s5pno43r")
      const evt = nervesEvents.find((e) => e.event === "repertoire.obligation_let_go")
      expect((evt?.meta as Record<string, unknown>).reason).toBe("stale")
    })

    it("treats whitespace-only reason as null", async () => {
      mockReadReturnObligation.mockReturnValue(makeReturnObligation())
      const t = findTool("let_go")
      const result = JSON.parse(await t.handler({ id: "1775976317954-s5pno43r", reason: "   " }))
      expect(result.reason).toBeNull()
    })
  })

  describe("Outer Obligation path", () => {
    it("fulfills pending outer obligation when no return-obligation match", async () => {
      mockReadReturnObligation.mockReturnValue(null)
      mockReadJsonFile.mockReturnValue(makeObligation({ status: "pending" }))

      const t = findTool("let_go")
      const result = JSON.parse(await t.handler({ id: "1775976317954-2gkm4pz0", reason: "merged PR #701" }))

      expect(result.kind).toBe("obligation")
      expect(result.let_go).toBe("1775976317954-2gkm4pz0")
      expect(result.reason).toBe("merged PR #701")
      expect(mockFulfillObligation).toHaveBeenCalledWith("/bundles/slugger.ouro", "1775976317954-2gkm4pz0")
      expect(mockAdvanceObligation).toHaveBeenCalledWith(
        "/bundles/slugger.ouro",
        "1775976317954-2gkm4pz0",
        { latestNote: "merged PR #701" },
      )
    })

    it("fulfills outer obligation without latestNote when no reason given", async () => {
      mockReadJsonFile.mockReturnValue(makeObligation())
      const t = findTool("let_go")
      await t.handler({ id: "1775976317954-2gkm4pz0" })
      expect(mockFulfillObligation).toHaveBeenCalled()
      expect(mockAdvanceObligation).not.toHaveBeenCalled()
    })

    it("emits a repertoire.obligation_let_go nerves event with kind=obligation", async () => {
      mockReadJsonFile.mockReturnValue(makeObligation())
      const t = findTool("let_go")
      await t.handler({ id: "1775976317954-2gkm4pz0", reason: "external fix" })
      const evt = nervesEvents.find((e) => e.event === "repertoire.obligation_let_go")
      expect(evt?.meta).toMatchObject({ kind: "obligation", id: "1775976317954-2gkm4pz0", reason: "external fix" })
    })

    it("is idempotent: returns existing status when already fulfilled", async () => {
      mockReadJsonFile.mockReturnValue(makeObligation({ status: "fulfilled" }))
      const t = findTool("let_go")
      const result = JSON.parse(await t.handler({ id: "1775976317954-2gkm4pz0" }))
      expect(result).toEqual({ kind: "obligation", id: "1775976317954-2gkm4pz0", already: "fulfilled" })
      expect(mockFulfillObligation).not.toHaveBeenCalled()
    })

    it("looks in the correct obligations dir", async () => {
      mockReadJsonFile.mockReturnValue(makeObligation())
      const t = findTool("let_go")
      await t.handler({ id: "1775976317954-2gkm4pz0" })
      const [dir, id] = mockReadJsonFile.mock.calls[0]
      expect(dir).toBe("/bundles/slugger.ouro/arc/obligations")
      expect(id).toBe("1775976317954-2gkm4pz0")
    })
  })

  describe("dispatch order", () => {
    it("tries inner (return obligation) first; outer is not consulted on inner hit", async () => {
      mockReadReturnObligation.mockReturnValue(makeReturnObligation())
      const t = findTool("let_go")
      await t.handler({ id: "shared-id" })
      expect(mockReadReturnObligation).toHaveBeenCalled()
      expect(mockReadJsonFile).not.toHaveBeenCalled()
    })

    it("falls through to outer when inner returns null", async () => {
      mockReadReturnObligation.mockReturnValue(null)
      mockReadJsonFile.mockReturnValue(makeObligation())
      const t = findTool("let_go")
      await t.handler({ id: "1775976317954-2gkm4pz0" })
      expect(mockReadReturnObligation).toHaveBeenCalled()
      expect(mockReadJsonFile).toHaveBeenCalled()
      expect(mockFulfillObligation).toHaveBeenCalled()
    })
  })
})
