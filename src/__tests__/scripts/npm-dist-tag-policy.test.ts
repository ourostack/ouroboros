import * as path from "path"

import { describe, expect, it, vi } from "vitest"

const {
  planPublishTag,
  resolvePublishTag,
} = require(path.resolve(__dirname, "../../../scripts/npm-dist-tag-policy.cjs"))

describe("npm dist-tag policy", () => {
  it("publishes stable releases on latest", () => {
    expect(planPublishTag({
      localVersion: "1.0.0",
      latestVersion: "0.1.0-alpha.538",
    })).toEqual({
      action: "publish",
      tag: "latest",
      reason: "stable publish owns latest",
    })
  })

  it("publishes prereleases on latest while latest is already a prerelease", () => {
    expect(planPublishTag({
      localVersion: "0.1.0-alpha.539",
      latestVersion: "0.1.0-alpha.531",
    })).toEqual({
      action: "publish",
      tag: "latest",
      reason: "latest dist-tag points at prerelease 0.1.0-alpha.531; keeping prerelease as the supported default channel",
    })
  })

  it("publishes prereleases on latest when the latest tag is missing", () => {
    expect(planPublishTag({
      localVersion: "0.1.0-alpha.539",
      latestVersion: "",
    })).toEqual({
      action: "publish",
      tag: "latest",
      reason: "latest dist-tag is missing; prerelease is the current supported default channel",
    })
  })

  it("publishes prereleases on their channel after latest is stable", () => {
    expect(planPublishTag({
      localVersion: "1.1.0-alpha.1",
      latestVersion: "1.0.0",
    })).toEqual({
      action: "publish",
      tag: "alpha",
      reason: "latest dist-tag points at stable 1.0.0; publishing prerelease on alpha",
    })
  })

  it("resolves publish tags by reading the package dist-tag map", () => {
    const execFileSyncImpl = vi.fn(() => JSON.stringify({
      alpha: "0.1.0-alpha.538",
      latest: "0.1.0-alpha.531",
    }))

    const result = resolvePublishTag("@ouro.bot/cli", "0.1.0-alpha.539", {
      execFileSyncImpl,
    })

    expect(result).toEqual({
      action: "publish",
      tag: "latest",
      latestVersion: "0.1.0-alpha.531",
      reason: "latest dist-tag points at prerelease 0.1.0-alpha.531; keeping prerelease as the supported default channel",
    })
    expect(execFileSyncImpl).toHaveBeenCalledWith(
      "npm",
      ["view", "@ouro.bot/cli", "dist-tags", "--json"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
  })

  it("does not read npm when latest version is injected by tests", () => {
    const execFileSyncImpl = vi.fn()

    const result = resolvePublishTag("@ouro.bot/cli", "1.1.0-alpha.1", {
      latestVersion: "1.0.0",
      execFileSyncImpl,
    })

    expect(result).toEqual({
      action: "publish",
      tag: "alpha",
      latestVersion: "1.0.0",
      reason: "latest dist-tag points at stable 1.0.0; publishing prerelease on alpha",
    })
    expect(execFileSyncImpl).not.toHaveBeenCalled()
  })

  it("fails closed when npm dist-tag lookup fails", () => {
    const execFileSyncImpl = vi.fn(() => {
      throw new Error("registry timeout")
    })

    expect(() => resolvePublishTag("@ouro.bot/cli", "0.1.0-alpha.539", {
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
      if (command === "npm" && args[0] === "view") return JSON.stringify({ alpha: "0.1.0-alpha.538" })
      return ""
    })

    const result = resolvePublishTag("@ouro.bot/cli", "0.1.0-alpha.539", {
      execFileSyncImpl,
    })

    expect(result).toEqual({
      action: "publish",
      tag: "latest",
      latestVersion: "",
      reason: "latest dist-tag is missing; prerelease is the current supported default channel",
    })
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

  it("errors on invalid latest tag values", () => {
    expect(() => resolvePublishTag("@ouro.bot/cli", "0.1.0-alpha.539", {
      latestVersion: "definitely-not-semver",
    })).toThrow("@ouro.bot/cli: latest dist-tag points at invalid version definitely-not-semver")
  })
})
