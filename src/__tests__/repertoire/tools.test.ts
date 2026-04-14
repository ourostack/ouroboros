import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
}))

// Hard-mock the daemon socket client. The runtime guard in socket-client.ts
// already prevents real socket calls under vitest (by detecting process.argv),
// but the explicit mock lets tests that care assert on call counts and avoids
// the per-file allowlist in test-isolation.contract.test.ts.
vi.mock("../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}))

vi.mock("../../repertoire/skills", () => ({
  listSkills: vi.fn(),
  loadSkill: vi.fn(),
}))

vi.mock("../../repertoire/graph-client", () => ({
  getProfile: vi.fn(),
  graphRequest: vi.fn(),
}))

vi.mock("../../repertoire/ado-client", () => ({
  queryWorkItems: vi.fn(),
  adoRequest: vi.fn(),
  discoverOrganizations: vi.fn(),
}))

vi.mock("../../repertoire/github-client", () => ({
  githubRequest: vi.fn(),
}))

const mockTaskModule = {
  getBoard: vi.fn(),
  createTask: vi.fn(),
  updateStatus: vi.fn(),
  boardStatus: vi.fn(),
  boardAction: vi.fn(),
  boardDeps: vi.fn(),
  boardSessions: vi.fn(),
}

vi.mock("../../repertoire/tasks", () => ({
  getTaskModule: () => mockTaskModule,
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
      provider: "minimax",
      context: { ...DEFAULT_AGENT_CONTEXT },
    })),
    getAgentName: vi.fn(() => "testagent"),
    getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
    getRepoRoot: vi.fn(() => "/mock/repo"),
    getAgentRepoWorkspacesRoot: vi.fn(() => "/mock/repo/testagent/state/workspaces"),
    HARNESS_CANONICAL_REPO_URL: "https://github.com/ouroborosbot/ouroboros.git",
    resetIdentity: vi.fn(),
  }
})

import * as fs from "fs"
import { execSync, spawnSync } from "child_process"
import { listSkills, loadSkill } from "../../repertoire/skills"

describe("execTool", () => {
  let execTool: (name: string, args: any, ctx?: any) => Promise<string>
  let patchRuntimeConfig: (partial: any) => void

  afterEach(() => {
    vi.restoreAllMocks()
  })

  beforeEach(async () => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReset()
    vi.mocked(fs.readFileSync).mockReset()
    vi.mocked(fs.writeFileSync).mockReset()
    vi.mocked(fs.readdirSync).mockReset()
    vi.mocked(fs.rmSync).mockReset()
    vi.mocked(execSync).mockReset()
    vi.mocked(spawnSync).mockReset()
    vi.mocked(listSkills).mockReset()
    vi.mocked(loadSkill).mockReset()
    mockTaskModule.getBoard.mockReset().mockReturnValue({
      compact: "[Tasks] drafting:0 processing:0 validating:0 collaborating:0 paused:0 blocked:0 done:0",
      full: "no tasks found",
      byStatus: {
        drafting: [],
        processing: [],
        "validating": [],
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
    mockTaskModule.createTask.mockReset().mockReturnValue("/mock/repo/testagent/tasks/one-shots/2026-03-06-1200-test-task.md")
    mockTaskModule.updateStatus.mockReset().mockReturnValue({ ok: true, from: "drafting", to: "processing", archived: [] })
    mockTaskModule.boardStatus.mockReset().mockReturnValue([])
    mockTaskModule.boardAction.mockReset().mockReturnValue([])
    mockTaskModule.boardDeps.mockReset().mockReturnValue([])
    mockTaskModule.boardSessions.mockReset().mockReturnValue([])
    const config = await import("../../heart/config")
    config.resetConfigCache()
    patchRuntimeConfig = config.patchRuntimeConfig
    const tools = await import("../../repertoire/tools")
    execTool = tools.execTool
  })

  // ── read_file ──
  it("read_file reads file contents", async () => {
    vi.mocked(fs.readFileSync).mockReturnValue("file content here")
    const result = await execTool("read_file", { path: "/tmp/test.txt" })
    expect(result).toBe("file content here")
    expect(fs.readFileSync).toHaveBeenCalledWith("/tmp/test.txt", "utf-8")
  })

  it("rethrows non-Error values from handlers", async () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw "boom" })
    await expect(execTool("read_file", { path: "/tmp/test.txt" })).rejects.toBe("boom")
  })

  // ── write_file ──
  it("write_file writes content and returns ok", async () => {
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined)
    const result = await execTool("write_file", { path: "/tmp/out.txt", content: "hello" })
    expect(result).toContain("ok")
    expect(fs.writeFileSync).toHaveBeenCalledWith("/tmp/out.txt", "hello", "utf-8")
  })

  it("relative paths resolve against repo root (no workspace indirection)", async () => {
    vi.mocked(fs.readFileSync).mockImplementation((targetPath: any) => {
      if (targetPath === "/mock/repo/src/mind/prompt.ts") {
        return "hello world"
      }
      return undefined as any
    })

    const read = await execTool("read_file", { path: "src/mind/prompt.ts" })
    expect(read).toBe("hello world")
  })

  // ── shell ──
  it("shell runs command and returns output", async () => {
    vi.mocked(execSync).mockReturnValue("shell output")
    const result = await execTool("shell", { command: "echo hello" })
    expect(result).toBe("shell output")
    expect(execSync).toHaveBeenCalledWith("echo hello", { encoding: "utf-8", timeout: 30000 })
  })

  it("safe_workspace is no longer a registered tool", async () => {
    const result = await execTool("safe_workspace", {})
    expect(result).toBe("unknown: safe_workspace")
  })

  it("shell does not rewrite commands (no workspace routing)", async () => {
    vi.mocked(execSync).mockReturnValue("direct output")
    const result = await execTool("shell", { command: "cd /mock/repo && git status" })
    expect(result).toBe("direct output")
    expect(execSync).toHaveBeenCalledWith(
      "cd /mock/repo && git status",
      { encoding: "utf-8", timeout: 30000 },
    )
  })

  // ── removed tools: gh_cli, list_directory, git_commit, get_current_time ──
  it("gh_cli is no longer a registered tool", async () => {
    const result = await execTool("gh_cli", { command: "pr list" })
    expect(result).toBe("unknown: gh_cli")
  })

  it("list_directory is no longer a registered tool", async () => {
    const result = await execTool("list_directory", { path: "/tmp" })
    expect(result).toBe("unknown: list_directory")
  })

  it("git_commit is no longer a registered tool", async () => {
    const result = await execTool("git_commit", { message: "test", paths: ["/tmp/test.txt"] })
    expect(result).toBe("unknown: git_commit")
  })

  // ── list_skills ──
  it("list_skills returns JSON list", async () => {
    vi.mocked(listSkills).mockReturnValue([{ name: "test", description: "test skill" }] as any)
    const result = await execTool("list_skills", {})
    expect(result).toContain("test")
  })

  // ── load_skill ──
  it("load_skill returns skill content", async () => {
    vi.mocked(loadSkill).mockReturnValue("skill content here")
    const result = await execTool("load_skill", { name: "test" })
    expect(result).toBe("skill content here")
  })

  it("load_skill returns error on exception", async () => {
    vi.mocked(loadSkill).mockImplementation(() => { throw new Error("not found") })
    const result = await execTool("load_skill", { name: "missing" })
    expect(result).toContain("error:")
  })

  it("get_current_time is no longer a registered tool", async () => {
    const result = await execTool("get_current_time", {})
    expect(result).toBe("unknown: get_current_time")
  })

  // ── claude ──
  it("claude runs claude CLI and returns output", async () => {
    vi.mocked(spawnSync).mockReturnValue({ stdout: "claude response", stderr: "", status: 0 } as any)
    const result = await execTool("claude", { prompt: "What is 2+2?" })
    expect(result).toBe("claude response")
    expect(spawnSync).toHaveBeenCalledWith(
      "claude",
      ["-p", "--no-session-persistence", "--dangerously-skip-permissions", "--add-dir", "."],
      expect.objectContaining({ input: "What is 2+2?" })
    )
  })

  it("claude returns error on spawn failure", async () => {
    vi.mocked(spawnSync).mockReturnValue({ error: new Error("spawn failed"), stdout: "", stderr: "", status: 1 } as any)
    const result = await execTool("claude", { prompt: "test" })
    expect(result).toContain("error:")
  })

  it("claude returns error on non-zero exit", async () => {
    vi.mocked(spawnSync).mockReturnValue({ stdout: "", stderr: "bad", status: 1 } as any)
    const result = await execTool("claude", { prompt: "test" })
    expect(result).toContain("exited with code 1")
  })

  it("claude returns (no output) when stdout is empty", async () => {
    vi.mocked(spawnSync).mockReturnValue({ stdout: "", stderr: "", status: 0 } as any)
    const result = await execTool("claude", { prompt: "test" })
    expect(result).toBe("(no output)")
  })

  it("claude catches thrown exception from spawnSync", async () => {
    vi.mocked(spawnSync).mockImplementation(() => { throw new Error("ENOENT: claude not found") })
    const result = await execTool("claude", { prompt: "test" })
    expect(result).toContain("error:")
    expect(result).toContain("ENOENT")
  })

  // ── web_search ──
  it("web_search calls perplexity API and returns results", async () => {
    patchRuntimeConfig({ integrations: { perplexityApiKey: "test-key" } })
    vi.resetModules()
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({ integrations: { perplexityApiKey: "test-key" } })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        results: [
          { title: "Result 1", url: "https://example.com", snippet: "A test result" },
        ],
      }),
    })
    vi.stubGlobal("fetch", mockFetch)

    const tools = await import("../../repertoire/tools")
    const result = await tools.execTool("web_search", { query: "test search" })
    expect(result).toContain("Result 1")
    expect(result).toContain("https://example.com")
    vi.unstubAllGlobals()
  })

  it("web_search returns error when API key missing", async () => {
    vi.resetModules()
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({ integrations: {} })

    const tools = await import("../../repertoire/tools")
    const result = await tools.execTool("web_search", { query: "test" })
    expect(result).toContain("perplexityApiKey not configured")
  })

  it("web_search picks up updated integrations config between calls without resetConfigCache()", async () => {
    const config = await import("../../heart/config")
    config.cacheRuntimeConfigForTests("testagent", {
      integrations: { perplexityApiKey: "" },
    })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        results: [
          { title: "Result 1", url: "https://example.com", snippet: "A test result" },
        ],
      }),
    })
    vi.stubGlobal("fetch", mockFetch)

    try {
      const firstResult = await execTool("web_search", { query: "test" })
      expect(firstResult).toContain("perplexityApiKey not configured")

      config.cacheRuntimeConfigForTests("testagent", {
        integrations: { perplexityApiKey: "fresh-key" },
      })
      const secondResult = await execTool("web_search", { query: "test" })
      expect(secondResult).toContain("Result 1")
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.perplexity.ai/search",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer fresh-key",
          }),
        }),
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("web_search returns error on non-ok response", async () => {
    vi.resetModules()
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({ integrations: { perplexityApiKey: "test-key" } })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    })
    vi.stubGlobal("fetch", mockFetch)

    const tools = await import("../../repertoire/tools")
    const result = await tools.execTool("web_search", { query: "test" })
    expect(result).toContain("error: 500")
    vi.unstubAllGlobals()
  })

  it("web_search returns 'no results' when empty results", async () => {
    vi.resetModules()
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({ integrations: { perplexityApiKey: "test-key" } })

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    })
    vi.stubGlobal("fetch", mockFetch)

    const tools = await import("../../repertoire/tools")
    const result = await tools.execTool("web_search", { query: "test" })
    expect(result).toBe("no results found")
    vi.unstubAllGlobals()
  })

  it("web_search returns error on exception", async () => {
    vi.resetModules()
    const config = await import("../../heart/config")
    config.resetConfigCache()
    config.patchRuntimeConfig({ integrations: { perplexityApiKey: "test-key" } })

    const mockFetch = vi.fn().mockRejectedValue(new Error("fetch failed"))
    vi.stubGlobal("fetch", mockFetch)

    const tools = await import("../../repertoire/tools")
    const result = await tools.execTool("web_search", { query: "test" })
    expect(result).toContain("error:")
    vi.unstubAllGlobals()
  })

  // ── search_notes ──
  it("search_notes returns relevant diary entries for a query", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(
      [
        JSON.stringify({
          id: "fact-1",
          text: "Ari likes mushroom pizza",
          source: "cli",
          createdAt: "2026-03-06T00:00:00.000Z",
          embedding: [],
        }),
        JSON.stringify({
          id: "fact-2",
          text: "Ari prefers strict TypeScript checks",
          source: "teams",
          createdAt: "2026-03-06T00:01:00.000Z",
          embedding: [],
        }),
      ].join("\n"),
    )

    const result = await execTool("search_notes", { query: "pizza" })
    expect(result).toContain("Ari likes mushroom pizza")
    expect(result).not.toContain("strict TypeScript")
  })

  it("search_notes returns a query-required error when query is empty", async () => {
    const result = await execTool("search_notes", { query: "   " })
    expect(result).toContain("query is required")
  })

  it("search_notes returns a query-required error when query is omitted", async () => {
    const result = await execTool("search_notes", {})
    expect(result).toContain("query is required")
  })

  it("search_notes returns error text when reading diary entries fails", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("disk read failed")
    })

    const result = await execTool("search_notes", { query: "pizza" })
    expect(result).toContain("error:")
    expect(result).toContain("disk read failed")
  })

  it("search_notes stringifies non-Error read failures", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw "disk failed as string"
    })

    const result = await execTool("search_notes", { query: "pizza" })
    expect(result).toContain("error:")
    expect(result).toContain("disk failed as string")
  })

  it("task tools return 'unknown' since they were consolidated into ouro task CLI", async () => {
    expect(await execTool("task_board", {})).toBe("unknown: task_board")
    expect(await execTool("task_create", { title: "x", type: "one-shot", category: "infra", body: "b" })).toBe("unknown: task_create")
    expect(await execTool("task_update_status", { name: "x", status: "done" })).toBe("unknown: task_update_status")
    expect(await execTool("task_board_status", { status: "processing" })).toBe("unknown: task_board_status")
    expect(await execTool("task_board_action", {})).toBe("unknown: task_board_action")
    expect(await execTool("task_board_deps", {})).toBe("unknown: task_board_deps")
    expect(await execTool("task_board_sessions", {})).toBe("unknown: task_board_sessions")
  })

  it("schedule_reminder tool is removed from baseToolDefinitions", async () => {
    const result = await execTool("schedule_reminder", {
      title: "Ping Ari",
      body: "Remind Ari to check the daemon",
      scheduledAt: "2026-03-10T17:00:00.000Z",
    })

    expect(result).toBe("unknown: schedule_reminder")
  })

  // ── unknown tool ──
  it("returns 'unknown' for unrecognized tool name", async () => {
    const result = await execTool("nonexistent_tool", {})
    expect(result).toBe("unknown: nonexistent_tool")
  })
})

