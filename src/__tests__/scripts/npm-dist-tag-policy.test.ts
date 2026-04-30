import * as path from "path"

import { describe, expect, it, vi } from "vitest"

const {
  planLatestDistTagRepair,
  repairLatestDistTagIfNeeded,
  resolvePublishTag,
} = require(path.resolve(__dirname, "../../../scripts/npm-dist-tag-policy.cjs"))

describe("npm dist-tag policy", () => {
  it("publishes prereleases on their prerelease channel", () => {
    expect(resolvePublishTag("0.1.0-alpha.537")).toBe("alpha")
  })

  it("publishes stable releases on latest", () => {
    expect(resolvePublishTag("1.0.0")).toBe("latest")
  })

  it("repairs latest when latest is already a stale prerelease", () => {
    expect(planLatestDistTagRepair({
      publishTag: "alpha",
      localVersion: "0.1.0-alpha.537",
      latestVersion: "0.1.0-alpha.531",
    })).toEqual({
      action: "repair",
      reason: "latest dist-tag points at stale prerelease 0.1.0-alpha.531",
    })
  })

  it("repairs latest when the latest tag is missing", () => {
    expect(planLatestDistTagRepair({
      publishTag: "alpha",
      localVersion: "0.1.0-alpha.537",
      latestVersion: "",
    })).toEqual({
      action: "repair",
      reason: "latest dist-tag is missing",
    })
  })

  it("leaves stable latest alone during prerelease publishes", () => {
    expect(planLatestDistTagRepair({
      publishTag: "alpha",
      localVersion: "1.1.0-alpha.1",
      latestVersion: "1.0.0",
    })).toEqual({
      action: "skip",
      reason: "latest dist-tag points at stable 1.0.0",
    })
  })

  it("leaves latest to stable publish flows when publishing latest", () => {
    expect(planLatestDistTagRepair({
      publishTag: "latest",
      localVersion: "1.0.0",
      latestVersion: "0.1.0-alpha.537",
    })).toEqual({
      action: "skip",
      reason: "stable publish owns latest",
    })
  })

  it("runs npm dist-tag add only when repair is needed", () => {
    const execFileSyncImpl = vi.fn(() => "")

    const result = repairLatestDistTagIfNeeded("@ouro.bot/cli", "0.1.0-alpha.537", "alpha", {
      execFileSyncImpl,
      latestVersion: "0.1.0-alpha.531",
    })

    expect(result).toEqual({
      action: "repair",
      latestVersion: "0.1.0-alpha.531",
      reason: "latest dist-tag points at stale prerelease 0.1.0-alpha.531",
      repairedTo: "0.1.0-alpha.537",
    })
    expect(execFileSyncImpl).toHaveBeenCalledWith(
      "npm",
      ["dist-tag", "add", "@ouro.bot/cli@0.1.0-alpha.537", "latest"],
      { stdio: "inherit" },
    )
  })

  it("does not call npm when stable latest should remain stable", () => {
    const execFileSyncImpl = vi.fn(() => "")

    const result = repairLatestDistTagIfNeeded("@ouro.bot/cli", "1.1.0-alpha.1", "alpha", {
      execFileSyncImpl,
      latestVersion: "1.0.0",
    })

    expect(result).toEqual({
      action: "skip",
      latestVersion: "1.0.0",
      reason: "latest dist-tag points at stable 1.0.0",
    })
    expect(execFileSyncImpl).not.toHaveBeenCalled()
  })

  it("fails closed when npm dist-tag lookup fails", () => {
    const execFileSyncImpl = vi.fn(() => {
      throw new Error("registry timeout")
    })

    expect(() => repairLatestDistTagIfNeeded("@ouro.bot/cli", "0.1.0-alpha.537", "alpha", {
      execFileSyncImpl,
    })).toThrow("@ouro.bot/cli: could not read npm dist-tags: registry timeout")

    expect(execFileSyncImpl).toHaveBeenCalledOnce()
    expect(execFileSyncImpl).toHaveBeenCalledWith(
      "npm",
      ["view", "@ouro.bot/cli", "dist-tags", "--json"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
  })

  it("distinguishes a genuinely missing latest key from lookup failure", () => {
    const execFileSyncImpl = vi.fn((command: string, args: string[]) => {
      if (command === "npm" && args[0] === "view") return JSON.stringify({ alpha: "0.1.0-alpha.537" })
      return ""
    })

    const result = repairLatestDistTagIfNeeded("@ouro.bot/cli", "0.1.0-alpha.537", "alpha", {
      execFileSyncImpl,
    })

    expect(result).toEqual({
      action: "repair",
      latestVersion: "",
      reason: "latest dist-tag is missing",
      repairedTo: "0.1.0-alpha.537",
    })
    expect(execFileSyncImpl).toHaveBeenNthCalledWith(
      1,
      "npm",
      ["view", "@ouro.bot/cli", "dist-tags", "--json"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    expect(execFileSyncImpl).toHaveBeenNthCalledWith(
      2,
      "npm",
      ["dist-tag", "add", "@ouro.bot/cli@0.1.0-alpha.537", "latest"],
      { stdio: "inherit" },
    )
  })
})
