import { describe, expect, it, vi } from "vitest"

import { PIN_MAX_AGE_MS, runSelfUpdate, type SelfUpdateDeps } from "../../../heart/versioning/self-update"
import type { ReleaseLookup } from "../../../heart/versioning/release-sources"
import type { SelfUpdateState } from "../../../heart/versioning/update-state"
import type { VersionIntent } from "../../../heart/versioning/version-intent"

const NOW = Date.parse("2026-10-11T12:00:00.000Z")

function lookup(latest: string | null, extra: Partial<ReleaseLookup> = {}): ReleaseLookup {
  return {
    latestVersion: latest,
    answers: latest
      ? [{ source: "github", version: latest, tarballUrl: `https://example.test/${latest}.tgz` }, { source: "npmjs", error: "socket closed" }]
      : [{ source: "npmjs", error: "socket closed" }, { source: "github", error: "HTTP 503" }],
    ...extra,
  }
}

/** A machine whose CurrentVersion, intent and state live in memory. */
function machine(options: {
  current?: string | null
  intent?: VersionIntent | null
  state?: SelfUpdateState | null
  latest?: string | null
  daemonRunning?: boolean
  devMode?: boolean
  locked?: boolean
} = {}) {
  let current = options.current === undefined ? "0.1.0-alpha.805" : options.current
  let intent = options.intent ?? null
  let state = options.state ?? null
  const release = vi.fn()
  const deps: SelfUpdateDeps = {
    now: () => NOW,
    getCurrentVersion: () => current,
    readIntent: () => intent,
    writeIntent: vi.fn((next: VersionIntent) => { intent = next }),
    readState: () => state,
    writeState: vi.fn((next: SelfUpdateState) => { state = next }),
    lookupLatest: vi.fn(async () => lookup(options.latest === undefined ? "0.1.0-alpha.896" : options.latest)),
    install: vi.fn(async () => "github" as const),
    validate: vi.fn(() => ({ ok: true })),
    smokeTest: vi.fn(async () => ({ ok: true })),
    activate: vi.fn((version: string) => { current = version }),
    isDaemonRunning: vi.fn(async () => options.daemonRunning ?? false),
    restartDaemon: vi.fn(async () => ({ ok: true })),
    isDevMode: () => options.devMode ?? false,
    acquireLock: () => (options.locked ? null : release),
  }
  return { deps, release, get state() { return state }, get intent() { return intent }, get current() { return current } }
}

