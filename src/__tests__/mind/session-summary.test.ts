import { describe, it, expect, vi, beforeEach } from "vitest"
import * as path from "path"

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import * as fs from "fs"

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReset()
  vi.mocked(fs.readFileSync).mockReset()
  vi.mocked(fs.readdirSync).mockReset()
  vi.mocked(fs.statSync).mockReset()
})

describe("buildSessionSummary", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("lists active sessions with friend names and timestamps", async () => {
    const { buildSessionSummary } = await import("../../mind/prompt")

    const sessionsDir = "/mock/sessions"
    const friendsDir = "/mock/friends"

    // sessions/<friendId>/<channel>/<key>.json
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(((p: string) => {
      if (p === sessionsDir) return ["friend-uuid-1", "self"] as any
      if (p === path.join(sessionsDir, "friend-uuid-1")) return ["cli"] as any
      if (p === path.join(sessionsDir, "friend-uuid-1", "cli")) return ["session.json"] as any
      if (p === path.join(sessionsDir, "self")) return ["inner"] as any
      if (p === path.join(sessionsDir, "self", "inner")) return ["dialog.json"] as any
      return [] as any
    }) as any)

    vi.mocked(fs.statSync).mockImplementation(((p: string) => {
      return { mtimeMs: Date.now() - 1000 * 60 * 30 } as any // 30 min ago
    }) as any)

    // Friend record: friend-uuid-1 -> "Bob"
    vi.mocked(fs.readFileSync).mockImplementation(((p: string) => {
      if (p === path.join(friendsDir, "friend-uuid-1.json")) {
        return JSON.stringify({ id: "friend-uuid-1", name: "Bob" })
      }
      throw new Error("ENOENT")
    }) as any)

    const result = buildSessionSummary({
      sessionsDir,
      friendsDir,
      agentName: "slugger",
    })

    expect(result).toContain("## active sessions")
    expect(result).toContain("Bob")
    expect(result).toContain("cli")
    expect(result).toContain("slugger")
    expect(result).toContain("inner")
  })

  it("excludes the current session from output", async () => {
    const { buildSessionSummary } = await import("../../mind/prompt")

    const sessionsDir = "/mock/sessions"
    const friendsDir = "/mock/friends"

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(((p: string) => {
      if (p === sessionsDir) return ["friend-uuid-1"] as any
      if (p === path.join(sessionsDir, "friend-uuid-1")) return ["cli"] as any
      if (p === path.join(sessionsDir, "friend-uuid-1", "cli")) return ["session.json"] as any
      return [] as any
    }) as any)

    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: Date.now() - 1000 * 60 * 5 } as any)

    vi.mocked(fs.readFileSync).mockImplementation(((p: string) => {
      if (p === path.join(friendsDir, "friend-uuid-1.json")) {
        return JSON.stringify({ id: "friend-uuid-1", name: "Bob" })
      }
      throw new Error("ENOENT")
    }) as any)

    const result = buildSessionSummary({
      sessionsDir,
      friendsDir,
      agentName: "slugger",
      currentFriendId: "friend-uuid-1",
      currentChannel: "cli",
      currentKey: "session",
    })

    expect(result).not.toContain("Bob")
  })

  it("returns empty string when sessions dir does not exist", async () => {
    const { buildSessionSummary } = await import("../../mind/prompt")

    vi.mocked(fs.existsSync).mockReturnValue(false)

    const result = buildSessionSummary({
      sessionsDir: "/mock/sessions",
      friendsDir: "/mock/friends",
      agentName: "slugger",
    })

    expect(result).toBe("")
  })

  it("returns empty string when no sessions are active within threshold", async () => {
    const { buildSessionSummary } = await import("../../mind/prompt")

    const sessionsDir = "/mock/sessions"
    const friendsDir = "/mock/friends"

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(((p: string) => {
      if (p === sessionsDir) return ["friend-uuid-1"] as any
      if (p === path.join(sessionsDir, "friend-uuid-1")) return ["cli"] as any
      if (p === path.join(sessionsDir, "friend-uuid-1", "cli")) return ["session.json"] as any
      return [] as any
    }) as any)

    // 48 hours ago — beyond 24h threshold
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: Date.now() - 1000 * 60 * 60 * 48 } as any)

    const result = buildSessionSummary({
      sessionsDir,
      friendsDir,
      agentName: "slugger",
    })

    expect(result).toBe("")
  })

  it("resolves 'self' friendId to agent name", async () => {
    const { buildSessionSummary } = await import("../../mind/prompt")

    const sessionsDir = "/mock/sessions"
    const friendsDir = "/mock/friends"

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(((p: string) => {
      if (p === sessionsDir) return ["self"] as any
      if (p === path.join(sessionsDir, "self")) return ["inner"] as any
      if (p === path.join(sessionsDir, "self", "inner")) return ["dialog.json"] as any
      return [] as any
    }) as any)

    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: Date.now() - 1000 * 60 * 10 } as any)

    const result = buildSessionSummary({
      sessionsDir,
      friendsDir,
      agentName: "slugger",
    })

    expect(result).toContain("slugger")
    expect(result).toContain("inner")
    expect(result).toContain("dialog")
  })

  it("handles missing friend record gracefully", async () => {
    const { buildSessionSummary } = await import("../../mind/prompt")

    const sessionsDir = "/mock/sessions"
    const friendsDir = "/mock/friends"

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(((p: string) => {
      if (p === sessionsDir) return ["unknown-uuid"] as any
      if (p === path.join(sessionsDir, "unknown-uuid")) return ["teams"] as any
      if (p === path.join(sessionsDir, "unknown-uuid", "teams")) return ["thread1.json"] as any
      return [] as any
    }) as any)

    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: Date.now() - 1000 * 60 * 5 } as any)

    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT")
    })

    const result = buildSessionSummary({
      sessionsDir,
      friendsDir,
      agentName: "slugger",
    })

    expect(result).toContain("unknown-uuid")
    expect(result).toContain("teams")
  })

  it("respects custom active threshold", async () => {
    const { buildSessionSummary } = await import("../../mind/prompt")

    const sessionsDir = "/mock/sessions"
    const friendsDir = "/mock/friends"

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(((p: string) => {
      if (p === sessionsDir) return ["friend-uuid-1"] as any
      if (p === path.join(sessionsDir, "friend-uuid-1")) return ["cli"] as any
      if (p === path.join(sessionsDir, "friend-uuid-1", "cli")) return ["session.json"] as any
      return [] as any
    }) as any)

    // 2 hours ago
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: Date.now() - 1000 * 60 * 60 * 2 } as any)

    vi.mocked(fs.readFileSync).mockImplementation(((p: string) => {
      if (p === path.join(friendsDir, "friend-uuid-1.json")) {
        return JSON.stringify({ id: "friend-uuid-1", name: "Bob" })
      }
      throw new Error("ENOENT")
    }) as any)

    // 1 hour threshold — session is 2h old, should be excluded
    const short = buildSessionSummary({
      sessionsDir,
      friendsDir,
      agentName: "slugger",
      activeThresholdMs: 1000 * 60 * 60,
    })
    expect(short).toBe("")

    // 3 hour threshold — session is 2h old, should be included
    const long = buildSessionSummary({
      sessionsDir,
      friendsDir,
      agentName: "slugger",
      activeThresholdMs: 1000 * 60 * 60 * 3,
    })
    expect(long).toContain("Bob")
  })

  it("returns empty string when readdirSync throws on sessions dir", async () => {
    const { buildSessionSummary } = await import("../../mind/prompt")

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error("EACCES") })

    const result = buildSessionSummary({
      sessionsDir: "/mock/sessions",
      friendsDir: "/mock/friends",
      agentName: "slugger",
    })

    expect(result).toBe("")
  })

  it("skips friend dir when channel readdirSync throws", async () => {
    const { buildSessionSummary } = await import("../../mind/prompt")

    const sessionsDir = "/mock/sessions"
    const friendsDir = "/mock/friends"

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(((p: string) => {
      if (p === sessionsDir) return ["friend-1"] as any
      if (p === path.join(sessionsDir, "friend-1")) throw new Error("EACCES")
      return [] as any
    }) as any)

    const result = buildSessionSummary({ sessionsDir, friendsDir, agentName: "slugger" })
    expect(result).toBe("")
  })

  it("skips channel dir when key readdirSync throws", async () => {
    const { buildSessionSummary } = await import("../../mind/prompt")

    const sessionsDir = "/mock/sessions"
    const friendsDir = "/mock/friends"

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(((p: string) => {
      if (p === sessionsDir) return ["friend-1"] as any
      if (p === path.join(sessionsDir, "friend-1")) return ["cli"] as any
      if (p === path.join(sessionsDir, "friend-1", "cli")) throw new Error("EACCES")
      return [] as any
    }) as any)

    const result = buildSessionSummary({ sessionsDir, friendsDir, agentName: "slugger" })
    expect(result).toBe("")
  })

  it("skips file when statSync throws", async () => {
    const { buildSessionSummary } = await import("../../mind/prompt")

    const sessionsDir = "/mock/sessions"
    const friendsDir = "/mock/friends"

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(((p: string) => {
      if (p === sessionsDir) return ["friend-1"] as any
      if (p === path.join(sessionsDir, "friend-1")) return ["cli"] as any
      if (p === path.join(sessionsDir, "friend-1", "cli")) return ["session.json"] as any
      return [] as any
    }) as any)

    vi.mocked(fs.statSync).mockImplementation(() => { throw new Error("ENOENT") })

    const result = buildSessionSummary({ sessionsDir, friendsDir, agentName: "slugger" })
    expect(result).toBe("")
  })

  it("falls back to friendId when friend record has no name", async () => {
    const { buildSessionSummary } = await import("../../mind/prompt")

    const sessionsDir = "/mock/sessions"
    const friendsDir = "/mock/friends"

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(((p: string) => {
      if (p === sessionsDir) return ["friend-no-name"] as any
      if (p === path.join(sessionsDir, "friend-no-name")) return ["cli"] as any
      if (p === path.join(sessionsDir, "friend-no-name", "cli")) return ["session.json"] as any
      return [] as any
    }) as any)

    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: Date.now() - 1000 * 60 * 5 } as any)

    // Friend record exists but has no name field
    vi.mocked(fs.readFileSync).mockImplementation(((p: string) => {
      if (p === path.join(friendsDir, "friend-no-name.json")) {
        return JSON.stringify({ id: "friend-no-name" })
      }
      throw new Error("ENOENT")
    }) as any)

    const result = buildSessionSummary({ sessionsDir, friendsDir, agentName: "slugger" })
    expect(result).toContain("friend-no-name")
  })

  it("skips non-json files in session directory", async () => {
    const { buildSessionSummary } = await import("../../mind/prompt")

    const sessionsDir = "/mock/sessions"
    const friendsDir = "/mock/friends"

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(((p: string) => {
      if (p === sessionsDir) return ["friend-1"] as any
      if (p === path.join(sessionsDir, "friend-1")) return ["cli"] as any
      if (p === path.join(sessionsDir, "friend-1", "cli")) return ["session.json", ".DS_Store", "notes.txt"] as any
      return [] as any
    }) as any)

    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: Date.now() - 1000 * 60 * 5 } as any)
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("ENOENT") })

    const result = buildSessionSummary({ sessionsDir, friendsDir, agentName: "slugger" })
    // Only session.json should be listed, not .DS_Store or notes.txt
    expect(result).toContain("session")
    expect(result).not.toContain("DS_Store")
    expect(result).not.toContain("notes")
  })

  it("formats time ago in days for old sessions", async () => {
    const { buildSessionSummary } = await import("../../mind/prompt")

    const sessionsDir = "/mock/sessions"
    const friendsDir = "/mock/friends"

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(((p: string) => {
      if (p === sessionsDir) return ["friend-1"] as any
      if (p === path.join(sessionsDir, "friend-1")) return ["cli"] as any
      if (p === path.join(sessionsDir, "friend-1", "cli")) return ["session.json"] as any
      return [] as any
    }) as any)

    // 2 days ago (needs activeThreshold > 2 days to show)
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: Date.now() - 1000 * 60 * 60 * 48 } as any)

    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("ENOENT") })

    const result = buildSessionSummary({
      sessionsDir,
      friendsDir,
      agentName: "slugger",
      activeThresholdMs: 1000 * 60 * 60 * 72, // 3 day threshold
    })

    expect(result).toContain("2d ago")
  })

  it("prefers friend-facing activity over newer passive internal mtimes", async () => {
    const { buildSessionSummary } = await import("../../mind/prompt")

    const sessionsDir = "/mock/sessions"
    const friendsDir = "/mock/friends"
    const now = Date.now()

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(((p: string) => {
      if (p === sessionsDir) return ["friend-1", "friend-2"] as any
      if (p === path.join(sessionsDir, "friend-1")) return ["cli"] as any
      if (p === path.join(sessionsDir, "friend-2")) return ["cli"] as any
      if (p === path.join(sessionsDir, "friend-1", "cli")) return ["session.json"] as any
      if (p === path.join(sessionsDir, "friend-2", "cli")) return ["session.json"] as any
      return [] as any
    }) as any)

    vi.mocked(fs.statSync).mockImplementation(((p: string) => {
      if (String(p).includes("friend-1")) return { mtimeMs: now - 1000 * 60 * 60 } as any
      return { mtimeMs: now - 1000 * 10 } as any
    }) as any)

    vi.mocked(fs.readFileSync).mockImplementation(((p: string) => {
      if (p === path.join(friendsDir, "friend-1.json")) return JSON.stringify({ id: "friend-1", name: "Ari" })
      if (p === path.join(friendsDir, "friend-2.json")) return JSON.stringify({ id: "friend-2", name: "Sam" })
      if (p === path.join(sessionsDir, "friend-1", "cli", "session.json")) {
        return JSON.stringify({
          version: 1,
          messages: [],
          state: { lastFriendActivityAt: new Date(now - 1000 * 60).toISOString() },
        })
      }
      if (p === path.join(sessionsDir, "friend-2", "cli", "session.json")) {
        return JSON.stringify({ version: 1, messages: [] })
      }
      throw new Error("ENOENT")
    }) as any)

    const result = buildSessionSummary({ sessionsDir, friendsDir, agentName: "slugger" })
    expect(result.indexOf("Ari/cli/session")).toBeLessThan(result.indexOf("Sam/cli/session"))
  })
})

