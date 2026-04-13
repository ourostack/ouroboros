import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"
import {
  listGithubCopilotModels,
  pingGithubCopilotModel,
  runOuroCli,
  type OuroCliDeps,
} from "../../../heart/daemon/daemon-cli"
import * as identity from "../../../heart/identity"

function emitTestEvent(testName: string): void {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.test_run",
    message: testName,
    meta: { test: true },
  })
}

const cleanup: string[] = []

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
  cleanup.push(dir)
  return dir
}

function writeAgentConfig(
  bundlesRoot: string,
  agentName: string,
  provider: string,
  model = "",
): void {
  const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
  fs.mkdirSync(agentRoot, { recursive: true })
  const config = {
    version: 2,
    enabled: true,
    provider,
    humanFacing: { provider, model },
    agentFacing: { provider, model },
    phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
    context: { maxTokens: 80000, contextMargin: 20 },
  }
  fs.writeFileSync(path.join(agentRoot, "agent.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8")
}

function seedSecrets(homeDir: string, agentName: string, secrets: Record<string, unknown>): void {
  const secretsDir = path.join(homeDir, ".agentsecrets", agentName)
  fs.mkdirSync(secretsDir, { recursive: true })
  fs.writeFileSync(path.join(secretsDir, "secrets.json"), JSON.stringify(secrets), "utf8")
}

function makeMockFetch(body: unknown, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch
}

/** Returns a fetch mock that serves different responses based on call order. */
function makeMockFetchSequence(responses: Array<{ body: unknown; status?: number }>): typeof fetch {
  let callIndex = 0
  return (async () => {
    const idx = callIndex < responses.length ? callIndex : responses.length - 1
    callIndex++
    const { body, status = 200 } = responses[idx]
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }
  }) as unknown as typeof fetch
}

function makeCliDeps(overrides: Partial<OuroCliDeps> = {}): OuroCliDeps {
  const output: string[] = []
  return {
    socketPath: "/tmp/test-socket",
    sendCommand: async () => ({ ok: true, summary: "" }),
    startDaemonProcess: async () => ({ pid: null }),
    writeStdout: (text: string) => output.push(text),
    checkSocketAlive: async () => false,
    cleanupStaleSocket: () => {},
    fallbackPendingMessage: () => "",
    ...overrides,
    _output: output,
  } as OuroCliDeps & { _output: string[] }
}

afterEach(() => {
  while (cleanup.length > 0) {
    const entry = cleanup.pop()
    if (!entry) continue
    fs.rmSync(entry, { recursive: true, force: true })
  }
})

