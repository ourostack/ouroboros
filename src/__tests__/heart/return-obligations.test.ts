import { describe, it, expect, vi, beforeEach } from "vitest"
import * as path from "path"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

import * as fs from "fs"
import { emitNervesEvent } from "../../nerves/runtime"

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReset()
  vi.mocked(fs.readFileSync).mockReset()
  vi.mocked(fs.writeFileSync).mockReset()
  vi.mocked(fs.readdirSync).mockReset()
  vi.mocked(fs.mkdirSync).mockReset()
  vi.mocked(emitNervesEvent).mockReset()
})

describe("generateObligationId", () => {
  beforeEach(() => { vi.resetModules() })

  it("produces a timestamp-prefixed ID", async () => {
    const { generateObligationId } = await import("../../arc/obligations")
    const id = generateObligationId(1709900001000)
    expect(id).toMatch(/^1709900001000-[a-z0-9]+$/)
  })

  it("produces unique IDs for the same timestamp", async () => {
    const { generateObligationId } = await import("../../arc/obligations")
    const id1 = generateObligationId(1709900001000)
    const id2 = generateObligationId(1709900001000)
    expect(id1).not.toBe(id2)
  })
})

describe("getReturnObligationsDir", () => {
  beforeEach(() => { vi.resetModules() })

  it("returns correct path under agent state", async () => {
    const { getReturnObligationsDir } = await import("../../arc/obligations")
    const result = getReturnObligationsDir("testagent")
    expect(result).toContain(path.join("testagent.ouro", "arc", "obligations", "inner"))
  })
})

describe("createReturnObligation", () => {
  beforeEach(() => { vi.resetModules() })

  it("writes obligation JSON to the obligations directory", async () => {
    const { createReturnObligation } = await import("../../arc/obligations")
    const obligation = {
      id: "1709900001000-abc12345",
      origin: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
      status: "queued" as const,
      delegatedContent: "think about penguins",
      createdAt: 1709900001000,
    }

    createReturnObligation("testagent", obligation)

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining(path.join("arc", "obligations", "inner")),
      { recursive: true },
    )
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("1709900001000-abc12345.json"),
      expect.any(String),
      "utf-8",
    )
    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
    expect(written).toEqual(obligation)
  })

  it("emits a nerves event on creation", async () => {
    const { createReturnObligation } = await import("../../arc/obligations")
    createReturnObligation("testagent", {
      id: "1709900001000-abc12345",
      origin: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
      status: "queued" as const,
      delegatedContent: "think about penguins",
      createdAt: 1709900001000,
    })

    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "mind.obligation_created",
      component: "mind",
      meta: expect.objectContaining({
        obligationId: "1709900001000-abc12345",
        status: "queued",
      }),
    }))
  })
})

describe("readReturnObligation", () => {
  beforeEach(() => { vi.resetModules() })

  it("returns the parsed obligation when found", async () => {
    const { readReturnObligation } = await import("../../arc/obligations")
    const stored = {
      id: "1709900001000-abc12345",
      origin: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
      status: "queued",
      delegatedContent: "think about penguins",
      createdAt: 1709900001000,
    }
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(stored))

    const result = readReturnObligation("testagent", "1709900001000-abc12345")
    expect(result).toEqual(stored)
  })

  it("returns null when file does not exist", async () => {
    const { readReturnObligation } = await import("../../arc/obligations")
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("ENOENT") })

    expect(readReturnObligation("testagent", "nonexistent")).toBeNull()
  })
})