// ── Unit 1.1: Session summary distinguishes active vs paused vs superseded work ──

describe("buildSessionSummary: work status classification", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("labels sessions with obligation status when available", async () => {
    const { buildSessionSummary } = await import("../../mind/prompt")

    const sessionsDir = "/mock/sessions"
    const friendsDir = "/mock/friends"
    const now = Date.now()

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockImplementation(((p: string) => {
      if (p === sessionsDir) return ["friend-1"] as any
      if (p === path.join(sessionsDir, "friend-1")) return ["cli"] as any
      if (p === path.join(sessionsDir, "friend-1", "cli")) return ["session.json"] as any
      return [] as any
    }) as any)

    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: now - 1000 * 60 * 5 } as any)

    vi.mocked(fs.readFileSync).mockImplementation(((p: string) => {
      if (p === path.join(friendsDir, "friend-1.json")) {
        return JSON.stringify({ id: "friend-1", name: "Ari" })
      }
      if (p === path.join(sessionsDir, "friend-1", "cli", "session.json")) {
        return JSON.stringify({
          version: 1,
          messages: [],
          state: {
            lastFriendActivityAt: new Date(now - 1000 * 60 * 5).toISOString(),
            mustResolveBeforeHandoff: true,
          },
        })
      }
      throw new Error("ENOENT")
    }) as any)

    const result = buildSessionSummary({ sessionsDir, friendsDir, agentName: "slugger" })
    // Active sessions with mustResolveBeforeHandoff should be marked as active
    expect(result).toContain("Ari")
    expect(result).toContain("cli")
  })
})
