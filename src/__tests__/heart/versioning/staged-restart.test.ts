import { describe, expect, it, vi } from "vitest"

import { performStagedRestart } from "../../../heart/versioning/staged-restart"
import type { StagedRestartDeps } from "../../../heart/versioning/staged-restart"

function makeDeps(overrides?: Partial<StagedRestartDeps>): StagedRestartDeps {
  return {
    execSync: vi.fn(),
    spawnSync: vi.fn().mockReturnValue({ status: 0, error: undefined }),
    resolveNewCodePath: vi.fn().mockReturnValue("/usr/local/lib/node_modules/@ouro.bot/cli"),
    gracefulShutdown: vi.fn().mockResolvedValue(undefined),
    spawnNewDaemon: vi.fn().mockReturnValue({ pid: 12345 }),
    nodePath: "/usr/local/bin/node",
    bundlesRoot: "/tmp/test-bundles",
    socketPath: "/tmp/test.sock",
    ...overrides,
  }
}

describe("performStagedRestart", () => {
  it("installs, runs hooks, shuts down, and spawns new daemon on success", async () => {
    const deps = makeDeps()

    const result = await performStagedRestart("0.2.0-alpha.1", deps)

    expect(result.ok).toBe(true)
    expect(deps.execSync).toHaveBeenCalledWith(
      expect.stringContaining("npm install -g @ouro.bot/cli@0.2.0-alpha.1"),
    )
    expect(deps.spawnSync).toHaveBeenCalledWith(
      "/usr/local/bin/node",
      expect.arrayContaining([
        expect.stringContaining("run-hooks.js"),
        "--bundles-root",
        "/tmp/test-bundles",
      ]),
      expect.any(Object),
    )
    expect(deps.gracefulShutdown).toHaveBeenCalled()
    expect(deps.spawnNewDaemon).toHaveBeenCalledWith(
      expect.stringContaining("daemon-entry.js"),
      "/tmp/test.sock",
    )
  })

  it("uses default socket path when socketPath not provided", async () => {
    const deps = makeDeps({ socketPath: undefined })

    const result = await performStagedRestart("0.2.0-alpha.1", deps)

    expect(result.ok).toBe(true)
    expect(deps.spawnNewDaemon).toHaveBeenCalledWith(
      expect.any(String),
      "/tmp/ouroboros-daemon.sock",
    )
  })

  it("does not call graceful shutdown when hook runner exits non-zero", async () => {
    const deps = makeDeps({
      spawnSync: vi.fn().mockReturnValue({ status: 1, error: undefined }),
    })

    const result = await performStagedRestart("0.2.0-alpha.1", deps)

    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
    expect(deps.gracefulShutdown).not.toHaveBeenCalled()
    expect(deps.spawnNewDaemon).not.toHaveBeenCalled()
  })

  it("handles npm install failure", async () => {
    const deps = makeDeps({
      execSync: vi.fn().mockImplementation(() => {
        throw new Error("npm install failed")
      }),
    })

    const result = await performStagedRestart("0.2.0-alpha.1", deps)

    expect(result.ok).toBe(false)
    expect(result.error).toContain("npm install failed")
    expect(deps.gracefulShutdown).not.toHaveBeenCalled()
    expect(deps.spawnNewDaemon).not.toHaveBeenCalled()
  })

  it("handles spawn failure (error in spawnSync result)", async () => {
    const deps = makeDeps({
      spawnSync: vi.fn().mockReturnValue({ status: null, error: new Error("spawn failed") }),
    })

    const result = await performStagedRestart("0.2.0-alpha.1", deps)

    expect(result.ok).toBe(false)
    expect(result.error).toContain("spawn failed")
    expect(deps.gracefulShutdown).not.toHaveBeenCalled()
    expect(deps.spawnNewDaemon).not.toHaveBeenCalled()
  })

  it("handles new code path not existing", async () => {
    const deps = makeDeps({
      resolveNewCodePath: vi.fn().mockReturnValue(null),
    })

    const result = await performStagedRestart("0.2.0-alpha.1", deps)

    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
    expect(deps.gracefulShutdown).not.toHaveBeenCalled()
    expect(deps.spawnNewDaemon).not.toHaveBeenCalled()
  })

  it("still spawns new daemon when graceful shutdown fails", async () => {
    const deps = makeDeps({
      gracefulShutdown: vi.fn().mockRejectedValue(new Error("shutdown failed")),
    })

    const result = await performStagedRestart("0.2.0-alpha.1", deps)

    // Hooks succeeded and daemon spawned, so overall ok even if shutdown had trouble
    expect(result.ok).toBe(true)
    expect(result.shutdownError).toBe("shutdown failed")
    expect(deps.spawnNewDaemon).toHaveBeenCalled()
  })

  it("returns error when new daemon spawn fails after shutdown", async () => {
    const deps = makeDeps({
      spawnNewDaemon: vi.fn().mockImplementation(() => {
        throw new Error("ENOENT: no such file")
      }),
    })

    const result = await performStagedRestart("0.2.0-alpha.1", deps)

    expect(result.ok).toBe(false)
    expect(result.error).toContain("failed to spawn new daemon")
    expect(result.error).toContain("ENOENT")
    expect(deps.gracefulShutdown).toHaveBeenCalled()
  })

  it("handles non-Error thrown from execSync", async () => {
    const deps = makeDeps({
      execSync: vi.fn().mockImplementation(() => {
        throw "string-error"
      }),
    })

    const result = await performStagedRestart("0.2.0-alpha.1", deps)

    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })
})