describe("advanceReturnObligation", () => {
  beforeEach(() => { vi.resetModules() })

  it("advances obligation from queued to running", async () => {
    const { advanceReturnObligation } = await import("../../arc/obligations")
    const stored = {
      id: "1709900001000-abc12345",
      origin: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
      status: "queued",
      delegatedContent: "think about penguins",
      createdAt: 1709900001000,
    }
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(stored))

    const result = advanceReturnObligation("testagent", "1709900001000-abc12345", {
      status: "running",
      startedAt: 1709900002000,
    })

    expect(result).toEqual({
      ...stored,
      status: "running",
      startedAt: 1709900002000,
    })
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("1709900001000-abc12345.json"),
      expect.any(String),
      "utf-8",
    )
  })

  it("advances obligation from running to returned with returnTarget", async () => {
    const { advanceReturnObligation } = await import("../../arc/obligations")
    const stored = {
      id: "1709900001000-abc12345",
      origin: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
      status: "running",
      delegatedContent: "think about penguins",
      createdAt: 1709900001000,
      startedAt: 1709900002000,
    }
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(stored))

    const result = advanceReturnObligation("testagent", "1709900001000-abc12345", {
      status: "returned",
      returnedAt: 1709900003000,
      returnTarget: "direct-originator",
    })

    expect(result).toEqual({
      ...stored,
      status: "returned",
      returnedAt: 1709900003000,
      returnTarget: "direct-originator",
    })
  })

  it("advances obligation to deferred when no session available", async () => {
    const { advanceReturnObligation } = await import("../../arc/obligations")
    const stored = {
      id: "1709900001000-abc12345",
      origin: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
      status: "running",
      delegatedContent: "think about penguins",
      createdAt: 1709900001000,
      startedAt: 1709900002000,
    }
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(stored))

    const result = advanceReturnObligation("testagent", "1709900001000-abc12345", {
      status: "deferred",
      returnedAt: 1709900003000,
      returnTarget: "deferred",
    })

    expect(result!.status).toBe("deferred")
    expect(result!.returnTarget).toBe("deferred")
  })

  it("returns null when obligation does not exist", async () => {
    const { advanceReturnObligation } = await import("../../arc/obligations")
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("ENOENT") })

    expect(advanceReturnObligation("testagent", "nonexistent", { status: "running" })).toBeNull()
  })

  it("emits a nerves event on advancement", async () => {
    const { advanceReturnObligation } = await import("../../arc/obligations")
    const stored = {
      id: "1709900001000-abc12345",
      origin: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
      status: "queued",
      delegatedContent: "think about penguins",
      createdAt: 1709900001000,
    }
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(stored))

    advanceReturnObligation("testagent", "1709900001000-abc12345", { status: "running", startedAt: 1709900002000 })

    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "mind.obligation_advanced",
      meta: expect.objectContaining({
        obligationId: "1709900001000-abc12345",
        status: "running",
      }),
    }))
  })
})