describe("summarizeArgs", () => {
  let summarizeArgs: (name: string, args: Record<string, any>) => string

  beforeEach(async () => {
    vi.resetModules()
    const tools = await import("../../repertoire/tools")
    summarizeArgs = tools.summarizeArgs
  })

  it("returns path for read_file", () => {
    expect(summarizeArgs("read_file", { path: "/tmp/test.txt" })).toBe("path=/tmp/test.txt")
  })

  it("returns empty string for read_file with no path", () => {
    expect(summarizeArgs("read_file", {})).toBe("")
  })

  it("returns path for write_file", () => {
    expect(summarizeArgs("write_file", { path: "/tmp/out.txt", content: "x" })).toBe("path=/tmp/out.txt")
  })

  it("returns path for edit_file", () => {
    expect(summarizeArgs("edit_file", { path: "/tmp/edit.txt", old_string: "x", new_string: "y" })).toBe("path=/tmp/edit.txt")
  })

  it("returns pattern and cwd for glob", () => {
    expect(summarizeArgs("glob", { pattern: "**/*.ts", cwd: "/src" })).toBe("pattern=**/*.ts cwd=/src")
  })

  it("returns pattern only for glob with no cwd", () => {
    expect(summarizeArgs("glob", { pattern: "*.json" })).toBe("pattern=*.json")
  })

  it("returns pattern and path for grep", () => {
    expect(summarizeArgs("grep", { pattern: "log.*Error", path: "/src", include: "*.ts" })).toBe("pattern=log.*Error path=/src include=*.ts")
  })

  it("returns short command for shell", () => {
    expect(summarizeArgs("shell", { command: "echo hi" })).toBe("command=echo hi")
  })

  it("returns truncated command for shell when > 60 chars", () => {
    const longCmd = "a".repeat(70)
    expect(summarizeArgs("shell", { command: longCmd })).toBe("command=" + "a".repeat(60) + "...")
  })

  it("returns empty string for shell with no command", () => {
    expect(summarizeArgs("shell", {})).toBe("")
  })

  it("falls through to unknown handler for removed tools (list_directory, git_commit, gh_cli)", () => {
    // These tools have been removed, so summarizeArgs should treat them as unknown
    expect(summarizeArgs("list_directory", { path: "/tmp" })).toBe("path=/tmp")
    expect(summarizeArgs("git_commit", { message: "test" })).toBe("message=test")
    expect(summarizeArgs("gh_cli", { command: "pr list" })).toBe("command=pr list")
  })

  it("returns name for load_skill", () => {
    expect(summarizeArgs("load_skill", { name: "my-skill" })).toBe("name=my-skill")
  })

  it("returns empty string for load_skill with no name", () => {
    expect(summarizeArgs("load_skill", {})).toBe("")
  })

  it("falls through to unknown handler for removed task tools (consolidated into ouro task CLI)", () => {
    // These tools have been removed, so summarizeArgs should treat them as unknown
    expect(summarizeArgs("task_create", { title: "Ship it", type: "one-shot", category: "infra", body: "ignored" })).toBe("title=Ship it type=one-shot category=infra body=ignored")
    expect(summarizeArgs("task_update_status", { name: "sample", status: "processing" })).toBe("name=sample status=processing")
    expect(summarizeArgs("task_board_status", { status: "blocked" })).toBe("status=blocked")
    expect(summarizeArgs("task_board_action", { scope: "blocked" })).toBe("scope=blocked")
    expect(summarizeArgs("task_board", {})).toBe("")
    expect(summarizeArgs("task_board_deps", {})).toBe("")
    expect(summarizeArgs("task_board_sessions", {})).toBe("")
  })

  it("falls through to generic summary for removed schedule_reminder tool", () => {
    // schedule_reminder was removed -- now hits the summarizeUnknownArgs fallback
    expect(
      summarizeArgs("schedule_reminder", {
        title: "Ping Ari",
        scheduledAt: "2026-03-10T17:00:00.000Z",
      }),
    ).toBe("title=Ping Ari scheduledAt=2026-03-10T17:00:00.000Z")
  })

  it("returns truncated prompt for claude", () => {
    const prompt = "a".repeat(70)
    expect(summarizeArgs("claude", { prompt })).toBe("prompt=" + "a".repeat(60) + "...")
  })

  it("returns empty string for claude with no prompt", () => {
    expect(summarizeArgs("claude", {})).toBe("")
  })

  it("returns truncated query for web_search", () => {
    const query = "a".repeat(70)
    expect(summarizeArgs("web_search", { query })).toBe("query=" + "a".repeat(60) + "...")
  })

  it("returns empty string for web_search with no query", () => {
    expect(summarizeArgs("web_search", {})).toBe("")
  })

  it("returns truncated query for search_notes", () => {
    const query = "a".repeat(70)
    expect(summarizeArgs("search_notes", { query })).toBe("query=" + "a".repeat(60) + "...")
  })

  it("returns empty string for search_notes with no query", () => {
    expect(summarizeArgs("search_notes", {})).toBe("")
  })

  it("returns entry/about for diary_write summaries", () => {
    expect(summarizeArgs("diary_write", { entry: "keep this", about: "ari" })).toBe("entry=keep this about=ari")
  })

  it("returns friendId for get_friend_note summaries", () => {
    expect(summarizeArgs("get_friend_note", { friendId: "friend-123" })).toBe("friendId=friend-123")
  })

  it("returns org/project for ado_batch_update", () => {
    expect(summarizeArgs("ado_batch_update", { organization: "contoso", project: "web", items: [] })).toBe("organization=contoso project=web")
  })

  it("returns org/project/title for ado_create_epic", () => {
    expect(summarizeArgs("ado_create_epic", { organization: "contoso", project: "web", title: "New epic" })).toBe("organization=contoso project=web title=New epic")
  })

  it("returns org/project/title for ado_create_issue", () => {
    expect(summarizeArgs("ado_create_issue", { organization: "contoso", project: "web", title: "Bug" })).toBe("organization=contoso project=web title=Bug")
  })

  it("returns org/project/workItemIds for ado_move_items", () => {
    expect(summarizeArgs("ado_move_items", { organization: "contoso", project: "web", workItemIds: [1, 2] })).toBe("organization=contoso project=web workItemIds=1,2")
  })

  it("returns org/project for ado_restructure_backlog", () => {
    expect(summarizeArgs("ado_restructure_backlog", { organization: "contoso", project: "web" })).toBe("organization=contoso project=web")
  })

  it("returns key=value summary for unknown tool", () => {
    expect(summarizeArgs("unknown_tool", { key: "value" })).toBe("key=value")
  })

  it("truncates long values for unknown tool summaries", () => {
    const longVal = "a".repeat(80)
    const result = summarizeArgs("unknown_tool", { key: longVal })
    expect(result).toBe("key=" + "a".repeat(60) + "...")
  })

  it("ignores whitespace-only values for unknown tool summaries", () => {
    const result = summarizeArgs("unknown_tool", {
      empty: "   \n\t  ",
      key: "value",
    })
    expect(result).toBe("key=value")
  })

  it("returns empty string for tools with summaryKeys: [] (graph_profile)", () => {
    expect(summarizeArgs("graph_profile", {})).toBe("")
    expect(summarizeArgs("graph_profile", { foo: "bar" })).toBe("")
  })

  it("uses summaryKeys from tool definition rather than switch branch", () => {
    // file_ouroboros_bug has summaryKeys: ["title"] -- should return key=value format
    expect(summarizeArgs("file_ouroboros_bug", { title: "Fix the login bug" })).toBe("title=Fix the login bug")
  })

  it("falls back to showing all args for tools not in any definition registry", () => {
    // A completely hypothetical tool name that doesn't exist in any definition
    expect(summarizeArgs("totally_unknown_tool_xyz", { a: "1", b: "2" })).toBe("a=1 b=2")
  })

  it("falls back to showing all args for registered tools without summaryKeys", () => {
    // query_active_work is in allDefinitions but has no summaryKeys
    expect(summarizeArgs("query_active_work", { status: "all" })).toBe("status=all")
  })
})

