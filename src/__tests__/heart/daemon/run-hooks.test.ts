import { describe, expect, it, vi } from "vitest"

import { runHooks } from "../../../heart/daemon/run-hooks"

describe("runHooks entry point", () => {
  it("returns 0 on successful hook execution", async () => {
    const applyPendingUpdates = vi.fn().mockResolvedValue(undefined)
    const registerUpdateHook = vi.fn()
    const getPackageVersion = vi.fn().mockReturnValue("0.2.0-alpha.1")

    const exitCode = await runHooks({
      bundlesRoot: "/tmp/test-bundles",
      applyPendingUpdates,
      registerUpdateHook,
      getPackageVersion,
    })

    expect(exitCode).toBe(0)
    expect(applyPendingUpdates).toHaveBeenCalledWith("/tmp/test-bundles", "0.2.0-alpha.1")
    expect(registerUpdateHook).toHaveBeenCalled()
  })

  it("returns 1 when hook execution fails", async () => {
    const applyPendingUpdates = vi.fn().mockRejectedValue(new Error("hook failed"))
    const registerUpdateHook = vi.fn()
    const getPackageVersion = vi.fn().mockReturnValue("0.2.0-alpha.1")

    const exitCode = await runHooks({
      bundlesRoot: "/tmp/test-bundles",
      applyPendingUpdates,
      registerUpdateHook,
      getPackageVersion,
    })

    expect(exitCode).toBe(1)
  })

  it("returns 1 when applyPendingUpdates throws non-Error", async () => {
    const applyPendingUpdates = vi.fn().mockRejectedValue("string-error")
    const registerUpdateHook = vi.fn()
    const getPackageVersion = vi.fn().mockReturnValue("0.2.0-alpha.1")

    const exitCode = await runHooks({
      bundlesRoot: "/tmp/test-bundles",
      applyPendingUpdates,
      registerUpdateHook,
      getPackageVersion,
    })

    expect(exitCode).toBe(1)
  })
})
