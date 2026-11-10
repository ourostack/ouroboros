import { beforeEach, describe, expect, it, vi } from "vitest"

const nerves = vi.hoisted(() => ({ emit: vi.fn() }))
vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent: nerves.emit }))

import {
  GITHUB_CLI_DEFAULT_SCOPES,
  GITHUB_CLI_OAUTH_CLIENT_ID,
  githubDeviceLogin,
  type GithubDeviceLoginDeps,
} from "../../../heart/auth/github-device-login"

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

function harness(polls: Array<Response>, code: unknown = { device_code: "dev-1", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 60, interval: 5 }) {
  let clock = 0
  const sleeps: number[] = []
  const requests: Array<{ url: string; body: string }> = []
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: String(init?.body) })
    return String(url).endsWith("/login/device/code") ? json(code) : polls.shift()!
  })
  const deps: GithubDeviceLoginDeps = {
    fetch: fetch as unknown as typeof globalThis.fetch,
    sleep: async (ms) => { sleeps.push(ms); clock += ms },
    now: () => clock,
  }
  return { deps, sleeps, requests }
}

describe("githubDeviceLogin", () => {
  beforeEach(() => nerves.emit.mockClear())

  it("shows the code, waits out pending and slow_down replies, and returns the token", async () => {
    const { deps, sleeps, requests } = harness([
      json({ error: "authorization_pending" }),
      json({ error: "slow_down", interval: 10 }),
      json({ error: "slow_down" }),
      json({ access_token: "gho_device" }),
    ])
    const shown: string[] = []

    await expect(githubDeviceLogin((message) => shown.push(message), deps)).resolves.toBe("gho_device")

    expect(shown).toEqual(["To sign in to GitHub, open https://github.com/login/device on any device and enter code ABCD-1234"])
    expect(sleeps).toEqual([5_000, 5_000, 10_000, 15_000])
    expect(requests[0]).toEqual({
      url: "https://github.com/login/device/code",
      body: new URLSearchParams({ client_id: GITHUB_CLI_OAUTH_CLIENT_ID, scope: GITHUB_CLI_DEFAULT_SCOPES }).toString(),
    })
    expect(requests[1]).toEqual({
      url: "https://github.com/login/oauth/access_token",
      body: new URLSearchParams({ client_id: GITHUB_CLI_OAUTH_CLIENT_ID, device_code: "dev-1", grant_type: "urn:ietf:params:oauth:grant-type:device_code" }).toString(),
    })
    expect(nerves.emit).toHaveBeenCalledWith(expect.objectContaining({ event: "daemon.auth_github_device_login_start" }))
    expect(nerves.emit).toHaveBeenCalledWith(expect.objectContaining({ event: "daemon.auth_github_device_login_end" }))
  })

  it("defaults the interval and expiry GitHub may omit, and stops when the code expires", async () => {
    const pending = Array.from({ length: 200 }, () => json({ error: "authorization_pending" }))
    const { deps, sleeps } = harness(pending, { device_code: "d", user_code: "U", verification_uri: "https://github.com/login/device" })
    await expect(githubDeviceLogin(() => {}, deps)).rejects.toThrow("expired before it was approved")
    expect(sleeps[0]).toBe(5_000)
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(900_000)
    expect(nerves.emit).toHaveBeenCalledWith(expect.objectContaining({ event: "daemon.auth_github_device_login_error" }))

    const expired = harness([json({ error: "expired_token" })])
    await expect(githubDeviceLogin(() => {}, expired.deps)).rejects.toThrow("expired before it was approved")
  })

  it("reports a denial, an unknown error and an unreadable reply", async () => {
    await expect(githubDeviceLogin(() => {}, harness([json({ error: "access_denied" })]).deps)).rejects.toThrow("GitHub device login was denied.")
    await expect(githubDeviceLogin(() => {}, harness([json({ error: "incorrect_client_credentials" })]).deps)).rejects.toThrow("GitHub device login failed: incorrect_client_credentials.")
    const unreadable = { ok: false, status: 502, json: async () => { throw new Error("not json") } } as unknown as Response
    await expect(githubDeviceLogin(() => {}, harness([unreadable]).deps)).rejects.toThrow("GitHub device login failed: HTTP 502.")
  })

  it("fails before showing anything when GitHub returns no usable code", async () => {
    const shown = vi.fn()
    const refused = harness([])
    refused.deps.fetch = (async () => json({}, 422)) as unknown as typeof fetch
    await expect(githubDeviceLogin(shown, refused.deps)).rejects.toThrow("could not start (HTTP 422)")
    await expect(githubDeviceLogin(shown, harness([], { device_code: "d" }).deps)).rejects.toThrow("returned no code to enter")
    expect(shown).not.toHaveBeenCalled()
  })

  it("uses the real fetch, timer and clock by default", async () => {
    const realFetch = vi.fn(async (url: string) => url.endsWith("/login/device/code")
      ? json({ device_code: "d", user_code: "U", verification_uri: "https://github.com/login/device", interval: 0.001 })
      : json({ access_token: "gho_default" }))
    vi.stubGlobal("fetch", realFetch)
    try {
      await expect(githubDeviceLogin(() => {})).resolves.toBe("gho_default")
      expect(realFetch).toHaveBeenCalledTimes(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