describe("ToolDefinition type and registry", () => {
  it("exports ToolDefinition type from tools-base", async () => {
    vi.resetModules()
    const toolsBase = await import("../../repertoire/tools-base")
    // baseToolDefinitions should be an array of ToolDefinition
    expect(Array.isArray(toolsBase.baseToolDefinitions)).toBe(true)
    expect(toolsBase.baseToolDefinitions.length).toBeGreaterThan(0)
  })

  it("each base ToolDefinition has tool and handler, no integration", async () => {
    vi.resetModules()
    const toolsBase = await import("../../repertoire/tools-base")
    for (const def of toolsBase.baseToolDefinitions) {
      expect(def.tool).toBeDefined()
      expect(def.tool.type).toBe("function")
      expect(def.tool.function.name).toBeDefined()
      expect(typeof def.handler).toBe("function")
      // Base tools have no integration
      expect(def.integration).toBeUndefined()
    }
  })

  it("exports teamsToolDefinitions from tools-teams", async () => {
    vi.resetModules()
    const toolsTeams = await import("../../repertoire/tools-teams")
    expect(Array.isArray(toolsTeams.teamsToolDefinitions)).toBe(true)
    expect(toolsTeams.teamsToolDefinitions.length).toBeGreaterThan(0)
  })

  it("each teams ToolDefinition has tool, handler, and integration", async () => {
    vi.resetModules()
    const toolsTeams = await import("../../repertoire/tools-teams")
    for (const def of toolsTeams.teamsToolDefinitions) {
      expect(def.tool).toBeDefined()
      expect(def.tool.type).toBe("function")
      expect(def.tool.function.name).toBeDefined()
      expect(typeof def.handler).toBe("function")
      // All teams tools have an integration, except teams_send_message (uses botApi, not OAuth)
      if (def.tool.function.name !== "teams_send_message") {
        expect(def.integration).toBeDefined()
        expect(["ado", "graph"]).toContain(def.integration)
      }
    }
  })

  it("confirmationRequired no longer exists on any teams tool definition", async () => {
    vi.resetModules()
    const toolsTeams = await import("../../repertoire/tools-teams")
    for (const def of toolsTeams.teamsToolDefinitions) {
      expect((def as any).confirmationRequired).toBeUndefined()
    }
  })

  it("base tool definitions include expected tool names", async () => {
    vi.resetModules()
    const toolsBase = await import("../../repertoire/tools-base")
    const names = toolsBase.baseToolDefinitions.map((d: any) => d.tool.function.name)
    expect(names).toContain("read_file")
    expect(names).toContain("write_file")
    expect(names).toContain("shell")
    expect(names).toContain("list_skills")
    expect(names).toContain("load_skill")
    expect(names).toContain("claude")
    expect(names).toContain("web_search")
    expect(names).toContain("query_active_work")
  })

  it("base tool definitions do NOT include removed tools", async () => {
    vi.resetModules()
    const toolsBase = await import("../../repertoire/tools-base")
    const names = toolsBase.baseToolDefinitions.map((d: any) => d.tool.function.name)
    expect(names).not.toContain("list_directory")
    expect(names).not.toContain("git_commit")
    expect(names).not.toContain("get_current_time")
    expect(names).not.toContain("gh_cli")
  })

  it("base tool definitions do NOT include task tools (consolidated into ouro task CLI)", async () => {
    vi.resetModules()
    const toolsBase = await import("../../repertoire/tools-base")
    const names = toolsBase.baseToolDefinitions.map((d: any) => d.tool.function.name)
    expect(names).not.toContain("task_board")
    expect(names).not.toContain("task_create")
    expect(names).not.toContain("task_update_status")
    expect(names).not.toContain("task_board_status")
    expect(names).not.toContain("task_board_action")
    expect(names).not.toContain("task_board_deps")
    expect(names).not.toContain("task_board_sessions")
  })

  it("teams tool definitions include expected tool names", async () => {
    vi.resetModules()
    const toolsTeams = await import("../../repertoire/tools-teams")
    const names = toolsTeams.teamsToolDefinitions.map((d: any) => d.tool.function.name)
    expect(names).toContain("graph_query")
    expect(names).toContain("graph_mutate")
    expect(names).toContain("ado_query")
    expect(names).toContain("ado_mutate")
    expect(names).toContain("graph_profile")
    expect(names).toContain("ado_work_items")
    expect(names).toContain("graph_docs")
    expect(names).toContain("ado_docs")
  })

  it("teams tool definitions have correct integration tags", async () => {
    vi.resetModules()
    const toolsTeams = await import("../../repertoire/tools-teams")
    const defs = toolsTeams.teamsToolDefinitions
    const byName = (name: string) => defs.find((d: any) => d.tool.function.name === name)

    expect(byName("graph_query")?.integration).toBe("graph")
    expect(byName("graph_mutate")?.integration).toBe("graph")
    expect(byName("graph_profile")?.integration).toBe("graph")
    expect(byName("graph_docs")?.integration).toBe("graph")
    expect(byName("ado_query")?.integration).toBe("ado")
    expect(byName("ado_mutate")?.integration).toBe("ado")
    expect(byName("ado_work_items")?.integration).toBe("ado")
    expect(byName("ado_docs")?.integration).toBe("ado")
  })
})

describe("tools array export (backward compat)", () => {
  it("exports tools array with expected tool names", async () => {
    vi.resetModules()
    const { tools } = await import("../../repertoire/tools")
    const names = tools.map((t: any) => t.function.name)
    expect(names).toContain("read_file")
    expect(names).toContain("write_file")
    expect(names).toContain("shell")
    expect(names).toContain("list_skills")
    expect(names).toContain("load_skill")
    expect(names).toContain("claude")
    expect(names).toContain("web_search")
    // Removed tools should not be present
    expect(names).not.toContain("list_directory")
    expect(names).not.toContain("git_commit")
    expect(names).not.toContain("get_current_time")
    expect(names).not.toContain("gh_cli")
  })
})

describe("settleTool", () => {
  it("has correct name, description, and schema", async () => {
    vi.resetModules()
    const { settleTool } = await import("../../repertoire/tools")
    expect(settleTool.type).toBe("function")
    expect(settleTool.function.name).toBe("settle")
    // Description should frame as response delivery with turn-ending semantics
    expect(settleTool.function.description).toMatch(/deliver your response.*end your turn/i)
    expect(settleTool.function.description).not.toContain("instead of calling another tool")
    expect(settleTool.function.parameters).toEqual({
      type: "object",
      properties: {
        answer: { type: "string" },
        intent: { type: "string", enum: ["complete", "blocked", "direct_reply"] },
      },
      required: ["answer"],
    })
  })

  it("is NOT included in the default tools array", async () => {
    vi.resetModules()
    const { tools } = await import("../../repertoire/tools")
    const names = tools.map((t: any) => t.function.name)
    expect(names).not.toContain("settle")
  })
})

describe("getToolsForChannel with ChannelCapabilities", () => {
  it("returns only base tools when no integrations available", async () => {
    vi.resetModules()
    const { getToolsForChannel, tools } = await import("../../repertoire/tools")
    const cliCaps = {
      channel: "cli" as const,
      availableIntegrations: [],
      supportsMarkdown: false,
      supportsStreaming: true,
      supportsRichCards: false,
      maxMessageLength: Infinity,
    }
    const result = getToolsForChannel(cliCaps)
    const names = result.map((t: any) => t.function.name)
    // Should have all base tools
    expect(names).toContain("read_file")
    expect(names).toContain("shell")
    // Should NOT have graph/ado tools
    expect(names).not.toContain("graph_profile")
    expect(names).not.toContain("ado_work_items")
    expect(names).not.toContain("graph_query")
    expect(names).not.toContain("graph_mutate")
    expect(names).not.toContain("ado_query")
    expect(names).not.toContain("ado_mutate")
    // Same length as base tools minus capability-gated tools (set_reasoning_effort excluded without providerCapabilities)
    expect(result.length).toBe(tools.length - 1)
  })

  it("returns base + ado + graph tools for Teams capabilities", async () => {
    vi.resetModules()
    const { getToolsForChannel, tools } = await import("../../repertoire/tools")
    const teamsCaps = {
      channel: "teams" as const,
      senseType: "closed" as const,
      availableIntegrations: ["ado" as const, "graph" as const],
      supportsMarkdown: true,
      supportsStreaming: true,
      supportsRichCards: true,
      maxMessageLength: Infinity,
    }
    const result = getToolsForChannel(teamsCaps)
    const names = result.map((t: any) => t.function.name)
    // Exclude capability-gated tools (set_reasoning_effort) from base count
    const capabilityGatedTools = new Set(["set_reasoning_effort"])
    const baseCount = tools.filter((t: any) => !capabilityGatedTools.has(t.function.name)).length
    // All base tools now returned (no channel-level blocking)
    expect(names).toContain("read_file")
    expect(names).toContain("write_file")
    expect(names).toContain("shell")
    // Removed tools should not be present at all
    expect(names).not.toContain("git_commit")
    expect(names).not.toContain("gh_cli")
    expect(names).not.toContain("list_directory")
    expect(names).not.toContain("get_current_time")
    // Integration tools
    expect(names).toContain("graph_query")
    expect(names).toContain("graph_mutate")
    expect(names).toContain("graph_profile")
    expect(names).toContain("graph_docs")
    expect(names).toContain("ado_query")
    expect(names).toContain("ado_mutate")
    expect(names).toContain("ado_work_items")
    expect(names).toContain("ado_docs")
    expect(names).toContain("ado_backlog_list")
    expect(names).toContain("ado_create_epic")
    expect(names).toContain("ado_create_issue")
    expect(names).toContain("ado_move_items")
    expect(names).toContain("ado_restructure_backlog")
    expect(names).toContain("ado_validate_structure")
    expect(names).toContain("ado_preview_changes")
    expect(names).toContain("teams_send_message")
    // base tools + 8 teams tools + 11 semantic ado tools + 1 teams_send_message
    expect(result.length).toBe(baseCount + 20)
  })

  it("returns base + graph-only tools when only graph integration", async () => {
    vi.resetModules()
    const { getToolsForChannel, tools } = await import("../../repertoire/tools")
    const caps = {
      channel: "teams" as const,
      senseType: "closed" as const,
      availableIntegrations: ["graph" as const],
      supportsMarkdown: true,
      supportsStreaming: true,
      supportsRichCards: true,
      maxMessageLength: Infinity,
    }
    const result = getToolsForChannel(caps)
    const names = result.map((t: any) => t.function.name)
    const capabilityGatedTools = new Set(["set_reasoning_effort"])
    const baseCount = tools.filter((t: any) => !capabilityGatedTools.has(t.function.name)).length
    // Should have graph tools
    expect(names).toContain("graph_query")
    expect(names).toContain("graph_mutate")
    expect(names).toContain("graph_profile")
    expect(names).toContain("graph_docs")
    // Should NOT have ado tools
    expect(names).not.toContain("ado_query")
    expect(names).not.toContain("ado_mutate")
    expect(names).not.toContain("ado_work_items")
    expect(names).not.toContain("ado_docs")
    // base tools + 4 graph tools + 1 teams_send_message
    expect(result.length).toBe(baseCount + 5)
  })

  it("returns base + ado-only tools when only ado integration", async () => {
    vi.resetModules()
    const { getToolsForChannel, tools } = await import("../../repertoire/tools")
    const caps = {
      channel: "teams" as const,
      senseType: "closed" as const,
      availableIntegrations: ["ado" as const],
      supportsMarkdown: true,
      supportsStreaming: true,
      supportsRichCards: true,
      maxMessageLength: Infinity,
    }
    const result = getToolsForChannel(caps)
    const names = result.map((t: any) => t.function.name)
    const capabilityGatedTools = new Set(["set_reasoning_effort"])
    const baseCount = tools.filter((t: any) => !capabilityGatedTools.has(t.function.name)).length
    // Should have ado tools
    expect(names).toContain("ado_query")
    expect(names).toContain("ado_mutate")
    expect(names).toContain("ado_work_items")
    expect(names).toContain("ado_docs")
    // Should NOT have graph tools
    expect(names).not.toContain("graph_query")
    expect(names).not.toContain("graph_mutate")
    expect(names).not.toContain("graph_profile")
    expect(names).not.toContain("graph_docs")
    // Should have semantic ado tools
    expect(names).toContain("ado_backlog_list")
    // base tools + 4 ado tools + 11 semantic ado tools + 1 teams_send_message
    expect(result.length).toBe(baseCount + 16)
  })
})

