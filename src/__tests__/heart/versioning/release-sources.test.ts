import { describe, expect, it, vi } from "vitest"

import {
  GITHUB_DOWNLOAD_BASE,
  GITHUB_RELEASES_API,
  githubTarballName,
  installRelease,
  lookupLatestRelease,
  NPMJS_REGISTRY,
  selfUpdateE2eOverrides,
  type ReleaseSourceDeps,
} from "../../../heart/versioning/release-sources"

const BOT = { login: "github-actions[bot]" }

function assetUrl(version: string): string {
  return `${GITHUB_DOWNLOAD_BASE}v${version}/${githubTarballName(version)}`
}

function githubRelease(version: string, withAsset = true, draft = false) {
  return {
    tag_name: `v${version}`,
    draft,
    author: BOT,
    assets: withAsset ? [{ name: githubTarballName(version), browser_download_url: assetUrl(version), uploader: BOT }] : [],
  }
}

function deps(overrides: {
  npmjs?: unknown
  registry?: string | Error
  github?: unknown
} = {}): ReleaseSourceDeps {
  return {
    fetchJson: vi.fn(async (url: string) => {
      const value = url === GITHUB_RELEASES_API ? overrides.github : overrides.npmjs
      if (value instanceof Error) throw value
      return value
    }),
    execFile: vi.fn(async () => {
      if (overrides.registry instanceof Error) throw overrides.registry
      return overrides.registry ?? "\"0.1.0-alpha.853\"\n"
    }),
  }
}

describe("lookupLatestRelease", () => {
  it("takes the newest version across npmjs, the configured registry and GitHub", async () => {
    const d = deps({
      npmjs: new Error("Recv failure: Socket is not connected"),
      registry: "\"0.1.0-alpha.853\"",
      github: [githubRelease("0.1.0-alpha.895"), githubRelease("0.1.0-alpha.896"), githubRelease("0.1.0-alpha.894"), githubRelease("0.1.0-alpha.897", false), githubRelease("0.1.0-alpha.898", true, true), { tag_name: 42 }],
    })

    const result = await lookupLatestRelease(d)

    expect(result.latestVersion).toBe("0.1.0-alpha.896")
    expect(result.answers).toEqual([
      { source: "npmjs", error: "Recv failure: Socket is not connected" },
      { source: "npm-registry", version: "0.1.0-alpha.853" },
      { source: "github", version: "0.1.0-alpha.896", tarballUrl: assetUrl("0.1.0-alpha.896") },
    ])
    expect(d.fetchJson).toHaveBeenCalledWith(`${NPMJS_REGISTRY}@ouro.bot%2fcli`, 15_000)
    expect(d.execFile).toHaveBeenCalledWith("npm", ["view", "@ouro.bot/cli", "dist-tags.latest", "--json"], { timeoutMs: 15_000 })
  })

  it("prefers npmjs when it is newest and reports every malformed answer", async () => {
    const result = await lookupLatestRelease(deps({
      npmjs: { "dist-tags": { latest: "0.1.0-alpha.900" } },
      registry: "null",
      github: { message: "rate limited" },
    }))
    expect(result.latestVersion).toBe("0.1.0-alpha.900")
    expect(result.answers[1]).toEqual({ source: "npm-registry", error: "npm view returned no latest dist-tag" })
    expect(result.answers[2]).toEqual({ source: "github", error: "GitHub releases response is not a list" })
  })

  it("returns null when no source answers", async () => {
    const result = await lookupLatestRelease(deps({
      npmjs: {},
      registry: new Error("ENOTFOUND"),
      github: [githubRelease("0.1.0-alpha.1", false)],
    }))
    expect(result.latestVersion).toBeNull()
    expect(result.answers.map((answer) => answer.error)).toEqual([
      "registry response has no latest dist-tag",
      "ENOTFOUND",
      "no GitHub release published by github-actions[bot] carries an npm tarball",
    ])
  })

  it("stringifies non-Error failures", async () => {
    const d = deps()
    vi.mocked(d.fetchJson).mockRejectedValue("offline")
    const result = await lookupLatestRelease(d)
    expect(result.answers[0]).toEqual({ source: "npmjs", error: "offline" })
  })

  it("handles a release with no asset list", async () => {
    const result = await lookupLatestRelease(deps({ npmjs: null, github: [{ tag_name: "v0.1.0-alpha.2", author: BOT }] }))
    expect(result.answers[2]?.error).toBe("no GitHub release published by github-actions[bot] carries an npm tarball")
  })

  it("ignores releases and assets that our release workflow did not publish", async () => {
    const good = githubRelease("0.1.0-alpha.896")
    const result = await lookupLatestRelease(deps({
      npmjs: null,
      github: [
        good,
        { ...githubRelease("0.1.0-alpha.901"), author: { login: "mallory" } },
        { ...githubRelease("0.1.0-alpha.902"), author: null },
        { ...githubRelease("0.1.0-alpha.903"), tag_name: "release-903" },
        { ...githubRelease("0.1.0-alpha.904"), assets: [{ name: githubTarballName("0.1.0-alpha.904"), browser_download_url: "https://evil.example/ouro.bot-cli-0.1.0-alpha.904.tgz", uploader: BOT }] },
        { ...githubRelease("0.1.0-alpha.905"), assets: [{ name: githubTarballName("0.1.0-alpha.905"), browser_download_url: assetUrl("0.1.0-alpha.905"), uploader: { login: "mallory" } }] },
        { ...githubRelease("0.1.0-alpha.906"), assets: [{ name: githubTarballName("0.1.0-alpha.906"), browser_download_url: assetUrl("0.1.0-alpha.906"), uploader: null }] },
        { ...githubRelease("0.1.0-alpha.907"), assets: [{ name: githubTarballName("0.1.0-alpha.896"), browser_download_url: assetUrl("0.1.0-alpha.896"), uploader: BOT }] },
      ],
    }))
    expect(result.answers[2]).toEqual({ source: "github", version: "0.1.0-alpha.896", tarballUrl: assetUrl("0.1.0-alpha.896") })
  })

  it("asks only the overridden GitHub source in the package end-to-end test", async () => {
    const overrides = selfUpdateE2eOverrides({ OURO_SELF_UPDATE_E2E: "1", OURO_SELF_UPDATE_E2E_GITHUB_BASE: "http://127.0.0.1:4567/" })
    expect(overrides).toEqual({
      github: { apiUrl: "http://127.0.0.1:4567/releases", downloadBase: "http://127.0.0.1:4567/releases/download/" },
      githubOnly: true,
    })
    const d = deps()
    const url = "http://127.0.0.1:4567/releases/download/v0.1.0-alpha.896/ouro.bot-cli-0.1.0-alpha.896.tgz"
    const release = { ...githubRelease("0.1.0-alpha.896"), assets: [{ name: githubTarballName("0.1.0-alpha.896"), browser_download_url: url, uploader: BOT }] }
    vi.mocked(d.fetchJson).mockResolvedValue([release])
    const result = await lookupLatestRelease({ ...d, ...overrides })
    expect(result.answers).toEqual([{ source: "github", version: "0.1.0-alpha.896", tarballUrl: url }])
    expect(d.fetchJson).toHaveBeenCalledWith("http://127.0.0.1:4567/releases", 15_000)
    expect(d.execFile).not.toHaveBeenCalled()
  })

  it("honors the end-to-end override only with the flag and a loopback URL", () => {
    expect(selfUpdateE2eOverrides({})).toBeNull()
    expect(selfUpdateE2eOverrides({ OURO_SELF_UPDATE_E2E_GITHUB_BASE: "http://127.0.0.1:1" })).toBeNull()
    expect(selfUpdateE2eOverrides({ OURO_SELF_UPDATE_E2E: "1" })).toBeNull()
    expect(selfUpdateE2eOverrides({ OURO_SELF_UPDATE_E2E: "1", OURO_SELF_UPDATE_E2E_GITHUB_BASE: "https://evil.example" })).toBeNull()
    expect(selfUpdateE2eOverrides({ OURO_SELF_UPDATE_E2E: "1", OURO_SELF_UPDATE_E2E_GITHUB_BASE: "http://localhost:80" })).not.toBeNull()
  })
})

