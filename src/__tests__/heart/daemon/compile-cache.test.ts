import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { enableOuroCompileCache } from "../../../heart/daemon/compile-cache"

describe("enableOuroCompileCache", () => {
  it("caches under ~/.ouro-cli, not the OS temp directory, and keeps it out of child processes", () => {
    const env: NodeJS.ProcessEnv = {}
    const enable = vi.fn((directory?: string) => ({ status: 1, directory }))
    expect(enableOuroCompileCache(env, "/home/agent", enable)).toBe(path.join("/home/agent", ".ouro-cli", "cache", "node-compile"))
    expect(enable).toHaveBeenCalledWith(path.join("/home/agent", ".ouro-cli", "cache", "node-compile"))
    expect(env.NODE_COMPILE_CACHE).toBeUndefined()
  })

  it("uses NODE_COMPILE_CACHE when it is set", () => {
    const env: NodeJS.ProcessEnv = { NODE_COMPILE_CACHE: "/persistent/cache" }
    const enable = vi.fn((directory?: string) => ({ status: 2, directory }))
    expect(enableOuroCompileCache(env, "/home/agent", enable)).toBe("/persistent/cache")
    expect(enable).toHaveBeenCalledWith("/persistent/cache")
  })

  it("stays off when disabled, unsupported, failing or refused", () => {
    const enable = vi.fn((directory?: string) => ({ status: 1, directory }))
    expect(enableOuroCompileCache({ NODE_DISABLE_COMPILE_CACHE: "1" }, "/home/agent", enable)).toBeNull()
    expect(enable).not.toHaveBeenCalled()
    expect(enableOuroCompileCache({}, "/home/agent", null)).toBeNull()
    const env: NodeJS.ProcessEnv = {}
    expect(enableOuroCompileCache(env, "/home/agent", () => { throw new Error("read-only") })).toBeNull()
    expect(enableOuroCompileCache(env, "/home/agent", () => ({ status: 3, message: "cannot create directory" }))).toBeNull()
  })

  it("is on in this process when the module loads", async () => {
    const nodeModule = await import("node:module")
    const getCacheDir = (nodeModule as { getCompileCacheDir?: () => string | undefined }).getCompileCacheDir
    if (getCacheDir && !process.env.NODE_DISABLE_COMPILE_CACHE) expect(getCacheDir()).toBeTruthy()
  })
})
