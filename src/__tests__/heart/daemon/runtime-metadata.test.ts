import { describe, expect, it, vi } from "vitest"

import { getRuntimeMetadata } from "../../../heart/daemon/runtime-metadata"

function mockDirent(name: string, isDirectory: boolean): import("fs").Dirent {
  return {
    name,
    isDirectory: () => isDirectory,
  } as unknown as import("fs").Dirent
}

describe("runtime metadata", () => {
  it("reads version and last-updated from package.json and git", () => {
    const metadata = getRuntimeMetadata({
      repoRoot: "/mock/repo",
      readFileSync: vi.fn(() => JSON.stringify({ version: "1.2.3" })) as unknown as typeof import("fs").readFileSync,
      statSync: vi.fn(() => ({ mtime: new Date("2026-03-08T23:00:00.000Z") })) as unknown as typeof import("fs").statSync,
      execFileSync: vi.fn(() => "2026-03-08T22:11:00.000Z\n") as unknown as typeof import("child_process").execFileSync,
    })

    expect(metadata).toEqual(expect.objectContaining({
      version: "1.2.3",
      lastUpdated: "2026-03-08T22:11:00.000Z",
      repoRoot: "/mock/repo",
    }))
    expect(metadata.configFingerprint).toMatch(/^[a-f0-9]{64}$/)
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

    expect(metadata).toEqual(expect.objectContaining({
      version: "1.2.3",
      lastUpdated: "2026-03-08T23:00:00.000Z",
      repoRoot: "/mock/repo",
    }))
    expect(metadata.configFingerprint).toMatch(/^[a-f0-9]{64}$/)
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

    expect(metadata).toEqual(expect.objectContaining({
      version: "unknown",
      lastUpdated: "unknown",
      repoRoot: "/mock/repo",
    }))
    expect(metadata.configFingerprint).toMatch(/^[a-f0-9]{64}$/)
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

  it("skips daemon logging config targets when no daemon logging path is provided", () => {
    const readFileSync = vi.fn((target: string) => {
      if (target === "/mock/repo/package.json") {
        return JSON.stringify({ version: "1.2.3" })
      }
      throw new Error(`missing ${target}`)
    })

    const metadata = getRuntimeMetadata({
      repoRoot: "/mock/repo",
      bundlesRoot: "/mock/bundles",
      daemonLoggingPath: "",
      readFileSync: readFileSync as any,
      statSync: vi.fn(() => ({ mtime: new Date("2026-03-08T23:00:00.000Z") })) as any,
      readdirSync: vi.fn(() => []) as any,
      existsSync: vi.fn(() => false) as any,
      execFileSync: vi.fn(() => "2026-03-08T22:11:00.000Z\n") as any,
    })

    expect(metadata.version).toBe("1.2.3")
    expect(metadata.configFingerprint).not.toBe("unknown")
    expect(readFileSync).not.toHaveBeenCalledWith("/mock/logging.json", "utf-8")
  })

  it("includes daemon logging config in the tracked fingerprint targets", () => {
    const readFileSync = vi.fn((target: string) => {
      if (target === "/mock/repo/package.json") {
        return JSON.stringify({ version: "1.2.3" })
      }
      if (target === "/mock/logging.json") {
        return JSON.stringify({ level: "info", sinks: ["ndjson"] })
      }
      throw new Error(`missing ${target}`)
    })

    const metadata = getRuntimeMetadata({
      repoRoot: "/mock/repo",
      bundlesRoot: "/mock/bundles",
      daemonLoggingPath: "/mock/logging.json",
      readFileSync: readFileSync as any,
      statSync: vi.fn(() => ({ mtime: new Date("2026-03-08T23:00:00.000Z") })) as any,
      readdirSync: vi.fn(() => []) as any,
      existsSync: vi.fn((target: string) => target === "/mock/logging.json") as any,
      execFileSync: vi.fn(() => "2026-03-08T22:11:00.000Z\n") as any,
    })

    expect(metadata.version).toBe("1.2.3")
    expect(metadata.lastUpdated).toBe("2026-03-08T22:11:00.000Z")
    expect(metadata.configFingerprint).not.toBe("unknown")
    expect(readFileSync).toHaveBeenCalledWith("/mock/logging.json", "utf-8")
  })

  it("changes config fingerprint when tracked config content changes", () => {
    const files = new Map<string, string>([
      ["/mock/repo/package.json", JSON.stringify({ version: "1.2.3" })],
      ["/mock/bundles/slugger.ouro/agent.json", JSON.stringify({ provider: "anthropic" })],
      ["/mock/logging.json", JSON.stringify({ daemon: "info" })],
    ])

    const readFileSync = vi.fn((target: string) => {
      const value = files.get(target)
      if (!value) throw new Error(`missing ${target}`)
      return value
    }) as unknown as typeof import("fs").readFileSync
    const readdirSync = vi.fn((target: string) => {
      if (target === "/mock/bundles") {
        return [
          mockDirent("slugger.ouro", true),
          mockDirent("notes", true),
          mockDirent("README.md", false),
        ]
      }
      return []
    }) as unknown as typeof import("fs").readdirSync
    const existsSync = vi.fn((target: string) => files.has(target)) as unknown as typeof import("fs").existsSync

    const deps = {
      repoRoot: "/mock/repo",
      bundlesRoot: "/mock/bundles",
      daemonLoggingPath: "/mock/logging.json",
      readFileSync,
      readdirSync,
      existsSync,
      statSync: vi.fn(() => ({ mtime: new Date("2026-03-08T23:00:00.000Z") })) as unknown as typeof import("fs").statSync,
      execFileSync: vi.fn(() => "2026-03-08T22:11:00.000Z\n") as unknown as typeof import("child_process").execFileSync,
    }

    const first = getRuntimeMetadata(deps)
    files.set("/mock/bundles/slugger.ouro/agent.json", JSON.stringify({ provider: "minimax" }))
    const second = getRuntimeMetadata(deps)

    expect(first).toEqual(expect.objectContaining({
      version: "1.2.3",
      lastUpdated: "2026-03-08T22:11:00.000Z",
      repoRoot: "/mock/repo",
    }))
    expect(first.configFingerprint).not.toBe(second.configFingerprint)
  })

  it("hashes missing and unreadable tracked config files without crashing", () => {
    const files = new Map<string, string>([
      ["/mock/repo/package.json", JSON.stringify({ version: "1.2.3" })],
    ])

    const readFileSync = vi.fn((target: string) => {
      if (target === "/mock/bundles/slugger.ouro/agent.json") {
        throw new Error("permission denied")
      }
      const value = files.get(target)
      if (!value) throw new Error(`missing ${target}`)
      return value
    }) as unknown as typeof import("fs").readFileSync
    const readdirSync = vi.fn((target: string) => {
      if (target === "/mock/bundles") return [mockDirent("slugger.ouro", true)]
      throw new Error(`unexpected readdir ${target}`)
    }) as unknown as typeof import("fs").readdirSync
    const existsSync = vi.fn((target: string) =>
      target === "/mock/logging.json"
        ? false
        : target === "/mock/bundles/slugger.ouro/agent.json"
          ? true
          : files.has(target),
    ) as unknown as typeof import("fs").existsSync

    const metadata = getRuntimeMetadata({
      repoRoot: "/mock/repo",
      bundlesRoot: "/mock/bundles",
      daemonLoggingPath: "/mock/logging.json",
      readFileSync,
      readdirSync,
      existsSync,
      statSync: vi.fn(() => ({ mtime: new Date("2026-03-08T23:00:00.000Z") })) as unknown as typeof import("fs").statSync,
      execFileSync: vi.fn(() => "2026-03-08T22:11:00.000Z\n") as unknown as typeof import("child_process").execFileSync,
    })

    expect(metadata).toEqual(expect.objectContaining({
      version: "1.2.3",
      lastUpdated: "2026-03-08T22:11:00.000Z",
      repoRoot: "/mock/repo",
    }))
    expect(metadata.configFingerprint).toMatch(/^[a-f0-9]{64}$/)
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
      getAgentBundlesRoot: () => "/mock/bundles",
      getAgentDaemonLoggingConfigPath: () => "/mock/bundles/slugger.ouro/state/daemon/logging.json",
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
      repoRoot: "/mock/repo",
      configFingerprint: "unknown",
    })
  })

  it("returns unknown lastUpdated when stat helpers are unavailable", async () => {
    vi.resetModules()
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/bundles",
      getAgentDaemonLoggingConfigPath: () => "/mock/bundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("fs", () => ({
      readFileSync: vi.fn(() => JSON.stringify({ version: "1.2.3" })),
      readdirSync: vi.fn(() => []),
      existsSync: vi.fn(() => false),
    }))
    vi.doMock("child_process", () => ({}))

    const { getRuntimeMetadata: getWithMocks } = await import("../../../heart/daemon/runtime-metadata")
    const metadata = getWithMocks()

    expect(metadata).toEqual({
      version: "1.2.3",
      lastUpdated: "unknown",
      repoRoot: "/mock/repo",
      configFingerprint: expect.any(String),
    })
  })

  it("treats non-function module exports as unavailable helpers", async () => {
    vi.resetModules()
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/bundles",
      getAgentDaemonLoggingConfigPath: () => "/mock/bundles/slugger.ouro/state/daemon/logging.json",
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
      repoRoot: "/mock/repo",
      configFingerprint: "unknown",
    })
  })

  it("skips home-relative config targets when homedir is unavailable", async () => {
    vi.resetModules()
    const readFileSync = vi.fn((target: string) => {
      if (target === "/mock/repo/package.json") {
        return JSON.stringify({ version: "1.2.3" })
      }
      if (target === "/mock/bundles/slugger.ouro/agent.json") {
        return JSON.stringify({ provider: "anthropic" })
      }
      throw new Error(`missing ${target}`)
    })
    const readdirSync = vi.fn((target: string) => {
      if (target === "/mock/bundles") {
        return [mockDirent("slugger.ouro", true)]
      }
      return []
    })
    const existsSync = vi.fn((target: string) => target === "/mock/bundles/slugger.ouro/agent.json")

    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os")
      return {
        ...actual,
        homedir: () => {
          throw new Error("home unavailable")
        },
      }
    })
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/bundles",
      getAgentDaemonLoggingConfigPath: () => "/mock/bundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("fs", () => ({
      readFileSync,
      readdirSync,
      existsSync,
      statSync: vi.fn(() => ({ mtime: new Date("2026-03-08T23:20:00.000Z") })),
    }))
    vi.doMock("child_process", () => ({
      execFileSync: vi.fn(() => "2026-03-08T22:11:00.000Z\n"),
    }))

    const { getRuntimeMetadata: getWithMocks } = await import("../../../heart/daemon/runtime-metadata")
    const metadata = getWithMocks()

    expect(metadata).toEqual({
      version: "1.2.3",
      lastUpdated: "2026-03-08T22:11:00.000Z",
      repoRoot: "/mock/repo",
      configFingerprint: expect.any(String),
    })
    expect(readdirSync).toHaveBeenCalledTimes(1)
    expect(readdirSync).toHaveBeenCalledWith("/mock/bundles", { withFileTypes: true })
  })

  it("skips home-relative config targets when os.homedir is not exported", async () => {
    vi.resetModules()
    const readFileSync = vi.fn((target: string) => {
      if (target === "/mock/repo/package.json") {
        return JSON.stringify({ version: "1.2.3" })
      }
      if (target === "/mock/bundles/slugger.ouro/agent.json") {
        return JSON.stringify({ provider: "anthropic" })
      }
      throw new Error(`missing ${target}`)
    })
    const readdirSync = vi.fn((target: string) => {
      if (target === "/mock/bundles") {
        return [mockDirent("slugger.ouro", true)]
      }
      return []
    })
    const existsSync = vi.fn((target: string) => target === "/mock/bundles/slugger.ouro/agent.json")

    vi.doMock("os", async () => {
      const actual = await vi.importActual<typeof import("os")>("os")
      return Object.fromEntries(
        Object.entries(actual).filter(([key]) => key !== "homedir"),
      )
    })
    vi.doMock("../../../heart/identity", () => ({
      getRepoRoot: () => "/mock/repo",
      getAgentBundlesRoot: () => "/mock/bundles",
      getAgentDaemonLoggingConfigPath: () => "/mock/bundles/slugger.ouro/state/daemon/logging.json",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
    vi.doMock("fs", () => ({
      readFileSync,
      readdirSync,
      existsSync,
      statSync: vi.fn(() => ({ mtime: new Date("2026-03-08T23:20:00.000Z") })),
    }))
    vi.doMock("child_process", () => ({
      execFileSync: vi.fn(() => "2026-03-08T22:11:00.000Z\n"),
    }))

    const { getRuntimeMetadata: getWithMocks } = await import("../../../heart/daemon/runtime-metadata")
    const metadata = getWithMocks()

    expect(metadata).toEqual({
      version: "1.2.3",
      lastUpdated: "2026-03-08T22:11:00.000Z",
      repoRoot: "/mock/repo",
      configFingerprint: expect.any(String),
    })
    expect(readdirSync).toHaveBeenCalledWith("/mock/bundles", { withFileTypes: true })
  })
})
