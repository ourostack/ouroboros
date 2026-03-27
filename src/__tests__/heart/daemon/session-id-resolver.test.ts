import { describe, it, expect, vi, beforeEach } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"

// ── Mocks ──────────────────────────────────────────────────────

const mockExistsSync = vi.fn()
const mockReadFileSync = vi.fn()
const mockReaddirSync = vi.fn().mockReturnValue([])

vi.mock("fs", () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  readdirSync: (...args: any[]) => mockReaddirSync(...args),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

// ── Tests ──────────────────────────────────────────────────────

describe("resolveSessionId", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
    emitNervesEvent({
      component: "daemon",
      event: "daemon.session_id_resolver_test_start",
      message: "session ID resolver test",
      meta: {},
    })
  })

  it("returns a string", async () => {
    const { resolveSessionId } = await import("../../../heart/daemon/session-id-resolver")
    const id = resolveSessionId()
    expect(typeof id).toBe("string")
    expect(id.length).toBeGreaterThan(0)
  })

  it("returns a UUID fallback when no Claude session files exist", async () => {
    mockExistsSync.mockReturnValue(false)
    mockReaddirSync.mockReturnValue([])
    const { resolveSessionId } = await import("../../../heart/daemon/session-id-resolver")
    const id = resolveSessionId()
    // UUID format: 8-4-4-4-12
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it("resolves session ID from Claude Code session file via PID walk", async () => {
    // Simulate: current PID has a .claude/sessions/{pid}.json file
    const fakePid = process.pid
    const claudeSessionId = "cs_abcdef123456"

    mockExistsSync.mockImplementation((p: any) => {
      const s = String(p)
      return s.includes(`${fakePid}.json`)
    })
    mockReadFileSync.mockImplementation((p: any) => {
      const s = String(p)
      if (s.includes(`${fakePid}.json`)) {
        return JSON.stringify({ sessionId: claudeSessionId })
      }
      throw new Error("not found")
    })

    const { resolveSessionId } = await import("../../../heart/daemon/session-id-resolver")
    const id = resolveSessionId({ claudeSessionsDir: "/tmp/.claude/sessions" })
    expect(id).toBe(claudeSessionId)
  })

  it("walks parent PID chain when direct PID has no session file", async () => {
    // Simulate: current PID has no file, but parent PID does
    const parentPid = process.ppid
    const claudeSessionId = "cs_parent_session"

    mockExistsSync.mockImplementation((p: any) => {
      const s = String(p)
      return s.includes(`${parentPid}.json`)
    })
    mockReadFileSync.mockImplementation((p: any) => {
      const s = String(p)
      if (s.includes(`${parentPid}.json`)) {
        return JSON.stringify({ sessionId: claudeSessionId })
      }
      throw new Error("not found")
    })

    const { resolveSessionId } = await import("../../../heart/daemon/session-id-resolver")
    const id = resolveSessionId({ claudeSessionsDir: "/tmp/.claude/sessions" })
    expect(id).toBe(claudeSessionId)
  })

  it("falls back to UUID when PID walk exhausts without finding session", async () => {
    mockExistsSync.mockReturnValue(false)
    const { resolveSessionId } = await import("../../../heart/daemon/session-id-resolver")
    const id = resolveSessionId({ claudeSessionsDir: "/tmp/.claude/sessions" })
    // Should be a UUID
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it("handles malformed session JSON gracefully", async () => {
    const fakePid = process.pid
    mockExistsSync.mockImplementation((p: any) => String(p).includes(`${fakePid}.json`))
    mockReadFileSync.mockReturnValue("not valid json")

    const { resolveSessionId } = await import("../../../heart/daemon/session-id-resolver")
    const id = resolveSessionId({ claudeSessionsDir: "/tmp/.claude/sessions" })
    // Should fall back to UUID
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it("handles session file with missing sessionId field", async () => {
    const fakePid = process.pid
    mockExistsSync.mockImplementation((p: any) => String(p).includes(`${fakePid}.json`))
    mockReadFileSync.mockReturnValue(JSON.stringify({ foo: "bar" }))

    const { resolveSessionId } = await import("../../../heart/daemon/session-id-resolver")
    const id = resolveSessionId({ claudeSessionsDir: "/tmp/.claude/sessions" })
    // Should fall back to UUID since no sessionId field
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it("uses default Claude sessions dir when none provided", async () => {
    mockExistsSync.mockReturnValue(false)
    const { resolveSessionId } = await import("../../../heart/daemon/session-id-resolver")
    const id = resolveSessionId()
    // Should still return a valid ID (UUID fallback)
    expect(typeof id).toBe("string")
    expect(id.length).toBeGreaterThan(0)
  })
})