describe("getToolsForChannel with toolPreferences", () => {
  const teamsCaps = {
    channel: "teams" as const,
    senseType: "closed" as const,
    availableIntegrations: ["ado" as const, "graph" as const],
    supportsMarkdown: true,
    supportsStreaming: true,
    supportsRichCards: true,
    maxMessageLength: Infinity,
  }
  const cliCaps = {
    channel: "cli" as const,
    availableIntegrations: [] as const,
    supportsMarkdown: false,
    supportsStreaming: true,
    supportsRichCards: false,
    maxMessageLength: Infinity,
  }

  it("returns descriptions unchanged when no preferences provided", async () => {
    vi.resetModules()
    const { getToolsForChannel } = await import("../../repertoire/tools")
    const withoutPrefs = getToolsForChannel(teamsCaps)
    const withEmptyPrefs = getToolsForChannel(teamsCaps, {})
    const withUndefined = getToolsForChannel(teamsCaps, undefined)

    // All three should return identical descriptions
    const descsWithout = withoutPrefs.map((t: any) => t.function.description)
    const descsEmpty = withEmptyPrefs.map((t: any) => t.function.description)
    const descsUndefined = withUndefined.map((t: any) => t.function.description)
    expect(descsEmpty).toEqual(descsWithout)
    expect(descsUndefined).toEqual(descsWithout)
  })

  it("appends ado preference to all tools with integration: 'ado'", async () => {
    vi.resetModules()
    const { getToolsForChannel } = await import("../../repertoire/tools")
    const prefs = { ado: "my friend prefers iteration paths like Team\\Sprint1" }
    const result = getToolsForChannel(teamsCaps, prefs)

    // Find ado tools -- they should all have the preference appended
    const adoTools = result.filter((t: any) =>
      ["ado_query", "ado_mutate", "ado_work_items", "ado_docs",
       "ado_backlog_list", "ado_create_epic", "ado_create_issue",
       "ado_move_items", "ado_restructure_backlog", "ado_validate_structure",
       "ado_preview_changes"].includes(t.function.name),
    )
    expect(adoTools.length).toBeGreaterThan(0)
    for (const tool of adoTools) {
      expect(tool.function.description).toContain("my friend prefers iteration paths like Team\\Sprint1")
    }

    // Base tools should NOT have the preference (use web_search -- read_file is blocked for remote channels)
    const webSearch = result.find((t: any) => t.function.name === "web_search")
    expect(webSearch!.function.description).not.toContain("my friend prefers")

    // Graph tools should NOT have the preference
    const graphQuery = result.find((t: any) => t.function.name === "graph_query")
    expect(graphQuery!.function.description).not.toContain("my friend prefers")
  })

  it("appends graph preference to all tools with integration: 'graph'", async () => {
    vi.resetModules()
    const { getToolsForChannel } = await import("../../repertoire/tools")
    const prefs = { graph: "always include manager field in profile queries" }
    const result = getToolsForChannel(teamsCaps, prefs)

    // Graph tools should have the preference appended
    const graphTools = result.filter((t: any) =>
      ["graph_query", "graph_mutate", "graph_profile", "graph_docs"].includes(t.function.name),
    )
    expect(graphTools.length).toBeGreaterThan(0)
    for (const tool of graphTools) {
      expect(tool.function.description).toContain("always include manager field in profile queries")
    }

    // ADO tools should NOT have the preference
    const adoQuery = result.find((t: any) => t.function.name === "ado_query")
    expect(adoQuery!.function.description).not.toContain("always include manager")
  })

  it("ignores unknown preference keys that don't match any integration", async () => {
    vi.resetModules()
    const { getToolsForChannel } = await import("../../repertoire/tools")
    const withoutPrefs = getToolsForChannel(teamsCaps)
    const withUnknownPrefs = getToolsForChannel(teamsCaps, { nonexistent: "some pref" })

    // Descriptions should be identical -- unknown key has no effect
    const descsWithout = withoutPrefs.map((t: any) => t.function.description)
    const descsWith = withUnknownPrefs.map((t: any) => t.function.description)
    expect(descsWith).toEqual(descsWithout)
  })

  it("applies multiple preferences independently", async () => {
    vi.resetModules()
    const { getToolsForChannel } = await import("../../repertoire/tools")
    const prefs = {
      ado: "use area path Team\\Backend",
      graph: "prefer displayName over mail",
    }
    const result = getToolsForChannel(teamsCaps, prefs)

    // ADO tools get ado pref but not graph pref
    const adoQuery = result.find((t: any) => t.function.name === "ado_query")
    expect(adoQuery!.function.description).toContain("use area path Team\\Backend")
    expect(adoQuery!.function.description).not.toContain("prefer displayName over mail")

    // Graph tools get graph pref but not ado pref
    const graphQuery = result.find((t: any) => t.function.name === "graph_query")
    expect(graphQuery!.function.description).toContain("prefer displayName over mail")
    expect(graphQuery!.function.description).not.toContain("use area path Team\\Backend")
  })

  it("does not mutate original tool descriptions (rebuilt each call)", async () => {
    vi.resetModules()
    const { getToolsForChannel } = await import("../../repertoire/tools")

    // First call with preferences
    const prefs = { ado: "my special preference" }
    const firstCall = getToolsForChannel(teamsCaps, prefs)
    const adoToolFirst = firstCall.find((t: any) => t.function.name === "ado_query")
    expect(adoToolFirst!.function.description).toContain("my special preference")

    // Second call WITHOUT preferences
    const secondCall = getToolsForChannel(teamsCaps)
    const adoToolSecond = secondCall.find((t: any) => t.function.name === "ado_query")
    expect(adoToolSecond!.function.description).not.toContain("my special preference")

    // Third call with DIFFERENT preferences
    const thirdCall = getToolsForChannel(teamsCaps, { ado: "different pref" })
    const adoToolThird = thirdCall.find((t: any) => t.function.name === "ado_query")
    expect(adoToolThird!.function.description).toContain("different pref")
    expect(adoToolThird!.function.description).not.toContain("my special preference")
  })

  it("does not inject preferences for CLI channel (no integration tools)", async () => {
    vi.resetModules()
    const { getToolsForChannel } = await import("../../repertoire/tools")
    const prefs = { ado: "some ado preference", graph: "some graph preference" }
    const result = getToolsForChannel(cliCaps, prefs)

    // CLI has no integration tools, so no descriptions should be modified
    for (const tool of result) {
      expect(tool.function.description).not.toContain("some ado preference")
      expect(tool.function.description).not.toContain("some graph preference")
    }
  })
})


describe("tool access trust-level alignment (D1b Rule 1)", () => {
  const bbCaps = {
    channel: "bluebubbles" as const,
    senseType: "open" as const,
    availableIntegrations: [] as const,
    supportsMarkdown: false,
    supportsStreaming: false,
    supportsRichCards: false,
    maxMessageLength: Infinity,
  }
  const teamsCaps = {
    channel: "teams" as const,
    senseType: "closed" as const,
    availableIntegrations: ["ado" as const, "graph" as const],
    supportsMarkdown: true,
    supportsStreaming: true,
    supportsRichCards: true,
    maxMessageLength: Infinity,
  }
  const cliCaps = {
    channel: "cli" as const,
    senseType: "local" as const,
    availableIntegrations: [] as const,
    supportsMarkdown: false,
    supportsStreaming: true,
    supportsRichCards: false,
    maxMessageLength: Infinity,
  }

  function makeFriend(trustLevel: string, externalIds: any[] = []): any {
    return {
      id: "friend-1",
      name: "Test User",
      trustLevel,
      externalIds,
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      schemaVersion: 1,
    }
  }

  function makeContext(caps: any, friend: any): any {
    return { friend, channel: caps }
  }

  const blockedToolNames = ["shell", "read_file", "write_file", "edit_file", "glob", "grep"]

  it("returns all tools for acquaintance on remote channel (guardrails at exec time)", async () => {
    vi.resetModules()
    const { getToolsForChannel } = await import("../../repertoire/tools")
    const friend = makeFriend("acquaintance")
    const context = makeContext(bbCaps, friend)
    const result = getToolsForChannel(bbCaps, undefined, context)
    const names = result.map((t: any) => t.function.name)
    for (const tool of blockedToolNames) {
      expect(names).toContain(tool)
    }
  })

  it("returns all tools for stranger on remote channel (guardrails at exec time)", async () => {
    vi.resetModules()
    const { getToolsForChannel } = await import("../../repertoire/tools")
    const friend = makeFriend("stranger")
    const context = makeContext(bbCaps, friend)
    const result = getToolsForChannel(bbCaps, undefined, context)
    const names = result.map((t: any) => t.function.name)
    for (const tool of blockedToolNames) {
      expect(names).toContain(tool)
    }
  })

  it("allows local tools for family in group chat on remote channel", async () => {
    vi.resetModules()
    const { getToolsForChannel } = await import("../../repertoire/tools")
    const friend = makeFriend("family", [
      { provider: "imessage-handle", externalId: "group:chat123", linkedAt: "2026-01-01" },
    ])
    const context = makeContext(bbCaps, friend)
    const result = getToolsForChannel(bbCaps, undefined, context)
    const names = result.map((t: any) => t.function.name)
    for (const tool of blockedToolNames) {
      expect(names).toContain(tool)
    }
  })

  it("allows local tools for friend in group chat on remote channel", async () => {
    vi.resetModules()
    const { getToolsForChannel } = await import("../../repertoire/tools")
    const friend = makeFriend("friend", [
      { provider: "imessage-handle", externalId: "group:chat456", linkedAt: "2026-01-01" },
    ])
    const context = makeContext(teamsCaps, friend)
    const result = getToolsForChannel(teamsCaps, undefined, context)
    const names = result.map((t: any) => t.function.name)
    for (const tool of blockedToolNames) {
      expect(names).toContain(tool)
    }
  })

  it("allows local tools for family in 1:1 on remote channel", async () => {
    vi.resetModules()
    const { getToolsForChannel } = await import("../../repertoire/tools")
    const friend = makeFriend("family")
    const context = makeContext(teamsCaps, friend)
    const result = getToolsForChannel(teamsCaps, undefined, context)
    const names = result.map((t: any) => t.function.name)
    for (const tool of blockedToolNames) {
      expect(names).toContain(tool)
    }
  })

  it("allows local tools for friend in 1:1 on remote channel", async () => {
    vi.resetModules()
    const { getToolsForChannel } = await import("../../repertoire/tools")
    const friend = makeFriend("friend")
    const context = makeContext(bbCaps, friend)
    const result = getToolsForChannel(bbCaps, undefined, context)
    const names = result.map((t: any) => t.function.name)
    for (const tool of blockedToolNames) {
      expect(names).toContain(tool)
    }
  })

  it("never blocks local tools on CLI regardless of trust level", async () => {
    vi.resetModules()
    const { getToolsForChannel } = await import("../../repertoire/tools")
    for (const trustLevel of ["stranger", "acquaintance", "friend", "family"]) {
      const friend = makeFriend(trustLevel)
      const context = makeContext(cliCaps, friend)
      const result = getToolsForChannel(cliCaps, undefined, context)
      const names = result.map((t: any) => t.function.name)
      for (const tool of blockedToolNames) {
        expect(names).toContain(tool)
      }
    }
  })

  it("execTool allows read_file for acquaintance on remote channel (no channel blocking)", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockReturnValue("file content")
    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      signin: vi.fn(),
      context: {
        friend: makeFriend("acquaintance"),
        channel: bbCaps,
      },
    }
    const result = await execTool("read_file", { path: "/tmp/test.txt" }, ctx)
    expect(result).toBe("file content")
  })

  it("execTool allows read_file for family in group chat on remote channel", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockReturnValue("file content")
    const { execTool } = await import("../../repertoire/tools")
    const friend = makeFriend("family", [
      { provider: "imessage-handle", externalId: "group:chat789", linkedAt: "2026-01-01" },
    ])
    const ctx = {
      signin: vi.fn(),
      context: {
        friend,
        channel: bbCaps,
      },
    }
    const result = await execTool("read_file", { path: "/tmp/test.txt" }, ctx)
    expect(result).toBe("file content")
  })

  it("execTool allows read_file for stranger on remote channel (no channel blocking)", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockReturnValue("file content")
    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      signin: vi.fn(),
      context: {
        friend: makeFriend("stranger"),
        channel: bbCaps,
      },
    }
    const result = await execTool("read_file", { path: "/tmp/test.txt" }, ctx)
    expect(result).toBe("file content")
  })
})