describe("installRelease", () => {
  const lookup = {
    latestVersion: "0.1.0-alpha.896",
    answers: [{ source: "github" as const, version: "0.1.0-alpha.896", tarballUrl: "https://github.example/896.tgz" }],
  }

  it("installs from the configured registry first", async () => {
    const execFile = vi.fn(async () => "")
    await expect(installRelease("0.1.0-alpha.896", lookup, "/home/a/.ouro-cli", { execFile })).resolves.toBe("npm-registry")
    expect(execFile).toHaveBeenCalledWith("npm", ["install", "--prefix", "/home/a/.ouro-cli/versions/0.1.0-alpha.896", "@ouro.bot/cli@0.1.0-alpha.896"], { timeoutMs: 600_000 })
  })

  it("falls back to the GitHub tarball when the mirror lacks the version", async () => {
    const execFile = vi.fn()
      .mockRejectedValueOnce(new Error("npm install failed: No matching version found\nmore"))
      .mockResolvedValueOnce("")
    await expect(installRelease("0.1.0-alpha.896", lookup, "/h", { execFile })).resolves.toBe("github")
    expect(execFile).toHaveBeenLastCalledWith("npm", ["install", "--prefix", "/h/versions/0.1.0-alpha.896", "https://github.example/896.tgz"], { timeoutMs: 600_000 })
  })

  it("installs only from GitHub when told to", async () => {
    const execFile = vi.fn(async () => "")
    await expect(installRelease("0.1.0-alpha.896", lookup, "/h", { execFile, githubOnly: true })).resolves.toBe("github")
    expect(execFile).toHaveBeenCalledTimes(1)
  })

  it("tries npmjs directly last and reports every failure", async () => {
    const execFile = vi.fn().mockRejectedValue(new Error("E404"))
    await expect(installRelease("0.1.0-alpha.896", { latestVersion: "0.1.0-alpha.896", answers: [] }, "/h", { execFile }))
      .rejects.toThrow("could not install 0.1.0-alpha.896 from any source (npm-registry: E404; npmjs: E404)")
    expect(execFile).toHaveBeenLastCalledWith("npm", ["install", "--prefix", "/h/versions/0.1.0-alpha.896", "@ouro.bot/cli@0.1.0-alpha.896", "--registry", NPMJS_REGISTRY], { timeoutMs: 600_000 })
  })
})
