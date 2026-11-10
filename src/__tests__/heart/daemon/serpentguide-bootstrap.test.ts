import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const mockEmitNervesEvent = vi.fn()

function emitTestEvent(testName: string): void {
  mockEmitNervesEvent({
    component: "test",
    event: "test.case",
    message: testName,
    meta: {},
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
  vi.doUnmock("readline/promises")
  vi.doUnmock("crypto")
  vi.doUnmock("../../../senses/cli")
  vi.doUnmock("../../../heart/identity")
  vi.doUnmock("../../../heart/auth/auth-flow")
  vi.doUnmock("../../../heart/provider-ping")
  vi.doUnmock("../../../heart/daemon/provider-discovery")
  vi.doUnmock("../../../heart/hatch/specialist-orchestrator")
  vi.doUnmock("../../../heart/hatch/specialist-prompt")
  vi.doUnmock("../../../heart/hatch/specialist-tools")
  vi.doUnmock("../../../heart/core")
  vi.doUnmock("../../../heart/config")
  vi.doUnmock("../../../nerves/runtime")
  vi.doUnmock("../../../nerves")
})

type RunCliSession = (options: { exitOnToolResult?: (result: string) => boolean }) => Promise<{ exitReason: string; toolResult?: unknown }>

async function runGuide(runCliSession: RunCliSession) {
  const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "serpentguide-bootstrap-"))
  fs.mkdirSync(path.join(bundlesRoot, "slugger.ouro"), { recursive: true })
  const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

  const answers = ["1", "new", "minimax"]
  const question = vi.fn(async () => answers.shift() ?? "")
  const close = vi.fn()
  const collectRuntimeAuthCredentials = vi.fn(async () => ({ apiKey: "mm-good" }))
  const createSpecialistExecTool = vi.fn((_deps: unknown) => ({ name: "exec" }))
  const pingProvider = vi.fn()
  .mockResolvedValueOnce({ ok: false, classification: "auth-failure", message: "stale token" })
  .mockResolvedValueOnce({ ok: true })

  vi.doMock("readline/promises", () => ({
    createInterface: () => ({ question, close }),
  }))
  vi.doMock("crypto", async () => {
    const actual = await vi.importActual<typeof import("crypto")>("crypto")
    return { ...actual, randomUUID: () => "test-hatch-session" }
  })
  vi.doMock("../../../senses/cli", () => ({ runCliSession }))
  vi.doMock("../../../heart/identity", async () => {
    const actual = await vi.importActual<typeof import("../../../heart/identity")>("../../../heart/identity")
    return {
      ...actual,
      getAgentBundlesRoot: () => bundlesRoot,
      getRepoRoot: () => "/mock/repo",
      getAgentName: () => "SerpentGuide",
      getAgentRoot: (agentName = "SerpentGuide") => path.join(bundlesRoot, `${agentName}.ouro`),
      getAgentDaemonLogsDir: () => path.join(bundlesRoot, "SerpentGuide.ouro", "state", "daemon", "logs"),
      setAgentName: vi.fn(),
      setAgentConfigOverride: vi.fn(),
    }
  })
  vi.doMock("../../../heart/auth/auth-flow", async () => {
    const actual = await vi.importActual<typeof import("../../../heart/auth/auth-flow")>("../../../heart/auth/auth-flow")
    return {
      ...actual,
      collectRuntimeAuthCredentials,
      discoverGithubCopilotBaseUrl: vi.fn(async () => { throw new Error("no copilot here") }),
      runRuntimeAuthFlow: vi.fn(),
    }
  })
  vi.doMock("../../../heart/provider-ping", () => ({ pingProvider }))
  vi.doMock("../../../heart/daemon/provider-discovery", async () => {
    const actual = await vi.importActual<typeof import("../../../heart/daemon/provider-discovery")>("../../../heart/daemon/provider-discovery")
    return {
      ...actual,
      discoverInstalledAgentCredentials: vi.fn(async () => [{
        agentName: "slugger",
        provider: "minimax",
        credentials: { apiKey: "mm-stale" },
        providerConfig: {},
      }]),
      scanEnvVarCredentials: vi.fn(() => []),
    }
  })
  vi.doMock("../../../heart/hatch/specialist-orchestrator", () => ({
    listExistingBundles: () => ["slugger"],
    loadSoulText: () => "soul",
    pickRandomIdentity: () => ({ fileName: "guide.md", content: "identity" }),
    loadIdentityPhrases: () => ({
      thinking: ["thinking"],
      tool: ["tool"],
      followup: ["followup"],
    }),
  }))
  vi.doMock("../../../heart/hatch/specialist-prompt", () => ({
    buildSpecialistSystemPrompt: () => "system prompt",
  }))
  vi.doMock("../../../heart/hatch/specialist-tools", async () => {
    const actual = await vi.importActual<typeof import("../../../heart/hatch/specialist-tools")>("../../../heart/hatch/specialist-tools")
    return {
      parseAdoptionResult: actual.parseAdoptionResult,
      getSpecialistTools: () => [],
      createSpecialistExecTool,
    }
  })
  vi.doMock("../../../heart/core", () => ({ resetProviderRuntime: vi.fn() }))
  vi.doMock("../../../heart/config", () => ({ resetConfigCache: vi.fn() }))
  vi.doMock("../../../nerves/runtime", () => ({
    emitNervesEvent: (...args: unknown[]) => mockEmitNervesEvent(...args),
    setRuntimeLogger: vi.fn(),
  }))
  vi.doMock("../../../nerves", () => ({
    createLogger: vi.fn(() => ({})),
  }))

  const { defaultRunSerpentGuide } = await import("../../../heart/daemon/cli-defaults")
  try {
    const result = await defaultRunSerpentGuide()
    const stdout = stdoutWrite.mock.calls.map((call) => String(call[0])).join("")
    return { result, stdout, pingProvider, collectRuntimeAuthCredentials, close, createSpecialistExecTool }
  } finally {
    fs.rmSync(bundlesRoot, { recursive: true, force: true })
  }
}

