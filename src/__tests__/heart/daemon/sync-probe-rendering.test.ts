/**
 * Layer 2 — Unit 5a / 5b / 5c: tests for sync-probe rendering helpers.
 *
 * Covers the two helpers exported from `cli-exec.ts`:
 * - `summarizeSyncProbeFindings` — short label for the boot progress phase.
 * - `writeSyncProbeSummary`     — multi-line stdout summary when findings exist.
 *
 * These tests assert distinct, scannable copy per taxonomy variant and the
 * blocker-first ordering for actionability. The helpers are deliberately
 * pure (no side effects beyond the injected `writeStdout`), so the tests
 * stay simple and don't need vi mocks beyond the stdout sink.
 */
import { describe, expect, it, vi } from "vitest"
import {
  summarizeSyncProbeFindings,
  writeSyncProbeSummary,
} from "../../../heart/daemon/cli-exec"
import type { BootSyncProbeFinding } from "../../../heart/daemon/boot-sync-probe"

function finding(overrides: Partial<BootSyncProbeFinding> = {}): BootSyncProbeFinding {
  return {
    agent: "alice",
    classification: "unknown",
    error: "stub error",
    conflictFiles: [],
    warnings: [],
    advisory: true,
    ...overrides,
  }
}

describe("summarizeSyncProbeFindings", () => {
  it("returns the all-healthy phrase when findings is empty", () => {
    expect(summarizeSyncProbeFindings([])).toBe("all sync-enabled bundles healthy")
  })

  it("counts blocking findings", () => {
    const out = summarizeSyncProbeFindings([
      finding({ advisory: false, classification: "auth-failed" }),
    ])
    expect(out).toContain("1 finding")
    expect(out).toContain("1 blocking")
  })

  it("counts advisory findings", () => {
    const out = summarizeSyncProbeFindings([
      finding({ advisory: true, classification: "dirty-working-tree" }),
      finding({ advisory: true, classification: "non-fast-forward", agent: "bob" }),
    ])
    expect(out).toContain("2 findings")
    expect(out).toContain("2 advisory")
  })

  it("mixes blocking and advisory counts in the same blurb", () => {
    const out = summarizeSyncProbeFindings([
      finding({ advisory: false, classification: "not-found-404" }),
      finding({ advisory: true, classification: "dirty-working-tree", agent: "bob" }),
    ])
    expect(out).toContain("2 findings")
    expect(out).toContain("1 blocking")
    expect(out).toContain("1 advisory")
  })

  it("uses singular `finding` for one and plural `findings` otherwise", () => {
    expect(summarizeSyncProbeFindings([finding({ advisory: false })])).toContain("1 finding ")
    expect(
      summarizeSyncProbeFindings([finding({ advisory: false }), finding({ agent: "b" })]),
    ).toContain("2 findings ")
  })
})

describe("writeSyncProbeSummary", () => {
  it("writes nothing when given no findings (caller is supposed to gate on length)", () => {
    // The current call site only invokes this when findings.length > 0, but
    // we still assert the no-finding case behaves: the helper writes the
    // header and an empty list. (Defensive — keeps the helper a pure
    // formatter without behavior surprises if a future caller forgets to
    // gate.)
    const writeStdout = vi.fn()
    writeSyncProbeSummary({ writeStdout }, [])
    expect(writeStdout).toHaveBeenCalledTimes(1)
    const output = writeStdout.mock.calls[0][0]
    expect(output).toBe("sync probe findings:")
  })

  it("orders blocking findings before advisory findings", () => {
    const writeStdout = vi.fn()
    writeSyncProbeSummary({ writeStdout }, [
      finding({ agent: "carol", advisory: true, classification: "dirty-working-tree", error: "dirty tree" }),
      finding({ agent: "bob", advisory: false, classification: "auth-failed", error: "auth failed text" }),
    ])
    const output = writeStdout.mock.calls[0][0] as string
    const bobIdx = output.indexOf("bob")
    const carolIdx = output.indexOf("carol")
    expect(bobIdx).toBeGreaterThanOrEqual(0)
    expect(carolIdx).toBeGreaterThan(bobIdx)
  })

  it("labels blocking findings with [block] and advisory with [warn]", () => {
    const writeStdout = vi.fn()
    writeSyncProbeSummary({ writeStdout }, [
      finding({ agent: "alice", advisory: false, classification: "not-found-404", error: "404" }),
      finding({ agent: "bob", advisory: true, classification: "dirty-working-tree", error: "dirty" }),
    ])
    const output = writeStdout.mock.calls[0][0] as string
    expect(output).toContain("[block] alice")
    expect(output).toContain("[warn] bob")
  })

  it("includes the classification and the first line of the error in each row", () => {
    const writeStdout = vi.fn()
    writeSyncProbeSummary({ writeStdout }, [
      finding({
        agent: "alice",
        classification: "auth-failed",
        advisory: false,
        error: "fatal: Authentication failed for ...\nremote: HTTP 401",
      }),
    ])
    const output = writeStdout.mock.calls[0][0] as string
    expect(output).toContain("auth-failed")
    expect(output).toContain("fatal: Authentication failed")
    // Multiline errors get clipped to the first line for the summary view.
    expect(output).not.toContain("remote: HTTP 401")
  })

  it("sorts within the same severity by agent name", () => {
    const writeStdout = vi.fn()
    writeSyncProbeSummary({ writeStdout }, [
      finding({ agent: "zoe", advisory: false, classification: "auth-failed", error: "z" }),
      finding({ agent: "ann", advisory: false, classification: "not-found-404", error: "a" }),
      finding({ agent: "bob", advisory: false, classification: "network-down", error: "b" }),
    ])
    const output = writeStdout.mock.calls[0][0] as string
    const annIdx = output.indexOf("ann")
    const bobIdx = output.indexOf("bob")
    const zoeIdx = output.indexOf("zoe")
    expect(annIdx).toBeLessThan(bobIdx)
    expect(bobIdx).toBeLessThan(zoeIdx)
  })
})
