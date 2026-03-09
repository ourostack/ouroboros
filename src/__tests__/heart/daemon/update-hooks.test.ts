import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  applyPendingUpdates,
  clearRegisteredHooks,
  getRegisteredHooks,
  registerUpdateHook,
} from "../../../heart/daemon/update-hooks"
import type { UpdateHookContext, UpdateHookResult } from "../../../heart/daemon/update-hooks"

const createdDirs: string[] = []

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  createdDirs.push(dir)
  return dir
}

afterEach(() => {
  clearRegisteredHooks()
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("update hook registry", () => {
  it("registers and retrieves hooks", () => {
    const hook = vi.fn((_ctx: UpdateHookContext): UpdateHookResult => ({ ok: true }))
    registerUpdateHook(hook)
    expect(getRegisteredHooks()).toHaveLength(1)
    expect(getRegisteredHooks()[0]).toBe(hook)
  })

  it("clears all registered hooks", () => {
    registerUpdateHook(() => ({ ok: true }))
    registerUpdateHook(() => ({ ok: true }))
    clearRegisteredHooks()
    expect(getRegisteredHooks()).toHaveLength(0)
  })
})

describe("applyPendingUpdates", () => {
  it("iterates .ouro bundles and detects version mismatch", async () => {
    const bundlesRoot = createTempDir("update-hooks-test-")
    const agentDir = path.join(bundlesRoot, "test-agent.ouro")
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, "bundle-meta.json"),
      JSON.stringify({ runtimeVersion: "0.0.1", bundleSchemaVersion: 1, lastUpdated: "2025-01-01T00:00:00Z" }),
    )

    const hook = vi.fn((_ctx: UpdateHookContext): UpdateHookResult => ({ ok: true }))
    registerUpdateHook(hook)

    await applyPendingUpdates(bundlesRoot, "0.1.0")

    expect(hook).toHaveBeenCalledTimes(1)
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRoot: agentDir,
        currentVersion: "0.1.0",
        previousVersion: "0.0.1",
      }),
    )
  })

  it("skips agents with matching versions", async () => {
    const bundlesRoot = createTempDir("update-hooks-skip-")
    const agentDir = path.join(bundlesRoot, "test-agent.ouro")
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, "bundle-meta.json"),
      JSON.stringify({ runtimeVersion: "0.1.0", bundleSchemaVersion: 1, lastUpdated: "2025-01-01T00:00:00Z" }),
    )

    const hook = vi.fn((_ctx: UpdateHookContext): UpdateHookResult => ({ ok: true }))
    registerUpdateHook(hook)

    await applyPendingUpdates(bundlesRoot, "0.1.0")

    expect(hook).not.toHaveBeenCalled()
  })

  it("handles missing bundle-meta.json (backfill/first-boot case)", async () => {
    const bundlesRoot = createTempDir("update-hooks-missing-meta-")
    const agentDir = path.join(bundlesRoot, "test-agent.ouro")
    fs.mkdirSync(agentDir, { recursive: true })
    // No bundle-meta.json

    const hook = vi.fn((_ctx: UpdateHookContext): UpdateHookResult => ({ ok: true }))
    registerUpdateHook(hook)

    await applyPendingUpdates(bundlesRoot, "0.1.0")

    // No version to compare, should run hooks with undefined previousVersion
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({
        agentRoot: agentDir,
        currentVersion: "0.1.0",
        previousVersion: undefined,
      }),
    )
  })

  it("handles empty bundles directory", async () => {
    const bundlesRoot = createTempDir("update-hooks-empty-")

    const hook = vi.fn((_ctx: UpdateHookContext): UpdateHookResult => ({ ok: true }))
    registerUpdateHook(hook)

    await applyPendingUpdates(bundlesRoot, "0.1.0")

    expect(hook).not.toHaveBeenCalled()
  })

  it("handles non-existent bundles directory", async () => {
    const hook = vi.fn((_ctx: UpdateHookContext): UpdateHookResult => ({ ok: true }))
    registerUpdateHook(hook)

    await expect(
      applyPendingUpdates("/nonexistent/path", "0.1.0"),
    ).resolves.toBeUndefined()

    expect(hook).not.toHaveBeenCalled()
  })

  it("handles read errors gracefully (one agent failing does not block others)", async () => {
    const bundlesRoot = createTempDir("update-hooks-error-")
    const agent1 = path.join(bundlesRoot, "agent1.ouro")
    const agent2 = path.join(bundlesRoot, "agent2.ouro")
    fs.mkdirSync(agent1, { recursive: true })
    fs.mkdirSync(agent2, { recursive: true })
    fs.writeFileSync(path.join(agent1, "bundle-meta.json"), "invalid-json")
    fs.writeFileSync(
      path.join(agent2, "bundle-meta.json"),
      JSON.stringify({ runtimeVersion: "0.0.1", bundleSchemaVersion: 1, lastUpdated: "2025-01-01T00:00:00Z" }),
    )

    const hook = vi.fn((_ctx: UpdateHookContext): UpdateHookResult => ({ ok: true }))
    registerUpdateHook(hook)

    await applyPendingUpdates(bundlesRoot, "0.1.0")

    // agent1 has invalid JSON -- should still process agent2
    // agent1 gets hooks with undefined previousVersion (couldn't parse meta)
    expect(hook).toHaveBeenCalledTimes(2)
  })

  it("runs hooks in registration order", async () => {
    const bundlesRoot = createTempDir("update-hooks-order-")
    const agentDir = path.join(bundlesRoot, "test-agent.ouro")
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, "bundle-meta.json"),
      JSON.stringify({ runtimeVersion: "0.0.1", bundleSchemaVersion: 1, lastUpdated: "2025-01-01T00:00:00Z" }),
    )

    const order: number[] = []
    registerUpdateHook(() => { order.push(1); return { ok: true } })
    registerUpdateHook(() => { order.push(2); return { ok: true } })
    registerUpdateHook(() => { order.push(3); return { ok: true } })

    await applyPendingUpdates(bundlesRoot, "0.1.0")

    expect(order).toEqual([1, 2, 3])
  })

  it("continues running hooks even if one throws", async () => {
    const bundlesRoot = createTempDir("update-hooks-throw-")
    const agentDir = path.join(bundlesRoot, "test-agent.ouro")
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, "bundle-meta.json"),
      JSON.stringify({ runtimeVersion: "0.0.1", bundleSchemaVersion: 1, lastUpdated: "2025-01-01T00:00:00Z" }),
    )

    const order: number[] = []
    registerUpdateHook(() => { order.push(1); throw new Error("hook 1 failed") })
    registerUpdateHook(() => { order.push(2); return { ok: true } })

    await applyPendingUpdates(bundlesRoot, "0.1.0")

    expect(order).toEqual([1, 2])
  })

  it("skips non-.ouro directories", async () => {
    const bundlesRoot = createTempDir("update-hooks-non-ouro-")
    fs.mkdirSync(path.join(bundlesRoot, "notes"), { recursive: true })
    fs.mkdirSync(path.join(bundlesRoot, "test-agent.ouro"), { recursive: true })
    fs.writeFileSync(
      path.join(bundlesRoot, "test-agent.ouro", "bundle-meta.json"),
      JSON.stringify({ runtimeVersion: "0.0.1", bundleSchemaVersion: 1, lastUpdated: "2025-01-01T00:00:00Z" }),
    )

    const hook = vi.fn((_ctx: UpdateHookContext): UpdateHookResult => ({ ok: true }))
    registerUpdateHook(hook)

    await applyPendingUpdates(bundlesRoot, "0.1.0")

    expect(hook).toHaveBeenCalledTimes(1)
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({ agentRoot: path.join(bundlesRoot, "test-agent.ouro") }),
    )
  })

  it("handles hook throwing non-Error value", async () => {
    const bundlesRoot = createTempDir("update-hooks-non-error-throw-")
    const agentDir = path.join(bundlesRoot, "test-agent.ouro")
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, "bundle-meta.json"),
      JSON.stringify({ runtimeVersion: "0.0.1", bundleSchemaVersion: 1, lastUpdated: "2025-01-01T00:00:00Z" }),
    )

    registerUpdateHook(() => { throw "string-error" })

    await expect(
      applyPendingUpdates(bundlesRoot, "0.1.0"),
    ).resolves.toBeUndefined()
  })

  it("handles unreadable bundles directory gracefully", async () => {
    // Create a file where a directory is expected -- readdirSync will throw
    const unreadableRoot = path.join(os.tmpdir(), `update-hooks-file-${Date.now()}`)
    fs.writeFileSync(unreadableRoot, "not-a-directory", "utf-8")
    createdDirs.push(unreadableRoot)

    const hook = vi.fn((_ctx: UpdateHookContext): UpdateHookResult => ({ ok: true }))
    registerUpdateHook(hook)

    await expect(
      applyPendingUpdates(unreadableRoot, "0.1.0"),
    ).resolves.toBeUndefined()

    expect(hook).not.toHaveBeenCalled()
  })
})
