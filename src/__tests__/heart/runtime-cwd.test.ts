import { describe, expect, it } from "vitest"

describe("recoverRuntimeCwd", () => {
  it("returns the current cwd when it is still valid", async () => {
    const { recoverRuntimeCwd } = await import("../../heart/runtime-cwd")

    expect(recoverRuntimeCwd()).toBe(process.cwd())
  })

  it("repairs a deleted process cwd to the provided fallback", async () => {
    const fallback = "/repo/root"
    const { recoverRuntimeCwd } = await import("../../heart/runtime-cwd")
    let currentInvalid = true
    let current = "/deleted/worktree"

    expect(recoverRuntimeCwd(fallback, {
      cwd: () => {
        if (currentInvalid) throw new Error("ENOENT: no such file or directory, uv_cwd")
        return current
      },
      chdir: (target) => {
        current = target
        currentInvalid = false
      },
      existsSync: () => true,
    })).toBe(fallback)
    expect(current).toBe(fallback)
  })

  it("returns the fallback with error telemetry when the fallback does not exist", async () => {
    const fallback = "/missing/repo/root"
    const { recoverRuntimeCwd } = await import("../../heart/runtime-cwd")

    expect(recoverRuntimeCwd(fallback, {
      cwd: () => {
        throw "ENOENT: no such file or directory, uv_cwd"
      },
      chdir: () => {
        throw new Error("should not chdir")
      },
      existsSync: () => false,
    })).toBe(fallback)
  })

  it("returns the fallback when cwd repair throws an Error", async () => {
    const fallback = "/repo/root"
    const { recoverRuntimeCwd } = await import("../../heart/runtime-cwd")

    expect(recoverRuntimeCwd(fallback, {
      cwd: () => {
        throw new Error("ENOENT: no such file or directory, uv_cwd")
      },
      chdir: () => {
        throw new Error("permission denied")
      },
      existsSync: () => true,
    })).toBe(fallback)
  })

  it("returns the fallback when cwd repair throws a non-Error", async () => {
    const fallback = "/repo/root"
    const { recoverRuntimeCwd } = await import("../../heart/runtime-cwd")

    expect(recoverRuntimeCwd(fallback, {
      cwd: () => {
        throw new Error("ENOENT: no such file or directory, uv_cwd")
      },
      chdir: () => {
        throw "permission denied"
      },
      existsSync: () => true,
    })).toBe(fallback)
  })
})
