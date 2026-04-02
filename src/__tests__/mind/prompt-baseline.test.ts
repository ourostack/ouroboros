/**
 * Token baseline measurement for system prompts.
 * Captures character/token counts per channel and saves to artifacts directory.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
// Use dynamic require to bypass vitest's mock interception of fs
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realFs = require("node:fs") as typeof import("node:fs")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realPath = require("node:path") as typeof import("node:path")

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}))

vi.mock("../../repertoire/skills", () => ({
  listSkills: vi.fn(),
  loadSkill: vi.fn(),
}))

const mockGetBoard = vi.fn()
vi.mock("../../repertoire/tasks", () => ({
  getTaskModule: () => ({
    getBoard: mockGetBoard,
  }),
}))

vi.mock("../../heart/identity", () => {
  const DEFAULT_AGENT_CONTEXT = {
    maxTokens: 80000,
    contextMargin: 20,
  }
  return {
    DEFAULT_AGENT_CONTEXT,
    loadAgentConfig: vi.fn(() => ({
      name: "testagent",
      configPath: "~/.agentsecrets/testagent/secrets.json",
      provider: "minimax",
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      context: { ...DEFAULT_AGENT_CONTEXT },
    })),
    getAgentName: vi.fn(() => "testagent"),
    getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
    getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
    getRepoRoot: vi.fn(() => "/mock/repo"),
    getAgentRepoWorkspacesRoot: vi.fn(() => "/mock/repo/testagent/state/workspaces"),
    HARNESS_CANONICAL_REPO_URL: "https://github.com/ouroborosbot/ouroboros.git",
    resetIdentity: vi.fn(),
  }
})

vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: vi.fn() } }
    responses = { create: vi.fn() }
    constructor(_opts?: any) {}
  }
  return {
    default: MockOpenAI,
    AzureOpenAI: MockOpenAI,
  }
})

import * as fs from "fs"

const MOCK_SOUL = "i am a witty, funny, competent chaos monkey coding assistant.\ni get things done, crack jokes, embrace chaos, deliver quality."
const MOCK_IDENTITY = "i am Ouroboros.\ni use lowercase in my responses to the user except for proper nouns. no periods unless necessary. i never apply lowercase to code, file paths, environment variables, or tool arguments -- only to natural language output."
const MOCK_LORE = "i am named after the ouroboros -- the ancient symbol of a serpent eating its own tail."
const MOCK_TACIT_KNOWLEDGE = "i learned that structured logging is better than console.log."
const MOCK_ASPIRATIONS = "keep improving the harness and help people with real work."
const MOCK_PACKAGE_JSON = JSON.stringify({ version: "0.1.0-alpha.20" })

function setupReadFileSync() {
  vi.mocked(fs.readFileSync).mockImplementation((filePath: any, _encoding?: any) => {
    const p = String(filePath)
    if (p.endsWith("SOUL.md")) return MOCK_SOUL
    if (p.endsWith("IDENTITY.md")) return MOCK_IDENTITY
    if (p.endsWith("LORE.md")) return MOCK_LORE
    if (p.endsWith("FRIENDS.md")) return "my creator works at microsoft."
    if (p.endsWith("TACIT.md")) return MOCK_TACIT_KNOWLEDGE
    if (p.endsWith("ASPIRATIONS.md")) return MOCK_ASPIRATIONS
    if (p.endsWith("secrets.json")) return JSON.stringify({})
    if (p.endsWith("package.json")) return MOCK_PACKAGE_JSON
    return ""
  })
}

const PREFERRED_ARTIFACTS_DIR = "/Users/microsoft/AgentBundles/ouroboros.ouro/tasks/one-shots/2026-03-31-doing-claude-code-harness-improvements"
const ARTIFACTS_DIR = realFs.existsSync(realPath.dirname(PREFERRED_ARTIFACTS_DIR))
  ? PREFERRED_ARTIFACTS_DIR
  : realPath.join(require("os").tmpdir(), "ouroboros-baseline-artifacts")

// Ensure artifacts directory exists
realFs.mkdirSync(ARTIFACTS_DIR, { recursive: true })

describe("token baseline measurement", () => {
  beforeEach(() => {
    vi.resetModules()
    mockGetBoard.mockReset().mockReturnValue({
      compact: "",
      full: "",
      byStatus: {
        drafting: [],
        processing: [],
        validating: [],
        collaborating: [],
        paused: [],
        blocked: [],
        done: [],
        cancelled: [],
      },
      actionRequired: [],
      unresolvedDependencies: [],
      activeSessions: [],
    })
  })

  it("measures and records token baseline for all 5 channels", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])

    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")

    const channels = ["cli", "teams", "bluebubbles", "inner", "mcp"] as const
    const CONTEXT_WINDOW = 80000
    const CEILING_PERCENT = 20
    const ceiling = (CONTEXT_WINDOW * CEILING_PERCENT) / 100

    const results: Array<{ channel: string; chars: number; approxTokens: number; percent: string }> = []

    for (const channel of channels) {
      resetPsycheCache()
      const prompt = await buildSystem(channel)
      const chars = prompt.length
      const approxTokens = Math.ceil(chars / 4)
      const percent = ((approxTokens / CONTEXT_WINDOW) * 100).toFixed(1)
      results.push({ channel, chars, approxTokens, percent })

      // Hard assertion: each channel must be under ceiling
      expect(approxTokens, `${channel} exceeds ${CEILING_PERCENT}% ceiling`).toBeLessThan(ceiling)
    }

    // Build markdown report
    const lines = [
      "# Token Baseline Measurement (Pre-Phase-1)",
      "",
      `**Date**: ${new Date().toISOString().slice(0, 10)}`,
      `**Context window**: ${CONTEXT_WINDOW} tokens`,
      `**Hard ceiling**: ${CEILING_PERCENT}% = ${ceiling} tokens`,
      `**Method**: character count / 4 (approximation, no tokenizer dependency)`,
      "",
      "## Results",
      "",
      "| Channel | Characters | Approx Tokens | % of 80K |",
      "|---------|-----------|---------------|----------|",
    ]

    for (const r of results) {
      lines.push(`| ${r.channel} | ${r.chars} | ${r.approxTokens} | ${r.percent}% |`)
    }

    lines.push("")
    lines.push("## Analysis")
    lines.push("")

    const maxTokens = Math.max(...results.map(r => r.approxTokens))
    const maxChannel = results.find(r => r.approxTokens === maxTokens)!
    lines.push(`- Largest prompt: **${maxChannel.channel}** at ~${maxChannel.approxTokens} tokens (${maxChannel.percent}% of context)`)
    lines.push(`- All channels within ${CEILING_PERCENT}% ceiling (${ceiling} tokens)`)
    lines.push(`- Headroom: ${ceiling - maxTokens} tokens before ceiling`)

    lines.push("")
    lines.push("## Notes")
    lines.push("")
    lines.push("- Measurements use mock psyche files (shorter than production)")
    lines.push("- Production prompts are larger due to real psyche content, friend notes, active work frames, etc.")
    lines.push("- This baseline is conservative; actual prompts trend higher")

    const report = lines.join("\n")

    // Write to artifacts directory using real (unmocked) fs
    realFs.writeFileSync(realPath.join(ARTIFACTS_DIR, "baseline-tokens.md"), report, "utf-8")

    // Verify file was written
    const written = realFs.readFileSync(realPath.join(ARTIFACTS_DIR, "baseline-tokens.md"), "utf-8")
    expect(written).toContain("Token Baseline Measurement")
    expect(written).toContain("cli")
    expect(written).toContain("teams")
    expect(written).toContain("inner")
  })

  it("captures regression baseline prompts for each channel", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])

    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")

    const channels = ["cli", "teams", "bluebubbles", "inner", "mcp"] as const
    const channelDescriptions: Record<string, string> = {
      cli: "CLI coding session (has edit_file, shell, coding tools)",
      teams: "Teams 1:1 chat (has trust, feedback, social tools)",
      bluebubbles: "BlueBubbles group chat (has observe, group participation)",
      inner: "Inner dialog heartbeat (has metacognitive, journal tools)",
      mcp: "MCP channel (programmatic access)",
    }

    const regressionSignals = [
      "## Regression signals to watch",
      "",
      "- **Personality flattening**: Does the prompt retain humor, lowercase style, chaos-monkey energy?",
      "- **Lost metacognitive flow**: Does inner channel still get ponder/rest framing?",
      "- **ponder/rest/settle misuse**: Are tool contracts clear about when to use each?",
      "- **Friend note confusion**: Does context section clearly separate auto-loaded vs manual recall?",
      "- **Cross-session truth**: Does family trust section correctly reference live world-state?",
      "- **Tool behavior**: Is tool_choice=required + settle contract present and clear?",
    ]

    for (const channel of channels) {
      resetPsycheCache()
      const prompt = await buildSystem(channel)

      const header = [
        `# Regression Baseline: ${channel}`,
        "",
        `**Channel**: ${channel}`,
        `**Description**: ${channelDescriptions[channel]}`,
        `**Date**: ${new Date().toISOString().slice(0, 10)}`,
        `**Characters**: ${prompt.length}`,
        `**Approx tokens**: ${Math.ceil(prompt.length / 4)}`,
        "",
        ...regressionSignals,
        "",
        "---",
        "",
        "## Full assembled system prompt",
        "",
        prompt,
      ]

      const filename = `baseline-prompt-${channel}.md`
      realFs.writeFileSync(realPath.join(ARTIFACTS_DIR, filename), header.join("\n"), "utf-8")

      // Verify file was written with expected content
      const written = realFs.readFileSync(realPath.join(ARTIFACTS_DIR, filename), "utf-8")
      expect(written).toContain(`Regression Baseline: ${channel}`)
      expect(written).toContain("Full assembled system prompt")
    }
  })
})