describe("ToolContext shape", () => {
  it("ToolContext accepts context?: ResolvedContext", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    vi.mocked(fs.readFileSync).mockReturnValue("file content")
    // ToolContext with context field
    const ctx = {
      graphToken: "token",
      adoToken: "token",
      signin: vi.fn(),
      context: {
        identity: {
          id: "test-uuid",
          displayName: "Test User",
          externalIds: [],
          tenantMemberships: [],
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
          schemaVersion: 1,
        },
        channel: {
          channel: "teams" as const,
          senseType: "closed" as const,
          availableIntegrations: ["ado" as const, "graph" as const],
          supportsMarkdown: true,
          supportsStreaming: true,
          supportsRichCards: true,
          maxMessageLength: Infinity,
        },
      },
    }
    // Channel-level blocking removed — execTool now allows all tools
    const result = await execTool("read_file", { path: "/tmp/test.txt" }, ctx)
    expect(result).toBe("file content")
  })

  it("ToolContext does NOT have adoOrganizations field", async () => {
    vi.resetModules()
    const toolsBase = await import("../../repertoire/tools-base")
    // TypeScript would catch this at compile time, but we verify at runtime:
    // Create a minimal valid ToolContext and verify no adoOrganizations
    const minCtx: any = {
      signin: vi.fn(),
    }
    // If adoOrganizations were required, TypeScript would error.
    // We just verify the interface shape by checking the module exports.
    expect(toolsBase).toBeDefined()
  })
})

describe("execTool with ToolContext (graph/ado handlers)", () => {
  it("passes ToolContext to graph_profile handler", async () => {
    vi.resetModules()
    const { getProfile } = await import("../../repertoire/graph-client")
    vi.mocked(getProfile).mockResolvedValue("Profile: Jane Doe")

    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      graphToken: "test-graph-token",
      adoToken: undefined,
      signin: vi.fn(),
    }

    const result = await execTool("graph_profile", {}, ctx)
    expect(result).toBe("Profile: Jane Doe")
    expect(getProfile).toHaveBeenCalledWith("test-graph-token")
  })

  it("graph_profile returns AUTH_REQUIRED when graphToken missing", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      graphToken: undefined,
      adoToken: undefined,
      signin: vi.fn(),
    }

    const result = await execTool("graph_profile", {}, ctx)
    expect(result).toBe("AUTH_REQUIRED:graph -- I need access to your Microsoft 365 profile. Please sign in when prompted.")
  })

  it("graph_profile returns AUTH_REQUIRED when no ToolContext provided", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")

    const result = await execTool("graph_profile", {})
    expect(result).toBe("AUTH_REQUIRED:graph -- I need access to your Microsoft 365 profile. Please sign in when prompted.")
  })

  it("passes ToolContext to ado_work_items handler", async () => {
    vi.resetModules()
    const { queryWorkItems } = await import("../../repertoire/ado-client")
    vi.mocked(queryWorkItems).mockResolvedValue("Work items: #123 Fix bug")

    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      graphToken: undefined,
      adoToken: "test-ado-token",
      signin: vi.fn(),
    }

    const result = await execTool("ado_work_items", { organization: "myorg", query: "SELECT * FROM WorkItems" }, ctx)
    expect(result).toBe("Work items: #123 Fix bug")
    expect(queryWorkItems).toHaveBeenCalledWith("test-ado-token", "myorg", "SELECT * FROM WorkItems")
  })

  it("ado_work_items returns AUTH_REQUIRED when adoToken missing", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      graphToken: undefined,
      adoToken: undefined,
      signin: vi.fn(),
    }

    const result = await execTool("ado_work_items", { organization: "myorg" }, ctx)
    expect(result).toBe("AUTH_REQUIRED:ado -- I need access to your Azure DevOps account. Please sign in when prompted.")
  })

  it("ado_work_items uses default query when none provided", async () => {
    vi.resetModules()
    const { queryWorkItems } = await import("../../repertoire/ado-client")
    vi.mocked(queryWorkItems).mockResolvedValue("Work items found")

    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      graphToken: undefined,
      adoToken: "test-token",
      signin: vi.fn(),
    }

    const result = await execTool("ado_work_items", { organization: "myorg" }, ctx)
    expect(result).toBe("Work items found")
    // Should use default query
    expect(queryWorkItems).toHaveBeenCalledWith("test-token", "myorg", expect.stringContaining("SELECT"))
  })

  it("ado_work_items returns AUTH_REQUIRED when no ToolContext provided", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")

    const result = await execTool("ado_work_items", { organization: "myorg" })
    expect(result).toBe("AUTH_REQUIRED:ado -- I need access to your Azure DevOps account. Please sign in when prompted.")
  })

  it("ado_work_items without org: single org auto-selects", async () => {
    vi.resetModules()
    const { queryWorkItems, discoverOrganizations } = await import("../../repertoire/ado-client")
    vi.mocked(discoverOrganizations).mockResolvedValue(["solo-org"])
    vi.mocked(queryWorkItems).mockResolvedValue("Work items from solo-org")

    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      graphToken: undefined,
      adoToken: "test-token",
      signin: vi.fn(),
    }

    const result = await execTool("ado_work_items", {}, ctx)
    expect(result).toBe("Work items from solo-org")
    expect(discoverOrganizations).toHaveBeenCalledWith("test-token")
    expect(queryWorkItems).toHaveBeenCalledWith("test-token", "solo-org", expect.stringContaining("SELECT"))
  })

  it("ado_work_items without org: multiple orgs returns list for model", async () => {
    vi.resetModules()
    const { discoverOrganizations } = await import("../../repertoire/ado-client")
    vi.mocked(discoverOrganizations).mockResolvedValue(["org-a", "org-b", "org-c"])

    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      graphToken: undefined,
      adoToken: "test-token",
      signin: vi.fn(),
    }

    const result = await execTool("ado_work_items", {}, ctx)
    expect(result).toContain("org-a")
    expect(result).toContain("org-b")
    expect(result).toContain("org-c")
    // Should indicate disambiguation is needed
    expect(result.toLowerCase()).toContain("organization")
  })

  it("ado_work_items without org: zero orgs returns not found message", async () => {
    vi.resetModules()
    const { discoverOrganizations } = await import("../../repertoire/ado-client")
    vi.mocked(discoverOrganizations).mockResolvedValue([])

    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      graphToken: undefined,
      adoToken: "test-token",
      signin: vi.fn(),
    }

    const result = await execTool("ado_work_items", {}, ctx)
    expect(result.toLowerCase()).toContain("no")
    expect(result.toLowerCase()).toContain("organization")
  })

  it("ado_work_items without org: discovery error returns structured message", async () => {
    vi.resetModules()
    const { discoverOrganizations } = await import("../../repertoire/ado-client")
    vi.mocked(discoverOrganizations).mockRejectedValue(new Error("API timeout"))

    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      graphToken: undefined,
      adoToken: "test-token",
      signin: vi.fn(),
    }

    const result = await execTool("ado_work_items", {}, ctx)
    expect(result).toContain("error")
  })

  it("ado_work_items without org: non-Error discovery rejection uses String(e)", async () => {
    vi.resetModules()
    const { discoverOrganizations } = await import("../../repertoire/ado-client")
    vi.mocked(discoverOrganizations).mockRejectedValue("string rejection")

    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      graphToken: undefined,
      adoToken: "test-token",
      signin: vi.fn(),
    }

    const result = await execTool("ado_work_items", {}, ctx)
    expect(result).toContain("string rejection")
  })

  it("base tools work without ToolContext", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockReturnValue("file content")
    const { execTool } = await import("../../repertoire/tools")

    const result = await execTool("read_file", { path: "/tmp/test.txt" })
    expect(result).toBe("file content")
  })

  it("base tools work with ToolContext (context is ignored)", async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockReturnValue("file content")
    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      graphToken: "token",
      adoToken: "token",
      signin: vi.fn(),
    }

    const result = await execTool("read_file", { path: "/tmp/test.txt" }, ctx)
    expect(result).toBe("file content")
  })
})

describe("summarizeArgs for graph/ado tools", () => {
  let summarizeArgs: (name: string, args: Record<string, any>) => string

  beforeEach(async () => {
    vi.resetModules()
    const tools = await import("../../repertoire/tools")
    summarizeArgs = tools.summarizeArgs
  })

  it("returns empty string for graph_profile", () => {
    expect(summarizeArgs("graph_profile", {})).toBe("")
  })

  it("returns organization for ado_work_items", () => {
    expect(summarizeArgs("ado_work_items", { organization: "myorg", query: "some query" })).toBe("organization=myorg query=some query")
  })

  it("returns empty string for ado_work_items with no organization", () => {
    expect(summarizeArgs("ado_work_items", {})).toBe("")
  })

  it("returns path for graph_query", () => {
    expect(summarizeArgs("graph_query", { path: "/me/messages" })).toBe("path=/me/messages")
  })

  it("returns empty string for graph_query with no path", () => {
    expect(summarizeArgs("graph_query", {})).toBe("")
  })

  it("truncates long graph_query path values", () => {
    const longPath = "/me/messages?" + "q=".repeat(80)
    expect(summarizeArgs("graph_query", { path: longPath })).toBe("path=" + longPath.slice(0, 60) + "...")
  })

  it("returns method + path for graph_mutate", () => {
    expect(summarizeArgs("graph_mutate", { method: "POST", path: "/me/messages" })).toBe("method=POST path=/me/messages")
  })

  it("returns empty string for graph_mutate with no method/path", () => {
    expect(summarizeArgs("graph_mutate", {})).toBe("")
  })

  it("returns org + path for ado_query", () => {
    expect(summarizeArgs("ado_query", { organization: "myorg", path: "/_apis/git/repos" })).toBe("organization=myorg path=/_apis/git/repos")
  })

  it("returns empty string parts for ado_query with no args", () => {
    expect(summarizeArgs("ado_query", {})).toBe("")
  })

  it("ignores whitespace-only path for ado_query summary", () => {
    expect(summarizeArgs("ado_query", { organization: "myorg", path: "   " })).toBe("organization=myorg")
  })

  it("returns method + org + path for ado_mutate", () => {
    expect(summarizeArgs("ado_mutate", { method: "PATCH", organization: "myorg", path: "/_apis/wit/workitems/1" })).toBe("method=PATCH organization=myorg path=/_apis/wit/workitems/1")
  })

  it("returns empty string parts for ado_mutate with no args", () => {
    expect(summarizeArgs("ado_mutate", {})).toBe("")
  })
})

