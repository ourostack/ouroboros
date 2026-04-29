import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { afterEach, describe, expect, it, vi } from "vitest"

const mockStoreProviderCredentials = vi.hoisted(() =>
  vi.fn(async (agentName: string, provider: string, _credentials: Record<string, unknown>) => ({
    credentialPath: `vault:${agentName}:providers/${provider}`,
  })),
)

vi.mock("../../../heart/auth/auth-flow", () => ({
  storeProviderCredentials: mockStoreProviderCredentials,
}))

import { runHatchFlow } from "../../../heart/hatch/hatch-flow"
import { getDefaultModelForProvider } from "../../../heart/provider-models"
import { readProviderState } from "../../../heart/provider-state"

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
}

describe("hatch flow", () => {
  const cleanup: string[] = []

  afterEach(() => {
    mockStoreProviderCredentials.mockClear()
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (!entry) continue
      fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  it("creates a canonical hatchling bundle with family imprint and heartbeat habit", async () => {
    const bundlesRoot = makeTempDir("hatch-bundles")
    const specialistSource = makeTempDir("hatch-specialist")
    const specialistTarget = makeTempDir("hatch-specialist-target")
    cleanup.push(bundlesRoot, specialistSource, specialistTarget)

    fs.writeFileSync(path.join(specialistSource, "medusa.md"), "# Medusa\n", "utf-8")
    fs.writeFileSync(path.join(specialistSource, "python.md"), "# Python\n", "utf-8")

    const result = await runHatchFlow(
      {
        agentName: "Hatchling",
        humanName: "Ari",
        provider: "anthropic",
        credentials: {
          setupToken: `sk-ant-oat01-${"a".repeat(80)}`,
        },
      },
      {
        bundlesRoot,
        specialistIdentitySourceDir: specialistSource,
        specialistIdentityTargetDir: specialistTarget,
        now: () => new Date("2026-03-07T00:00:00.000Z"),
        random: () => 0.99,
      },
    )

    expect(result.bundleRoot).toBe(path.join(bundlesRoot, "Hatchling.ouro"))
    expect(result.selectedIdentity).toBe("python.md")

    const agentConfig = JSON.parse(
      fs.readFileSync(path.join(result.bundleRoot, "agent.json"), "utf-8"),
    ) as Record<string, unknown>
    expect(agentConfig.enabled).toBe(true)
    expect(agentConfig.provider).toBe("anthropic")
    expect(agentConfig.version).toBe(2)
    expect(agentConfig.humanFacing).toEqual({ provider: "anthropic", model: "claude-opus-4-6" })
    expect(agentConfig.agentFacing).toEqual({ provider: "anthropic", model: "claude-opus-4-6" })

    const friendDir = path.join(result.bundleRoot, "friends")
    const friendFiles = fs.readdirSync(friendDir).filter((name) => name.endsWith(".json"))
    expect(friendFiles.length).toBe(1)
    const friend = JSON.parse(fs.readFileSync(path.join(friendDir, friendFiles[0]), "utf-8")) as {
      name: string
      trustLevel: string
      externalIds: { provider: string; externalId: string }[]
    }
    expect(friend.name).toBe("Ari")
    expect(friend.trustLevel).toBe("family")
    expect(friend.externalIds[0].provider).toBe("local")
    expect(friend.externalIds[0].externalId).toBe(os.userInfo().username)

    // habits/ dir at bundle root (not tasks/habits/)
    const habitsDir = path.join(result.bundleRoot, "habits")
    expect(fs.existsSync(habitsDir)).toBe(true)
    expect(fs.existsSync(path.join(habitsDir, "README.md"))).toBe(true)

    // heartbeat.md with new simple schema (no timestamp prefix, no task cruft)
    const heartbeatPath = path.join(habitsDir, "heartbeat.md")
    expect(fs.existsSync(heartbeatPath)).toBe(true)
    const heartbeat = fs.readFileSync(heartbeatPath, "utf-8")
    expect(heartbeat).toContain("title: Heartbeat check-in")
    expect(heartbeat).toContain("cadence: 30m")
    expect(heartbeat).toContain("status: active")
    expect(heartbeat).not.toContain("lastRun:")
    expect(heartbeat).toContain("created:")
    // Should NOT have task-system fields
    expect(heartbeat).not.toContain("type:")
    expect(heartbeat).not.toContain("category:")
    expect(heartbeat).not.toContain("requester:")
    expect(heartbeat).not.toContain("validator:")
    expect(heartbeat).not.toContain("scheduledAt:")
    expect(heartbeat).not.toContain("updated:")
    // Body should still be present
    expect(heartbeat).toContain("Run a lightweight heartbeat cycle")

    // tasks/habits/ should NOT be created
    expect(fs.existsSync(path.join(result.bundleRoot, "tasks", "habits"))).toBe(false)
  })

  it("creates bootstrapped local provider state for the hatchling machine", async () => {
    const homeDir = makeTempDir("hatch-provider-state-home")
    const bundlesRoot = path.join(homeDir, "AgentBundles")
    const specialistSource = makeTempDir("hatch-provider-state-specialist")
    const specialistTarget = makeTempDir("hatch-provider-state-specialist-target")
    cleanup.push(homeDir, specialistSource, specialistTarget)

    fs.writeFileSync(path.join(specialistSource, "medusa.md"), "# Medusa\n", "utf-8")

    const result = await runHatchFlow(
      {
        agentName: "ProviderStateBot",
        humanName: "Ari",
        provider: "minimax",
        credentials: {
          apiKey: "minimax-secret-key",
        },
      },
      {
        bundlesRoot,
        specialistIdentitySourceDir: specialistSource,
        specialistIdentityTargetDir: specialistTarget,
        now: () => new Date("2026-04-12T22:15:00.000Z"),
        random: () => 0,
      },
    )

    const stateResult = readProviderState(result.bundleRoot)
    expect(stateResult.ok).toBe(true)
    if (!stateResult.ok) throw new Error(stateResult.error)
    expect(stateResult.state.machineId).toMatch(/^machine_/)
    expect(stateResult.state.updatedAt).toBe("2026-04-12T22:15:00.000Z")
    const expectedModel = getDefaultModelForProvider("minimax")
    expect(stateResult.state.lanes.outward).toMatchObject({
      provider: "minimax",
      model: expectedModel,
      source: "bootstrap",
      updatedAt: "2026-04-12T22:15:00.000Z",
    })
    expect(stateResult.state.lanes.inner).toMatchObject({
      provider: "minimax",
      model: expectedModel,
      source: "bootstrap",
      updatedAt: "2026-04-12T22:15:00.000Z",
    })
    expect(stateResult.state.readiness).toEqual({})
    expect(JSON.stringify(stateResult.state)).not.toContain("minimax-secret-key")
  })

  it("creates a machine identity while bootstrapping provider state from the default provider credential home", async () => {
    const homeDir = makeTempDir("hatch-provider-state-default-home")
    const bundlesRoot = path.join(homeDir, "AgentBundles")
    const specialistSource = makeTempDir("hatch-provider-state-default-specialist")
    const specialistTarget = makeTempDir("hatch-provider-state-default-specialist-target")
    cleanup.push(homeDir, specialistSource, specialistTarget)
    fs.writeFileSync(path.join(specialistSource, "medusa.md"), "# Medusa\n", "utf-8")

    vi.resetModules()
    vi.doMock("../../../heart/provider-credentials", async () => {
      const actual = await vi.importActual<typeof import("../../../heart/provider-credentials")>("../../../heart/provider-credentials")
      return {
        ...actual,
        providerCredentialMachineHomeDir: () => homeDir,
      }
    })

    try {
      const { runHatchFlow: runIsolatedHatchFlow } = await import("../../../heart/hatch/hatch-flow")
      const result = await runIsolatedHatchFlow(
        {
          agentName: "DefaultProviderHomeBot",
          humanName: "Ari",
          provider: "minimax",
          credentials: { apiKey: "minimax-key" },
        },
        {
          bundlesRoot,
          specialistIdentitySourceDir: specialistSource,
          specialistIdentityTargetDir: specialistTarget,
          now: () => new Date("2026-04-12T22:16:00.000Z"),
          random: () => 0,
        },
      )

      const stateResult = readProviderState(result.bundleRoot)
      expect(stateResult.ok).toBe(true)
      if (!stateResult.ok) throw new Error(stateResult.error)
      expect(stateResult.state.updatedAt).toBe("2026-04-12T22:16:00.000Z")
      expect(fs.existsSync(path.join(homeDir, ".ouro-cli", "machine.json"))).toBe(true)
    } finally {
      vi.doUnmock("../../../heart/provider-credentials")
      vi.resetModules()
    }
  })

  it("fails fast when required provider credentials are missing", async () => {
    const bundlesRoot = makeTempDir("hatch-bundles-missing")
    const specialistSource = makeTempDir("hatch-specialist-missing")
    const specialistTarget = makeTempDir("hatch-specialist-target-missing")
    cleanup.push(bundlesRoot, specialistSource, specialistTarget)
    fs.writeFileSync(path.join(specialistSource, "medusa.md"), "# Medusa\n", "utf-8")

    await expect(() =>
      runHatchFlow(
        {
          agentName: "NoKey",
          humanName: "Ari",
          provider: "anthropic",
          credentials: {},
        },
        {
          bundlesRoot,
          specialistIdentitySourceDir: specialistSource,
          specialistIdentityTargetDir: specialistTarget,
          random: () => 0,
        },
      ),
    ).rejects.toThrow("Missing required credentials for anthropic")
  })

  it("writes provider-specific secrets for azure hatch flows", async () => {
    const bundlesRoot = makeTempDir("hatch-bundles-azure")
    const specialistSource = makeTempDir("hatch-specialist-azure")
    const specialistTarget = makeTempDir("hatch-specialist-target-azure")
    cleanup.push(bundlesRoot, specialistSource, specialistTarget)
    fs.writeFileSync(path.join(specialistSource, "medusa.md"), "# Medusa\n", "utf-8")

    const result = await runHatchFlow(
      {
        agentName: "AzureBot",
        humanName: "Ari",
        provider: "azure",
        credentials: {
          apiKey: "azure-key",
          endpoint: "https://example.openai.azure.com",
          deployment: "gpt-4o-mini",
        },
      },
      {
        bundlesRoot,
        specialistIdentitySourceDir: specialistSource,
        specialistIdentityTargetDir: specialistTarget,
        random: () => 0,
      },
    )

    expect(result.credentialPath).toBe("vault:AzureBot:providers/azure")
    expect(mockStoreProviderCredentials).toHaveBeenLastCalledWith("AzureBot", "azure", {
      apiKey: "azure-key",
      endpoint: "https://example.openai.azure.com",
      deployment: "gpt-4o-mini",
    })

    // Psyche files are no longer written by runHatchFlow (specialist writes them now)
    expect(fs.existsSync(path.join(result.bundleRoot, "psyche", "IDENTITY.md"))).toBe(false)
  })

  it("writes provider-specific secrets for openai-codex hatch flows", async () => {
    const bundlesRoot = makeTempDir("hatch-bundles-codex")
    const specialistSource = makeTempDir("hatch-specialist-codex")
    const specialistTarget = makeTempDir("hatch-specialist-target-codex")
    cleanup.push(bundlesRoot, specialistSource, specialistTarget)
    fs.writeFileSync(path.join(specialistSource, "medusa.md"), "# Medusa\n", "utf-8")

    const result = await runHatchFlow(
      {
        agentName: "CodexBot",
        humanName: "Ari",
        provider: "openai-codex",
        credentials: {
          oauthAccessToken: "oauth-token-123",
        },
      },
      {
        bundlesRoot,
        specialistIdentitySourceDir: specialistSource,
        specialistIdentityTargetDir: specialistTarget,
        random: () => 0,
      },
    )

    expect(result.credentialPath).toBe("vault:CodexBot:providers/openai-codex")
    expect(mockStoreProviderCredentials).toHaveBeenLastCalledWith("CodexBot", "openai-codex", {
      oauthAccessToken: "oauth-token-123",
    })

    const agentConfig = JSON.parse(fs.readFileSync(path.join(result.bundleRoot, "agent.json"), "utf-8")) as Record<string, any>
    expect(agentConfig.humanFacing).toEqual({ provider: "openai-codex", model: "gpt-5.4" })
    expect(agentConfig.agentFacing).toEqual({ provider: "openai-codex", model: "gpt-5.4" })
  })

  it("writes provider-specific secrets for minimax hatch flows", async () => {
    const bundlesRoot = makeTempDir("hatch-bundles-minimax")
    const specialistSource = makeTempDir("hatch-specialist-minimax")
    const specialistTarget = makeTempDir("hatch-specialist-target-minimax")
    cleanup.push(bundlesRoot, specialistSource, specialistTarget)
    fs.writeFileSync(path.join(specialistSource, "python.md"), "# Python\n", "utf-8")

    const result = await runHatchFlow(
      {
        agentName: "MiniBot",
        humanName: "Ari",
        provider: "minimax",
        credentials: {
          apiKey: "minimax-key",
        },
      },
      {
        bundlesRoot,
        specialistIdentitySourceDir: specialistSource,
        specialistIdentityTargetDir: specialistTarget,
        random: () => 0,
      },
    )

    expect(result.credentialPath).toBe("vault:MiniBot:providers/minimax")
    expect(mockStoreProviderCredentials).toHaveBeenLastCalledWith("MiniBot", "minimax", {
      apiKey: "minimax-key",
    })
  })

  it("preserves existing README files and falls back to friend slug when human name is blank", async () => {
    const bundlesRoot = makeTempDir("hatch-bundles-readme")
    const specialistSource = makeTempDir("hatch-specialist-readme")
    const specialistTarget = makeTempDir("hatch-specialist-target-readme")
    cleanup.push(bundlesRoot, specialistSource, specialistTarget)
    fs.writeFileSync(path.join(specialistSource, "medusa.md"), "# Medusa\n", "utf-8")

    const baseInput = {
      agentName: "ReadmeBot",
      humanName: "   ",
      provider: "minimax" as const,
      credentials: {
        apiKey: "minimax-key",
      },
    }
    const deps = {
      bundlesRoot,
      specialistIdentitySourceDir: specialistSource,
      specialistIdentityTargetDir: specialistTarget,
      random: () => 0,
    }

    const first = await runHatchFlow(baseInput, deps)
    const friendFiles = fs.readdirSync(path.join(first.bundleRoot, "friends"))
    expect(friendFiles).toContain("friend-friend.json")

    const readmePath = path.join(first.bundleRoot, "skills", "README.md")
    fs.writeFileSync(readmePath, "# skills\n\ncustom readme\n", "utf-8")

    await runHatchFlow(baseInput, deps)

    expect(fs.readFileSync(readmePath, "utf-8")).toContain("custom readme")
  })

  it("uses default home, source, and target paths when optional deps are omitted", async () => {
    // Layer 3: the `~/AgentBundles/SerpentGuide.ouro/` override is gone —
    // `getSpecialistIdentitySourceDir()` now returns the in-repo path
    // unconditionally. This test mirrors the previous fixture but provides
    // the source via `specialistIdentitySourceDir` (since the in-repo path
    // would otherwise resolve to the actual repo at runtime, polluting
    // test state).
    const tempCwd = makeTempDir("hatch-default-cwd")
    cleanup.push(tempCwd)

    const homeDir = os.homedir()
    const explicitSourceDir = makeTempDir("hatch-default-source")
    cleanup.push(explicitSourceDir)
    fs.writeFileSync(path.join(explicitSourceDir, "python.md"), "# Python\n", "utf-8")

    const agentName = `DefaultsBot-${Date.now()}`
    const bundleRoot = path.join(homeDir, "AgentBundles", `${agentName}.ouro`)
    cleanup.push(bundleRoot)

    const originalCwd = process.cwd()
    try {
      process.chdir(tempCwd)
      const result = await runHatchFlow({
        agentName,
        humanName: "Ari",
        provider: "anthropic",
        credentials: {
          setupToken: `sk-ant-oat01-${"b".repeat(80)}`,
        },
      }, { specialistIdentitySourceDir: explicitSourceDir })

      expect(result.bundleRoot).toBe(bundleRoot)
      expect(fs.existsSync(path.join(tempCwd, "SerpentGuide.ouro", "psyche", "identities", "python.md"))).toBe(true)
      expect(result.credentialPath).toBe(`vault:${agentName}:providers/anthropic`)
    } finally {
      process.chdir(originalCwd)
    }
  })

  it("falls through to getSpecialistIdentitySourceDir() when specialistIdentitySourceDir is not in deps", async () => {
    // Covers the RHS branch of the `?? getSpecialistIdentitySourceDir()`
    // operator at hatch-flow.ts:183. Without this test, the production
    // code path (deps override absent) is unreachable from the test
    // suite — branch coverage stays at 99.99% even though both sides
    // of the `??` are syntactically reachable.
    const homeDir = os.homedir()
    const explicitTargetDir = makeTempDir("hatch-default-target")
    cleanup.push(explicitTargetDir)

    const agentName = `SourceFallbackBot-${Date.now()}`
    const bundleRoot = path.join(homeDir, "AgentBundles", `${agentName}.ouro`)
    cleanup.push(bundleRoot)

    const result = await runHatchFlow({
      agentName,
      humanName: "Ari",
      provider: "anthropic",
      credentials: {
        setupToken: `sk-ant-oat01-${"c".repeat(80)}`,
      },
    }, { specialistIdentityTargetDir: explicitTargetDir })

    expect(result.bundleRoot).toBe(bundleRoot)
    // Source resolves to the in-repo SerpentGuide.ouro path via the
    // production resolver. Identities directory will have been populated
    // from whatever ships in-repo today.
    expect(fs.readdirSync(explicitTargetDir).length).toBeGreaterThan(0)
    expect(result.credentialPath).toBe(`vault:${agentName}:providers/anthropic`)
  })
})
