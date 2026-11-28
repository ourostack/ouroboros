import { describe, expect, it, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))
vi.mock("../../../heart/daemon/daemon-tombstone", () => ({ writeDaemonTombstone: vi.fn() }))

import type { ConfigCheckResult } from "../../../heart/daemon/agent-config-check"
import {
  createProviderReadinessPreparationFailure,
  startDaemonAfterContainerCredentialBootstrap,
} from "../../../heart/daemon/daemon-bootstrap-startup"
import { prepareProviderRuntimeTolerantOfVaultOutage } from "../../../heart/daemon/vault-outage"

const unreachable: ConfigCheckResult = { ok: false, error: "vault request to /identity/accounts/prelogin timed out", vaultUnreachable: true }
const rejected: ConfigCheckResult = {
  ok: false,
  error: "wrong master password",
  issue: { summary: "slugger: vault rejected the credentials", actions: [{ actor: "human-required", command: "ouro vault unlock --agent slugger" }] } as never,
}

function harness(check: (agent: string) => Promise<ConfigCheckResult>) {
  const timers: Array<{ run: () => void; delayMs: number }> = []
  const onDegraded = vi.fn()
  const onRecovered = vi.fn()
  const onProviderFailed = vi.fn()
  const deps = {
    check: vi.fn(check),
    onDegraded,
    onRecovered,
    onProviderFailed,
    schedule: (run: () => void, delayMs: number) => { timers.push({ run, delayMs }); return { unref: vi.fn() } },
    initialDelayMs: 10,
    maxDelayMs: 25,
  }
  return { deps, timers, onDegraded, onRecovered, onProviderFailed }
}

