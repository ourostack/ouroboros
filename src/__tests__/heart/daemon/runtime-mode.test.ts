import { describe, expect, it, vi } from "vitest"

import { detectRuntimeMode } from "../../../heart/daemon/runtime-mode"

describe("detectRuntimeMode", () => {
  it("returns 'dev' when path contains .claude/worktrees/", () => {
    const result = detectRuntimeMode("/Users/ari/Projects/repo/.claude/worktrees/agent-abc123")
    expect(result).toBe("dev")
  })

  it("returns 'production' when path contains node_modules/@ouro.bot/cli", () => {
    const result = detectRuntimeMode("/usr/local/lib/node_modules/@ouro.bot/cli")
    expect(result).toBe("production")
  })

  it("returns 'production' when path contains node_modules/ouro.bot", () => {
    const result = detectRuntimeMode("/usr/local/lib/node_modules/ouro.bot")
    expect(result).toBe("production")
  })

  it("returns 'dev' when path is a git repo (has .git at root)", () => {
    const existsSync = vi.fn(() => true)
    const result = detectRuntimeMode("/Users/ari/Projects/repo", { existsSync })
    expect(result).toBe("dev")
    expect(existsSync).toHaveBeenCalledWith("/Users/ari/Projects/repo/.git")
  })

  it("returns 'dev' when path is not in node_modules and not a git repo (conservative default)", () => {
    const existsSync = vi.fn(() => false)
    const result = detectRuntimeMode("/some/random/path", { existsSync })
    expect(result).toBe("dev")
  })
})
