/**
 * Verification truthfulness tests — Unit 2.4
 *
 * Separates reported verification from personally verified verification.
 * Tests wrong-worktree/stale-checkout review scenarios.
 */
import { describe, expect, it, vi } from "vitest"

import { prepareCodingContextPack } from "../../../repertoire/coding/context-pack"
import type { CodingIdentityPacket, CodingVerificationStatus } from "../../../repertoire/coding/types"

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    agentRoot: "/Users/test/AgentBundles/slugger.ouro",
    agentName: "slugger",
    nowIso: () => "2026-04-03T12:00:00.000Z",
    existsSync: () => false,
    readFileSync: () => { throw new Error("should not read") },
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    listSkills: () => [],
    runCommand: (_cmd: string, args: string[]) => {
      if (args.includes("--show-toplevel")) return { status: 0, stdout: "/Users/test/Projects/ouro\n", stderr: "" }
      if (args.includes("--abbrev-ref")) return { status: 0, stdout: "feat/my-feature\n", stderr: "" }
      if (args.includes("--short") && args.includes("HEAD")) return { status: 0, stdout: "abc1234\n", stderr: "" }
      if (args.includes("status") && args.includes("--short")) return { status: 0, stdout: "", stderr: "" }
      return { status: 1, stdout: "", stderr: "" }
    },
    ...overrides,
  }
}

describe("verification truthfulness", () => {
  it("identity packet defaults to not-verified even when verification commands exist", () => {
    const pack = prepareCodingContextPack(
      {
        request: {
          runner: "codex",
          workdir: "/Users/test/Projects/ouro",
          prompt: "fix tests",
          verificationCommands: ["npm test", "npx tsc --noEmit"],
        },
      },
      baseDeps(),
    )

    // Commands are present but status is not-verified because the agent hasn't run them
    expect(pack.identityPacket.verificationCommands).toEqual(["npm test", "npx tsc --noEmit"])
    expect(pack.identityPacket.verificationStatus).toBe("not-verified")
  })

  it("CodingVerificationStatus type allows exactly three values", () => {
    const statuses: CodingVerificationStatus[] = ["not-verified", "verified-pass", "verified-fail"]
    expect(statuses).toHaveLength(3)
    // This test exercises the type at runtime — additional values would be caught by TypeScript
  })

  it("state file content distinguishes not-verified from verified states", () => {
    const writes = new Map<string, string>()
    prepareCodingContextPack(
      {
        request: {
          runner: "codex",
          workdir: "/Users/test/Projects/ouro",
          prompt: "review the fix",
          verificationCommands: ["npm test"],
        },
      },
      baseDeps({
        writeFileSync: (target: string, content: string) => { writes.set(target, content) },
      }),
    )

    const stateContent = [...writes.values()].find((v) => v.includes("Coding Identity")) ?? ""
    expect(stateContent).toContain("verificationStatus: not-verified")
    // The state file should not claim verification happened
    expect(stateContent).not.toContain("verificationStatus: verified-pass")
  })
})

