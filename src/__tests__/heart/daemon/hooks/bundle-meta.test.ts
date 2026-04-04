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

  it("bumps bundleSchemaVersion from 1 to 2 on migration", async () => {
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
    expect(updated.bundleSchemaVersion).toBe(2)
  })

  it("preserves bundleSchemaVersion when already at 2 or higher", async () => {
    const agentRoot = createTempDir("bundle-meta-hook-schema-preserve-")
    const metaPath = path.join(agentRoot, "bundle-meta.json")
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        runtimeVersion: "0.0.1",
        bundleSchemaVersion: 2,
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
    expect(updated.bundleSchemaVersion).toBe(2)
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
    expect(created.bundleSchemaVersion).toBe(2)
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
    expect(updated.bundleSchemaVersion).toBe(2)
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

  it("migrates continuity data from state/ to arc/ when schema version < 2", async () => {
    const agentRoot = createTempDir("bundle-meta-hook-migrate-arc-")
    const metaPath = path.join(agentRoot, "bundle-meta.json")
    fs.writeFileSync(metaPath, JSON.stringify({
      runtimeVersion: "0.0.1",
      bundleSchemaVersion: 1,
      lastUpdated: "2025-01-01T00:00:00Z",
    }))

    // Set up state/ directories with files
    for (const name of ["episodes", "obligations", "cares", "intentions"]) {
      const dir = path.join(agentRoot, "state", name)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `${name}-1.json`), `{"id":"${name}-1"}`)
    }

    const ctx: UpdateHookContext = { agentRoot, currentVersion: "0.1.0", previousVersion: "0.0.1" }
    const result = await bundleMetaHook(ctx)

    expect(result.ok).toBe(true)

    // Files should be in arc/
    for (const name of ["episodes", "obligations", "cares", "intentions"]) {
      const arcFile = path.join(agentRoot, "arc", name, `${name}-1.json`)
      expect(fs.existsSync(arcFile)).toBe(true)
      const content = JSON.parse(fs.readFileSync(arcFile, "utf-8"))
      expect(content.id).toBe(`${name}-1`)
    }

    // Schema version bumped to 2
    const updated = JSON.parse(fs.readFileSync(metaPath, "utf-8"))
    expect(updated.bundleSchemaVersion).toBe(2)
  })

  it("migrates psyche/memory to diary/ when schema version < 2", async () => {
    const agentRoot = createTempDir("bundle-meta-hook-migrate-diary-")
    const metaPath = path.join(agentRoot, "bundle-meta.json")
    fs.writeFileSync(metaPath, JSON.stringify({
      runtimeVersion: "0.0.1",
      bundleSchemaVersion: 1,
      lastUpdated: "2025-01-01T00:00:00Z",
    }))

    // Set up psyche/memory with files
    const memoryDir = path.join(agentRoot, "psyche", "memory")
    fs.mkdirSync(path.join(memoryDir, "daily"), { recursive: true })
    fs.mkdirSync(path.join(memoryDir, "archive"), { recursive: true })
    fs.writeFileSync(path.join(memoryDir, "facts.jsonl"), '{"id":"f1"}\n')
    fs.writeFileSync(path.join(memoryDir, "entities.json"), '[]')
    fs.writeFileSync(path.join(memoryDir, "daily", "2026-03-25.md"), "daily note")
    fs.writeFileSync(path.join(memoryDir, "archive", "old.jsonl"), '{"id":"a1"}\n')

    const ctx: UpdateHookContext = { agentRoot, currentVersion: "0.1.0", previousVersion: "0.0.1" }
    const result = await bundleMetaHook(ctx)

    expect(result.ok).toBe(true)

    // Files should be in diary/
    const diaryDir = path.join(agentRoot, "diary")
    expect(fs.existsSync(path.join(diaryDir, "facts.jsonl"))).toBe(true)
    expect(fs.existsSync(path.join(diaryDir, "entities.json"))).toBe(true)
    expect(fs.existsSync(path.join(diaryDir, "daily", "2026-03-25.md"))).toBe(true)
    expect(fs.existsSync(path.join(diaryDir, "archive", "old.jsonl"))).toBe(true)
  })

  it("migration is idempotent -- running twice is safe", async () => {
    const agentRoot = createTempDir("bundle-meta-hook-idempotent-")
    const metaPath = path.join(agentRoot, "bundle-meta.json")
    fs.writeFileSync(metaPath, JSON.stringify({
      runtimeVersion: "0.0.1",
      bundleSchemaVersion: 1,
      lastUpdated: "2025-01-01T00:00:00Z",
    }))

    // Set up one file
    fs.mkdirSync(path.join(agentRoot, "state", "episodes"), { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "state", "episodes", "ep-1.json"), '{"id":"ep-1"}')

    const ctx: UpdateHookContext = { agentRoot, currentVersion: "0.1.0", previousVersion: "0.0.1" }
    await bundleMetaHook(ctx)

    // Reset version to 1 to simulate re-run
    fs.writeFileSync(metaPath, JSON.stringify({
      runtimeVersion: "0.1.0",
      bundleSchemaVersion: 2,
      lastUpdated: new Date().toISOString(),
    }))

    // Second run should be a no-op (version already 2)
    const result2 = await bundleMetaHook(ctx)
    expect(result2.ok).toBe(true)

    // File still in arc/
    expect(fs.existsSync(path.join(agentRoot, "arc", "episodes", "ep-1.json"))).toBe(true)
  })

  it("migration skips missing source directories", async () => {
    const agentRoot = createTempDir("bundle-meta-hook-missing-src-")
    const metaPath = path.join(agentRoot, "bundle-meta.json")
    fs.writeFileSync(metaPath, JSON.stringify({
      runtimeVersion: "0.0.1",
      bundleSchemaVersion: 1,
      lastUpdated: "2025-01-01T00:00:00Z",
    }))

    // No state/ directories exist at all
    const ctx: UpdateHookContext = { agentRoot, currentVersion: "0.1.0", previousVersion: "0.0.1" }
    const result = await bundleMetaHook(ctx)

    expect(result.ok).toBe(true)
    const updated = JSON.parse(fs.readFileSync(metaPath, "utf-8"))
    expect(updated.bundleSchemaVersion).toBe(2)
  })

  it("migration skips entities that already exist at target", async () => {
    const agentRoot = createTempDir("bundle-meta-hook-skip-existing-")
    const metaPath = path.join(agentRoot, "bundle-meta.json")
    fs.writeFileSync(metaPath, JSON.stringify({
      runtimeVersion: "0.0.1",
      bundleSchemaVersion: 1,
      lastUpdated: "2025-01-01T00:00:00Z",
    }))

    // Set up source and target with same file
    fs.mkdirSync(path.join(agentRoot, "state", "episodes"), { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "state", "episodes", "ep-1.json"), '{"id":"old"}')
    fs.mkdirSync(path.join(agentRoot, "arc", "episodes"), { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "arc", "episodes", "ep-1.json"), '{"id":"existing"}')

    const ctx: UpdateHookContext = { agentRoot, currentVersion: "0.1.0", previousVersion: "0.0.1" }
    const result = await bundleMetaHook(ctx)

    expect(result.ok).toBe(true)
    // Existing target file should not be overwritten
    const content = JSON.parse(fs.readFileSync(path.join(agentRoot, "arc", "episodes", "ep-1.json"), "utf-8"))
    expect(content.id).toBe("existing")
  })

  it("migration is lossless -- all source files arrive at destination", async () => {
    const agentRoot = createTempDir("bundle-meta-hook-lossless-")
    const metaPath = path.join(agentRoot, "bundle-meta.json")
    fs.writeFileSync(metaPath, JSON.stringify({
      runtimeVersion: "0.0.1",
      bundleSchemaVersion: 1,
      lastUpdated: "2025-01-01T00:00:00Z",
    }))

    // Set up multiple files in multiple dirs
    for (const name of ["episodes", "obligations"]) {
      const dir = path.join(agentRoot, "state", name)
      fs.mkdirSync(dir, { recursive: true })
      for (let i = 0; i < 3; i++) {
        fs.writeFileSync(path.join(dir, `${name}-${i}.json`), `{"id":"${name}-${i}","data":"preserved"}`)
      }
    }

    const ctx: UpdateHookContext = { agentRoot, currentVersion: "0.1.0", previousVersion: "0.0.1" }
    await bundleMetaHook(ctx)

    for (const name of ["episodes", "obligations"]) {
      for (let i = 0; i < 3; i++) {
        const arcFile = path.join(agentRoot, "arc", name, `${name}-${i}.json`)
        expect(fs.existsSync(arcFile)).toBe(true)
        const content = JSON.parse(fs.readFileSync(arcFile, "utf-8"))
        expect(content.data).toBe("preserved")
      }
    }
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
