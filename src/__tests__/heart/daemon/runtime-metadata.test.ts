import { describe, expect, it, vi } from "vitest"

import { getRuntimeMetadata } from "../../../heart/daemon/runtime-metadata"

describe("runtime metadata", () => {
  it("reads version and last-updated from package.json and git", () => {
    const metadata = getRuntimeMetadata({
      repoRoot: "/mock/repo",
      readFileSync: vi.fn(() => JSON.stringify({ version: "1.2.3" })) as unknown as typeof import("fs").readFileSync,
      statSync: vi.fn(() => ({ mtime: new Date("2026-03-08T23:00:00.000Z") })) as unknown as typeof import("fs").statSync,
      execFileSync: vi.fn(() => "2026-03-08T22:11:00.000Z\n") as unknown as typeof import("child_process").execFileSync,
    })

    expect(metadata).toEqual({
      version: "1.2.3",
      lastUpdated: "2026-03-08T22:11:00.000Z",
    })
  })

  it("falls back to package.json mtime when git metadata is unavailable", () => {
    const metadata = getRuntimeMetadata({
      repoRoot: "/mock/repo",
      readFileSync: vi.fn(() => JSON.stringify({ version: "1.2.3" })) as unknown as typeof import("fs").readFileSync,
      statSync: vi.fn(() => ({ mtime: new Date("2026-03-08T23:00:00.000Z") })) as unknown as typeof import("fs").statSync,
      execFileSync: vi.fn(() => {
        throw new Error("git unavailable")
      }) as unknown as typeof import("child_process").execFileSync,
    })

    expect(metadata).toEqual({
      version: "1.2.3",
      lastUpdated: "2026-03-08T23:00:00.000Z",
    })
  })

  it("returns unknown values when neither package metadata nor timestamps are readable", () => {
    const metadata = getRuntimeMetadata({
      repoRoot: "/mock/repo",
      readFileSync: vi.fn(() => {
        throw new Error("missing package.json")
      }) as unknown as typeof import("fs").readFileSync,
      statSync: vi.fn(() => {
        throw new Error("missing stats")
      }) as unknown as typeof import("fs").statSync,
      execFileSync: vi.fn(() => {
        throw new Error("missing git")
      }) as unknown as typeof import("child_process").execFileSync,
    })

    expect(metadata).toEqual({
      version: "unknown",
      lastUpdated: "unknown",
    })
  })

  it("returns unknown when package.json has a non-string version", () => {
    const metadata = getRuntimeMetadata({
      repoRoot: "/mock/repo",
      readFileSync: vi.fn(() => JSON.stringify({ version: 123 })) as unknown as typeof import("fs").readFileSync,
      statSync: vi.fn(() => ({ mtime: new Date("2026-03-08T23:00:00.000Z") })) as unknown as typeof import("fs").statSync,
      execFileSync: vi.fn(() => "2026-03-08T22:11:00.000Z\n") as unknown as typeof import("child_process").execFileSync,
    })

    expect(metadata.version).toBe("unknown")
  })

  it("returns unknown when package.json version is blank after trimming", () => {
    const metadata = getRuntimeMetadata({
      repoRoot: "/mock/repo",
      readFileSync: vi.fn(() => JSON.stringify({ version: "   " })) as unknown as typeof import("fs").readFileSync,
      statSync: vi.fn(() => ({ mtime: new Date("2026-03-08T23:00:00.000Z") })) as unknown as typeof import("fs").statSync,
      execFileSync: vi.fn(() => "2026-03-08T22:11:00.000Z\n") as unknown as typeof import("child_process").execFileSync,
    })

    expect(metadata.version).toBe("unknown")
  })

  it("falls back cleanly when runtime modules do not expose file or git helpers", async () => {
    vi.resetModules()
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("fs", () => ({
      statSync: vi.fn(() => ({ mtime: new Date("2026-03-08T23:15:00.000Z") })),
    }))
    vi.doMock("child_process", () => ({}))

    const { getRuntimeMetadata: getWithMocks } = await import("../../../heart/daemon/runtime-metadata")
    const metadata = getWithMocks()

    expect(metadata).toEqual({
      version: "unknown",
      lastUpdated: "2026-03-08T23:15:00.000Z",
    })
  })

  it("treats non-function module exports as unavailable helpers", async () => {
    vi.resetModules()
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("fs", () => ({
      readFileSync: "not-a-function",
      statSync: vi.fn(() => ({ mtime: new Date("2026-03-08T23:20:00.000Z") })),
    }))
    vi.doMock("child_process", () => ({
      execFileSync: "not-a-function",
    }))

    const { getRuntimeMetadata: getWithMocks } = await import("../../../heart/daemon/runtime-metadata")
    const metadata = getWithMocks()

    expect(metadata).toEqual({
      version: "unknown",
      lastUpdated: "2026-03-08T23:20:00.000Z",
    })
  })
})