describe("review anchoring — wrong-worktree/stale-checkout detection", () => {
  it("identity packet captures the actual worktree being inspected", () => {
    // When the agent prepares context for /Users/test/worktrees/stale,
    // the identity should reflect THAT worktree's state, not some other
    const pack = prepareCodingContextPack(
      {
        request: {
          runner: "codex",
          workdir: "/Users/test/worktrees/stale-checkout",
          prompt: "review PR",
        },
      },
      baseDeps({
        runCommand: (_cmd: string, args: string[]) => {
          if (args.includes("--show-toplevel")) return { status: 0, stdout: "/Users/test/worktrees/stale-checkout\n", stderr: "" }
          if (args.includes("--abbrev-ref")) return { status: 0, stdout: "feat/old-branch\n", stderr: "" }
          if (args.includes("--short") && args.includes("HEAD")) return { status: 0, stdout: "old1111\n", stderr: "" }
          if (args.includes("status") && args.includes("--short")) return { status: 0, stdout: " M stale-file.ts\n", stderr: "" }
          return { status: 1, stdout: "", stderr: "" }
        },
      }),
    )

    expect(pack.identityPacket.worktreePath).toBe("/Users/test/worktrees/stale-checkout")
    expect(pack.identityPacket.branch).toBe("feat/old-branch")
    expect(pack.identityPacket.commit).toBe("old1111")
    expect(pack.identityPacket.dirty).toBe(true)
    expect(pack.identityPacket.dirtyFiles).toEqual([" M stale-file.ts"])
  })

  it("state content includes worktree path for review anchoring", () => {
    const writes = new Map<string, string>()
    prepareCodingContextPack(
      {
        request: {
          runner: "codex",
          workdir: "/Users/test/worktrees/review-target",
          prompt: "review the PR",
        },
      },
      baseDeps({
        runCommand: (_cmd: string, args: string[]) => {
          if (args.includes("--show-toplevel")) return { status: 0, stdout: "/Users/test/worktrees/review-target\n", stderr: "" }
          if (args.includes("--abbrev-ref")) return { status: 0, stdout: "feat/review-branch\n", stderr: "" }
          if (args.includes("--short") && args.includes("HEAD")) return { status: 0, stdout: "rev5678\n", stderr: "" }
          if (args.includes("status") && args.includes("--short")) return { status: 0, stdout: "", stderr: "" }
          return { status: 1, stdout: "", stderr: "" }
        },
        writeFileSync: (target: string, content: string) => { writes.set(target, content) },
      }),
    )

    const stateContent = [...writes.values()].find((v) => v.includes("Coding Identity")) ?? ""
    expect(stateContent).toContain("worktreePath: /Users/test/worktrees/review-target")
    expect(stateContent).toContain("branch: feat/review-branch")
    expect(stateContent).toContain("commit: rev5678")
  })

  it("dirty state is captured so reviewers can see uncommitted changes", () => {
    const writes = new Map<string, string>()
    prepareCodingContextPack(
      {
        request: {
          runner: "codex",
          workdir: "/Users/test/Projects/ouro",
          prompt: "check this",
        },
      },
      baseDeps({
        runCommand: (_cmd: string, args: string[]) => {
          if (args.includes("--show-toplevel")) return { status: 0, stdout: "/Users/test/Projects/ouro\n", stderr: "" }
          if (args.includes("--abbrev-ref")) return { status: 0, stdout: "feat/dirty-branch\n", stderr: "" }
          if (args.includes("--short") && args.includes("HEAD")) return { status: 0, stdout: "dir9999\n", stderr: "" }
          if (args.includes("status") && args.includes("--short")) return { status: 0, stdout: " M file1.ts\n M file2.ts\n?? new-file.ts\n", stderr: "" }
          return { status: 1, stdout: "", stderr: "" }
        },
        writeFileSync: (target: string, content: string) => { writes.set(target, content) },
      }),
    )

    const stateContent = [...writes.values()].find((v) => v.includes("Coding Identity")) ?? ""
    expect(stateContent).toContain("dirty: true")
    expect(stateContent).toContain("dirtyFiles:")
    expect(stateContent).toContain(" M file1.ts")
    expect(stateContent).toContain(" M file2.ts")
    expect(stateContent).toContain("?? new-file.ts")
  })
})

describe("verification truthfulness — prompt guidance", () => {
  it("workspace discipline section warns about claiming unperformed verification", async () => {
    vi.resetModules()
    const { workspaceDisciplineSection } = await import("../../../mind/prompt")
    const section = workspaceDisciplineSection()

    expect(section).toContain("no claiming verification i did not personally perform")
  })

  it("workspace discipline section mentions recording what was personally verified", async () => {
    vi.resetModules()
    const { workspaceDisciplineSection } = await import("../../../mind/prompt")
    const section = workspaceDisciplineSection()

    expect(section).toContain("record what i personally verified")
  })
})
