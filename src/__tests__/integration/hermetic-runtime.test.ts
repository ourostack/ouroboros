import { afterEach, describe, expect, it } from "vitest"
import { createHermeticRuntimeHarness, type HermeticRuntimeHarness } from "./fixtures/hermetic-runtime"

describe("hermetic Ouro runtime integration", () => {
  let harness: HermeticRuntimeHarness | null = null

  afterEach(async () => {
    if (harness) {
      await harness.cleanup()
      harness = null
    }
  })

  it("runs the built runtime against an isolated machine-like sandbox", async () => {
    harness = await createHermeticRuntimeHarness()

    expect(harness.homeDir).not.toBe(process.env.HOME)
    expect(harness.bundlesRoot).toContain("AgentBundles")
    expect(harness.socketPath).toContain(".sock")
    expect(harness.fakeBinDir).toContain("bin")
  })

  it("boots, reports status, and stops when the provider live check succeeds", async () => {
    harness = await createHermeticRuntimeHarness({ providerMode: "ok" })

    const up = await harness.runCli(["up", "--no-repair"])
    expect(up.exitCode).toBe(0)
    expect(up.stdout).toContain("provider checks")
    expect(up.stdout).toContain("starting daemon")

    const status = await harness.runCli(["status"])
    expect(status.exitCode).toBe(0)
    expect(status.stdout).toContain("slugger")
    expect(status.stdout.toLowerCase()).toContain("running")

    const stop = await harness.runCli(["stop"])
    expect(stop.exitCode).toBe(0)
    expect(stop.stdout.toLowerCase()).toContain("stopped")
  })

  it("surfaces a truthful degraded message when the selected provider fails its live check", async () => {
    harness = await createHermeticRuntimeHarness({ providerMode: "fail-live-check" })

    const up = await harness.runCli(["up", "--no-repair"])
    expect(up.exitCode).toBe(0)
    expect(up.stdout).toContain("Provider checks need attention")
    expect(up.stdout).toContain("failed live check")
    expect(up.stdout).toContain("daemon not started")

    const status = await harness.runCli(["status"])
    expect(status.exitCode).toBe(0)
    expect(status.stdout.toLowerCase()).toContain("stopped")
  })
})
