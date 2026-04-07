import { describe, it, expect, vi, beforeEach } from "vitest"

// Track nerves events
const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

// Mock child_process
const mockExecFile = vi.fn()
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}))

import { ensureBwCli } from "../../repertoire/bw-installer"

describe("ensureBwCli", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
  })

  it("returns existing path when bw is already installed", async () => {
    mockExecFile.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (cmd === "which" && args[0] === "bw") {
        cb(null, "/usr/local/bin/bw\n", "")
        return
      }
      cb(new Error("unexpected call"), "", "")
    })

    const result = await ensureBwCli()
    expect(result).toBe("/usr/local/bin/bw")

    // Should NOT emit install events
    expect(nervesEvents.some((e) => e.event === "repertoire.bw_cli_install_start")).toBe(false)
  })

  it("installs via npm when bw is not in PATH, then returns installed path", async () => {
    let whichCallCount = 0
    mockExecFile.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (cmd === "which" && args[0] === "bw") {
        whichCallCount++
        if (whichCallCount === 1) {
          // First call: not found
          cb(new Error("not found"), "", "")
          return
        }
        // Second call: found after install
        cb(null, "/usr/local/bin/bw\n", "")
        return
      }
      if (cmd === "npm" && args.includes("@bitwarden/cli")) {
        cb(null, "added 1 package\n", "")
        return
      }
      cb(new Error("unexpected call"), "", "")
    })

    const result = await ensureBwCli()
    expect(result).toBe("/usr/local/bin/bw")

    // Should emit install start and end events
    expect(nervesEvents.some((e) => e.event === "repertoire.bw_cli_install_start")).toBe(true)
    expect(nervesEvents.some((e) => e.event === "repertoire.bw_cli_install_end")).toBe(true)
  })

  it("throws when npm install fails", async () => {
    mockExecFile.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (cmd === "which") {
        cb(new Error("not found"), "", "")
        return
      }
      if (cmd === "npm") {
        cb(new Error("EACCES: permission denied"), "", "")
        return
      }
      cb(new Error("unexpected call"), "", "")
    })

    await expect(ensureBwCli()).rejects.toThrow("failed to install bw CLI via npm")
    await expect(ensureBwCli()).rejects.toThrow("EACCES")

    // Should emit start and fail events
    expect(nervesEvents.some((e) => e.event === "repertoire.bw_cli_install_start")).toBe(true)
    expect(nervesEvents.some((e) => e.event === "repertoire.bw_cli_install_fail")).toBe(true)
  })

  it("throws when npm install succeeds but binary still not found", async () => {
    mockExecFile.mockImplementation((cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      if (cmd === "which") {
        cb(new Error("not found"), "", "")
        return
      }
      if (cmd === "npm") {
        cb(null, "added 1 package\n", "")
        return
      }
      cb(new Error("unexpected call"), "", "")
    })

    await expect(ensureBwCli()).rejects.toThrow("binary not found in PATH")
  })

  it("handles which returning empty string as not found", async () => {
    let whichCallCount = 0
    mockExecFile.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (cmd === "which" && args[0] === "bw") {
        whichCallCount++
        if (whichCallCount === 1) {
          // First call: empty output (no binary)
          cb(null, "  \n", "")
          return
        }
        cb(null, "/usr/local/bin/bw\n", "")
        return
      }
      if (cmd === "npm") {
        cb(null, "ok\n", "")
        return
      }
      cb(new Error("unexpected call"), "", "")
    })

    const result = await ensureBwCli()
    expect(result).toBe("/usr/local/bin/bw")
    // Should have gone through install path
    expect(nervesEvents.some((e) => e.event === "repertoire.bw_cli_install_start")).toBe(true)
  })

  it("post-install which returning empty triggers error", async () => {
    mockExecFile.mockImplementation((cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      if (cmd === "which") {
        cb(null, "", "")
        return
      }
      if (cmd === "npm") {
        cb(null, "ok\n", "")
        return
      }
      cb(new Error("unexpected call"), "", "")
    })

    await expect(ensureBwCli()).rejects.toThrow("binary not found in PATH")
  })
})
