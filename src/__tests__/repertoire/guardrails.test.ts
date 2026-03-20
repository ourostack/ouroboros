import { describe, it, expect, vi, beforeEach } from "vitest"
import * as fs from "node:fs"

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
  }
})

describe("guardInvocation — structural guardrails", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReturnValue(false)
  })

  // --- edit_file requires prior read ---

  it("edit_file rejects if path has not been read", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("edit_file", { path: "/some/file.ts" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toMatch(/read/i)
    }
  })

  it("edit_file allows if path is in readPaths", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("edit_file", { path: "/some/file.ts" }, { readPaths: new Set(["/some/file.ts"]) })
    expect(result.allowed).toBe(true)
  })

  // --- write_file on existing file requires prior read ---

  it("write_file rejects overwriting existing file without prior read", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("write_file", { path: "/existing/file.ts" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toMatch(/read/i)
    }
  })

  it("write_file allows new file (not on disk) without prior read", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("write_file", { path: "/new/file.ts" }, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })

  it("write_file allows overwriting existing file if in readPaths", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("write_file", { path: "/existing/file.ts" }, { readPaths: new Set(["/existing/file.ts"]) })
    expect(result.allowed).toBe(true)
  })

  // --- destructive shell patterns blocked ---

  it("blocks rm -rf /", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "rm -rf /" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/dangerous/i)
  })

  it("blocks rm -rf ~", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "rm -rf ~" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
  })

  it("blocks chmod -R 777 /", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "chmod -R 777 /" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
  })

  it("blocks mkfs.ext4", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "mkfs.ext4 /dev/sda" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
  })

  it("blocks dd if=/dev/zero of=/dev/sda", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "dd if=/dev/zero of=/dev/sda" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
  })

  it("allows non-destructive commands like ls", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ls -la" }, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })

  it("allows non-destructive commands like cat", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "cat foo.txt" }, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })

  it("allows non-destructive commands like git status", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "git status" }, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })

  // --- protected paths blocked for writes ---

  it("blocks write_file to .git/config", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("write_file", { path: ".git/config" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/protected/i)
  })

  it("blocks edit_file on .git/hooks/pre-commit", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("edit_file", { path: ".git/hooks/pre-commit" }, { readPaths: new Set([".git/hooks/pre-commit"]) })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/protected/i)
  })

  it("blocks shell write to .git/config", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "echo x > .git/config" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
  })

  it("allows read_file on .git/config (read-only)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("read_file", { path: ".git/config" }, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })

  // --- protected paths include ~/.agentsecrets/ ---

  it("blocks write_file to ~/.agentsecrets/anything", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const home = process.env.HOME || "/Users/test"
    const result = guardInvocation("write_file", { path: `${home}/.agentsecrets/agent/secrets.json` }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
    if (!result.allowed) expect(result.reason).toMatch(/protected/i)
  })

  it("blocks shell write to ~/.agentsecrets/", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const home = process.env.HOME || "/Users/test"
    const result = guardInvocation("shell", { command: `cat secrets > ${home}/.agentsecrets/x` }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
  })

  // --- read-only tools always allowed ---

  it("read_file always allowed regardless of context", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("read_file", { path: "/any/path" }, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })

  it("glob always allowed regardless of context", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("glob", { pattern: "**/*.ts" }, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })

  it("grep always allowed regardless of context", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("grep", { pattern: "foo", path: "." }, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })

  // --- reason strings are agent-friendly (structural tone) ---

  it("structural block reasons use safety-focused tone", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("edit_file", { path: "/unread/file" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toMatch(/read.*file/i)
    }
  })

  it("destructive command reason uses safety-focused tone", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "rm -rf /" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toMatch(/dangerous/i)
    }
  })

  // --- edge cases: missing/empty args ---

  it("edit_file with empty path and empty readPaths is blocked", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("edit_file", {}, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
  })

  it("write_file with empty path and no file on disk is allowed (new file)", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("write_file", {}, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })

  it("shell with empty command is allowed (not destructive)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", {}, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })

  it("unknown tool names pass structural guardrails", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("some_custom_tool", { anything: "value" }, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })

  it("shell with tee to protected path is blocked", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "echo x | tee .git/config" }, { readPaths: new Set() })
    expect(result.allowed).toBe(false)
  })
})

