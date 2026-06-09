import { describe, expect, it, vi } from "vitest"

import {
  parseOuroCommand,
  runOuroCli,
  type OuroCliDeps,
} from "../../../heart/daemon/daemon-cli"
import { createTmpBundle } from "../../test-helpers/tmpdir-bundle"

function createMockDeps(overrides: Partial<OuroCliDeps> = {}): OuroCliDeps {
  return {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn().mockRejectedValue(new Error("daemon should not be called")),
    startDaemonProcess: vi.fn().mockResolvedValue({ pid: 12345 }),
    writeStdout: vi.fn(),
    checkSocketAlive: vi.fn().mockResolvedValue(true),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn().mockReturnValue("pending"),
    ...overrides,
  }
}

describe("ouro work card CLI", () => {
  it("parses work card text and JSON formats", () => {
    expect(parseOuroCommand(["work", "card", "--agent", "slugger"])).toEqual({
      kind: "work.card",
      agent: "slugger",
    })
    expect(parseOuroCommand(["work", "card", "--agent", "slugger", "--format", "json"])).toEqual({
      kind: "work.card",
      agent: "slugger",
      format: "json",
    })
    expect(parseOuroCommand(["work", "card", "--agent", "slugger", "--json"])).toEqual({
      kind: "work.card",
      agent: "slugger",
      format: "json",
    })
    expect(parseOuroCommand(["work", "card"])).toEqual({ kind: "work.card" })
    expect(() => parseOuroCommand(["work"])).toThrow(/Usage: ouro work card/)
    expect(() => parseOuroCommand(["work", "card", "--format"])).toThrow(/Usage: ouro work card/)
    expect(() => parseOuroCommand(["work", "card", "--format", "yaml"])).toThrow(/format/)
  })

  it("renders JSON from the bundle without routing through the daemon socket", async () => {
    const tmp = createTmpBundle({ agentName: "slugger" })
    try {
      const writeStdout = vi.fn()
      const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot, writeStdout })

      const result = await runOuroCli(["work", "card", "--agent", "slugger", "--format", "json"], deps)
      const parsed = JSON.parse(result)

      expect(parsed.agent).toBe("slugger")
      expect(parsed.schemaVersion).toBe(1)
      expect(parsed.projection.owner).toBe("arc/work-card")
      expect(parsed.claims.available).toBe(false)
      expect(parsed.counts.unverifiedClaims).toBeNull()
      expect(deps.sendCommand).not.toHaveBeenCalled()
      expect(writeStdout).toHaveBeenCalledWith(result)
    } finally {
      tmp.cleanup()
    }
  })
})
