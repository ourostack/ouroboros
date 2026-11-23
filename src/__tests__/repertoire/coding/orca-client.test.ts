import { describe, expect, it, vi } from "vitest"

import { OrcaCli, OrcaCliError, resolveOrcaExecutable, type ExecFileFn } from "../../../repertoire/coding/orca-client"

type Call = { file: string; args: string[]; options: { cwd?: string; timeout: number } }

function cliReplying(replies: Array<{ stdout?: string; stderr?: string; error?: Error | null } | object>) {
  const calls: Call[] = []
  const execFileFn: ExecFileFn = (file, args, options, callback) => {
    calls.push({ file, args, options })
    const next = replies.shift() ?? {}
    if ("stdout" in next || "stderr" in next || "error" in next) {
      const reply = next as { stdout?: string; stderr?: string; error?: Error | null }
      callback(reply.error ?? null, reply.stdout as string, reply.stderr as string)
    } else {
      callback(null, JSON.stringify({ ok: true, result: next }), "")
    }
    return undefined
  }
  return { cli: new OrcaCli({ executablePath: "/bin/orca", execFileFn, timeoutMs: 10, launchTimeoutMs: 20 }), calls }
}

const worktree = { id: "repo::/wt/fix", path: "/wt/fix", branch: "refs/heads/ari/fix", isMainWorktree: false }

describe("resolveOrcaExecutable", () => {
  it("prefers the app bundle, then the per-user app, then orca on PATH", () => {
    expect(resolveOrcaExecutable({ existsSync: (p) => p.startsWith("/Applications/"), homeDir: "/home/me" }))
      .toBe("/Applications/Orca.app/Contents/Resources/bin/orca")
    expect(resolveOrcaExecutable({ existsSync: (p) => p.startsWith("/home/me/"), homeDir: "/home/me" }))
      .toBe("/home/me/Applications/Orca.app/Contents/Resources/bin/orca")
    expect(resolveOrcaExecutable({ existsSync: () => false, homeDir: "/home/me" })).toBe("orca")
  })

  it("uses the real filesystem and home by default", () => {
    expect(typeof resolveOrcaExecutable()).toBe("string")
    expect(new OrcaCli().executablePath.length).toBeGreaterThan(0)
  })
})

describe("OrcaCli.run", () => {
  it("adds --json and returns the reply's result", async () => {
    const { cli, calls } = cliReplying([{ hello: 1 }])
    expect(await cli.run(["terminal", "list"], { cwd: "/x" })).toEqual({ hello: 1 })
    expect(calls[0]).toEqual(expect.objectContaining({ file: "/bin/orca", args: ["terminal", "list", "--json"] }))
    expect(calls[0].options).toEqual(expect.objectContaining({ cwd: "/x", timeout: 10 }))
  })

  it("treats a missing result as empty", async () => {
    const { cli } = cliReplying([{ stdout: JSON.stringify({ ok: true }) }])
    expect(await cli.run(["status"])).toEqual({})
  })

  it("throws Orca's own error code and message", async () => {
    const { cli } = cliReplying([{ stdout: JSON.stringify({ ok: false, error: { code: "terminal_handle_stale", message: "gone" } }), error: new Error("exit 1") }])
    await expect(cli.run(["terminal", "read"])).rejects.toMatchObject({ code: "terminal_handle_stale", message: "orca terminal read: gone" })
  })

  it("falls back to stderr, then the exec error, when there is no JSON", async () => {
    const stderr = cliReplying([{ stdout: "", stderr: "orca: runtime not reachable\n", error: new Error("exit 1") }])
    await expect(stderr.cli.run(["agent", "list"])).rejects.toMatchObject({ code: "orca-cli-failed", message: "orca agent list: orca: runtime not reachable" })

    const exec = cliReplying([{ stdout: undefined, stderr: undefined, error: new Error("spawn orca ENOENT") }])
    await expect(exec.cli.run(["agent", "list"])).rejects.toMatchObject({ code: "orca-cli-failed", message: "orca agent list: spawn orca ENOENT" })

    const silent = cliReplying([{ stdout: "not json", stderr: "", error: null }])
    await expect(silent.cli.run(["agent", "list"])).rejects.toMatchObject({ code: "orca-bad-reply", message: "orca agent list: orca agent list printed no JSON reply" })
  })

  it("treats a non-object reply as a bad reply", async () => {
    const { cli } = cliReplying([{ stdout: "[1,2]" }])
    await expect(cli.run(["x"])).rejects.toBeInstanceOf(OrcaCliError)
  })
})