describe("listActiveReturnObligations", () => {
  beforeEach(() => { vi.resetModules() })

  it("returns empty array when directory does not exist", async () => {
    const { listActiveReturnObligations } = await import("../../arc/obligations")
    vi.mocked(fs.existsSync).mockReturnValue(false)

    expect(listActiveReturnObligations("testagent")).toEqual([])
  })

  it("returns only queued and running obligations sorted by createdAt", async () => {
    const { listActiveReturnObligations } = await import("../../arc/obligations")
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      "1709900003000-third.json",
      "1709900001000-first.json",
      "1709900002000-second.json",
    ] as any)

    const obligations = [
      { id: "1709900001000-first", status: "queued", createdAt: 1709900001000, origin: { friendId: "f1", channel: "cli", key: "s" }, delegatedContent: "a" },
      { id: "1709900002000-second", status: "returned", createdAt: 1709900002000, origin: { friendId: "f2", channel: "cli", key: "s" }, delegatedContent: "b" },
      { id: "1709900003000-third", status: "running", createdAt: 1709900003000, origin: { friendId: "f3", channel: "cli", key: "s" }, delegatedContent: "c" },
    ]
    vi.mocked(fs.readFileSync).mockImplementation(((p: string) => {
      const match = obligations.find(o => (p as string).includes(o.id))
      if (match) return JSON.stringify(match)
      throw new Error("ENOENT")
    }) as any)

    // Pin `now` to just after the fixture timestamps so all three are within
    // the 14-day injection window (which would otherwise exclude them).
    const result = listActiveReturnObligations("testagent", { now: () => 1709900004000 })
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe("1709900001000-first")
    expect(result[0].status).toBe("queued")
    expect(result[1].id).toBe("1709900003000-third")
    expect(result[1].status).toBe("running")
  })

  it("excludes obligations older than 14 days from injection even if still queued", async () => {
    const { listActiveReturnObligations } = await import("../../arc/obligations")
    vi.mocked(fs.existsSync).mockReturnValue(true)
    const dayMs = 24 * 60 * 60 * 1000
    const nowMs = 2_000_000_000_000 // arbitrary fixed point
    const fresh = { id: "fresh", status: "queued", createdAt: nowMs - 10 * dayMs, origin: { friendId: "f", channel: "c", key: "k" }, delegatedContent: "fresh" }
    const aging = { id: "aging", status: "queued", createdAt: nowMs - 14 * dayMs, origin: { friendId: "f", channel: "c", key: "k" }, delegatedContent: "aging" }
    const stale = { id: "stale", status: "queued", createdAt: nowMs - 30 * dayMs, origin: { friendId: "f", channel: "c", key: "k" }, delegatedContent: "stale" }
    vi.mocked(fs.readdirSync).mockReturnValue(["fresh.json", "aging.json", "stale.json"] as any)
    vi.mocked(fs.readFileSync).mockImplementation(((p: string) => {
      if ((p as string).includes("fresh")) return JSON.stringify(fresh)
      if ((p as string).includes("aging")) return JSON.stringify(aging)
      if ((p as string).includes("stale")) return JSON.stringify(stale)
      throw new Error("ENOENT")
    }) as any)

    const result = listActiveReturnObligations("testagent", { now: () => nowMs })
    // 30-day item is excluded; 14-day-on-the-dot item is included at the boundary; 10-day item is included.
    expect(result.map((o) => o.id)).toEqual(["aging", "fresh"])
  })

  it("excludes invalid legacy statuses (e.g. fulfilled written by pre-split code) from injection", async () => {
    const { listActiveReturnObligations } = await import("../../arc/obligations")
    vi.mocked(fs.existsSync).mockReturnValue(true)
    const nowMs = 2_000_000_000_000
    const valid = { id: "v", status: "queued", createdAt: nowMs - 1000, origin: { friendId: "f", channel: "c", key: "k" }, delegatedContent: "ok" }
    const legacy = { id: "l", status: "fulfilled" /* not in ReturnObligationStatus */, createdAt: nowMs - 1000, origin: { friendId: "f", channel: "c", key: "k" }, delegatedContent: "old" }
    vi.mocked(fs.readdirSync).mockReturnValue(["v.json", "l.json"] as any)
    vi.mocked(fs.readFileSync).mockImplementation(((p: string) => {
      if ((p as string).includes("v")) return JSON.stringify(valid)
      if ((p as string).includes("l")) return JSON.stringify(legacy)
      throw new Error("ENOENT")
    }) as any)

    const result = listActiveReturnObligations("testagent", { now: () => nowMs })
    expect(result.map((o) => o.id)).toEqual(["v"])
  })

  it("skips unparseable files", async () => {
    const { listActiveReturnObligations } = await import("../../arc/obligations")
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue(["bad.json", "good.json"] as any)
    vi.mocked(fs.readFileSync).mockImplementation(((p: string) => {
      if ((p as string).includes("bad")) return "not valid json"
      return JSON.stringify({
        id: "good", status: "queued", createdAt: 1, origin: { friendId: "f", channel: "c", key: "k" }, delegatedContent: "x",
      })
    }) as any)

    // Pin `now` to just after the fixture timestamp so the good entry is fresh.
    expect(listActiveReturnObligations("testagent", { now: () => 100 })).toHaveLength(1)
  })

  it("returns empty array when readdirSync throws", async () => {
    const { listActiveReturnObligations } = await import("../../arc/obligations")
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error("EACCES") })

    expect(listActiveReturnObligations("testagent")).toEqual([])
  })

  it("skips non-json files", async () => {
    const { listActiveReturnObligations } = await import("../../arc/obligations")
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([".DS_Store", "notes.txt"] as any)

    expect(listActiveReturnObligations("testagent")).toEqual([])
  })
})