describe("execTool for generic Graph tools", () => {
  it("graph_query calls graphRequest with GET", async () => {
    vi.resetModules()
    const { graphRequest } = await import("../../repertoire/graph-client")
    vi.mocked(graphRequest).mockResolvedValue('{"value": []}')

    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      graphToken: "test-token",
      adoToken: undefined,
      signin: vi.fn(),
    }

    const result = await execTool("graph_query", { path: "/me/messages?$top=5" }, ctx)
    expect(result).toBe('{"value": []}')
    expect(graphRequest).toHaveBeenCalledWith("test-token", "GET", "/me/messages?$top=5")
  })

  it("graph_query returns AUTH_REQUIRED when graphToken missing", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      graphToken: undefined,
      adoToken: undefined,
      signin: vi.fn(),
    }

    const result = await execTool("graph_query", { path: "/me" }, ctx)
    expect(result).toContain("AUTH_REQUIRED:graph")
  })

  it("graph_query returns AUTH_REQUIRED when no ToolContext", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")

    const result = await execTool("graph_query", { path: "/me" })
    expect(result).toContain("AUTH_REQUIRED:graph")
  })

  it("graph_mutate calls graphRequest with specified method and body", async () => {
    vi.resetModules()
    const { graphRequest } = await import("../../repertoire/graph-client")
    vi.mocked(graphRequest).mockResolvedValue('{"id": "msg-1"}')

    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      graphToken: "test-token",
      adoToken: undefined,
      signin: vi.fn(),
    }

    const body = '{"subject": "Hello"}'
    const result = await execTool("graph_mutate", { method: "POST", path: "/me/messages", body }, ctx)
    expect(result).toBe('{"id": "msg-1"}')
    expect(graphRequest).toHaveBeenCalledWith("test-token", "POST", "/me/messages", body)
  })

  it("graph_mutate calls graphRequest with PATCH method", async () => {
    vi.resetModules()
    const { graphRequest } = await import("../../repertoire/graph-client")
    vi.mocked(graphRequest).mockResolvedValue('{"updated": true}')

    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      graphToken: "test-token",
      adoToken: undefined,
      signin: vi.fn(),
    }

    const result = await execTool("graph_mutate", { method: "PATCH", path: "/me/events/1", body: '{"subject":"Updated"}' }, ctx)
    expect(result).toBe('{"updated": true}')
    expect(graphRequest).toHaveBeenCalledWith("test-token", "PATCH", "/me/events/1", '{"subject":"Updated"}')
  })

  it("graph_mutate calls graphRequest with DELETE method (no body)", async () => {
    vi.resetModules()
    const { graphRequest } = await import("../../repertoire/graph-client")
    vi.mocked(graphRequest).mockResolvedValue('{}')

    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      graphToken: "test-token",
      adoToken: undefined,
      signin: vi.fn(),
    }

    const result = await execTool("graph_mutate", { method: "DELETE", path: "/me/messages/msg-1" }, ctx)
    expect(result).toBe('{}')
    expect(graphRequest).toHaveBeenCalledWith("test-token", "DELETE", "/me/messages/msg-1", undefined)
  })

  it("graph_mutate rejects invalid method", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      graphToken: "test-token",
      adoToken: undefined,
      signin: vi.fn(),
    }

    const result = await execTool("graph_mutate", { method: "GET", path: "/me" }, ctx)
    expect(result).toContain("Invalid method")
    expect(result).toContain("POST, PATCH, DELETE")
  })

  it("graph_mutate returns AUTH_REQUIRED when graphToken missing", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      graphToken: undefined,
      adoToken: undefined,
      signin: vi.fn(),
    }

    const result = await execTool("graph_mutate", { method: "POST", path: "/me/messages" }, ctx)
    expect(result).toContain("AUTH_REQUIRED:graph")
  })
})

describe("execTool for generic ADO tools", () => {
  it("ado_query calls adoRequest with GET by default", async () => {
    vi.resetModules()
    const { adoRequest } = await import("../../repertoire/ado-client")
    vi.mocked(adoRequest).mockResolvedValue('{"value": []}')

    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      graphToken: undefined,
      adoToken: "test-token",
      signin: vi.fn(),
    }

    const result = await execTool("ado_query", { organization: "myorg", path: "/_apis/git/repositories" }, ctx)
    expect(result).toBe('{"value": []}')
    expect(adoRequest).toHaveBeenCalledWith("test-token", "GET", "myorg", "/_apis/git/repositories", undefined, undefined)
  })

  it("ado_query calls adoRequest with POST for WIQL", async () => {
    vi.resetModules()
    const { adoRequest } = await import("../../repertoire/ado-client")
    vi.mocked(adoRequest).mockResolvedValue('{"workItems": []}')

    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      graphToken: undefined,
      adoToken: "test-token",
      signin: vi.fn(),
    }

    const body = '{"query": "SELECT [System.Id] FROM WorkItems"}'
    const result = await execTool("ado_query", { organization: "myorg", path: "/_apis/wit/wiql", method: "POST", body }, ctx)
    expect(result).toBe('{"workItems": []}')
    expect(adoRequest).toHaveBeenCalledWith("test-token", "POST", "myorg", "/_apis/wit/wiql", body, undefined)
  })

  it("ado_query returns AUTH_REQUIRED when adoToken missing", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      graphToken: undefined,
      adoToken: undefined,
      signin: vi.fn(),
    }

    const result = await execTool("ado_query", { organization: "myorg", path: "/_apis/projects" }, ctx)
    expect(result).toContain("AUTH_REQUIRED:ado")
  })

  it("ado_query returns AUTH_REQUIRED when no ToolContext", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")

    const result = await execTool("ado_query", { organization: "myorg", path: "/_apis/projects" })
    expect(result).toContain("AUTH_REQUIRED:ado")
  })

  it("ado_mutate calls adoRequest with specified method and body", async () => {
    vi.resetModules()
    const { adoRequest } = await import("../../repertoire/ado-client")
    vi.mocked(adoRequest).mockResolvedValue('{"id": 456}')

    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      graphToken: undefined,
      adoToken: "test-token",
      signin: vi.fn(),
    }

    const body = '[{"op": "replace", "path": "/fields/System.Title", "value": "Updated"}]'
    const result = await execTool("ado_mutate", { method: "PATCH", organization: "myorg", path: "/_apis/wit/workitems/456", body }, ctx)
    expect(result).toBe('{"id": 456}')
    expect(adoRequest).toHaveBeenCalledWith("test-token", "PATCH", "myorg", "/_apis/wit/workitems/456", body, undefined)
  })

  it("ado_mutate rejects invalid method", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      graphToken: undefined,
      adoToken: "test-token",
      signin: vi.fn(),
    }

    const result = await execTool("ado_mutate", { method: "GET", organization: "myorg", path: "/_apis/projects" }, ctx)
    expect(result).toContain("Invalid method")
    expect(result).toContain("POST, PATCH, DELETE")
  })

  it("ado_mutate returns AUTH_REQUIRED when adoToken missing", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      graphToken: undefined,
      adoToken: undefined,
      signin: vi.fn(),
    }

    const result = await execTool("ado_mutate", { method: "POST", organization: "myorg", path: "/_apis/wit/workitems" }, ctx)
    expect(result).toContain("AUTH_REQUIRED:ado")
  })
})

describe("ado_mutate without authority checks (authority removed)", () => {
  it("ado_mutate proceeds with valid context", async () => {
    vi.resetModules()
    const { adoRequest } = await import("../../repertoire/ado-client")
    vi.mocked(adoRequest).mockResolvedValue('{"id": 789}')

    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      adoToken: "test-token",
      signin: vi.fn(),
      context: {
        friend: { id: "id", name: "test", externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {}, createdAt: "", updatedAt: "", schemaVersion: 1 },
        channel: { channel: "teams" as const, senseType: "closed" as const, availableIntegrations: ["ado" as const, "graph" as const], supportsMarkdown: true, supportsStreaming: true, supportsRichCards: true, maxMessageLength: 28000 },
      },
    }

    const result = await execTool("ado_mutate", { method: "POST", organization: "myorg", path: "/_apis/wit/workitems/$Task" }, ctx)
    expect(result).toBe('{"id": 789}')
    expect(adoRequest).toHaveBeenCalled()
  })

  it("ado_mutate proceeds when no context is available", async () => {
    vi.resetModules()
    const { adoRequest } = await import("../../repertoire/ado-client")
    vi.mocked(adoRequest).mockResolvedValue('{"id": 111}')

    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      adoToken: "test-token",
      signin: vi.fn(),
    }

    const result = await execTool("ado_mutate", { method: "PATCH", organization: "myorg", path: "/_apis/wit/workitems/1" }, ctx)
    expect(result).toBe('{"id": 111}')
    expect(adoRequest).toHaveBeenCalled()
  })
})

describe("execTool for docs tools", () => {
  it("graph_docs returns matching endpoints for a query", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")

    const result = await execTool("graph_docs", { query: "send email" })
    expect(result).toContain("send")
    // Should be valid, non-empty output
    expect(result.length).toBeGreaterThan(10)
  })

  it("graph_docs returns matching endpoints for calendar", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")

    const result = await execTool("graph_docs", { query: "calendar events" })
    expect(result).toContain("calendar")
  })

  it("graph_docs returns no results message for non-matching query", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")

    const result = await execTool("graph_docs", { query: "zzzyyyxxx_nonexistent" })
    expect(result).toContain("No matching")
  })

  it("graph_docs returns top 5 results max", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")

    // A broad query that should match many endpoints
    const result = await execTool("graph_docs", { query: "me" })
    const sections = result.split("\n\n").filter((s: string) => s.trim().length > 0)
    expect(sections.length).toBeLessThanOrEqual(5)
  })

  it("graph_docs is case-insensitive", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")

    const lower = await execTool("graph_docs", { query: "messages" })
    const upper = await execTool("graph_docs", { query: "MESSAGES" })
    expect(lower).toBe(upper)
  })

  it("ado_docs returns matching endpoints for a query", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")

    const result = await execTool("ado_docs", { query: "work items" })
    expect(result).toContain("work")
    expect(result.length).toBeGreaterThan(10)
  })

  it("ado_docs returns matching endpoints for pull requests", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")

    const result = await execTool("ado_docs", { query: "pull request" })
    expect(result).toContain("pull")
  })

  it("ado_docs returns no results message for non-matching query", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")

    const result = await execTool("ado_docs", { query: "zzzyyyxxx_nonexistent" })
    expect(result).toContain("No matching")
  })

  it("ado_docs returns top 5 results max", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")

    const result = await execTool("ado_docs", { query: "api" })
    const sections = result.split("\n\n").filter((s: string) => s.trim().length > 0)
    expect(sections.length).toBeLessThanOrEqual(5)
  })

  it("ado_docs is case-insensitive", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")

    const lower = await execTool("ado_docs", { query: "pipeline" })
    const upper = await execTool("ado_docs", { query: "PIPELINE" })
    expect(lower).toBe(upper)
  })

  it("graph_docs handles missing query arg", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")

    const result = await execTool("graph_docs", {})
    expect(typeof result).toBe("string")
  })

  it("ado_docs handles missing query arg", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")

    const result = await execTool("ado_docs", {})
    expect(typeof result).toBe("string")
  })

  it("ado_docs includes Host line for endpoints with custom host", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")

    const result = await execTool("ado_docs", { query: "group entitlement" })
    expect(result).toContain("Host: vsaex.dev.azure.com")
  })
})

