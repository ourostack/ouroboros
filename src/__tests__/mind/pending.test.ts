import { describe, it, expect, vi, beforeEach } from "vitest"
import * as os from "os"
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
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}))

import * as fs from "fs"

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReset()
  vi.mocked(fs.readFileSync).mockReset()
  vi.mocked(fs.readdirSync).mockReset()
  vi.mocked(fs.renameSync).mockReset()
  vi.mocked(fs.unlinkSync).mockReset()
  vi.mocked(fs.mkdirSync).mockReset()
})

describe("getPendingDir", () => {
  it("returns correct path", async () => {
    const { getPendingDir } = await import("../../mind/pending")
    const result = getPendingDir("testagent", "friend-1", "cli", "session")
    expect(result).toBe(
      path.join(
        os.homedir(),
        "AgentBundles",
        "testagent.ouro",
        "state",
        "pending",
        "friend-1",
        "cli",
        "session",
      ),
    )
  })
})

describe("hasPendingMessages", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("returns false when the directory does not exist", async () => {
    const { hasPendingMessages } = await import("../../mind/pending")
    vi.mocked(fs.existsSync).mockReturnValue(false)

    expect(hasPendingMessages("/mock/pending/friend-1/cli/session")).toBe(false)
  })

  it("returns true when json or processing files are present", async () => {
    const { hasPendingMessages } = await import("../../mind/pending")
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      "1709900001-a.json.processing",
      "1709900002-b.json",
      "notes.txt",
    ] as any)

    expect(hasPendingMessages("/mock/pending/friend-1/cli/session")).toBe(true)
  })

  it("returns false when only unrelated files are present", async () => {
    const { hasPendingMessages } = await import("../../mind/pending")
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      ".DS_Store",
      "notes.txt",
    ] as any)

    expect(hasPendingMessages("/mock/pending/friend-1/cli/session")).toBe(false)
  })

  it("returns false when readdirSync throws", async () => {
    const { hasPendingMessages } = await import("../../mind/pending")
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error("EACCES") })

    expect(hasPendingMessages("/mock/pending/friend-1/cli/session")).toBe(false)
  })
})

describe("drainPending", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("returns empty array when readdirSync throws", async () => {
    const { drainPending } = await import("../../mind/pending")
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error("EACCES") })

    const result = drainPending("/mock/pending/friend-1/cli/session")
    expect(result).toEqual([])
  })

  it("returns empty array when directory does not exist", async () => {
    const { drainPending } = await import("../../mind/pending")
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const result = drainPending("/mock/pending/friend-1/cli/session")
    expect(result).toEqual([])
  })

  it("drains .json files in timestamp order", async () => {
    const { drainPending } = await import("../../mind/pending")
    const dir = "/mock/pending/friend-1/cli/session"

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      "1709900002-abc.json",
      "1709900001-xyz.json",
    ] as any)

    vi.mocked(fs.readFileSync).mockImplementation(((p: string) => {
      if (p.includes("1709900001")) {
        return JSON.stringify({ from: "agent-a", content: "first message", timestamp: 1709900001 })
      }
      if (p.includes("1709900002")) {
        return JSON.stringify({ from: "agent-b", content: "second message", timestamp: 1709900002 })
      }
      throw new Error("ENOENT")
    }) as any)

    const result = drainPending(dir)

    expect(result).toHaveLength(2)
    expect(result[0].content).toBe("first message")
    expect(result[1].content).toBe("second message")
  })

  it("renames to .processing before reading, deletes after", async () => {
    const { drainPending } = await import("../../mind/pending")
    const dir = "/mock/pending/friend-1/cli/session"

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue(["1709900001-abc.json"] as any)

    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ from: "agent-a", content: "hello", timestamp: 1709900001 }),
    )

    drainPending(dir)

    // Should rename .json -> .processing
    expect(fs.renameSync).toHaveBeenCalledWith(
      path.join(dir, "1709900001-abc.json"),
      path.join(dir, "1709900001-abc.json.processing"),
    )
    // Should read the .processing file
    expect(fs.readFileSync).toHaveBeenCalledWith(
      path.join(dir, "1709900001-abc.json.processing"),
      "utf-8",
    )
    // Should delete the .processing file
    expect(fs.unlinkSync).toHaveBeenCalledWith(
      path.join(dir, "1709900001-abc.json.processing"),
    )
  })

  it("recovers .processing files from previous crash", async () => {
    const { drainPending } = await import("../../mind/pending")
    const dir = "/mock/pending/friend-1/cli/session"

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      "1709900001-abc.json.processing",
    ] as any)

    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ from: "agent-a", content: "crash recovery", timestamp: 1709900001 }),
    )

    const result = drainPending(dir)

    expect(result).toHaveLength(1)
    expect(result[0].content).toBe("crash recovery")
    // Should NOT rename (already .processing)
    expect(fs.renameSync).not.toHaveBeenCalled()
    // Should still delete after reading
    expect(fs.unlinkSync).toHaveBeenCalledWith(
      path.join(dir, "1709900001-abc.json.processing"),
    )
  })

  it("skips files that fail to parse and still processes remaining", async () => {
    const { drainPending } = await import("../../mind/pending")
    const dir = "/mock/pending/friend-1/cli/session"

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      "1709900001-bad.json",
      "1709900002-good.json",
    ] as any)

    vi.mocked(fs.readFileSync).mockImplementation(((p: string) => {
      if (p.includes("1709900001-bad")) return "not valid json"
      return JSON.stringify({ from: "agent-a", content: "good msg", timestamp: 1709900002 })
    }) as any)

    const result = drainPending(dir)

    expect(result).toHaveLength(1)
    expect(result[0].content).toBe("good msg")
  })
})
