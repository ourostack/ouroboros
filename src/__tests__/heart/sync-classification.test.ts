/**
 * Layer 2 — Unit 1a: failing tests for `classifySyncFailure`.
 *
 * The classifier is a pure function over (error, context) that pattern-matches
 * on common git failure shapes — stderr text, system errno, AbortError —
 * and returns one of the locked taxonomy variants. The implementation lives
 * in `src/heart/sync-classification.ts` (Unit 1b).
 *
 * Test idiom mirrors the existing `sync.test.ts`: child_process is mocked,
 * but here only `collectRebaseConflictFiles`'s git status invocation matters,
 * because everything else is pure error-shape inspection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("child_process", () => ({
  execFileSync: vi.fn(),
}))

import * as childProcess from "child_process"

const fakeAgentRoot = "/fake/agent/root"

describe("classifySyncFailure", () => {
  beforeEach(() => {
    vi.mocked(childProcess.execFileSync).mockReset()
    // Default: git status returns no unmerged paths.
    vi.mocked(childProcess.execFileSync).mockReturnValue(Buffer.from(""))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe("auth-failed", () => {
    it("classifies 401 stderr as auth-failed", async () => {
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const err = new Error("fatal: Authentication failed for 'https://example.com/repo.git/'\nremote: HTTP 401")
      const result = classifySyncFailure(err, { agentRoot: fakeAgentRoot })
      expect(result.classification).toBe("auth-failed")
    })

    it("classifies 403 stderr as auth-failed", async () => {
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const err = new Error("remote: Permission denied\nfatal: unable to access ...: The requested URL returned error: 403")
      const result = classifySyncFailure(err, { agentRoot: fakeAgentRoot })
      expect(result.classification).toBe("auth-failed")
    })

    it("classifies 'Authentication failed' message as auth-failed", async () => {
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const err = new Error("Authentication failed")
      const result = classifySyncFailure(err, { agentRoot: fakeAgentRoot })
      expect(result.classification).toBe("auth-failed")
    })
  })

  describe("not-found-404", () => {
    it("classifies 404 stderr as not-found-404", async () => {
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const err = new Error("fatal: unable to access 'https://example.com/repo.git/': The requested URL returned error: 404")
      const result = classifySyncFailure(err, { agentRoot: fakeAgentRoot })
      expect(result.classification).toBe("not-found-404")
    })

    it("classifies 'repository not found' as not-found-404", async () => {
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const err = new Error("remote: Repository not found.\nfatal: repository 'https://example.com/repo.git/' not found")
      const result = classifySyncFailure(err, { agentRoot: fakeAgentRoot })
      expect(result.classification).toBe("not-found-404")
    })
  })

  describe("network-down", () => {
    it("classifies ENOTFOUND as network-down", async () => {
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const err = new Error("fatal: unable to access 'https://nope.invalid/repo.git/': Could not resolve host: nope.invalid")
      const result = classifySyncFailure(err, { agentRoot: fakeAgentRoot })
      expect(result.classification).toBe("network-down")
    })

    it("classifies ECONNREFUSED as network-down", async () => {
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const err = new Error("fatal: unable to access 'https://localhost:9/repo.git/': Failed to connect to localhost port 9: Connection refused")
      const result = classifySyncFailure(err, { agentRoot: fakeAgentRoot })
      expect(result.classification).toBe("network-down")
    })

    it("classifies a system error with code ENOTFOUND as network-down", async () => {
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const err = Object.assign(new Error("getaddrinfo ENOTFOUND nope.invalid"), { code: "ENOTFOUND" })
      const result = classifySyncFailure(err, { agentRoot: fakeAgentRoot })
      expect(result.classification).toBe("network-down")
    })

    it("classifies 'Could not resolve host' as network-down", async () => {
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const err = new Error("Could not resolve host: example.invalid")
      const result = classifySyncFailure(err, { agentRoot: fakeAgentRoot })
      expect(result.classification).toBe("network-down")
    })
  })

  describe("dirty-working-tree", () => {
    it("classifies 'would be overwritten by merge' as dirty-working-tree", async () => {
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const err = new Error("error: Your local changes to the following files would be overwritten by merge:\n\tagent.json\nPlease commit your changes or stash them before you merge.")
      const result = classifySyncFailure(err, { agentRoot: fakeAgentRoot })
      expect(result.classification).toBe("dirty-working-tree")
    })

    it("classifies 'commit your changes or stash them' as dirty-working-tree", async () => {
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const err = new Error("Please commit your changes or stash them before you switch branches.")
      const result = classifySyncFailure(err, { agentRoot: fakeAgentRoot })
      expect(result.classification).toBe("dirty-working-tree")
    })
  })

  describe("non-fast-forward", () => {
    it("classifies 'non-fast-forward' stderr as non-fast-forward", async () => {
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const err = new Error("! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs")
      const result = classifySyncFailure(err, { agentRoot: fakeAgentRoot })
      expect(result.classification).toBe("non-fast-forward")
    })

    it("classifies 'rejected' + 'fetch first' stderr as non-fast-forward", async () => {
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const err = new Error("! [rejected]        main -> main (fetch first)\nhint: Updates were rejected because the remote contains work that you do\nhint: not have locally.")
      const result = classifySyncFailure(err, { agentRoot: fakeAgentRoot })
      expect(result.classification).toBe("non-fast-forward")
    })
  })

  describe("merge-conflict", () => {
    it("classifies rebase-conflict stderr as merge-conflict and lists conflict files", async () => {
      // Pretend git status reports unmerged paths.
      vi.mocked(childProcess.execFileSync).mockReturnValueOnce(
        Buffer.from("UU agent.json\nAA settings.json\n M README.md\n"),
      )
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const err = new Error("CONFLICT (content): Merge conflict in agent.json\nerror: Failed to merge in the changes.\nFailed to merge ... rebase --continue")
      const result = classifySyncFailure(err, { agentRoot: fakeAgentRoot })
      expect(result.classification).toBe("merge-conflict")
      expect(result.conflictFiles).toEqual(["agent.json", "settings.json"])
    })

    it("classifies generic 'CONFLICT' stderr as merge-conflict (no conflict files when status is clean)", async () => {
      vi.mocked(childProcess.execFileSync).mockReturnValueOnce(Buffer.from(""))
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const err = new Error("CONFLICT (content): Merge conflict in foo")
      const result = classifySyncFailure(err, { agentRoot: fakeAgentRoot })
      expect(result.classification).toBe("merge-conflict")
      expect(result.conflictFiles).toEqual([])
    })
  })

  describe("timeout-soft and timeout-hard", () => {
    it("classifies abortReason='soft' as timeout-soft", async () => {
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const err = Object.assign(new Error("This operation was aborted"), { name: "AbortError" })
      const result = classifySyncFailure(err, { agentRoot: fakeAgentRoot, abortReason: "soft" })
      expect(result.classification).toBe("timeout-soft")
    })

    it("classifies abortReason='hard' as timeout-hard", async () => {
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const err = Object.assign(new Error("This operation was aborted"), { name: "AbortError" })
      const result = classifySyncFailure(err, { agentRoot: fakeAgentRoot, abortReason: "hard" })
      expect(result.classification).toBe("timeout-hard")
    })

    it("treats AbortError without abortReason context as timeout-hard (default)", async () => {
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const err = Object.assign(new Error("aborted"), { name: "AbortError" })
      const result = classifySyncFailure(err, { agentRoot: fakeAgentRoot })
      expect(result.classification).toBe("timeout-hard")
    })

    it("treats a system AbortError (code=ABORT_ERR) the same way", async () => {
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const err = Object.assign(new Error("operation cancelled"), { code: "ABORT_ERR" })
      const result = classifySyncFailure(err, { agentRoot: fakeAgentRoot, abortReason: "hard" })
      expect(result.classification).toBe("timeout-hard")
    })
  })

  describe("unknown", () => {
    it("classifies an unrecognised git failure as unknown", async () => {
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const err = new Error("some unrecognised git error that we have no pattern for")
      const result = classifySyncFailure(err, { agentRoot: fakeAgentRoot })
      expect(result.classification).toBe("unknown")
    })

    it("classifies a non-Error throw (string) as unknown", async () => {
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const result = classifySyncFailure("plain string thrown", { agentRoot: fakeAgentRoot })
      expect(result.classification).toBe("unknown")
    })

    it("classifies null/undefined as unknown", async () => {
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      expect(classifySyncFailure(null, { agentRoot: fakeAgentRoot }).classification).toBe("unknown")
      expect(classifySyncFailure(undefined, { agentRoot: fakeAgentRoot }).classification).toBe("unknown")
    })
  })

  describe("classification result shape", () => {
    it("returns the original error message as `error` field", async () => {
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const err = new Error("specific error text we want preserved")
      const result = classifySyncFailure(err, { agentRoot: fakeAgentRoot })
      expect(result.error).toContain("specific error text we want preserved")
    })

    it("includes empty conflictFiles for non-conflict classifications", async () => {
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const err = new Error("Authentication failed")
      const result = classifySyncFailure(err, { agentRoot: fakeAgentRoot })
      expect(result.conflictFiles).toEqual([])
    })

    it("stringifies non-Error values for the error field", async () => {
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const result = classifySyncFailure({ weird: "object" }, { agentRoot: fakeAgentRoot })
      expect(result.error).toBeTypeOf("string")
      expect(result.classification).toBe("unknown")
    })
  })

  describe("priority (more specific patterns win)", () => {
    it("classifies an AbortError mentioning 401 as timeout (abort wins over content match)", async () => {
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const err = Object.assign(new Error("aborted (would have hit 401)"), { name: "AbortError" })
      const result = classifySyncFailure(err, { agentRoot: fakeAgentRoot, abortReason: "hard" })
      expect(result.classification).toBe("timeout-hard")
    })

    it("classifies a 404 stderr that also mentions 'not-fast-forward' as not-found-404 (404 is more actionable)", async () => {
      const { classifySyncFailure } = await import("../../heart/sync-classification")
      const err = new Error("fatal: ... 404 ... non-fast-forward ...")
      const result = classifySyncFailure(err, { agentRoot: fakeAgentRoot })
      expect(result.classification).toBe("not-found-404")
    })
  })
})