describe("getToolsForChannel includes docs tools", () => {
  it("teams channel includes graph_docs and ado_docs", async () => {
    vi.resetModules()
    const { getToolsForChannel, tools } = await import("../../repertoire/tools")
    const teamsCaps = {
      channel: "teams" as const,
      senseType: "closed" as const,
      availableIntegrations: ["ado" as const, "graph" as const],
      supportsMarkdown: true,
      supportsStreaming: true,
      supportsRichCards: true,
      maxMessageLength: Infinity,
    }
    const teamsTools = getToolsForChannel(teamsCaps)
    const names = teamsTools.map((t: any) => t.function.name)
    const capabilityGatedTools = new Set(["set_reasoning_effort"])
    const baseCount = tools.filter((t: any) => !capabilityGatedTools.has(t.function.name)).length
    expect(names).toContain("graph_docs")
    expect(names).toContain("ado_docs")
    // Should have semantic ado tools
    expect(names).toContain("ado_backlog_list")
    // All base tools now present (no channel-level blocking)
    expect(names).toContain("read_file")
    expect(names).toContain("shell")
    // base tools + 8 teams tools (4 generic + 2 aliases + 2 docs) + 11 semantic ado tools + 1 teams_send_message
    expect(teamsTools.length).toBe(baseCount + 20)
  })

  it("cli channel does NOT include graph_docs or ado_docs", async () => {
    vi.resetModules()
    const { getToolsForChannel } = await import("../../repertoire/tools")
    const cliCaps = {
      channel: "cli" as const,
      availableIntegrations: [],
      supportsMarkdown: false,
      supportsStreaming: true,
      supportsRichCards: false,
      maxMessageLength: Infinity,
    }
    const cliTools = getToolsForChannel(cliCaps)
    const names = cliTools.map((t: any) => t.function.name)
    expect(names).not.toContain("graph_docs")
    expect(names).not.toContain("ado_docs")
  })

  it("bluebubbles channel includes the reply-target tool", async () => {
    vi.resetModules()
    const { getToolsForChannel } = await import("../../repertoire/tools")
    const bluebubblesCaps = {
      channel: "bluebubbles" as const,
      availableIntegrations: [],
      supportsMarkdown: false,
      supportsStreaming: false,
      supportsRichCards: false,
      maxMessageLength: Infinity,
    }
    const result = getToolsForChannel(bluebubblesCaps)
    const names = result.map((t: any) => t.function.name)
    expect(names).toContain("bluebubbles_set_reply_target")
  })
})

describe("summarizeArgs for docs tools", () => {
  let summarizeArgs: (name: string, args: Record<string, any>) => string

  beforeEach(async () => {
    vi.resetModules()
    const tools = await import("../../repertoire/tools")
    summarizeArgs = tools.summarizeArgs
  })

  it("returns query for graph_docs", () => {
    expect(summarizeArgs("graph_docs", { query: "send email" })).toBe("query=send email")
  })

  it("returns empty string for graph_docs with no query", () => {
    expect(summarizeArgs("graph_docs", {})).toBe("")
  })

  it("returns empty string for graph_docs whitespace-only query", () => {
    expect(summarizeArgs("graph_docs", { query: "  \n  " })).toBe("")
  })

  it("returns query for ado_docs", () => {
    expect(summarizeArgs("ado_docs", { query: "work items" })).toBe("query=work items")
  })

  it("returns empty string for ado_docs with no query", () => {
    expect(summarizeArgs("ado_docs", {})).toBe("")
  })

  it("returns user_name and user_id for teams_send_message", () => {
    expect(summarizeArgs("teams_send_message", { user_name: "Alice", user_id: "uid-1", message: "hi" })).toBe("user_name=Alice user_id=uid-1")
  })

  it("returns type+key summary for save_friend_note", () => {
    expect(summarizeArgs("save_friend_note", { type: "tool_preference", key: "ado", content: "flat backlog" })).toBe("type=tool_preference key=ado content=flat backlog")
  })

  it("returns target summary for bluebubbles_set_reply_target", () => {
    expect(summarizeArgs("bluebubbles_set_reply_target", { target: "thread", threadOriginatorGuid: "THREAD-1" }))
      .toBe("target=thread threadOriginatorGuid=THREAD-1")
  })

  it("returns the approved bridge summary fields for bridge_manage", () => {
    expect(summarizeArgs("bridge_manage", {
      action: "attach",
      bridgeId: "bridge-1",
      objective: "keep cli and teams aligned",
      friendId: "friend-2",
      channel: "teams",
      key: "conv-2",
      body: "ignored",
    })).toBe(
      "action=attach bridgeId=bridge-1 objective=keep cli and teams aligned friendId=friend-2 channel=teams key=conv-2",
    )
  })

  it("returns type for save_friend_note name type (no key)", () => {
    expect(summarizeArgs("save_friend_note", { type: "name", content: "Jordan" })).toBe("type=name content=Jordan")
  })

  it("returns org + project for ado_backlog_list", () => {
    expect(summarizeArgs("ado_backlog_list", { organization: "myorg", project: "myproj" })).toBe("organization=myorg project=myproj")
  })

  it("returns empty string for ado_backlog_list with no org/project", () => {
    expect(summarizeArgs("ado_backlog_list", {})).toBe("")
  })
})

describe("bluebubbles reply target tool", () => {
  it("returns a friendly message when reply targeting is unavailable", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const result = await execTool("bluebubbles_set_reply_target", { target: "top_level" }, { signin: async () => undefined })
    expect(result).toBe("bluebubbles reply targeting is not available in this context.")
  })

  it("updates the toolContext lane controller", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const setSelection = vi.fn().mockReturnValue("bluebubbles reply target set to top_level")
    const result = await execTool(
      "bluebubbles_set_reply_target",
      { target: "top_level" },
      {
        signin: async () => undefined,
        bluebubblesReplyTarget: { setSelection },
      },
    )
    expect(setSelection).toHaveBeenCalledWith({ target: "top_level" })
    expect(result).toBe("bluebubbles reply target set to top_level")
  })

  it("supports selecting the current inbound lane explicitly", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const setSelection = vi.fn().mockReturnValue("bluebubbles reply target set to current_lane")
    const result = await execTool(
      "bluebubbles_set_reply_target",
      { target: "current_lane" },
      {
        signin: async () => undefined,
        bluebubblesReplyTarget: { setSelection },
      },
    )
    expect(setSelection).toHaveBeenCalledWith({ target: "current_lane" })
    expect(result).toBe("bluebubbles reply target set to current_lane")
  })

  it("requires threadOriginatorGuid when targeting a specific thread", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const result = await execTool(
      "bluebubbles_set_reply_target",
      { target: "thread" },
      {
        signin: async () => undefined,
        bluebubblesReplyTarget: { setSelection: vi.fn() },
      },
    )
    expect(result).toBe("threadOriginatorGuid is required when target=thread.")
  })

  it("supports selecting a specific active thread", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const setSelection = vi.fn().mockReturnValue("bluebubbles reply target set to thread:THREAD-1")
    const result = await execTool(
      "bluebubbles_set_reply_target",
      { target: "thread", threadOriginatorGuid: "THREAD-1" },
      {
        signin: async () => undefined,
        bluebubblesReplyTarget: { setSelection },
      },
    )
    expect(setSelection).toHaveBeenCalledWith({ target: "thread", threadOriginatorGuid: "THREAD-1" })
    expect(result).toBe("bluebubbles reply target set to thread:THREAD-1")
  })

  it("rejects unknown target values", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const result = await execTool(
      "bluebubbles_set_reply_target",
      { target: "sideways" },
      {
        signin: async () => undefined,
        bluebubblesReplyTarget: { setSelection: vi.fn() },
      },
    )
    expect(result).toBe("target must be one of: current_lane, top_level, thread.")
  })

  it("rejects non-string target values", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const result = await execTool(
      "bluebubbles_set_reply_target",
      { target: 42 as unknown as string },
      {
        signin: async () => undefined,
        bluebubblesReplyTarget: { setSelection: vi.fn() },
      },
    )
    expect(result).toBe("target must be one of: current_lane, top_level, thread.")
  })
})

