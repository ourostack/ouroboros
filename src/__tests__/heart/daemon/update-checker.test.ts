import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  checkForUpdate,
  startUpdateChecker,
  stopUpdateChecker,
} from "../../../heart/daemon/update-checker"
import type { UpdateCheckerDeps } from "../../../heart/daemon/update-checker"

function makeDeps(overrides?: Partial<UpdateCheckerDeps>): UpdateCheckerDeps {
  return {
    fetchRegistryJson: vi.fn().mockResolvedValue({
      "dist-tags": { alpha: "0.2.0-alpha.1", latest: "0.1.0" },
    }),
    distTag: "alpha",
    ...overrides,
  }
}

describe("checkForUpdate", () => {
  it("detects when a newer version is available", async () => {
    const deps = makeDeps()

    const result = await checkForUpdate("0.1.0-alpha.5", deps)

    expect(result.available).toBe(true)
    expect(result.latestVersion).toBe("0.2.0-alpha.1")
  })

  it("reports no update when current version matches registry", async () => {
    const deps = makeDeps({
      fetchRegistryJson: vi.fn().mockResolvedValue({
        "dist-tags": { alpha: "0.1.0-alpha.5" },
      }),
    })

    const result = await checkForUpdate("0.1.0-alpha.5", deps)

    expect(result.available).toBe(false)
    expect(result.latestVersion).toBe("0.1.0-alpha.5")
  })

  it("reports no update when current version is newer than registry", async () => {
    const deps = makeDeps({
      fetchRegistryJson: vi.fn().mockResolvedValue({
        "dist-tags": { alpha: "0.1.0-alpha.3" },
      }),
    })

    const result = await checkForUpdate("0.1.0-alpha.5", deps)

    expect(result.available).toBe(false)
    expect(result.latestVersion).toBe("0.1.0-alpha.3")
  })

  it("reads the configured dist-tag (alpha by default)", async () => {
    const deps = makeDeps({
      fetchRegistryJson: vi.fn().mockResolvedValue({
        "dist-tags": { alpha: "0.2.0-alpha.1", latest: "0.1.0" },
      }),
      distTag: "alpha",
    })

    const result = await checkForUpdate("0.1.0-alpha.5", deps)

    expect(result.latestVersion).toBe("0.2.0-alpha.1")
  })

  it("supports configurable dist-tag for future stable releases", async () => {
    const deps = makeDeps({
      fetchRegistryJson: vi.fn().mockResolvedValue({
        "dist-tags": { alpha: "0.2.0-alpha.1", latest: "1.0.0" },
      }),
      distTag: "latest",
    })

    const result = await checkForUpdate("0.1.0", deps)

    expect(result.available).toBe(true)
    expect(result.latestVersion).toBe("1.0.0")
  })

  it("handles fetch errors gracefully", async () => {
    const deps = makeDeps({
      fetchRegistryJson: vi.fn().mockRejectedValue(new Error("network error")),
    })

    const result = await checkForUpdate("0.1.0-alpha.5", deps)

    expect(result.available).toBe(false)
    expect(result.error).toBeDefined()
  })

  it("handles malformed registry response (missing dist-tags)", async () => {
    const deps = makeDeps({
      fetchRegistryJson: vi.fn().mockResolvedValue({}),
    })

    const result = await checkForUpdate("0.1.0-alpha.5", deps)

    expect(result.available).toBe(false)
    expect(result.error).toBeDefined()
  })

  it("handles dist-tag not present in response", async () => {
    const deps = makeDeps({
      fetchRegistryJson: vi.fn().mockResolvedValue({
        "dist-tags": { latest: "1.0.0" },
      }),
      distTag: "alpha",
    })

    const result = await checkForUpdate("0.1.0-alpha.5", deps)

    expect(result.available).toBe(false)
    expect(result.error).toBeDefined()
  })

  it("handles non-Error thrown from fetch", async () => {
    const deps = makeDeps({
      fetchRegistryJson: vi.fn().mockRejectedValue("string-error"),
    })

    const result = await checkForUpdate("0.1.0-alpha.5", deps)

    expect(result.available).toBe(false)
    expect(result.error).toBeDefined()
  })
})

describe("startUpdateChecker / stopUpdateChecker", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    stopUpdateChecker()
    vi.useRealTimers()
  })

  it("sets up a periodic timer that calls onUpdate when update available", async () => {
    const fetchRegistryJson = vi.fn().mockResolvedValue({
      "dist-tags": { alpha: "0.2.0-alpha.1" },
    })

    const onUpdate = vi.fn()

    startUpdateChecker({
      currentVersion: "0.1.0-alpha.5",
      intervalMs: 1000,
      onUpdate,
      deps: { fetchRegistryJson, distTag: "alpha" },
    })

    await vi.advanceTimersByTimeAsync(1000)

    expect(fetchRegistryJson).toHaveBeenCalled()
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ available: true, latestVersion: "0.2.0-alpha.1" }),
    )
  })

  it("does not call onUpdate when no update is available", async () => {
    const fetchRegistryJson = vi.fn().mockResolvedValue({
      "dist-tags": { alpha: "0.1.0-alpha.5" },
    })

    const onUpdate = vi.fn()

    startUpdateChecker({
      currentVersion: "0.1.0-alpha.5",
      intervalMs: 1000,
      onUpdate,
      deps: { fetchRegistryJson, distTag: "alpha" },
    })

    await vi.advanceTimersByTimeAsync(1000)

    expect(fetchRegistryJson).toHaveBeenCalled()
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it("stopUpdateChecker clears the timer", async () => {
    const fetchRegistryJson = vi.fn().mockResolvedValue({
      "dist-tags": { alpha: "0.2.0-alpha.1" },
    })

    const onUpdate = vi.fn()

    startUpdateChecker({
      currentVersion: "0.1.0-alpha.5",
      intervalMs: 1000,
      onUpdate,
      deps: { fetchRegistryJson, distTag: "alpha" },
    })

    stopUpdateChecker()

    await vi.advanceTimersByTimeAsync(2000)

    expect(onUpdate).not.toHaveBeenCalled()
  })

  it("handles fetch failure during periodic check without crashing", async () => {
    const fetchRegistryJson = vi.fn().mockRejectedValue(new Error("network error"))
    const onUpdate = vi.fn()

    startUpdateChecker({
      currentVersion: "0.1.0-alpha.5",
      intervalMs: 1000,
      onUpdate,
      deps: { fetchRegistryJson, distTag: "alpha" },
    })

    await vi.advanceTimersByTimeAsync(1000)

    expect(fetchRegistryJson).toHaveBeenCalled()
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it("uses default interval of 30 minutes when not specified", async () => {
    const fetchRegistryJson = vi.fn().mockResolvedValue({
      "dist-tags": { alpha: "0.2.0-alpha.1" },
    })
    const onUpdate = vi.fn()

    startUpdateChecker({
      currentVersion: "0.1.0-alpha.5",
      onUpdate,
      deps: { fetchRegistryJson, distTag: "alpha" },
    })

    // Advance less than 30 minutes -- should not fire
    await vi.advanceTimersByTimeAsync(29 * 60 * 1000)
    expect(fetchRegistryJson).not.toHaveBeenCalled()

    // Advance to 30 minutes -- should fire
    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(fetchRegistryJson).toHaveBeenCalled()
  })
})