describe("listGithubCopilotModels", () => {
  it("parses array response", async () => {
    emitTestEvent("listGithubCopilotModels array response")
    const body = [
      { id: "gpt-4o", name: "GPT-4o", capabilities: ["chat"] },
      { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
    ]
    const models = await listGithubCopilotModels("https://api.example.com", "tok", makeMockFetch(body))
    expect(models).toHaveLength(2)
    expect(models[0].id).toBe("gpt-4o")
    expect(models[0].capabilities).toEqual(["chat"])
    expect(models[1].id).toBe("claude-sonnet-4.6")
    expect(models[1].capabilities).toBeUndefined()
  })

  it("parses { data: [...] } response", async () => {
    emitTestEvent("listGithubCopilotModels data wrapper")
    const body = { data: [{ id: "model-a", name: "Model A" }] }
    const models = await listGithubCopilotModels("https://api.example.com", "tok", makeMockFetch(body))
    expect(models).toHaveLength(1)
    expect(models[0].id).toBe("model-a")
  })

  it("throws on non-ok response", async () => {
    emitTestEvent("listGithubCopilotModels error response")
    await expect(
      listGithubCopilotModels("https://api.example.com", "tok", makeMockFetch({}, 403)),
    ).rejects.toThrow("HTTP 403")
  })

  it("strips trailing slashes from baseUrl", async () => {
    emitTestEvent("listGithubCopilotModels trailing slash")
    let requestedUrl = ""
    const mockFetch = (async (url: string) => {
      requestedUrl = url
      return { ok: true, status: 200, json: async () => [] }
    }) as unknown as typeof fetch
    await listGithubCopilotModels("https://api.example.com/", "tok", mockFetch)
    expect(requestedUrl).toBe("https://api.example.com/models")
  })
})

describe("ouro config models execution", () => {
  it("lists models for github-copilot provider", async () => {
    emitTestEvent("config models github-copilot")
    const bundlesRoot = makeTempDir("config-models-ghc")
    const homeDir = makeTempDir("config-models-home")
    writeAgentConfig(bundlesRoot, "TestAgent", "github-copilot")
    seedSecrets(homeDir, "TestAgent", {
      providers: {
        "github-copilot": {
          model: "claude-sonnet-4.6",
          githubToken: "ghp_test",
          baseUrl: "https://api.copilot.example.com",
        },
      },
    })

    const bundlesSpy = vi.spyOn(identity, "getAgentBundlesRoot").mockReturnValue(bundlesRoot)
    const secretsSpy = vi.spyOn(identity, "getAgentSecretsPath")
      .mockReturnValue(path.join(homeDir, ".agentsecrets", "TestAgent", "secrets.json"))

    const body = [
      { id: "gpt-4o", name: "GPT-4o", capabilities: ["chat", "embeddings"] },
      { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
    ]
    const deps = makeCliDeps({ fetchImpl: makeMockFetch(body) })
    const result = await runOuroCli(["config", "models", "--agent", "TestAgent"], deps)

    expect(result).toContain("available models:")
    expect(result).toContain("gpt-4o")
    expect(result).toContain("claude-sonnet-4.6")
    expect(result).toContain("chat, embeddings")

    bundlesSpy.mockRestore()
    secretsSpy.mockRestore()
  })

  it("shows static message for non-github-copilot providers", async () => {
    emitTestEvent("config models non-ghc")
    const bundlesRoot = makeTempDir("config-models-azure")
    writeAgentConfig(bundlesRoot, "AzAgent", "azure")

    const bundlesSpy = vi.spyOn(identity, "getAgentBundlesRoot").mockReturnValue(bundlesRoot)

    const deps = makeCliDeps()
    const result = await runOuroCli(["config", "models", "--agent", "AzAgent"], deps)

    expect(result).toContain("model listing not available for azure")
    expect(result).toContain("check provider documentation")

    bundlesSpy.mockRestore()
  })

  it("throws when github-copilot credentials missing", async () => {
    emitTestEvent("config models missing creds")
    const bundlesRoot = makeTempDir("config-models-nocreds")
    const homeDir = makeTempDir("config-models-nocreds-home")
    writeAgentConfig(bundlesRoot, "NoCreds", "github-copilot")

    const bundlesSpy = vi.spyOn(identity, "getAgentBundlesRoot").mockReturnValue(bundlesRoot)
    const secretsSpy = vi.spyOn(identity, "getAgentSecretsPath")
      .mockReturnValue(path.join(homeDir, ".agentsecrets", "NoCreds", "secrets.json"))

    const deps = makeCliDeps()
    await expect(
      runOuroCli(["config", "models", "--agent", "NoCreds"], deps),
    ).rejects.toThrow("github-copilot credentials not configured")

    bundlesSpy.mockRestore()
    secretsSpy.mockRestore()
  })
})

describe("ouro config model validation for github-copilot", () => {
  it("rejects model not in available list", async () => {
    emitTestEvent("config model validation reject")
    const bundlesRoot = makeTempDir("config-model-validate")
    const homeDir = makeTempDir("config-model-validate-home")
    writeAgentConfig(bundlesRoot, "ValidAgent", "github-copilot")
    seedSecrets(homeDir, "ValidAgent", {
      providers: {
        "github-copilot": {
          model: "claude-sonnet-4.6",
          githubToken: "ghp_test",
          baseUrl: "https://api.copilot.example.com",
        },
      },
    })

    const bundlesSpy = vi.spyOn(identity, "getAgentBundlesRoot").mockReturnValue(bundlesRoot)
    const secretsSpy = vi.spyOn(identity, "getAgentSecretsPath")
      .mockReturnValue(path.join(homeDir, ".agentsecrets", "ValidAgent", "secrets.json"))

    const body = [{ id: "gpt-4o", name: "GPT-4o" }, { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" }]
    const deps = makeCliDeps({ fetchImpl: makeMockFetch(body) })
    const result = await runOuroCli(["config", "model", "--agent", "ValidAgent", "nonexistent-model"], deps)

    expect(result).toContain("not found")
    expect(result).toContain("gpt-4o")
    expect(result).toContain("claude-sonnet-4.6")

    bundlesSpy.mockRestore()
    secretsSpy.mockRestore()
  })

  it("allows model that is in the available list and ping succeeds", async () => {
    emitTestEvent("config model validation accept")
    const bundlesRoot = makeTempDir("config-model-valid")
    const homeDir = makeTempDir("config-model-valid-home")
    writeAgentConfig(bundlesRoot, "ValidAgent2", "github-copilot", "old-model")
    seedSecrets(homeDir, "ValidAgent2", {
      providers: {
        "github-copilot": {
          githubToken: "ghp_test",
          baseUrl: "https://api.copilot.example.com",
        },
      },
    })

    const bundlesSpy = vi.spyOn(identity, "getAgentBundlesRoot").mockReturnValue(bundlesRoot)
    const secretsSpy = vi.spyOn(identity, "getAgentSecretsPath")
      .mockReturnValue(path.join(homeDir, ".agentsecrets", "ValidAgent2", "secrets.json"))

    const catalogBody = [{ id: "gpt-4o", name: "GPT-4o" }, { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6" }]
    const deps = makeCliDeps({
      fetchImpl: makeMockFetchSequence([
        { body: catalogBody },       // catalog GET /models
        { body: { id: "resp-1" } },  // ping POST succeeds
      ]),
    })
    const result = await runOuroCli(["config", "model", "--agent", "ValidAgent2", "claude-sonnet-4.6"], deps)

    expect(result).toContain("updated ValidAgent2 model")
    expect(result).toContain("claude-sonnet-4.6")

    bundlesSpy.mockRestore()
    secretsSpy.mockRestore()
  })

  it("rejects when ping fails with network error", async () => {
    emitTestEvent("config model validation fetch fail")
    const bundlesRoot = makeTempDir("config-model-fetchfail")
    const homeDir = makeTempDir("config-model-fetchfail-home")
    writeAgentConfig(bundlesRoot, "FetchFail", "github-copilot")
    seedSecrets(homeDir, "FetchFail", {
      providers: {
        "github-copilot": {
          model: "old-model",
          githubToken: "ghp_test",
          baseUrl: "https://api.copilot.example.com",
        },
      },
    })

    const bundlesSpy = vi.spyOn(identity, "getAgentBundlesRoot").mockReturnValue(bundlesRoot)
    const secretsSpy = vi.spyOn(identity, "getAgentSecretsPath")
      .mockReturnValue(path.join(homeDir, ".agentsecrets", "FetchFail", "secrets.json"))

    const failingFetch = (async () => { throw new Error("network error") }) as unknown as typeof fetch
    const deps = makeCliDeps({ fetchImpl: failingFetch })
    const result = await runOuroCli(["config", "model", "--agent", "FetchFail", "any-model"], deps)

    // Ping fails — model switch is rejected
    expect(result).toContain("ping failed")
    expect(result).toContain("network error")

    bundlesSpy.mockRestore()
    secretsSpy.mockRestore()
  })

  it("rejects when ping returns HTTP error", async () => {
    emitTestEvent("config model ping http error")
    const bundlesRoot = makeTempDir("config-model-ping-http")
    const homeDir = makeTempDir("config-model-ping-http-home")
    writeAgentConfig(bundlesRoot, "PingFail", "github-copilot")
    seedSecrets(homeDir, "PingFail", {
      providers: {
        "github-copilot": {
          model: "old-model",
          githubToken: "ghp_test",
          baseUrl: "https://api.copilot.example.com",
        },
      },
    })

    const bundlesSpy = vi.spyOn(identity, "getAgentBundlesRoot").mockReturnValue(bundlesRoot)
    const secretsSpy = vi.spyOn(identity, "getAgentSecretsPath")
      .mockReturnValue(path.join(homeDir, ".agentsecrets", "PingFail", "secrets.json"))

    const deps = makeCliDeps({
      fetchImpl: makeMockFetchSequence([
        { body: [{ id: "gpt-4o", name: "GPT-4o" }] },                              // catalog OK
        { body: { error: { message: "model not supported" } }, status: 403 },       // ping 403
      ]),
    })
    const result = await runOuroCli(["config", "model", "--agent", "PingFail", "gpt-4o"], deps)

    expect(result).toContain("ping failed")
    expect(result).toContain("model not supported")
    expect(result).toContain("ouro config models")

    bundlesSpy.mockRestore()
    secretsSpy.mockRestore()
  })

  it("skips validation for non-github-copilot providers", async () => {
    emitTestEvent("config model validation skip non-ghc")
    const bundlesRoot = makeTempDir("config-model-azure")
    const homeDir = makeTempDir("config-model-azure-home")
    writeAgentConfig(bundlesRoot, "AzModel", "anthropic", "claude-opus-4-6")
    seedSecrets(homeDir, "AzModel", {
      providers: {
        anthropic: { setupToken: "tok" },
      },
    })

    const bundlesSpy = vi.spyOn(identity, "getAgentBundlesRoot").mockReturnValue(bundlesRoot)
    const secretsSpy = vi.spyOn(identity, "getAgentSecretsPath")
      .mockReturnValue(path.join(homeDir, ".agentsecrets", "AzModel", "secrets.json"))

    const deps = makeCliDeps()
    const result = await runOuroCli(["config", "model", "--agent", "AzModel", "claude-sonnet-4.6"], deps)

    expect(result).toContain("updated AzModel model")

    bundlesSpy.mockRestore()
    secretsSpy.mockRestore()
  })
})

describe("pingGithubCopilotModel", () => {
  it("returns ok for successful ping", async () => {
    emitTestEvent("pingGithubCopilotModel success")
    const mockFetch = makeMockFetch({ id: "resp-1" })
    const result = await pingGithubCopilotModel("https://api.example.com", "tok", "gpt-4o", mockFetch)
    expect(result).toEqual({ ok: true })
  })

  it("uses /chat/completions for claude models", async () => {
    emitTestEvent("pingGithubCopilotModel claude endpoint")
    let requestedUrl = ""
    let requestedBody = ""
    const mockFetch = (async (url: string, init: RequestInit) => {
      requestedUrl = url as string
      requestedBody = init?.body as string
      return { ok: true, status: 200, json: async () => ({}) }
    }) as unknown as typeof fetch
    await pingGithubCopilotModel("https://api.example.com", "tok", "claude-sonnet-4.6", mockFetch)
    expect(requestedUrl).toBe("https://api.example.com/chat/completions")
    expect(JSON.parse(requestedBody)).toMatchObject({ model: "claude-sonnet-4.6", max_tokens: 1 })
  })

  it("uses /responses for non-claude models", async () => {
    emitTestEvent("pingGithubCopilotModel gpt endpoint")
    let requestedUrl = ""
    let requestedBody = ""
    const mockFetch = (async (url: string, init: RequestInit) => {
      requestedUrl = url as string
      requestedBody = init?.body as string
      return { ok: true, status: 200, json: async () => ({}) }
    }) as unknown as typeof fetch
    await pingGithubCopilotModel("https://api.example.com", "tok", "gpt-4o", mockFetch)
    expect(requestedUrl).toBe("https://api.example.com/responses")
    expect(JSON.parse(requestedBody)).toMatchObject({ model: "gpt-4o", input: "ping", max_output_tokens: 16 })
  })

  it("returns error detail from JSON error response", async () => {
    emitTestEvent("pingGithubCopilotModel error json")
    const mockFetch = makeMockFetch({ error: { message: "model not available" } }, 403)
    const result = await pingGithubCopilotModel("https://api.example.com", "tok", "gpt-4o", mockFetch)
    expect(result).toEqual({ ok: false, error: "model not available" })
  })

  it("retries failed model pings before succeeding", async () => {
    emitTestEvent("pingGithubCopilotModel retry success")
    let calls = 0
    const mockFetch = (async () => {
      calls++
      if (calls < 3) {
        return { ok: false, status: 503, json: async () => ({ message: "temporarily down" }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    }) as unknown as typeof fetch

    const result = await pingGithubCopilotModel("https://api.example.com", "tok", "gpt-4o", mockFetch)

    expect(result).toEqual({ ok: true })
    expect(calls).toBe(3)
  })

  it("returns error string from flat error field", async () => {
    emitTestEvent("pingGithubCopilotModel error string")
    const mockFetch = makeMockFetch({ error: "forbidden" }, 403)
    const result = await pingGithubCopilotModel("https://api.example.com", "tok", "gpt-4o", mockFetch)
    expect(result).toEqual({ ok: false, error: "forbidden" })
  })

  it("returns HTTP status when response body is not JSON", async () => {
    emitTestEvent("pingGithubCopilotModel non-json error")
    const mockFetch = (async () => ({
      ok: false,
      status: 500,
      json: async () => { throw new Error("not json") },
    })) as unknown as typeof fetch
    const result = await pingGithubCopilotModel("https://api.example.com", "tok", "gpt-4o", mockFetch)
    expect(result).toEqual({ ok: false, error: "HTTP 500" })
  })

  it("returns network error message on fetch failure", async () => {
    emitTestEvent("pingGithubCopilotModel network error")
    const mockFetch = (async () => { throw new Error("ECONNREFUSED") }) as unknown as typeof fetch
    const result = await pingGithubCopilotModel("https://api.example.com", "tok", "gpt-4o", mockFetch)
    expect(result).toEqual({ ok: false, error: "ECONNREFUSED" })
  })

  it("strips trailing slashes from baseUrl", async () => {
    emitTestEvent("pingGithubCopilotModel trailing slash")
    let requestedUrl = ""
    const mockFetch = (async (url: string) => {
      requestedUrl = url as string
      return { ok: true, status: 200, json: async () => ({}) }
    }) as unknown as typeof fetch
    await pingGithubCopilotModel("https://api.example.com/", "tok", "gpt-4o", mockFetch)
    expect(requestedUrl).toBe("https://api.example.com/responses")
  })
})