async function boot(agents: string[], deps: ReturnType<typeof harness>["deps"]) {
  const startDaemon = vi.fn(async () => undefined)
  const exit = vi.fn()
  const started = await startDaemonAfterContainerCredentialBootstrap({
    loadBootstrap: async () => ({}),
    prepareDaemon: async () => {
      const failures = await prepareProviderRuntimeTolerantOfVaultOutage(agents, deps)
      if (failures.length > 0) throw createProviderReadinessPreparationFailure(failures)
    },
    startDaemon,
    markStartupFailure: vi.fn(),
    exit,
  })
  return { started, startDaemon, exit }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("daemon startup during a vault outage", () => {
  it("starts a running, degraded daemon instead of exiting when the vault is unreachable", async () => {
    const { deps, onDegraded, timers } = harness(async () => unreachable)
    const { started, startDaemon, exit } = await boot(["slugger"], deps)
    expect(started).toBe(true)
    expect(startDaemon).toHaveBeenCalledTimes(1)
    expect(exit).not.toHaveBeenCalled()
    expect(onDegraded).toHaveBeenCalledWith("slugger", expect.stringContaining("timed out"))
    expect(timers).toHaveLength(1)
  })

  it("still fails startup when the vault answers with an auth rejection", async () => {
    const { deps, onDegraded } = harness(async () => rejected)
    const { started, startDaemon, exit } = await boot(["slugger"], deps)
    expect(started).toBe(false)
    expect(startDaemon).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(1)
    expect(onDegraded).not.toHaveBeenCalled()
  })

  it("degrades only the agent whose vault is unreachable; a rejection elsewhere is still fatal", async () => {
    const { deps } = harness(async (agent) => (agent === "a" ? unreachable : rejected))
    const failures = await prepareProviderRuntimeTolerantOfVaultOutage(["a", "b"], deps)
    expect(failures).toHaveLength(1)
    expect(failures[0]!.summary).toContain("rejected")
  })

  it("reports a generic failure when a rejection carries no repair issue", async () => {
    const { deps } = harness(async () => ({ ok: false, error: "nope" }))
    const failures = await prepareProviderRuntimeTolerantOfVaultOutage(["slugger"], deps)
    expect(failures).toEqual([{ summary: "slugger: provider runtime unavailable", actions: [{ actor: "agent-runnable", command: "ouro doctor" }] }])
  })

  it("retries with capped backoff and clears the degraded state when the vault returns", async () => {
    let answers: ConfigCheckResult[] = [unreachable, unreachable, unreachable, { ok: true }]
    const { deps, timers, onDegraded, onRecovered } = harness(async () => answers.shift()!)
    await prepareProviderRuntimeTolerantOfVaultOutage(["slugger"], deps)
    expect(timers.map((t) => t.delayMs)).toEqual([10])
    timers[0]!.run(); await flush()
    timers[1]!.run(); await flush()
    expect(timers.map((t) => t.delayMs)).toEqual([10, 20, 25])
    expect(onRecovered).not.toHaveBeenCalled()
    timers[2]!.run(); await flush()
    expect(onRecovered).toHaveBeenCalledWith("slugger")
    expect(timers).toHaveLength(3)
    expect(onDegraded).toHaveBeenCalledTimes(3)
    answers = []
  })

  it("reports a provider failure after the vault answers, with the provider's own repair line", async () => {
    const answers: ConfigCheckResult[] = [unreachable, { ok: false, error: "provider failed live check: 400", fix: "restore quota", providerFailure: true }]
    const { deps, timers, onDegraded, onProviderFailed } = harness(async () => answers.shift()!)
    await prepareProviderRuntimeTolerantOfVaultOutage(["slugger"], deps)
    timers[0]!.run(); await flush()
    expect(onProviderFailed).toHaveBeenCalledWith("slugger", "provider failed live check: 400", "restore quota")
    expect(onDegraded).toHaveBeenCalledTimes(1)
    expect(timers).toHaveLength(2)
    answers.push({ ok: false, providerFailure: true })
    timers[1]!.run(); await flush()
    expect(onProviderFailed).toHaveBeenLastCalledWith("slugger", "vault unreachable", undefined)
  })

  it("keeps the agent degraded with the rejection reason if the vault comes back but refuses us", async () => {
    const answers: ConfigCheckResult[] = [unreachable, rejected]
    const { deps, timers, onDegraded } = harness(async () => answers.shift()!)
    await prepareProviderRuntimeTolerantOfVaultOutage(["slugger"], deps)
    timers[0]!.run(); await flush()
    expect(onDegraded).toHaveBeenLastCalledWith("slugger", "wrong master password")
    answers.push({ ok: false })
    timers[1]!.run(); await flush()
    expect(onDegraded).toHaveBeenLastCalledWith("slugger", "vault request to /identity/accounts/prelogin timed out")
    expect(timers).toHaveLength(3)
  })

  it("keeps retrying when a retry check throws", async () => {
    const answers: Array<ConfigCheckResult | Error> = [unreachable, new Error("boom"), "str" as never]
    const { deps, timers, onDegraded } = harness(async () => {
      const next = answers.shift()!
      if (next instanceof Error) throw next
      if (typeof next === "string") throw next
      return next
    })
    await prepareProviderRuntimeTolerantOfVaultOutage(["slugger"], deps)
    timers[0]!.run(); await flush()
    expect(onDegraded).toHaveBeenLastCalledWith("slugger", "boom")
    timers[1]!.run(); await flush()
    expect(onDegraded).toHaveBeenLastCalledWith("slugger", "str")
    expect(timers).toHaveLength(3)
  })

  it("uses setTimeout by default and does not keep the process alive", async () => {
    vi.useFakeTimers()
    try {
      const check = vi.fn(async () => unreachable)
      await prepareProviderRuntimeTolerantOfVaultOutage(["slugger"], { check, onDegraded: vi.fn(), onRecovered: vi.fn() })
      expect(check).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(check).toHaveBeenCalledTimes(2)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it("tolerates a scheduler that returns no handle", async () => {
    const run: Array<() => void> = []
    const check = vi.fn(async () => unreachable)
    await prepareProviderRuntimeTolerantOfVaultOutage(["slugger"], { check, onDegraded: vi.fn(), onRecovered: vi.fn(), schedule: (fn) => { run.push(fn); return undefined } })
    expect(run).toHaveLength(1)
  })

  it("falls back to a plain reason when the unreachable result has no error text", async () => {
    const { deps, onDegraded } = harness(async () => ({ ok: false, vaultUnreachable: true }))
    await prepareProviderRuntimeTolerantOfVaultOutage(["slugger"], deps)
    expect(onDegraded).toHaveBeenCalledWith("slugger", "vault unreachable")
  })
})
