import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"

import { bundleMetaHook } from "../../../../heart/daemon/hooks/bundle-meta"
import type { UpdateHookContext } from "../../../../heart/daemon/update-hooks"

const createdDirs: string[] = []

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  createdDirs.push(dir)
  return dir
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("bundleMetaHook", () => {
  it("updates runtimeVersion to currentVersion", async () => {
    const agentRoot = createTempDir("bundle-meta-hook-update-")
    const metaPath = path.join(agentRoot, "bundle-meta.json")
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        runtimeVersion: "0.0.1",
        bundleSchemaVersion: 1,
        lastUpdated: "2025-01-01T00:00:00Z",
      }),
    )

    const ctx: UpdateHookContext = {
      agentRoot,
      currentVersion: "0.1.0",
      previousVersion: "0.0.1",
    }

    const result = await bundleMetaHook(ctx)

    expect(result.ok).toBe(true)
    const updated = JSON.parse(fs.readFileSync(metaPath, "utf-8"))
    expect(updated.runtimeVersion).toBe("0.1.0")
  })

  it("saves old runtimeVersion as previousRuntimeVersion", async () => {
    const agentRoot = createTempDir("bundle-meta-hook-prev-")
    const metaPath = path.join(agentRoot, "bundle-meta.json")
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        runtimeVersion: "0.0.1",
        bundleSchemaVersion: 1,
        lastUpdated: "2025-01-01T00:00:00Z",
      }),
    )

    const ctx: UpdateHookContext = {
      agentRoot,
      currentVersion: "0.1.0",
      previousVersion: "0.0.1",
    }

    await bundleMetaHook(ctx)

    const updated = JSON.parse(fs.readFileSync(metaPath, "utf-8"))
    expect(updated.previousRuntimeVersion).toBe("0.0.1")
  })

  it("updates lastUpdated timestamp", async () => {
    const agentRoot = createTempDir("bundle-meta-hook-time-")
    const metaPath = path.join(agentRoot, "bundle-meta.json")
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        runtimeVersion: "0.0.1",
        bundleSchemaVersion: 1,
        lastUpdated: "2025-01-01T00:00:00Z",
      }),
    )

    const ctx: UpdateHookContext = {
      agentRoot,
      currentVersion: "0.1.0",
      previousVersion: "0.0.1",
    }

    await bundleMetaHook(ctx)

    const updated = JSON.parse(fs.readFileSync(metaPath, "utf-8"))
    expect(updated.lastUpdated).not.toBe("2025-01-01T00:00:00Z")
    // Should be a valid ISO date string
    expect(new Date(updated.lastUpdated).toISOString()).toBe(updated.lastUpdated)
  })

  it("preserves bundleSchemaVersion", async () => {
    const agentRoot = createTempDir("bundle-meta-hook-schema-")
    const metaPath = path.join(agentRoot, "bundle-meta.json")
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        runtimeVersion: "0.0.1",
        bundleSchemaVersion: 1,
        lastUpdated: "2025-01-01T00:00:00Z",
      }),
    )

    const ctx: UpdateHookContext = {
      agentRoot,
      currentVersion: "0.1.0",
      previousVersion: "0.0.1",
    }

    await bundleMetaHook(ctx)

    const updated = JSON.parse(fs.readFileSync(metaPath, "utf-8"))
    expect(updated.bundleSchemaVersion).toBe(1)
  })

  it("handles first-boot case (no bundle-meta.json) -- creates fresh meta with no previousRuntimeVersion", async () => {
    const agentRoot = createTempDir("bundle-meta-hook-first-boot-")
    // No bundle-meta.json exists

    const ctx: UpdateHookContext = {
      agentRoot,
      currentVersion: "0.1.0",
      previousVersion: undefined,
    }

    const result = await bundleMetaHook(ctx)

    expect(result.ok).toBe(true)
    const metaPath = path.join(agentRoot, "bundle-meta.json")
    const created = JSON.parse(fs.readFileSync(metaPath, "utf-8"))
    expect(created.runtimeVersion).toBe("0.1.0")
    expect(created.previousRuntimeVersion).toBeUndefined()
    expect(created.bundleSchemaVersion).toBe(1)
  })

  it("handles malformed existing bundle-meta.json (overwrites with fresh)", async () => {
    const agentRoot = createTempDir("bundle-meta-hook-malformed-")
    const metaPath = path.join(agentRoot, "bundle-meta.json")
    fs.writeFileSync(metaPath, "not-valid-json{{{")

    const ctx: UpdateHookContext = {
      agentRoot,
      currentVersion: "0.1.0",
      previousVersion: undefined,
    }

    const result = await bundleMetaHook(ctx)

    expect(result.ok).toBe(true)
    const updated = JSON.parse(fs.readFileSync(metaPath, "utf-8"))
    expect(updated.runtimeVersion).toBe("0.1.0")
    expect(updated.bundleSchemaVersion).toBe(1)
  })

  it("returns error result on write failure (does not throw)", async () => {
    // Use a path that cannot be written to
    const ctx: UpdateHookContext = {
      agentRoot: "/nonexistent/path/that/does/not/exist",
      currentVersion: "0.1.0",
      previousVersion: undefined,
    }

    const result = await bundleMetaHook(ctx)

    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
    expect(typeof result.error).toBe("string")
  })

  it("preserves existing previousRuntimeVersion chain (overwrites with current old version)", async () => {
    const agentRoot = createTempDir("bundle-meta-hook-chain-")
    const metaPath = path.join(agentRoot, "bundle-meta.json")
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        runtimeVersion: "0.0.5",
        bundleSchemaVersion: 1,
        lastUpdated: "2025-01-01T00:00:00Z",
        previousRuntimeVersion: "0.0.1",
      }),
    )

    const ctx: UpdateHookContext = {
      agentRoot,
      currentVersion: "0.1.0",
      previousVersion: "0.0.5",
    }

    await bundleMetaHook(ctx)

    const updated = JSON.parse(fs.readFileSync(metaPath, "utf-8"))
    // previousRuntimeVersion should now be 0.0.5 (was 0.0.1)
    expect(updated.previousRuntimeVersion).toBe("0.0.5")
    expect(updated.runtimeVersion).toBe("0.1.0")
  })
})
