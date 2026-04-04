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
    const { generateObligationId } = await import("../../mind/obligations")
    const id = generateObligationId(1709900001000)
    expect(id).toMatch(/^1709900001000-[a-z0-9]+$/)
  })

  it("produces unique IDs for the same timestamp", async () => {
    const { generateObligationId } = await import("../../mind/obligations")
    const id1 = generateObligationId(1709900001000)
    const id2 = generateObligationId(1709900001000)
    expect(id1).not.toBe(id2)
  })
})

describe("getObligationsDir", () => {
  beforeEach(() => { vi.resetModules() })

  it("returns correct path under agent state", async () => {
    const { getObligationsDir } = await import("../../mind/obligations")
    const result = getObligationsDir("testagent")
    expect(result).toContain(path.join("testagent.ouro", "arc", "obligations", "inner"))
  })
})

describe("createObligation", () => {
  beforeEach(() => { vi.resetModules() })

  it("writes obligation JSON to the obligations directory", async () => {
    const { createObligation } = await import("../../mind/obligations")
    const obligation = {
      id: "1709900001000-abc12345",
      origin: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
      status: "queued" as const,
      delegatedContent: "think about penguins",
      createdAt: 1709900001000,
    }

    createObligation("testagent", obligation)

    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining(path.join("arc", "obligations", "inner")),
      { recursive: true },
    )
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("1709900001000-abc12345.json"),
      expect.any(String),
      "utf8",
    )
    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
    expect(written).toEqual(obligation)
  })

  it("emits a nerves event on creation", async () => {
    const { createObligation } = await import("../../mind/obligations")
    createObligation("testagent", {
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

describe("readObligation", () => {
  beforeEach(() => { vi.resetModules() })

  it("returns the parsed obligation when found", async () => {
    const { readObligation } = await import("../../mind/obligations")
    const stored = {
      id: "1709900001000-abc12345",
      origin: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
      status: "queued",
      delegatedContent: "think about penguins",
      createdAt: 1709900001000,
    }
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(stored))

    const result = readObligation("testagent", "1709900001000-abc12345")
    expect(result).toEqual(stored)
  })

  it("returns null when file does not exist", async () => {
    const { readObligation } = await import("../../mind/obligations")
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("ENOENT") })

    expect(readObligation("testagent", "nonexistent")).toBeNull()
  })
})

describe("advanceObligation", () => {
  beforeEach(() => { vi.resetModules() })

  it("advances obligation from queued to running", async () => {
    const { advanceObligation } = await import("../../mind/obligations")
    const stored = {
      id: "1709900001000-abc12345",
      origin: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
      status: "queued",
      delegatedContent: "think about penguins",
      createdAt: 1709900001000,
    }
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(stored))

    const result = advanceObligation("testagent", "1709900001000-abc12345", {
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
      "utf8",
    )
  })

  it("advances obligation from running to returned with returnTarget", async () => {
    const { advanceObligation } = await import("../../mind/obligations")
    const stored = {
      id: "1709900001000-abc12345",
      origin: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
      status: "running",
      delegatedContent: "think about penguins",
      createdAt: 1709900001000,
      startedAt: 1709900002000,
    }
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(stored))

    const result = advanceObligation("testagent", "1709900001000-abc12345", {
      status: "returned",
      returnedAt: 1709900003000,
      returnTarget: "exact-origin",
    })

    expect(result).toEqual({
      ...stored,
      status: "returned",
      returnedAt: 1709900003000,
      returnTarget: "exact-origin",
    })
  })

  it("advances obligation to deferred when no session available", async () => {
    const { advanceObligation } = await import("../../mind/obligations")
    const stored = {
      id: "1709900001000-abc12345",
      origin: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
      status: "running",
      delegatedContent: "think about penguins",
      createdAt: 1709900001000,
      startedAt: 1709900002000,
    }
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(stored))

    const result = advanceObligation("testagent", "1709900001000-abc12345", {
      status: "deferred",
      returnedAt: 1709900003000,
      returnTarget: "deferred",
    })

    expect(result!.status).toBe("deferred")
    expect(result!.returnTarget).toBe("deferred")
  })

  it("returns null when obligation does not exist", async () => {
    const { advanceObligation } = await import("../../mind/obligations")
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("ENOENT") })

    expect(advanceObligation("testagent", "nonexistent", { status: "running" })).toBeNull()
  })

  it("emits a nerves event on advancement", async () => {
    const { advanceObligation } = await import("../../mind/obligations")
    const stored = {
      id: "1709900001000-abc12345",
      origin: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
      status: "queued",
      delegatedContent: "think about penguins",
      createdAt: 1709900001000,
    }
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(stored))

    advanceObligation("testagent", "1709900001000-abc12345", { status: "running", startedAt: 1709900002000 })

    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "mind.obligation_advanced",
      meta: expect.objectContaining({
        obligationId: "1709900001000-abc12345",
        status: "running",
      }),
    }))
  })
})

describe("listActiveObligations", () => {
  beforeEach(() => { vi.resetModules() })

  it("returns empty array when directory does not exist", async () => {
    const { listActiveObligations } = await import("../../mind/obligations")
    vi.mocked(fs.existsSync).mockReturnValue(false)

    expect(listActiveObligations("testagent")).toEqual([])
  })

  it("returns only queued and running obligations sorted by createdAt", async () => {
    const { listActiveObligations } = await import("../../mind/obligations")
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

    const result = listActiveObligations("testagent")
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe("1709900001000-first")
    expect(result[0].status).toBe("queued")
    expect(result[1].id).toBe("1709900003000-third")
    expect(result[1].status).toBe("running")
  })

  it("skips unparseable files", async () => {
    const { listActiveObligations } = await import("../../mind/obligations")
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue(["bad.json", "good.json"] as any)
    vi.mocked(fs.readFileSync).mockImplementation(((p: string) => {
      if ((p as string).includes("bad")) return "not valid json"
      return JSON.stringify({
        id: "good", status: "queued", createdAt: 1, origin: { friendId: "f", channel: "c", key: "k" }, delegatedContent: "x",
      })
    }) as any)

    expect(listActiveObligations("testagent")).toHaveLength(1)
  })

  it("returns empty array when readdirSync throws", async () => {
    const { listActiveObligations } = await import("../../mind/obligations")
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error("EACCES") })

    expect(listActiveObligations("testagent")).toEqual([])
  })

  it("skips non-json files", async () => {
    const { listActiveObligations } = await import("../../mind/obligations")
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([".DS_Store", "notes.txt"] as any)

    expect(listActiveObligations("testagent")).toEqual([])
  })
})
