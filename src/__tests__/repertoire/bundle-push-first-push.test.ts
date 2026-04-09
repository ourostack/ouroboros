/**
 * Unit tests for isFirstPushToRemote — the function that detects whether
 * a bundle_push is the first push to a given remote (triggers the
 * Directive D confirmation-token gate).
 *
 * These tests mock child_process.execFileSync to simulate the three
 * code paths without needing a real reachable git remote:
 *
 *   1. symbolic-ref failure → conservative true (first push assumed)
 *   2. ls-remote returns empty stdout → true (first push confirmed)
 *   3. ls-remote returns non-empty stdout → false (subsequent push)
 *
 * Separate from the integration tests in tools-bundle.test.ts which
 * use real git against unreachable remotes and always hit path 1.
 */
import { describe, expect, it, vi } from "vitest"

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}))

vi.mock("../../heart/identity", () => ({
  getAgentRoot: vi.fn(() => "/mock/bundle"),
}))

// Suppress nerves event emissions in this isolated test
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { execFileSync } from "child_process"
import { isFirstPushToRemote } from "../../repertoire/tools-bundle"

describe("isFirstPushToRemote", () => {
  it("returns true when symbolic-ref fails (no HEAD → conservative first-push assumption)", () => {
    vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "symbolic-ref") throw new Error("fatal: ref HEAD is not a symbolic ref")
      return Buffer.from("")
    })

    expect(isFirstPushToRemote("/mock/bundle", "origin")).toBe(true)
  })

  it("returns true when ls-remote returns empty stdout (real first push — remote branch does not exist)", () => {
    vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "symbolic-ref") return Buffer.from("main\n")
      if (argv[0] === "ls-remote") return Buffer.from("")
      return Buffer.from("")
    })

    expect(isFirstPushToRemote("/mock/bundle", "origin")).toBe(true)
  })

  it("returns false when ls-remote returns non-empty stdout (subsequent push — remote branch exists)", () => {
    vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "symbolic-ref") return Buffer.from("main\n")
      if (argv[0] === "ls-remote") return Buffer.from("abc123\trefs/heads/main\n")
      return Buffer.from("")
    })

    expect(isFirstPushToRemote("/mock/bundle", "origin")).toBe(false)
  })

  it("returns true when ls-remote itself fails (network error → conservative first-push assumption)", () => {
    vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "symbolic-ref") return Buffer.from("main\n")
      if (argv[0] === "ls-remote") throw new Error("Could not resolve host")
      return Buffer.from("")
    })

    expect(isFirstPushToRemote("/mock/bundle", "origin")).toBe(true)
  })

  it("passes the correct branch name to ls-remote", () => {
    vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
      const argv = args as string[]
      if (argv[0] === "symbolic-ref") return Buffer.from("feature-branch\n")
      if (argv[0] === "ls-remote") {
        // Verify the branch arg
        expect(argv).toContain("feature-branch")
        return Buffer.from("abc123\trefs/heads/feature-branch\n")
      }
      return Buffer.from("")
    })

    expect(isFirstPushToRemote("/mock/bundle", "upstream")).toBe(false)
  })
})