describe("save_friend_note tool", () => {
  // Helper: create a mock FriendRecord
  function makeFriend(overrides: Record<string, any> = {}) {
    return {
      id: "uuid-1",
      name: "Jordan",
      externalIds: [{ provider: "aad", externalId: "aad-1", linkedAt: "2026-01-01" }],
      tenantMemberships: ["t1"],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      schemaVersion: 1,
      ...overrides,
    }
  }

  // Helper: create a mock ToolContext with friendStore
  function makeCtx(overrides: Record<string, any> = {}) {
    const friend = overrides.friend ?? makeFriend(overrides.friendOverrides)
    const friendStore = overrides.friendStore ?? {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
    }
    return {
      signin: vi.fn(),
      context: {
        friend,
        channel: { channel: "cli" as const, availableIntegrations: [] as any[], supportsMarkdown: false, supportsStreaming: true, supportsRichCards: false, maxMessageLength: Infinity },
      },
      friendStore,
    }
  }

  it("is registered as a base tool definition (no integration)", async () => {
    vi.resetModules()
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "save_friend_note")
    expect(def).toBeDefined()
    expect(def!.integration).toBeUndefined()
  })

  it("tool description includes first-person override guidance", async () => {
    vi.resetModules()
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const def = baseToolDefinitions.find(d => d.tool.function.name === "save_friend_note")!
    expect(def.tool.function.description).toContain("override")
  })

  // -- Validation tests --

  it("returns first-person error when content is missing", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = makeCtx()
    const result = await execTool("save_friend_note", { type: "note", key: "role" }, ctx)
    expect(result).toMatch(/content/i)
    expect(result).toMatch(/i need|required/i)
  })

  it("returns first-person error when key is missing for tool_preference type", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = makeCtx()
    const result = await execTool("save_friend_note", { type: "tool_preference", content: "flat backlog" }, ctx)
    expect(result).toMatch(/key/i)
    expect(result).toMatch(/i need|required/i)
  })

  it("returns first-person error when key is missing for note type", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = makeCtx()
    const result = await execTool("save_friend_note", { type: "note", content: "engineering manager" }, ctx)
    expect(result).toMatch(/key/i)
    expect(result).toMatch(/i need|required/i)
  })

  it("returns first-person error when type is invalid", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = makeCtx()
    const result = await execTool("save_friend_note", { type: "invalid", key: "k", content: "v" }, ctx)
    expect(result).toMatch(/type/i)
  })

  it("returns error when no context is available", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = { signin: vi.fn() }
    const result = await execTool("save_friend_note", { type: "note", key: "role", content: "eng" }, ctx)
    expect(result).toContain("no friend context")
  })

  it("returns error when no friendStore is available", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = {
      signin: vi.fn(),
      context: {
        friend: makeFriend(),
        channel: { channel: "cli" as const, availableIntegrations: [] as any[], supportsMarkdown: false, supportsStreaming: true, supportsRichCards: false, maxMessageLength: Infinity },
      },
    }
    const result = await execTool("save_friend_note", { type: "note", key: "role", content: "eng" }, ctx)
    expect(result).toContain("not available")
  })

  // -- type: "name" tests --

  it("type 'name' updates name field (not a note)", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = makeCtx()
    const result = await execTool("save_friend_note", { type: "name", content: "Jordan Lee" }, ctx)
    expect(result).toContain("saved")
    expect(ctx.friendStore.put).toHaveBeenCalledWith(
      "uuid-1",
      expect.objectContaining({
        name: "Jordan Lee",
      }),
    )
    // notes should NOT contain "name" key -- name is stored on the record, not as a note
    const putArg = ctx.friendStore.put.mock.calls[0][1]
    expect(putArg.notes).not.toHaveProperty("name")
  })

  it("type 'name' does not require key parameter", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = makeCtx()
    const result = await execTool("save_friend_note", { type: "name", content: "Alex" }, ctx)
    expect(result).toContain("saved")
  })

  // -- type: "tool_preference" tests --

  it("type 'tool_preference' saves new preference", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = makeCtx()
    const result = await execTool("save_friend_note", { type: "tool_preference", key: "ado", content: "flat backlog view" }, ctx)
    expect(result).toContain("saved")
    expect(ctx.friendStore.put).toHaveBeenCalledWith(
      "uuid-1",
      expect.objectContaining({
        toolPreferences: { ado: "flat backlog view" },
      }),
    )
  })

  it("type 'tool_preference' with existing value and no override returns conflict", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = makeCtx({ friendOverrides: { toolPreferences: { ado: "old preference" } } })
    const result = await execTool("save_friend_note", { type: "tool_preference", key: "ado", content: "new preference" }, ctx)
    // Should NOT have written to disk
    expect(ctx.friendStore.put).not.toHaveBeenCalled()
    // Should return existing value and merge instruction
    expect(result).toContain("old preference")
    expect(result).toMatch(/override|merge/i)
  })

  it("type 'tool_preference' with existing value and override=true overwrites", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = makeCtx({ friendOverrides: { toolPreferences: { ado: "old preference" } } })
    const result = await execTool("save_friend_note", { type: "tool_preference", key: "ado", content: "new preference", override: "true" }, ctx)
    expect(result).toContain("saved")
    expect(ctx.friendStore.put).toHaveBeenCalledWith(
      "uuid-1",
      expect.objectContaining({
        toolPreferences: { ado: "new preference" },
      }),
    )
  })

  // -- type: "note" tests --

  it("type 'note' saves new note with structured { value, savedAt }", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = makeCtx()
    const result = await execTool("save_friend_note", { type: "note", key: "role", content: "engineering manager" }, ctx)
    expect(result).toContain("saved")
    expect(ctx.friendStore.put).toHaveBeenCalledWith(
      "uuid-1",
      expect.objectContaining({
        notes: { role: { value: "engineering manager", savedAt: expect.stringMatching(/^\d{4}-/) } },
      }),
    )
  })

  it("type 'note' with existing structured value and no override returns conflict showing value", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = makeCtx({ friendOverrides: { notes: { role: { value: "old role", savedAt: "2026-01-01T00:00:00.000Z" } } } })
    const result = await execTool("save_friend_note", { type: "note", key: "role", content: "new role" }, ctx)
    expect(ctx.friendStore.put).not.toHaveBeenCalled()
    expect(result).toContain("old role")
    expect(result).not.toContain("[object Object]")
    expect(result).toMatch(/override|merge/i)
  })

  it("type 'note' with existing value and override=true replaces with updated savedAt", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = makeCtx({ friendOverrides: { notes: { role: { value: "old role", savedAt: "2026-01-01T00:00:00.000Z" } } } })
    const result = await execTool("save_friend_note", { type: "note", key: "role", content: "new role", override: "true" }, ctx)
    expect(result).toContain("saved")
    expect(ctx.friendStore.put).toHaveBeenCalledWith(
      "uuid-1",
      expect.objectContaining({
        notes: { role: { value: "new role", savedAt: expect.stringMatching(/^\d{4}-/) } },
      }),
    )
  })

  // -- type: "note" key: "name" -> name field redirect tests --

  it("type 'note' key 'name' redirects to name field update (not a note)", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = makeCtx()
    const result = await execTool("save_friend_note", { type: "note", key: "name", content: "Ari" }, ctx)
    expect(ctx.friendStore.put).toHaveBeenCalledWith(
      "uuid-1",
      expect.objectContaining({
        name: "Ari",
      }),
    )
    // notes should NOT contain key "name"
    const putArg = ctx.friendStore.put.mock.calls[0][1]
    expect(putArg.notes).not.toHaveProperty("name")
  })

  it("type 'note' key 'name' returns descriptive redirect message", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = makeCtx()
    const result = await execTool("save_friend_note", { type: "note", key: "name", content: "Ari" }, ctx)
    // Should indicate it was stored as name, not a note
    expect(result.toLowerCase()).toContain("name")
    expect(result).toContain("Ari")
    expect(result.toLowerCase()).toMatch(/name.*not a note|stored as.*name/)
  })

  it("type 'note' key 'name' with override=true still redirects to name field", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = makeCtx()
    const result = await execTool("save_friend_note", { type: "note", key: "name", content: "Ari", override: "true" }, ctx)
    expect(ctx.friendStore.put).toHaveBeenCalledWith(
      "uuid-1",
      expect.objectContaining({
        name: "Ari",
      }),
    )
  })

  it("type 'note' key 'name' does NOT check for existing note conflict", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    // Give the friend an existing "name" note to verify it's bypassed
    const ctx = makeCtx({ friendOverrides: { notes: { name: { value: "Old Name", savedAt: "2026-01-01T00:00:00.000Z" } } } })
    const result = await execTool("save_friend_note", { type: "note", key: "name", content: "New Name" }, ctx)
    // Should NOT return conflict message, should always update
    expect(result).not.toContain("already have")
    expect(ctx.friendStore.put).toHaveBeenCalled()
  })

  // -- Disk write / no process-local mutation tests --

  it("writes to disk via friendStore.put, reads fresh record via friendStore.get", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const friend = makeFriend()
    const friendStore = {
      get: vi.fn().mockResolvedValue(friend),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
    }
    const ctx = {
      signin: vi.fn(),
      context: { friend, channel: { channel: "cli" as const, availableIntegrations: [] as any[], supportsMarkdown: false, supportsStreaming: true, supportsRichCards: false, maxMessageLength: Infinity } },
      friendStore,
    }
    await execTool("save_friend_note", { type: "note", key: "role", content: "manager" }, ctx)
    // Should have called get first to read fresh record
    expect(friendStore.get).toHaveBeenCalledWith("uuid-1")
    // Should have called put to write
    expect(friendStore.put).toHaveBeenCalled()
  })

  it("handles write failure gracefully", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const friendStore = {
      get: vi.fn().mockResolvedValue(makeFriend()),
      put: vi.fn().mockRejectedValue(new Error("disk full")),
      delete: vi.fn(),
      findByExternalId: vi.fn(),
    }
    const ctx = {
      signin: vi.fn(),
      context: { friend: makeFriend(), channel: { channel: "cli" as const, availableIntegrations: [] as any[], supportsMarkdown: false, supportsStreaming: true, supportsRichCards: false, maxMessageLength: Infinity } },
      friendStore,
    }
    const result = await execTool("save_friend_note", { type: "note", key: "role", content: "test" }, ctx)
    expect(result).toContain("error")
    expect(result).toContain("disk full")
  })

  it("returns error when friend has no id", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const friendNoId = makeFriend({ id: "" })
    const ctx = {
      signin: vi.fn(),
      context: { friend: friendNoId, channel: { channel: "cli" as const, availableIntegrations: [] as any[], supportsMarkdown: false, supportsStreaming: true, supportsRichCards: false, maxMessageLength: Infinity } },
      friendStore: { get: vi.fn(), put: vi.fn(), delete: vi.fn(), findByExternalId: vi.fn() },
    }
    const result = await execTool("save_friend_note", { type: "note", key: "role", content: "test" }, ctx)
    expect(result).toContain("no friend identity")
  })

  it("returns error when friendStore.get returns null", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    const ctx = makeCtx({ friendStore: { get: vi.fn().mockResolvedValue(null), put: vi.fn(), delete: vi.fn(), findByExternalId: vi.fn() } })
    const result = await execTool("save_friend_note", { type: "note", key: "role", content: "test" }, ctx)
    expect(result).toContain("can't find")
  })
})

describe("github tool registration", () => {
  it("allDefinitions includes file_ouroboros_bug (via execTool)", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    // If file_ouroboros_bug is registered, calling it without a token returns AUTH_REQUIRED
    const result = await execTool("file_ouroboros_bug", { title: "t" })
    expect(result).toContain("AUTH_REQUIRED:github")
  })

  it("summarizeArgs returns title key=value for file_ouroboros_bug", async () => {
    vi.resetModules()
    const { summarizeArgs } = await import("../../repertoire/tools")
    expect(summarizeArgs("file_ouroboros_bug", { title: "Fix bug" })).toBe("title=Fix bug")
  })

  it("summarizeArgs returns empty string for file_ouroboros_bug with no title", async () => {
    vi.resetModules()
    const { summarizeArgs } = await import("../../repertoire/tools")
    expect(summarizeArgs("file_ouroboros_bug", {})).toBe("")
  })

  it("file_ouroboros_bug executes on remote channel (no channel-level blocking)", async () => {
    vi.resetModules()
    const { execTool } = await import("../../repertoire/tools")
    // If it were blocked, calling it in a remote context would return "can't do that from here"
    const remoteContext = {
      githubToken: "tok",
      signin: async () => undefined,
      context: {
        identity: {
          id: "friend-1",
          displayName: "Test",
          externalIds: [],
          tenantMemberships: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          schemaVersion: 1,
        },
        channel: {
          channel: "teams",
          availableIntegrations: ["github"],
          supportsMarkdown: true,
          supportsStreaming: true,
          supportsRichCards: true,
          maxMessageLength: Infinity,
        },
        notes: null,
      },
    } as any
    const { githubRequest } = await import("../../repertoire/github-client")
    vi.mocked(githubRequest).mockResolvedValue('{"id":1}')
    const result = await execTool("file_ouroboros_bug", { title: "t" }, remoteContext)
    expect(result).not.toContain("can't do that from here")
  })

  it("getToolsForChannel with github integration returns file_ouroboros_bug", async () => {
    vi.resetModules()
    const { getToolsForChannel } = await import("../../repertoire/tools")
    const teamsCaps = {
      channel: "teams" as const,
      senseType: "closed" as const,
      availableIntegrations: ["ado" as const, "graph" as const, "github" as const],
      supportsMarkdown: true,
      supportsStreaming: true,
      supportsRichCards: true,
      maxMessageLength: Infinity,
    }
    const result = getToolsForChannel(teamsCaps)
    const names = result.map((t: any) => t.function.name)
    expect(names).toContain("file_ouroboros_bug")
  })

  it("getToolsForChannel with CLI caps does NOT return file_ouroboros_bug", async () => {
    vi.resetModules()
    const { getToolsForChannel } = await import("../../repertoire/tools")
    const cliCaps = {
      channel: "cli" as const,
      availableIntegrations: [] as const,
      supportsMarkdown: false,
      supportsStreaming: true,
      supportsRichCards: false,
      maxMessageLength: Infinity,
    }
    const result = getToolsForChannel(cliCaps)
    const names = result.map((t: any) => t.function.name)
    expect(names).not.toContain("file_ouroboros_bug")
  })
})