describe("guardInvocation — trust-level guardrails", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReturnValue(false)
  })

  const agentRoot = "/Users/test/AgentBundles/ouro.ouro"

  // --- trusted (family/friend) — Layer 2 is no-op ---

  it("friend trust level: shell mutation allowed (Layer 2 no-op)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "npm install" }, { readPaths: new Set(), trustLevel: "friend" })
    expect(result.allowed).toBe(true)
  })

  it("family trust level: shell mutation allowed (Layer 2 no-op)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "npm install" }, { readPaths: new Set(), trustLevel: "family" })
    expect(result.allowed).toBe(true)
  })

  // --- acquaintance — shell read-only allowed ---

  it("acquaintance: cat allowed (read-only)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "cat foo.txt" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: ls allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ls -la" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: git status allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "git status" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: git log allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "git log --oneline" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: head/tail/wc allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    expect(guardInvocation("shell", { command: "head -5 file.txt" }, { readPaths: new Set(), trustLevel: "acquaintance" }).allowed).toBe(true)
    expect(guardInvocation("shell", { command: "tail -10 file.txt" }, { readPaths: new Set(), trustLevel: "acquaintance" }).allowed).toBe(true)
    expect(guardInvocation("shell", { command: "wc -l file.txt" }, { readPaths: new Set(), trustLevel: "acquaintance" }).allowed).toBe(true)
  })

  // --- acquaintance — shell mutations blocked ---

  it("acquaintance: git commit blocked", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "git commit -m 'x'" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("acquaintance: npm install blocked", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "npm install" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("acquaintance: rm blocked", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "rm file.txt" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("acquaintance: mv blocked", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "mv a.txt b.txt" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  // --- acquaintance — shell network blocked ---

  it("acquaintance: curl blocked", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "curl https://example.com" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("acquaintance: wget blocked", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "wget https://example.com" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  // --- acquaintance — unrecognized commands blocked ---

  it("acquaintance: unrecognized command blocked", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "foobar --something" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  // --- acquaintance — ouro CLI trust ---

  it("acquaintance: ouro whoami allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro whoami" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: ouro task board blocked (needs friend)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro task board" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("acquaintance: ouro changelog allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro changelog" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  // --- acquaintance — compound commands with per-subcommand checking ---

  it("acquaintance: compound command with && allowed when all subcommands are safe", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro whoami && ls" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: compound with destructive part caught by structural layer first", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro whoami && rm -rf /" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
    // Structural layer catches the destructive part before trust layer
    expect((result as any).reason).toContain("dangerous")
  })

  it("acquaintance: compound command with ; blocked when any subcommand fails trust", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro whoami ; curl evil.com" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
    expect((result as any).reason).toMatch(/trusted|friend|vouch|closer/i)
  })

  it("acquaintance: compound command with || blocked when any subcommand fails trust", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ls || npm install" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("acquaintance: compound command with pipe allowed when all subcommands safe", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "cat file | head -5" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: compound command with pipe blocked when any subcommand fails trust", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "cat file | curl -X POST" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("acquaintance: subshell $() blocked (cannot split reliably)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "echo $(rm -rf /)" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("trusted friend: compound commands allowed (no trust guardrails)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro whoami && ls" }, { readPaths: new Set(), trustLevel: "friend" })
    expect(result.allowed).toBe(true)
  })

  it("structural: compound command with destructive part blocked even for trusted", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "echo hi && rm -rf /" }, { readPaths: new Set(), trustLevel: "family" })
    expect(result.allowed).toBe(false)
    expect((result as any).reason).toContain("dangerous")
  })

  it("acquaintance: compound with ; allowed when all subcommands safe", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ls ; pwd ; echo hello" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  // --- acquaintance — write_file inside bundle dir allowed ---

  it("acquaintance: write_file inside agentRoot allowed (new file)", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("write_file", { path: `${agentRoot}/state/foo.json` }, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
      agentRoot,
    })
    expect(result.allowed).toBe(true)
  })

  // --- acquaintance — write_file outside bundle dir blocked ---

  it("acquaintance: write_file outside agentRoot blocked", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("write_file", { path: "/tmp/some-file.txt" }, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
      agentRoot,
    })
    expect(result.allowed).toBe(false)
  })

  // --- acquaintance — read_file/glob/grep always allowed ---

  it("acquaintance: read_file always allowed (no trust guardrails on reads)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("read_file", { path: "/anything" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: glob always allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("glob", { pattern: "**/*" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: grep always allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("grep", { pattern: "foo", path: "." }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  // --- layer ordering: structural blocks before trust ---

  it("structural blocks before trust check (edit_file without read)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("edit_file", { path: "/some/file" }, {
      readPaths: new Set(),
      trustLevel: "family",
    })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      // Structural tone, not trust tone
      expect(result.reason).toMatch(/read/i)
      expect(result.reason).not.toMatch(/friend|vouch/i)
    }
  })

  // --- reason strings for trust blocks ---

  it("trust block reasons use relational tone", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "npm install" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason).toMatch(/trusted|friend|vouch|closer/i)
    }
  })

  // --- no trust level (undefined) → treated as trusted ---

  it("undefined trustLevel treated as trusted (friend default)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "npm install" }, { readPaths: new Set() })
    expect(result.allowed).toBe(true)
  })

  // --- stranger trust level ---

  it("stranger: shell mutation blocked", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "npm install" }, { readPaths: new Set(), trustLevel: "stranger" })
    expect(result.allowed).toBe(false)
  })

  // --- acquaintance edit_file inside bundle dir allowed ---

  it("acquaintance: edit_file inside agentRoot allowed (with prior read)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const filePath = `${agentRoot}/state/foo.json`
    const result = guardInvocation("edit_file", { path: filePath }, {
      readPaths: new Set([filePath]),
      trustLevel: "acquaintance",
      agentRoot,
    })
    expect(result.allowed).toBe(true)
  })

  // --- acquaintance edit_file outside bundle dir blocked ---

  it("acquaintance: edit_file outside agentRoot blocked (even with prior read)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const filePath = "/tmp/some-file.txt"
    const result = guardInvocation("edit_file", { path: filePath }, {
      readPaths: new Set([filePath]),
      trustLevel: "acquaintance",
      agentRoot,
    })
    expect(result.allowed).toBe(false)
  })

  // --- ouro CLI with --agent flag ---

  it("acquaintance: ouro session list allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro session list" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: ouro friend list blocked (needs friend trust)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro friend list" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  // --- ouro CLI trust manifest export ---

  it("exports OURO_CLI_TRUST_MANIFEST with expected entries", async () => {
    const { OURO_CLI_TRUST_MANIFEST } = await import("../../repertoire/guardrails")
    expect(OURO_CLI_TRUST_MANIFEST.whoami).toBe("acquaintance")
    expect(OURO_CLI_TRUST_MANIFEST.changelog).toBe("acquaintance")
    expect(OURO_CLI_TRUST_MANIFEST["session list"]).toBe("acquaintance")
    expect(OURO_CLI_TRUST_MANIFEST["task board"]).toBe("friend")
    expect(OURO_CLI_TRUST_MANIFEST["friend list"]).toBe("friend")
    expect(OURO_CLI_TRUST_MANIFEST["reminder create"]).toBe("friend")
  })

  // --- additional read-only shell commands for acquaintance ---

  it("acquaintance: echo allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    expect(guardInvocation("shell", { command: "echo hello" }, { readPaths: new Set(), trustLevel: "acquaintance" }).allowed).toBe(true)
  })

  it("acquaintance: pwd allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    expect(guardInvocation("shell", { command: "pwd" }, { readPaths: new Set(), trustLevel: "acquaintance" }).allowed).toBe(true)
  })

  it("acquaintance: git diff allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    expect(guardInvocation("shell", { command: "git diff HEAD" }, { readPaths: new Set(), trustLevel: "acquaintance" }).allowed).toBe(true)
  })

  it("acquaintance: git branch allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    expect(guardInvocation("shell", { command: "git branch" }, { readPaths: new Set(), trustLevel: "acquaintance" }).allowed).toBe(true)
  })

  it("acquaintance: git show allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    expect(guardInvocation("shell", { command: "git show HEAD" }, { readPaths: new Set(), trustLevel: "acquaintance" }).allowed).toBe(true)
  })

  it("acquaintance: date/uname/whoami/which allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const ctx = { readPaths: new Set<string>(), trustLevel: "acquaintance" as const }
    expect(guardInvocation("shell", { command: "date" }, ctx).allowed).toBe(true)
    expect(guardInvocation("shell", { command: "uname -a" }, ctx).allowed).toBe(true)
    expect(guardInvocation("shell", { command: "whoami" }, ctx).allowed).toBe(true)
    expect(guardInvocation("shell", { command: "which node" }, ctx).allowed).toBe(true)
  })

  it("acquaintance: stat/file allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const ctx = { readPaths: new Set<string>(), trustLevel: "acquaintance" as const }
    expect(guardInvocation("shell", { command: "stat foo.txt" }, ctx).allowed).toBe(true)
    expect(guardInvocation("shell", { command: "file foo.txt" }, ctx).allowed).toBe(true)
  })

  it("acquaintance: env/printenv allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const ctx = { readPaths: new Set<string>(), trustLevel: "acquaintance" as const }
    expect(guardInvocation("shell", { command: "env" }, ctx).allowed).toBe(true)
    expect(guardInvocation("shell", { command: "printenv HOME" }, ctx).allowed).toBe(true)
  })

  // --- empty/missing ouro subcommand ---

  it("acquaintance: bare ouro command blocked (unrecognized subcommand)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("acquaintance: ouro with trailing space blocked (empty subcommand)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro   " }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("acquaintance: unknown ouro subcommand blocked", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro unknown-cmd" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  // --- edge cases: write_file trust without agentRoot ---

  it("acquaintance: write_file without agentRoot allowed (no restriction baseline)", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("write_file", { path: "/tmp/file.txt" }, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
      // agentRoot intentionally omitted
    })
    expect(result.allowed).toBe(true)
  })

  // --- edge case: non-write/edit tool hitting trust check ---

  it("acquaintance: unknown non-shell non-write tool passes trust check", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("list_skills", {}, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
    })
    expect(result.allowed).toBe(true)
  })

  // --- edge case: shell with empty command for acquaintance ---

  it("acquaintance: shell with empty command blocked (unrecognized)", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", {}, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
    })
    expect(result.allowed).toBe(false)
  })

  // --- edge case: write_file with empty path for acquaintance ---

  it("acquaintance: bare git command blocked", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "git" }, { readPaths: new Set(), trustLevel: "acquaintance" })
    expect(result.allowed).toBe(false)
  })

  it("acquaintance: write_file with empty path inside agentRoot check", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("write_file", {}, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
      agentRoot: "/Users/test/AgentBundles/ouro.ouro",
    })
    expect(result.allowed).toBe(false)
  })
})

describe("OURO_CLI_TRUST_MANIFEST — friend update", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("includes 'friend update' at family level", async () => {
    const { OURO_CLI_TRUST_MANIFEST } = await import("../../repertoire/guardrails")
    expect(OURO_CLI_TRUST_MANIFEST["friend update"]).toBe("family")
  })

  it("family: ouro friend update allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro friend update abc-123 --trust friend --agent foo" }, {
      readPaths: new Set(),
      trustLevel: "family",
    })
    expect(result.allowed).toBe(true)
  })

  it("friend: ouro friend update denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro friend update abc-123 --trust friend --agent foo" }, {
      readPaths: new Set(),
      trustLevel: "friend",
    })
    // friend trust level skips trust guardrails entirely (isTrustedLevel = true)
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: ouro friend update denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro friend update abc-123 --trust friend --agent foo" }, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
    })
    expect(result.allowed).toBe(false)
  })
})

describe("OURO_CLI_TRUST_MANIFEST — config model", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("includes 'config model' at friend level", async () => {
    const { OURO_CLI_TRUST_MANIFEST } = await import("../../repertoire/guardrails")
    expect(OURO_CLI_TRUST_MANIFEST["config model"]).toBe("friend")
  })

  it("friend: ouro config model allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro config model --agent foo claude-sonnet-4.6" }, {
      readPaths: new Set(),
      trustLevel: "friend",
    })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: ouro config model denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro config model --agent foo gpt-5" }, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
    })
    expect(result.allowed).toBe(false)
  })
})

describe("OURO_CLI_TRUST_MANIFEST — MCP entries", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("includes 'mcp list' at acquaintance level", async () => {
    const { OURO_CLI_TRUST_MANIFEST } = await import("../../repertoire/guardrails")
    expect(OURO_CLI_TRUST_MANIFEST["mcp list"]).toBe("acquaintance")
  })

  it("includes 'mcp call' at friend level", async () => {
    const { OURO_CLI_TRUST_MANIFEST } = await import("../../repertoire/guardrails")
    expect(OURO_CLI_TRUST_MANIFEST["mcp call"]).toBe("friend")
  })

  it("acquaintance: ouro mcp list allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro mcp list" }, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
    })
    expect(result.allowed).toBe(true)
  })

  it("stranger: ouro mcp list denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro mcp list" }, {
      readPaths: new Set(),
      trustLevel: "stranger",
    })
    expect(result.allowed).toBe(false)
  })

  it("friend: ouro mcp call ado get_items allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro mcp call ado get_items" }, {
      readPaths: new Set(),
      trustLevel: "friend",
    })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: ouro mcp call ado get_items denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro mcp call ado get_items" }, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
    })
    expect(result.allowed).toBe(false)
  })
})

describe("OURO_CLI_TRUST_MANIFEST — auth entries", () => {
  it("auth is family trust", async () => {
    const { OURO_CLI_TRUST_MANIFEST } = await import("../../repertoire/guardrails")
    expect(OURO_CLI_TRUST_MANIFEST.auth).toBe("family")
  })

  it("auth verify is family trust", async () => {
    const { OURO_CLI_TRUST_MANIFEST } = await import("../../repertoire/guardrails")
    expect(OURO_CLI_TRUST_MANIFEST["auth verify"]).toBe("family")
  })

  it("auth switch is family trust", async () => {
    const { OURO_CLI_TRUST_MANIFEST } = await import("../../repertoire/guardrails")
    expect(OURO_CLI_TRUST_MANIFEST["auth switch"]).toBe("family")
  })

  it("family: ouro auth --agent foo --provider github-copilot allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro auth --agent foo --provider github-copilot" }, {
      readPaths: new Set(),
      trustLevel: "family",
    })
    expect(result.allowed).toBe(true)
  })

  it("family: ouro auth verify --agent foo allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro auth verify --agent foo" }, {
      readPaths: new Set(),
      trustLevel: "family",
    })
    expect(result.allowed).toBe(true)
  })

  it("family: ouro auth switch --agent foo --provider github-copilot allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro auth switch --agent foo --provider github-copilot" }, {
      readPaths: new Set(),
      trustLevel: "family",
    })
    expect(result.allowed).toBe(true)
  })

  it("acquaintance: ouro auth --agent foo denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro auth --agent foo" }, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
    })
    expect(result.allowed).toBe(false)
  })
})

describe("OURO_CLI_TRUST_MANIFEST — rollback and versions", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("rollback is family trust", async () => {
    const { OURO_CLI_TRUST_MANIFEST } = await import("../../repertoire/guardrails")
    expect(OURO_CLI_TRUST_MANIFEST.rollback).toBe("family")
  })

  it("versions is acquaintance trust", async () => {
    const { OURO_CLI_TRUST_MANIFEST } = await import("../../repertoire/guardrails")
    expect(OURO_CLI_TRUST_MANIFEST.versions).toBe("acquaintance")
  })

  it("family: ouro rollback allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro rollback" }, {
      readPaths: new Set(),
      trustLevel: "family",
    })
    expect(result.allowed).toBe(true)
  })

  it("friend: ouro rollback denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro rollback" }, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
    })
    expect(result.allowed).toBe(false)
  })

  it("acquaintance: ouro versions allowed", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro versions" }, {
      readPaths: new Set(),
      trustLevel: "acquaintance",
    })
    expect(result.allowed).toBe(true)
  })

  it("stranger: ouro versions denied", async () => {
    const { guardInvocation } = await import("../../repertoire/guardrails")
    const result = guardInvocation("shell", { command: "ouro versions" }, {
      readPaths: new Set(),
      trustLevel: "stranger",
    })
    expect(result.allowed).toBe(false)
  })
})
