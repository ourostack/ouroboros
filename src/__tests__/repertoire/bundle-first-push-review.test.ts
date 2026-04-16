/**
 * Tests for bundle_first_push_review + bundle_push confirmation token
 * gating (Directive D: PII-aware first-push workflow).
 *
 * The first-push review tool exists to create a human-in-the-loop gate
 * between "bundle built locally" and "bundle contents on the internet".
 * It enumerates PII-bearing directories, probes the remote URL for
 * GitHub visibility, generates a warning, and issues a confirmation
 * token. bundle_push refuses first-push attempts that don't present a
 * valid token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as path from "path"

vi.mock("../../heart/identity", () => ({
  getAgentRoot: vi.fn(),
}))

import { getAgentRoot } from "../../heart/identity"
import { bundleToolDefinitions, __getConfirmationTokenStore } from "../../repertoire/tools-bundle"
import { BUNDLE_GITIGNORE_TEMPLATE } from "../../repertoire/bundle-templates"
import { createTmpBundle } from "../test-helpers/tmpdir-bundle"

function tool(name: string) {
  const def = bundleToolDefinitions.find((d) => d.tool.function.name === name)
  if (!def) throw new Error(`tool not found: ${name}`)
  return def
}

function initGitWithMainBranch(dir: string): void {
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: dir, stdio: "pipe" })
  execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: dir, stdio: "pipe" })
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" })
}

async function invoke(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const def = tool(name)
  const result = await def.handler(args as Record<string, string>)
  return JSON.parse(result) as Record<string, unknown>
}

describe("bundle_init_git writes the full template", () => {
  let tmp: ReturnType<typeof createTmpBundle>

  beforeEach(() => {
    tmp = createTmpBundle({ agentName: "template-test" })
    vi.mocked(getAgentRoot).mockReturnValue(tmp.agentRoot)
  })

  afterEach(() => {
    tmp.cleanup()
  })

  it("bundle_init_git writes the full BUNDLE_GITIGNORE_TEMPLATE", async () => {
    await invoke("bundle_init_git")
    const content = fs.readFileSync(path.join(tmp.agentRoot, ".gitignore"), "utf-8")
    expect(content).toBe(BUNDLE_GITIGNORE_TEMPLATE)
  })

  it("template blocks functional cases: state, .env, credentials, editor noise", async () => {
    await invoke("bundle_init_git")

    // Create files that should be ignored
    fs.mkdirSync(path.join(tmp.agentRoot, "state"), { recursive: true })
    fs.writeFileSync(path.join(tmp.agentRoot, "state", "session.json"), "{}", "utf-8")
    fs.writeFileSync(path.join(tmp.agentRoot, ".env"), "SECRET=x", "utf-8")
    fs.writeFileSync(path.join(tmp.agentRoot, ".env.local"), "SECRET=x", "utf-8")
    fs.mkdirSync(path.join(tmp.agentRoot, "secrets"), { recursive: true })
    fs.writeFileSync(path.join(tmp.agentRoot, "secrets", "token.json"), "{}", "utf-8")
    fs.writeFileSync(path.join(tmp.agentRoot, "foo.key"), "x", "utf-8")
    fs.writeFileSync(path.join(tmp.agentRoot, "foo.pem"), "x", "utf-8")
    fs.writeFileSync(path.join(tmp.agentRoot, ".DS_Store"), "x", "utf-8")
    fs.mkdirSync(path.join(tmp.agentRoot, "node_modules", "foo"), { recursive: true })
    fs.writeFileSync(path.join(tmp.agentRoot, "node_modules", "foo", "index.js"), "x", "utf-8")

    // Create files that should be TRACKED
    fs.mkdirSync(path.join(tmp.agentRoot, "friends"), { recursive: true })
    fs.writeFileSync(path.join(tmp.agentRoot, "friends", "ari.json"), "{}", "utf-8")
    fs.mkdirSync(path.join(tmp.agentRoot, "journal"), { recursive: true })
    fs.writeFileSync(path.join(tmp.agentRoot, "journal", "entry.md"), "hi", "utf-8")

    const result = await invoke("bundle_list_first_commit")
    expect(result.ok).toBe(true)
    const groups = result.groups as Record<string, { files: Array<{ path: string }> }>
    const allFiles = Object.values(groups).flatMap((g) => g.files.map((f) => f.path))

    // Tracked files present
    expect(allFiles).toContain(path.join("friends", "ari.json"))
    expect(allFiles).toContain(path.join("journal", "entry.md"))
    // Ignored files absent
    expect(allFiles).not.toContain(path.join("state", "session.json"))
    expect(allFiles).not.toContain(".env")
    expect(allFiles).not.toContain(".env.local")
    expect(allFiles).not.toContain(path.join("secrets", "token.json"))
    expect(allFiles).not.toContain("foo.key")
    expect(allFiles).not.toContain("foo.pem")
    expect(allFiles).not.toContain(".DS_Store")
    expect(allFiles).not.toContain(path.join("node_modules", "foo", "index.js"))
  })
})

describe("bundle_first_push_review", () => {
  let tmp: ReturnType<typeof createTmpBundle>

  beforeEach(() => {
    tmp = createTmpBundle({ agentName: "first-push-test" })
    vi.mocked(getAgentRoot).mockReturnValue(tmp.agentRoot)
    // Clear token store between tests
    __getConfirmationTokenStore().clear()
  })

  afterEach(() => {
    tmp.cleanup()
  })

  it("refuses when bundle is not a git repo", async () => {
    const result = await invoke("bundle_first_push_review")
    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain("not a git repo")
  })

  it("refuses when no remote is configured", async () => {
    initGitWithMainBranch(tmp.agentRoot)
    const result = await invoke("bundle_first_push_review")
    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain("no remote")
  })

  it("returns generic warning for a non-GitHub remote with no PII dirs", async () => {
    initGitWithMainBranch(tmp.agentRoot)
    execFileSync("git", ["remote", "add", "origin", "https://gitlab.com/user/repo.git"], {
      cwd: tmp.agentRoot,
      stdio: "pipe",
    })
    // Don't populate any PII dirs
    const result = await invoke("bundle_first_push_review")
    expect(result.ok).toBe(true)
    expect(result.warningLevel).toBe("generic")
    expect(result.remoteUrl).toBe("https://gitlab.com/user/repo.git")
    expect(result.piiCounts).toEqual({})
    expect(result.totalPiiRecords).toBe(0)
    expect(typeof result.confirmationToken).toBe("string")
  })

  it("populates piiCounts for PII directories that exist and are non-empty", async () => {
    initGitWithMainBranch(tmp.agentRoot)
    execFileSync("git", ["remote", "add", "origin", "https://gitlab.com/user/repo.git"], {
      cwd: tmp.agentRoot,
      stdio: "pipe",
    })
    // Populate friends and journal
    fs.mkdirSync(path.join(tmp.agentRoot, "friends"), { recursive: true })
    fs.writeFileSync(path.join(tmp.agentRoot, "friends", "ari.json"), "{}", "utf-8")
    fs.writeFileSync(path.join(tmp.agentRoot, "friends", "bob.json"), "{}", "utf-8")
    fs.mkdirSync(path.join(tmp.agentRoot, "journal"), { recursive: true })
    fs.writeFileSync(path.join(tmp.agentRoot, "journal", "e1.md"), "hi", "utf-8")

    const result = await invoke("bundle_first_push_review")
    expect(result.ok).toBe(true)
    const piiCounts = result.piiCounts as Record<string, number>
    expect(piiCounts.friends).toBe(2)
    expect(piiCounts.journal).toBe(1)
    expect(result.totalPiiRecords).toBe(3)
    expect(String(result.warningText)).toContain("2 friends records")
    expect(String(result.warningText)).toContain("1 journal record")
  })

  it("returns public_github warning when GitHub API reports private: false", async () => {
    initGitWithMainBranch(tmp.agentRoot)
    execFileSync("git", ["remote", "add", "origin", "https://github.com/user/repo.git"], {
      cwd: tmp.agentRoot,
      stdio: "pipe",
    })

    // Mock fetch to return public repo
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ private: false }), { status: 200 }))
    const def = tool("bundle_first_push_review")
    // Re-invoke with a test deps seam — we need to rebuild the handler.
    // Since the handler is module-local, we instead stub globalThis.fetch.
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch
    try {
      const raw = await def.handler({})
      const result = JSON.parse(raw) as Record<string, unknown>
      expect(result.warningLevel).toBe("public_github")
      expect(String(result.warningText)).toContain("PUBLIC GitHub")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("returns private_github warning when GitHub API reports private: true", async () => {
    initGitWithMainBranch(tmp.agentRoot)
    execFileSync("git", ["remote", "add", "origin", "git@github.com:user/repo.git"], {
      cwd: tmp.agentRoot,
      stdio: "pipe",
    })

    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ private: true }), { status: 200 }))
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch
    try {
      const result = await invoke("bundle_first_push_review")
      expect(result.warningLevel).toBe("private_github")
      expect(String(result.warningText)).toContain("PRIVATE GitHub")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("falls back to generic warning on GitHub API 404", async () => {
    initGitWithMainBranch(tmp.agentRoot)
    execFileSync("git", ["remote", "add", "origin", "https://github.com/user/nonexistent.git"], {
      cwd: tmp.agentRoot,
      stdio: "pipe",
    })

    const mockFetch = vi.fn(async () => new Response("Not Found", { status: 404 }))
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch
    try {
      const result = await invoke("bundle_first_push_review")
      expect(result.warningLevel).toBe("generic")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("falls back to generic warning when GitHub API returns a malformed private field", async () => {
    initGitWithMainBranch(tmp.agentRoot)
    execFileSync("git", ["remote", "add", "origin", "https://github.com/user/repo.git"], {
      cwd: tmp.agentRoot,
      stdio: "pipe",
    })

    // API returns { private: null } — neither true nor false
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ private: null }), { status: 200 }))
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch
    try {
      const result = await invoke("bundle_first_push_review")
      expect(result.warningLevel).toBe("generic")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("falls back to generic warning on network error", async () => {
    initGitWithMainBranch(tmp.agentRoot)
    execFileSync("git", ["remote", "add", "origin", "https://github.com/user/repo.git"], {
      cwd: tmp.agentRoot,
      stdio: "pipe",
    })

    const mockFetch = vi.fn(async () => {
      throw new Error("network error")
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch
    try {
      const result = await invoke("bundle_first_push_review")
      expect(result.warningLevel).toBe("generic")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("treats empty PII directories as 0 count (existing but empty)", async () => {
    initGitWithMainBranch(tmp.agentRoot)
    execFileSync("git", ["remote", "add", "origin", "https://gitlab.com/user/repo.git"], {
      cwd: tmp.agentRoot,
      stdio: "pipe",
    })
    // Create a PII dir but leave it empty (no tracked files)
    fs.mkdirSync(path.join(tmp.agentRoot, "friends"), { recursive: true })
    // No files written

    const result = await invoke("bundle_first_push_review")
    expect(result.ok).toBe(true)
    const piiCounts = result.piiCounts as Record<string, number>
    // empty dir → no entry in piiCounts
    expect(piiCounts.friends).toBeUndefined()
  })

  it("prunes expired tokens during bundle_first_push_review invocation", async () => {
    initGitWithMainBranch(tmp.agentRoot)
    execFileSync("git", ["remote", "add", "origin", "https://gitlab.com/user/repo.git"], {
      cwd: tmp.agentRoot,
      stdio: "pipe",
    })

    // Inject an expired token directly
    const store = __getConfirmationTokenStore()
    const expiredToken = "expired-test-token"
    store.set(expiredToken, {
      bundleRoot: "/some/bundle",
      createdAt: Date.now() - 16 * 60 * 1000, // 16 minutes ago — past TTL
    })
    expect(store.has(expiredToken)).toBe(true)

    // A new invocation should prune the expired token as a side effect
    await invoke("bundle_first_push_review")
    expect(store.has(expiredToken)).toBe(false)
  })

  it("stores the confirmation token in the module-level store", async () => {
    initGitWithMainBranch(tmp.agentRoot)
    execFileSync("git", ["remote", "add", "origin", "https://gitlab.com/user/repo.git"], {
      cwd: tmp.agentRoot,
      stdio: "pipe",
    })
    const result = await invoke("bundle_first_push_review")
    const token = String(result.confirmationToken)
    const store = __getConfirmationTokenStore()
    expect(store.has(token)).toBe(true)
    const entry = store.get(token)
    expect(entry?.bundleRoot).toBe(tmp.agentRoot)
  })
})

describe("bundle_push first-push token gating", () => {
  let tmp: ReturnType<typeof createTmpBundle>

  beforeEach(() => {
    tmp = createTmpBundle({ agentName: "first-push-gate-test" })
    vi.mocked(getAgentRoot).mockReturnValue(tmp.agentRoot)
    __getConfirmationTokenStore().clear()
  })

  afterEach(() => {
    tmp.cleanup()
  })

  function setupBundleReadyToPush(remoteUrl = path.join(tmp.bundlesRoot, "missing-remote.git")): void {
    initGitWithMainBranch(tmp.agentRoot)
    execFileSync("git", ["remote", "add", "origin", remoteUrl], { cwd: tmp.agentRoot, stdio: "pipe" })
    fs.writeFileSync(path.join(tmp.agentRoot, "file.txt"), "x", "utf-8")
    execFileSync("git", ["add", "-A"], { cwd: tmp.agentRoot, stdio: "pipe" })
    execFileSync("git", ["commit", "-m", "init"], { cwd: tmp.agentRoot, stdio: "pipe" })
  }

  it("refuses first push with no confirmation_token", async () => {
    setupBundleReadyToPush()
    const result = await invoke("bundle_push")
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("confirmation_required")
    expect(String(result.error)).toContain("confirmation token")
  })

  it("refuses first push with an invalid confirmation_token", async () => {
    setupBundleReadyToPush()
    const result = await invoke("bundle_push", { confirmation_token: "bogus-token" })
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("confirmation_required")
    expect(String(result.error)).toContain("invalid or expired")
  })

  it("refuses first push with a token from a different bundle", async () => {
    setupBundleReadyToPush()
    // Manually inject a token bound to a different bundle
    __getConfirmationTokenStore().set("wrong-bundle-token", {
      bundleRoot: "/some/other/bundle",
      createdAt: Date.now(),
    })
    const result = await invoke("bundle_push", { confirmation_token: "wrong-bundle-token" })
    expect(result.ok).toBe(false)
    expect(result.kind).toBe("confirmation_required")
    expect(String(result.error)).toContain("different bundle")
  })

  it("proceeds with first push when a valid token is present (then fails on missing remote)", async () => {
    setupBundleReadyToPush()
    // Get a real token via bundle_first_push_review
    const review = await invoke("bundle_first_push_review")
    const token = String(review.confirmationToken)

    // Attempt the push with the valid token. The push itself will fail
    // against the missing local remote, but the important thing is that
    // we got PAST the token check (kind !== "confirmation_required").
    const result = await invoke("bundle_push", { confirmation_token: token })
    expect(result.ok).toBe(false)
    expect(result.kind).not.toBe("confirmation_required")
    // Token should have been consumed
    expect(__getConfirmationTokenStore().has(token)).toBe(false)
  })
})

describe("bundle_first_push_review URL parsing edge cases", () => {
  let tmp: ReturnType<typeof createTmpBundle>

  beforeEach(() => {
    tmp = createTmpBundle({ agentName: "url-parse-test" })
    vi.mocked(getAgentRoot).mockReturnValue(tmp.agentRoot)
    __getConfirmationTokenStore().clear()
  })

  afterEach(() => {
    tmp.cleanup()
  })

  it("gitlab URL does not trigger GitHub probe (fetch not called)", async () => {
    initGitWithMainBranch(tmp.agentRoot)
    execFileSync("git", ["remote", "add", "origin", "https://gitlab.com/user/repo.git"], {
      cwd: tmp.agentRoot,
      stdio: "pipe",
    })
    const mockFetch = vi.fn(async () => new Response("{}", { status: 200 }))
    const originalFetch = globalThis.fetch
    globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch
    try {
      const result = await invoke("bundle_first_push_review")
      expect(result.warningLevel).toBe("generic")
      expect(mockFetch).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("self-hosted git URL treated as generic", async () => {
    initGitWithMainBranch(tmp.agentRoot)
    execFileSync("git", ["remote", "add", "origin", "https://git.example.com/user/repo.git"], {
      cwd: tmp.agentRoot,
      stdio: "pipe",
    })
    const result = await invoke("bundle_first_push_review")
    expect(result.warningLevel).toBe("generic")
  })
})
