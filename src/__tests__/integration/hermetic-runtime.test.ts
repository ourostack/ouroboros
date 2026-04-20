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

  it("renders the noninteractive connections screen from the built runtime with live provider truth", async () => {
    harness = await createHermeticRuntimeHarness({ providerMode: "ok" })

    const connect = await harness.runCli(["connect", "--agent", "slugger"])

    expect(connect.exitCode).toBe(0)
    expect(connect.stdout).toContain("slugger connections")
    expect(connect.stdout).toContain("Providers")
    expect(connect.stdout).toContain("Providers [ready]")
    expect(connect.stdout).toContain("Perplexity search [missing]")
    expect(connect.stdout).toContain("Memory embeddings [missing]")
    expect(connect.stdout).toContain("run: ouro connect perplexity --agent slugger")
  })

  it("keeps connections-screen provider guidance truthful when the live provider check fails", async () => {
    harness = await createHermeticRuntimeHarness({ providerMode: "fail-live-check" })

    const connect = await harness.runCli(["connect", "--agent", "slugger"])

    expect(connect.exitCode).toBe(0)
    expect(connect.stdout).toContain("slugger connections")
    expect(connect.stdout).toContain("Providers - needs attention")
    expect(connect.stdout).toContain("Outward lane: github-copilot / claude-sonnet-4.6")
    expect(connect.stdout).toContain("failed live check")
    expect(connect.stdout).toContain("run: ouro auth --agent slugger --provider github-copilot")
  })

  it("cleans up idempotently after a started daemon", async () => {
    harness = await createHermeticRuntimeHarness({ providerMode: "ok" })

    const up = await harness.runCli(["up", "--no-repair"])
    expect(up.exitCode).toBe(0)

    await expect(harness.cleanup()).resolves.toBeUndefined()
    await expect(harness.cleanup()).resolves.toBeUndefined()
    harness = null
  })
})
