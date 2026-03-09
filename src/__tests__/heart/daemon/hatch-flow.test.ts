import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { afterEach, describe, expect, it } from "vitest"

import { runHatchFlow } from "../../../heart/daemon/hatch-flow"

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
}

describe("hatch flow", () => {
  const cleanup: string[] = []

  afterEach(() => {
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (!entry) continue
      fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  it("creates a canonical hatchling bundle with family imprint and heartbeat habit", async () => {
    const bundlesRoot = makeTempDir("hatch-bundles")
    const secretsRoot = makeTempDir("hatch-secrets")
    const specialistSource = makeTempDir("hatch-specialist")
    const specialistTarget = makeTempDir("hatch-specialist-target")
    cleanup.push(bundlesRoot, secretsRoot, specialistSource, specialistTarget)

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
        secretsRoot,
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
    expect(agentConfig.version).toBe(1)

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
    expect(friend.externalIds[0].externalId).toBe(`${os.userInfo().username}@${os.hostname()}`)

    const habitsDir = path.join(result.bundleRoot, "tasks", "habits")
    const heartbeatFiles = fs.readdirSync(habitsDir).filter((name) => name.includes("heartbeat"))
    expect(heartbeatFiles.length).toBe(1)
    const heartbeat = fs.readFileSync(path.join(habitsDir, heartbeatFiles[0]), "utf-8")
    expect(heartbeat).toContain("cadence: \"30m\"")
    expect(heartbeat).toContain("status: processing")
  })

  it("fails fast when required provider credentials are missing", async () => {
    const bundlesRoot = makeTempDir("hatch-bundles-missing")
    const secretsRoot = makeTempDir("hatch-secrets-missing")
    const specialistSource = makeTempDir("hatch-specialist-missing")
    const specialistTarget = makeTempDir("hatch-specialist-target-missing")
    cleanup.push(bundlesRoot, secretsRoot, specialistSource, specialistTarget)
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
          secretsRoot,
          specialistIdentitySourceDir: specialistSource,
          specialistIdentityTargetDir: specialistTarget,
          random: () => 0,
        },
      ),
    ).rejects.toThrow("Missing required credentials for anthropic")
  })

  it("writes provider-specific secrets for azure hatch flows", async () => {
    const bundlesRoot = makeTempDir("hatch-bundles-azure")
    const secretsRoot = makeTempDir("hatch-secrets-azure")
    const specialistSource = makeTempDir("hatch-specialist-azure")
    const specialistTarget = makeTempDir("hatch-specialist-target-azure")
    cleanup.push(bundlesRoot, secretsRoot, specialistSource, specialistTarget)
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
        secretsRoot,
        specialistIdentitySourceDir: specialistSource,
        specialistIdentityTargetDir: specialistTarget,
        random: () => 0,
      },
    )

    const secretsPath = path.join(secretsRoot, "AzureBot", "secrets.json")
    const secrets = JSON.parse(fs.readFileSync(secretsPath, "utf-8")) as {
      providers: {
        azure: { apiKey: string; endpoint: string; deployment: string }
      }
    }
    expect(secrets.providers.azure.apiKey).toBe("azure-key")
    expect(secrets.providers.azure.endpoint).toBe("https://example.openai.azure.com")
    expect(secrets.providers.azure.deployment).toBe("gpt-4o-mini")

    // Psyche files are no longer written by runHatchFlow (specialist writes them now)
    expect(fs.existsSync(path.join(result.bundleRoot, "psyche", "IDENTITY.md"))).toBe(false)
  })

  it("writes provider-specific secrets for openai-codex hatch flows", async () => {
    const bundlesRoot = makeTempDir("hatch-bundles-codex")
    const secretsRoot = makeTempDir("hatch-secrets-codex")
    const specialistSource = makeTempDir("hatch-specialist-codex")
    const specialistTarget = makeTempDir("hatch-specialist-target-codex")
    cleanup.push(bundlesRoot, secretsRoot, specialistSource, specialistTarget)
    fs.writeFileSync(path.join(specialistSource, "medusa.md"), "# Medusa\n", "utf-8")

    await runHatchFlow(
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
        secretsRoot,
        specialistIdentitySourceDir: specialistSource,
        specialistIdentityTargetDir: specialistTarget,
        random: () => 0,
      },
    )

    const secretsPath = path.join(secretsRoot, "CodexBot", "secrets.json")
    const secrets = JSON.parse(fs.readFileSync(secretsPath, "utf-8")) as {
      providers: {
        "openai-codex": { oauthAccessToken: string }
      }
    }
    expect(secrets.providers["openai-codex"].oauthAccessToken).toBe("oauth-token-123")
  })

  it("writes provider-specific secrets for minimax hatch flows", async () => {
    const bundlesRoot = makeTempDir("hatch-bundles-minimax")
    const secretsRoot = makeTempDir("hatch-secrets-minimax")
    const specialistSource = makeTempDir("hatch-specialist-minimax")
    const specialistTarget = makeTempDir("hatch-specialist-target-minimax")
    cleanup.push(bundlesRoot, secretsRoot, specialistSource, specialistTarget)
    fs.writeFileSync(path.join(specialistSource, "python.md"), "# Python\n", "utf-8")

    await runHatchFlow(
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
        secretsRoot,
        specialistIdentitySourceDir: specialistSource,
        specialistIdentityTargetDir: specialistTarget,
        random: () => 0,
      },
    )

    const secretsPath = path.join(secretsRoot, "MiniBot", "secrets.json")
    const secrets = JSON.parse(fs.readFileSync(secretsPath, "utf-8")) as {
      providers: {
        minimax: { apiKey: string }
      }
    }
    expect(secrets.providers.minimax.apiKey).toBe("minimax-key")
  })

  it("preserves existing README files and falls back to friend slug when human name is blank", async () => {
    const bundlesRoot = makeTempDir("hatch-bundles-readme")
    const secretsRoot = makeTempDir("hatch-secrets-readme")
    const specialistSource = makeTempDir("hatch-specialist-readme")
    const specialistTarget = makeTempDir("hatch-specialist-target-readme")
    cleanup.push(bundlesRoot, secretsRoot, specialistSource, specialistTarget)
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
      secretsRoot,
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

  it("writeSecretsFile creates correct anthropic secrets file", async () => {
    const secretsRoot = makeTempDir("hatch-secrets-ws-anthropic")
    cleanup.push(secretsRoot)

    const { writeSecretsFile } = await import("../../../heart/daemon/hatch-flow")
    const resultPath = writeSecretsFile("TestAgent", "anthropic", { setupToken: "sk-test-token" }, secretsRoot)

    expect(resultPath).toBe(path.join(secretsRoot, "TestAgent", "secrets.json"))
    const secrets = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as {
      providers: { anthropic: { setupToken: string } }
    }
    expect(secrets.providers.anthropic.setupToken).toBe("sk-test-token")
  })

  it("writeSecretsFile creates correct azure secrets file", async () => {
    const secretsRoot = makeTempDir("hatch-secrets-ws-azure")
    cleanup.push(secretsRoot)

    const { writeSecretsFile } = await import("../../../heart/daemon/hatch-flow")
    const resultPath = writeSecretsFile(
      "TestAgent",
      "azure",
      { apiKey: "az-key", endpoint: "https://az.test", deployment: "gpt-4o" },
      secretsRoot,
    )

    expect(resultPath).toBe(path.join(secretsRoot, "TestAgent", "secrets.json"))
    const secrets = JSON.parse(fs.readFileSync(resultPath, "utf-8")) as {
      providers: { azure: { apiKey: string; endpoint: string; deployment: string } }
    }
    expect(secrets.providers.azure.apiKey).toBe("az-key")
    expect(secrets.providers.azure.endpoint).toBe("https://az.test")
    expect(secrets.providers.azure.deployment).toBe("gpt-4o")
  })

  it("writeSecretsFile returns the path to the written secrets file", async () => {
    const secretsRoot = makeTempDir("hatch-secrets-ws-return")
    cleanup.push(secretsRoot)

    const { writeSecretsFile } = await import("../../../heart/daemon/hatch-flow")
    const resultPath = writeSecretsFile("ReturnTest", "minimax", { apiKey: "mm-key" }, secretsRoot)

    expect(resultPath).toBe(path.join(secretsRoot, "ReturnTest", "secrets.json"))
    expect(fs.existsSync(resultPath)).toBe(true)
  })

  it("uses default home, source, and target paths when optional deps are omitted", async () => {
    const tempCwd = makeTempDir("hatch-default-cwd")
    cleanup.push(tempCwd)

    const homeDir = os.homedir()
    const specialistBundleDir = path.join(homeDir, "AgentBundles", "AdoptionSpecialist.ouro")
    const sourceDir = path.join(specialistBundleDir, "psyche", "identities")
    fs.mkdirSync(sourceDir, { recursive: true })
    fs.writeFileSync(path.join(sourceDir, "python.md"), "# Python\n", "utf-8")

    const agentName = `DefaultsBot-${Date.now()}`
    const bundleRoot = path.join(homeDir, "AgentBundles", `${agentName}.ouro`)
    const secretsDir = path.join(homeDir, ".agentsecrets", agentName)
    const specialistSecretsDir = path.join(homeDir, ".agentsecrets", "AdoptionSpecialist")
    cleanup.push(bundleRoot, secretsDir, specialistBundleDir, specialistSecretsDir)

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
      })

      expect(result.bundleRoot).toBe(bundleRoot)
      expect(fs.existsSync(path.join(tempCwd, "AdoptionSpecialist.ouro", "psyche", "identities", "python.md"))).toBe(true)
      expect(fs.existsSync(path.join(secretsDir, "secrets.json"))).toBe(true)
    } finally {
      process.chdir(originalCwd)
    }
  })
})