describe("OrcaCli commands", () => {
  it("shows a worktree, or null when Orca manages none there", async () => {
    const { cli, calls } = cliReplying([{ worktree }, { stdout: JSON.stringify({ ok: false, error: { message: "no worktree" } }) }])
    expect(await cli.showWorktree("/wt/fix")).toEqual({ id: "repo::/wt/fix", path: "/wt/fix", branch: "ari/fix", isMainWorktree: false })
    expect(calls[0].args).toEqual(["worktree", "show", "--worktree", "path:/wt/fix", "--json"])
    expect(await cli.showWorktree("/elsewhere")).toBeNull()
  })

  it("creates a worktree with a terminal agent from the repo directory", async () => {
    const { cli, calls } = cliReplying([{
      worktree: { id: "repo::/wt/new", path: "/wt/new", isMainWorktree: true },
      launch: { outcome: { kind: "terminal", handle: "term_1" }, prompt: { outcome: "handed-to-terminal" }, receipt: { detail: "terminal per settings" } },
    }])

    const launch = await cli.createWorktreeWithAgent({ repoDir: "/repo", name: "fix-it", agent: "claude", prompt: "do it" })

    expect(launch).toEqual({
      worktree: { id: "repo::/wt/new", path: "/wt/new", branch: undefined, isMainWorktree: true },
      terminalHandle: "term_1",
      promptDelivered: true,
      detail: "terminal per settings",
    })
    expect(calls[0].args).toEqual([
      "worktree", "create", "--name", "fix-it", "--no-parent", "--agent", "claude", "--surface", "terminal", "--prompt", "do it", "--json",
    ])
    expect(calls[0].options).toEqual(expect.objectContaining({ cwd: "/repo", timeout: 20 }))
  })

  it("reads each prompt outcome Orca reports", async () => {
    const { cli } = cliReplying([
      { worktree, launch: { outcome: { handle: "t" }, prompt: { outcome: "journaled" } } },
      { worktree, launch: { outcome: { handle: "t" }, prompt: { outcome: "not-delivered" } } },
      { worktree, launch: { outcome: { handle: "t" }, prompt: { outcome: "unconfirmed" } } },
      { worktree, agentTerminalHandle: "legacy" },
    ])
    const args = { repoDir: "/repo", name: "n", agent: "codex", prompt: "p" }
    expect((await cli.createWorktreeWithAgent(args)).promptDelivered).toBe(true)
    expect((await cli.createWorktreeWithAgent(args)).promptDelivered).toBe(false)
    expect((await cli.createWorktreeWithAgent(args)).promptDelivered).toBeNull()
    const legacy = await cli.createWorktreeWithAgent(args)
    expect(legacy).toEqual(expect.objectContaining({ terminalHandle: "legacy", promptDelivered: null, detail: null }))
  })

  it("refuses a launch that started no terminal agent, or names no worktree", async () => {
    const { cli } = cliReplying([{ worktree, launch: { outcome: { kind: "structured" } } }, { launch: { outcome: { handle: "t" } } }])
    const args = { repoDir: "/repo", name: "n", agent: "codex", prompt: "p" }
    await expect(cli.createWorktreeWithAgent(args)).rejects.toMatchObject({ code: "orca-no-terminal" })
    await expect(cli.createWorktreeWithAgent(args)).rejects.toMatchObject({ code: "orca-bad-reply" })
  })

  it("launches an agent in an existing worktree", async () => {
    const { cli, calls } = cliReplying([{ outcome: { kind: "terminal", handle: "term_2" }, receipt: { detail: "d" } }])

    const launch = await cli.launchAgent({ worktree, agent: "codex", prompt: "go" })

    expect(launch).toEqual({ worktree, terminalHandle: "term_2", promptDelivered: null, detail: "d" })
    expect(calls[0].args).toEqual([
      "agent", "launch", "--worktree", "id:repo::/wt/fix", "--agent", "codex", "--surface", "terminal", "--prompt", "go", "--json",
    ])
    expect(calls[0].options.cwd).toBe("/wt/fix")
  })

  it("lists terminals and agents in a worktree", async () => {
    const { cli, calls } = cliReplying([
      { terminals: [{ handle: "term_1", tabId: "a", leafId: "b" }, "junk"] },
      {},
      { agents: [{ state: "working", paneKey: "a:b" }] },
      { agents: "nope" },
    ])
    expect(await cli.listTerminals("repo::/wt")).toEqual([{ handle: "term_1", tabId: "a", leafId: "b" }, {}])
    expect(calls[0].args).toEqual(["terminal", "list", "--worktree", "id:repo::/wt", "--json"])
    expect(await cli.listTerminals("repo::/wt")).toEqual([])
    expect(await cli.listAgents("repo::/wt")).toEqual([{ state: "working", paneKey: "a:b" }])
    expect(calls[2].args).toEqual(["agent", "list", "--worktree", "id:repo::/wt", "--json"])
    expect(await cli.listAgents("repo::/wt")).toEqual([])
  })

  it("reads a terminal's rendered screen", async () => {
    const { cli, calls } = cliReplying([
      { terminal: { status: "running", tail: ["one", "two"] } },
      { terminal: { status: "exited", tail: [] } },
      { terminal: { status: "weird" } },
    ])
    expect(await cli.readTerminal("term_1")).toEqual({ status: "running", tail: "one\ntwo" })
    expect(calls[0].args).toEqual(["terminal", "read", "--terminal", "term_1", "--screen", "--limit", "120", "--json"])
    expect(await cli.readTerminal("term_1", 5)).toEqual({ status: "exited", tail: "" })
    expect(await cli.readTerminal("term_1")).toEqual({ status: "unknown", tail: "" })
  })

  it("sends text with Enter and closes a terminal's tab", async () => {
    const { cli, calls } = cliReplying([{}, {}])
    await cli.sendText("term_1", "yes")
    await cli.closeTerminal("term_1")
    expect(calls.map((call) => call.args)).toEqual([
      ["terminal", "send", "--terminal", "term_1", "--text", "yes", "--enter", "--json"],
      ["terminal", "close", "--terminal", "term_1", "--tab", "--json"],
    ])
  })
})

describe("OrcaCli default exec", () => {
  it("runs through child_process.execFile", async () => {
    vi.resetModules()
    vi.doMock("child_process", async () => {
      const actual = await vi.importActual<typeof import("child_process")>("child_process")
      return {
        ...actual,
        execFile: vi.fn((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
          callback(null, JSON.stringify({ ok: true, result: { via: "execFile" } }), "")
        }),
      }
    })
    const { OrcaCli: FreshCli } = await import("../../../repertoire/coding/orca-client")
    expect(await new FreshCli({ executablePath: "/bin/orca" }).run(["status"])).toEqual({ via: "execFile" })
    vi.doUnmock("child_process")
  })
})
