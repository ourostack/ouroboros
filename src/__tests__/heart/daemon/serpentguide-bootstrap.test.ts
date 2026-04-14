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

describe("SerpentGuide bootstrap credentials", () => {
  it("returns to credential selection when a discovered credential fails ping", async () => {
    emitTestEvent("serpent guide retries stale discovered credential")

    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "serpentguide-bootstrap-"))
    fs.mkdirSync(path.join(bundlesRoot, "slugger.ouro"), { recursive: true })
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    const answers = ["1", "new", "minimax"]
    const question = vi.fn(async () => answers.shift() ?? "")
    const close = vi.fn()
    const runCliSession = vi.fn(async () => ({
      exitReason: "tool_exit",
      toolResult: JSON.stringify({ success: true, agentName: "Hatchling" }),
    }))
    const collectRuntimeAuthCredentials = vi.fn(async () => ({ apiKey: "mm-good" }))
    const pingProvider = vi.fn()
      .mockResolvedValueOnce({ ok: false, classification: "auth-failure", message: "stale token" })
      .mockResolvedValueOnce({ ok: true })

    try {
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
      vi.doMock("../../../heart/hatch/specialist-tools", () => ({
        getSpecialistTools: () => [],
        createSpecialistExecTool: vi.fn(() => ({ name: "exec" })),
      }))
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

      const result = await defaultRunSerpentGuide()

      expect(result).toBe("Hatchling")
      expect(pingProvider).toHaveBeenNthCalledWith(1, "minimax", { model: "MiniMax-M2.7", apiKey: "mm-stale" })
      expect(pingProvider).toHaveBeenNthCalledWith(2, "minimax", { model: "MiniMax-M2.7", apiKey: "mm-good" })
      expect(collectRuntimeAuthCredentials).toHaveBeenCalledWith(
        expect.objectContaining({ agentName: "SerpentGuide", provider: "minimax" }),
        {},
      )
      expect(close).toHaveBeenCalled()
      expect(stdoutWrite.mock.calls.map((call) => String(call[0])).join("")).toContain(
        "credentials didn't work (stale token). choose another saved credential or enter 'new'.",
      )
    } finally {
      fs.rmSync(bundlesRoot, { recursive: true, force: true })
    }
  })
})
