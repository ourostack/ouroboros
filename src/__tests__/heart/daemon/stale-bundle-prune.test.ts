import { describe, expect, it, vi, beforeEach } from "vitest"

const emitNervesEventMock = vi.hoisted(() => vi.fn())

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: emitNervesEventMock,
}))

import type { Dirent } from "fs"
import { pruneStaleEphemeralBundles, type PruneDeps } from "../../../heart/daemon/stale-bundle-prune"

function makeDirent(name: string, isDir: boolean): Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
    path: "/mock/AgentBundles",
    parentPath: "/mock/AgentBundles",
  } as Dirent
}

describe("pruneStaleEphemeralBundles", () => {
  let deps: PruneDeps

  beforeEach(() => {
    emitNervesEventMock.mockReset()
    deps = {
      bundlesRoot: "/mock/AgentBundles",
      readdirSync: vi.fn(),
      existsSync: vi.fn(),
      rmSync: vi.fn(),
    }
  })

  it("returns empty array when bundles root is empty", () => {
    vi.mocked(deps.readdirSync).mockReturnValue([])

    const result = pruneStaleEphemeralBundles(deps)

    expect(result).toEqual([])
    expect(deps.rmSync).not.toHaveBeenCalled()
  })

  it("prunes stale bundles (no agent.json) and keeps valid ones", () => {
    vi.mocked(deps.readdirSync).mockReturnValue([
      makeDirent("valid.ouro", true),
      makeDirent("stale.ouro", true),
      makeDirent("also-valid.ouro", true),
    ])
    vi.mocked(deps.existsSync).mockImplementation((target: string) => {
      if (target === "/mock/AgentBundles/valid.ouro/agent.json") return true
      if (target === "/mock/AgentBundles/stale.ouro/agent.json") return false
      if (target === "/mock/AgentBundles/also-valid.ouro/agent.json") return true
      return false
    })

    const result = pruneStaleEphemeralBundles(deps)

    expect(result).toEqual(["stale.ouro"])
    expect(deps.rmSync).toHaveBeenCalledTimes(1)
    expect(deps.rmSync).toHaveBeenCalledWith("/mock/AgentBundles/stale.ouro", { recursive: true, force: true })
    expect(emitNervesEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "info",
        component: "daemon",
        event: "daemon.stale_bundle_pruned",
        meta: expect.objectContaining({ bundle: "stale.ouro" }),
      }),
    )
  })

  it("ignores non-.ouro directories", () => {
    vi.mocked(deps.readdirSync).mockReturnValue([
      makeDirent("notes", true),
      makeDirent("data.txt", false),
      makeDirent("valid.ouro", true),
    ])
    vi.mocked(deps.existsSync).mockReturnValue(true)

    const result = pruneStaleEphemeralBundles(deps)

    expect(result).toEqual([])
    expect(deps.rmSync).not.toHaveBeenCalled()
  })

  it("continues pruning other bundles when rmSync fails on one", () => {
    vi.mocked(deps.readdirSync).mockReturnValue([
      makeDirent("fail.ouro", true),
      makeDirent("succeed.ouro", true),
    ])
    vi.mocked(deps.existsSync).mockReturnValue(false) // both are stale
    vi.mocked(deps.rmSync).mockImplementation((target: string) => {
      if (typeof target === "string" && target.includes("fail.ouro")) {
        throw new Error("EPERM: permission denied")
      }
    })

    const result = pruneStaleEphemeralBundles(deps)

    expect(result).toEqual(["succeed.ouro"])
    expect(deps.rmSync).toHaveBeenCalledTimes(2)
    expect(emitNervesEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        component: "daemon",
        event: "daemon.stale_bundle_prune_error",
        meta: expect.objectContaining({ bundle: "fail.ouro" }),
      }),
    )
    expect(emitNervesEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "info",
        event: "daemon.stale_bundle_pruned",
        meta: expect.objectContaining({ bundle: "succeed.ouro" }),
      }),
    )
  })

  it("returns empty array when all bundles are valid", () => {
    vi.mocked(deps.readdirSync).mockReturnValue([
      makeDirent("a.ouro", true),
      makeDirent("b.ouro", true),
    ])
    vi.mocked(deps.existsSync).mockReturnValue(true) // all have agent.json

    const result = pruneStaleEphemeralBundles(deps)

    expect(result).toEqual([])
    expect(deps.rmSync).not.toHaveBeenCalled()
  })

  it("returns empty array when bundles root does not exist", () => {
    vi.mocked(deps.readdirSync).mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory")
    })

    const result = pruneStaleEphemeralBundles(deps)

    expect(result).toEqual([])
    expect(deps.rmSync).not.toHaveBeenCalled()
  })
})