describe("SerpentGuide bootstrap credentials", () => {
  it("returns to credential selection when a discovered credential fails ping", async () => {
    emitTestEvent("serpent guide retries stale discovered credential")
    const { result, stdout, pingProvider, collectRuntimeAuthCredentials, close } = await runGuide(async () => ({
      exitReason: "tool_exit",
      toolResult: JSON.stringify({ success: true, agentName: "Hatchling" }),
    }))

    expect(result).toBe("Hatchling")
    expect(pingProvider).toHaveBeenNthCalledWith(1, "minimax", { model: "MiniMax-M3", apiKey: "mm-stale" })
    expect(pingProvider).toHaveBeenNthCalledWith(2, "minimax", { model: "MiniMax-M3", apiKey: "mm-good" })
    expect(collectRuntimeAuthCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: "SerpentGuide", provider: "minimax" }),
      {},
    )
    expect(close).toHaveBeenCalled()
    expect(stdout).toContain("credentials didn't work (stale token). choose another saved credential or enter 'new'.")
  })

  it("keeps the guide open after a failed adoption and reports the failure when the human quits", async () => {
    emitTestEvent("serpent guide survives failed adoption")
    const decisions: boolean[] = []
    const { result, stdout } = await runGuide(async (options) => {
      decisions.push(options.exitOnToolResult!(JSON.stringify({ success: true, agentName: "Hatchling" })))
      decisions.push(options.exitOnToolResult!("error: failed to write secrets: vault server unreachable"))
      return { exitReason: "user_quit" }
    })

    expect(decisions).toEqual([true, false])
    expect(result).toBeNull()
    expect(stdout).toContain("hatch didn't finish: failed to write secrets: vault server unreachable")
    expect(stdout).not.toContain("ouro hatch error")
  })

  it("treats a plain-text adoption error that ends the session as a failed hatch, not a JSON crash", async () => {
    emitTestEvent("serpent guide reads plain-text adoption error")
    const { result, stdout } = await runGuide(async () => ({
      exitReason: "tool_exit",
      toolResult: "error: failed to write secrets: No supported secure local secret store",
    }))

    expect(result).toBeNull()
    expect(stdout).toContain("hatch didn't finish: failed to write secrets: No supported secure local secret store")
  })

  it("hands the terminal to the hidden vault-secret prompt", async () => {
    emitTestEvent("serpent guide wraps vault secret prompt")
    const { createSpecialistExecTool } = await runGuide(async () => ({ exitReason: "user_quit" }))
    const deps = createSpecialistExecTool.mock.calls[0][0] as { promptSecret: (question: string) => Promise<string> }
    const handoff = await import("../../../senses/terminal-handoff")
    const owner = { suspend: vi.fn(async () => undefined), resume: vi.fn() }
    const release = handoff.claimTerminal(owner)
    try {
      await expect(deps.promptSecret("Choose Ouro vault unlock secret: ")).rejects.toThrow("interactive terminal")
    } finally {
      release()
    }
    expect(owner.suspend).toHaveBeenCalledTimes(1)
    expect(owner.resume).toHaveBeenCalledTimes(1)
  })
})