describe("runSelfUpdate", () => {
  it("updates a machine with a stopped daemon and leaves the daemon stopped", async () => {
    const m = machine({ intent: { schemaVersion: 1, mode: "latest", targetVersion: "0.1.0-alpha.805" } })

    const result = await runSelfUpdate(m.deps)

    expect(result.outcome).toBe("updated")
    expect(result.summary).toBe("updated 0.1.0-alpha.805 -> 0.1.0-alpha.896 via github; daemon was not running and was left stopped")
    expect(m.current).toBe("0.1.0-alpha.896")
    expect(m.intent).toEqual({ schemaVersion: 1, mode: "latest", targetVersion: "0.1.0-alpha.896" })
    expect(m.deps.restartDaemon).not.toHaveBeenCalled()
    expect(m.state).toMatchObject({ outcome: "updated", currentVersion: "0.1.0-alpha.896", latestVersion: "0.1.0-alpha.896", source: "github", consecutiveFailures: 0, failedVersions: [] })
    expect(m.release).toHaveBeenCalledTimes(1)
  })

  it("restarts a running daemon on the new version", async () => {
    const m = machine({ daemonRunning: true, current: null })

    const result = await runSelfUpdate(m.deps)

    expect(result.summary).toBe("updated unknown -> 0.1.0-alpha.896 via github; daemon restarted and healthy")
    expect(m.deps.restartDaemon).toHaveBeenCalledWith("0.1.0-alpha.896")
  })

  it("does not touch a dev-mode daemon", async () => {
    const m = machine({ daemonRunning: true, devMode: true })
    await runSelfUpdate(m.deps)
    expect(m.deps.isDaemonRunning).not.toHaveBeenCalled()
    expect(m.deps.restartDaemon).not.toHaveBeenCalled()
  })

  it("rolls back, pins the previous version and never retries a release whose daemon is unhealthy", async () => {
    const m = machine({ daemonRunning: true })
    vi.mocked(m.deps.restartDaemon).mockResolvedValueOnce({ ok: false, detail: "daemon answered with 0.1.0-alpha.805" })

    const result = await runSelfUpdate(m.deps)

    expect(result.outcome).toBe("rolled-back")
    expect(result.summary).toBe("0.1.0-alpha.896 did not come up healthy (daemon answered with 0.1.0-alpha.805); rolled back to 0.1.0-alpha.805")
    expect(m.current).toBe("0.1.0-alpha.805")
    expect(m.intent).toEqual({ schemaVersion: 1, mode: "pinned", targetVersion: "0.1.0-alpha.805", pinnedAt: new Date(NOW).toISOString(), reason: "auto-rollback" })
    expect(m.deps.restartDaemon).toHaveBeenLastCalledWith("0.1.0-alpha.805")
    expect(m.state).toMatchObject({ outcome: "rolled-back", failedVersions: ["0.1.0-alpha.896"], consecutiveFailures: 1 })

    // Next hour: the same release is skipped, and the auto-rollback pin does not block a newer one.
    const again = await runSelfUpdate(m.deps)
    expect(again.outcome).toBe("rejected")
    expect(again.summary).toContain("failed its checks on this machine earlier")
    expect(m.state?.consecutiveFailures).toBe(2)

    vi.mocked(m.deps.lookupLatest).mockResolvedValueOnce(lookup("0.1.0-alpha.897"))
    const newer = await runSelfUpdate(m.deps)
    expect(newer.outcome).toBe("updated")
    expect(m.intent).toEqual({ schemaVersion: 1, mode: "latest", targetVersion: "0.1.0-alpha.897" })
    expect(m.state?.consecutiveFailures).toBe(0)
  })

  it("reports when the rolled-back daemon does not answer either", async () => {
    const m = machine({ daemonRunning: true })
    vi.mocked(m.deps.restartDaemon)
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false })

    const result = await runSelfUpdate(m.deps)

    expect(result.summary).toBe("0.1.0-alpha.896 did not come up healthy (no detail); rolled back to 0.1.0-alpha.805 but the daemon did not answer on it either (no detail)")
  })

  it("reports a failed health check with nothing to roll back to", async () => {
    const m = machine({ daemonRunning: true, current: null })
    vi.mocked(m.deps.restartDaemon).mockResolvedValueOnce({ ok: false, detail: "socket refused" })

    const result = await runSelfUpdate(m.deps)

    expect(result.outcome).toBe("rolled-back")
    expect(result.summary).toBe("0.1.0-alpha.896 did not come up healthy (socket refused) and there is no previous version to return to")

    const bare = machine({ daemonRunning: true, current: null })
    vi.mocked(bare.deps.restartDaemon).mockResolvedValueOnce({ ok: false })
    expect((await runSelfUpdate(bare.deps)).summary).toBe("0.1.0-alpha.896 did not come up healthy (no detail) and there is no previous version to return to")
  })

  it("rejects a release that fails its smoke test without activating it", async () => {
    const m = machine()
    vi.mocked(m.deps.smokeTest).mockResolvedValueOnce({ ok: false, detail: "--version printed \"boom\"" })

    const result = await runSelfUpdate(m.deps)

    expect(result.outcome).toBe("rejected")
    expect(result.summary).toBe("0.1.0-alpha.896 failed its pre-activation check: --version printed \"boom\"; staying on 0.1.0-alpha.805")
    expect(m.deps.activate).not.toHaveBeenCalled()
    expect(m.state?.failedVersions).toEqual(["0.1.0-alpha.896"])
  })

  it("rejects a release that fails payload validation without running it", async () => {
    const m = machine()
    vi.mocked(m.deps.validate).mockReturnValueOnce({ ok: false })

    const result = await runSelfUpdate(m.deps)

    expect(result.summary).toContain("failed its pre-activation check: no detail")
    expect(m.deps.smokeTest).not.toHaveBeenCalled()
  })

  it("records an install failure without marking the release as bad", async () => {
    const m = machine()
    vi.mocked(m.deps.install).mockRejectedValueOnce(new Error("could not install 0.1.0-alpha.896 from any source"))

    const result = await runSelfUpdate(m.deps)

    expect(result.outcome).toBe("install-failed")
    expect(m.state).toMatchObject({ failedVersions: [], detail: "could not install 0.1.0-alpha.896 from any source" })
  })

  it("stringifies a non-Error install failure", async () => {
    const m = machine()
    vi.mocked(m.deps.install).mockRejectedValueOnce("npm exploded")
    expect((await runSelfUpdate(m.deps)).summary).toBe("npm exploded")
  })

  it("reports unreachable sources", async () => {
    const m = machine({ latest: null })

    const result = await runSelfUpdate(m.deps)

    expect(result.outcome).toBe("unreachable")
    expect(result.summary).toBe("no release source answered (npmjs: socket closed; github: HTTP 503)")
  })

  it("reports current when nothing newer is published", async () => {
    const m = machine({ latest: "0.1.0-alpha.805" })
    const result = await runSelfUpdate(m.deps)
    expect(result.outcome).toBe("current")
    expect(m.state).toMatchObject({ outcome: "current", source: "github", detail: "current at 0.1.0-alpha.805" })
    expect(m.deps.install).not.toHaveBeenCalled()
  })

  it("honors a fresh rollback pin and says when updates resume", async () => {
    const pinnedAt = new Date(NOW - 60_000).toISOString()
    const m = machine({ intent: { schemaVersion: 1, mode: "pinned", targetVersion: "0.1.0-alpha.805", pinnedAt, reason: "rollback" } })

    const result = await runSelfUpdate(m.deps)

    const until = new Date(NOW - 60_000 + PIN_MAX_AGE_MS).toISOString()
    expect(result.outcome).toBe("pinned")
    expect(result.summary).toContain(`unattended updates resume after ${until}`)
    expect(m.state).toMatchObject({ outcome: "pinned", detail: `pin honored until ${until}` })
    expect(m.deps.lookupLatest).not.toHaveBeenCalled()
  })

  it("expires a stale rollback pin and updates", async () => {
    const pinnedAt = new Date(NOW - PIN_MAX_AGE_MS - 1).toISOString()
    const m = machine({ intent: { schemaVersion: 1, mode: "pinned", targetVersion: "0.1.0-alpha.805", pinnedAt } })

    const result = await runSelfUpdate(m.deps)

    expect(result.outcome).toBe("updated")
    expect(m.intent?.mode).toBe("latest")
  })

  it("starts the clock on a legacy pin with no timestamp, then expires it", async () => {
    const legacy: VersionIntent = { schemaVersion: 1, mode: "pinned", targetVersion: "0.1.0-alpha.805" }
    const m = machine({ intent: legacy })

    expect((await runSelfUpdate(m.deps)).outcome).toBe("pinned")
    expect(m.state?.pinFirstSeenAt).toBe(new Date(NOW).toISOString())

    const later = machine({
      intent: legacy,
      state: { ...(m.state as SelfUpdateState), pinFirstSeenAt: new Date(NOW - PIN_MAX_AGE_MS - 1).toISOString() },
    })
    expect((await runSelfUpdate(later.deps)).outcome).toBe("updated")
    expect(later.state?.pinFirstSeenAt).toBeUndefined()
  })

  it("does not write state when another pass holds the lock", async () => {
    const m = machine({ locked: true })
    const result = await runSelfUpdate(m.deps)
    expect(result).toEqual({ outcome: "busy", summary: "another ouro self-update is already running" })
    expect(m.deps.writeState).not.toHaveBeenCalled()
  })

  it("releases the lock when a step throws", async () => {
    const m = machine()
    vi.mocked(m.deps.lookupLatest).mockRejectedValueOnce(new Error("boom"))
    await expect(runSelfUpdate(m.deps)).rejects.toThrow("boom")
    expect(m.release).toHaveBeenCalledTimes(1)
  })
})
