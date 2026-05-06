import { describe, expect, it, vi } from "vitest"

import {
  runAgenticRepair,
  shouldFireRepairGuide,
  type AgenticRepairDeps,
} from "../../../heart/daemon/agentic-repair"
import type { DegradedAgent } from "../../../heart/daemon/interactive-repair"
import type { DiscoverWorkingProviderResult } from "../../../heart/daemon/provider-discovery"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

vi.mock("../../../heart/provider-ping", () => ({
  createProviderRuntimeForConfig: vi.fn(() => ({
    streamTurn: vi.fn(async () => ({ content: "", toolCalls: [], outputItems: [] })),
  })),
}))

function makeDiscoverResult(): DiscoverWorkingProviderResult {
  return {
    provider: "anthropic",
    credentials: { setupToken: "sk-test" },
    providerConfig: { model: "claude-opus-4-6" },
  }
}

function makeDeps(overrides: Partial<AgenticRepairDeps> = {}): AgenticRepairDeps {
  return {
    discoverWorkingProvider: vi.fn(async () => makeDiscoverResult()),
    runInteractiveRepair: vi.fn(async () => ({ repairsAttempted: false })),
    promptInput: vi.fn(async () => "y"),
    writeStdout: vi.fn(),
    createProviderRuntime: vi.fn(() => ({
      streamTurn: vi.fn(async () => ({
        content: "diagnosis text",
        toolCalls: [],
        outputItems: [],
      })),
    })),
    readDaemonLogsTail: vi.fn(() => "(no logs)"),
    ...overrides,
  }
}

/**
 * Layer 3 — RepairGuide wiring.
 *
 * The integration boundary tested here is the contract between
 * `shouldFireRepairGuide` (the gate function) and `runAgenticRepair` (the
 * existing flow it gates). The full slugger compound fixture in
 * `slugger-compound.test.ts` covers the end-to-end path through the cli-exec
 * call site; this file covers the unit-level wiring that the call site
 * relies on.
 */
describe("RepairGuide gate wiring (cli-exec.ts call site)", () => {
  it("cli-exec.ts uses shouldFireRepairGuide at the agentic-repair gate", async () => {
    // Static check: the call site must use the new contract function.
    // Writing this as a source-level check guards against a refactor that
    // accidentally reverts the gate to the bare `if (untypedDegraded.length > 0)`.
    const fs = await import("fs")
    const path = await import("path")
    const cliExecPath = path.resolve(__dirname, "../../../heart/daemon/cli-exec.ts")
    const source = fs.readFileSync(cliExecPath, "utf-8")
    expect(source).toContain("shouldFireRepairGuide")
  })

  it("cli-exec.ts no longer uses the bare untyped-only gate", async () => {
    // The bare `if (untypedDegraded.length > 0) {` block ending in
    // runAgenticRepair must be gone. If a future refactor reverts to the
    // bare gate, this test catches it. (The literal substring exists once
    // earlier in cli-exec.ts as a filter result label, not as a gate.)
    const fs = await import("fs")
    const path = await import("path")
    const cliExecPath = path.resolve(__dirname, "../../../heart/daemon/cli-exec.ts")
    const source = fs.readFileSync(cliExecPath, "utf-8")
    // The exact pre-PR gate line was:
    //   if (untypedDegraded.length > 0) {  // followed by runAgenticRepair
    // Replace with shouldFireRepairGuide(...). The new gate is the only
    // place where runAgenticRepair is called from cli-exec.ts; verify
    // runAgenticRepair appears under the new gate, not the old one.
    expect(source).not.toMatch(/if\s*\(\s*untypedDegraded\.length\s*>\s*0\s*\)\s*\{[\s\S]{0,300}runAgenticRepair/)
  })
})

describe("RepairGuide content prepending", () => {
  it("prepends RepairGuide bundle content to the diagnostic system prompt when present", async () => {
    // Use the actual on-disk RepairGuide.ouro/ as the fixture (it ships in
    // the repo). Verify the streamTurn mock receives a system message that
    // contains a marker from SOUL.md.
    const path = await import("path")
    const fs = await import("fs")
    const repoRoot = path.resolve(__dirname, "../../../..")
    expect(fs.existsSync(path.join(repoRoot, "RepairGuide.ouro"))).toBe(true)

    const captured: { systemContent?: string } = {}
    const mockStreamTurn = vi.fn(async (req: { messages: Array<{ role: string; content: string }> }) => {
      const sys = req.messages.find((m) => m.role === "system")
      captured.systemContent = sys?.content
      return {
        content: "```json\n" + JSON.stringify({
          actions: [
            { kind: "vault-unlock", agent: "slugger", reason: "expired" },
          ],
        }) + "\n```",
        toolCalls: [],
        outputItems: [],
      }
    })

    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "weird-error", fixHint: "" },
    ]
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
      runInteractiveRepair: vi.fn(async () => ({ repairsAttempted: true })),
      createProviderRuntime: vi.fn(() => ({ streamTurn: mockStreamTurn })),
      repoRootOverride: repoRoot,
    })

    const result = await runAgenticRepair(degraded, deps)
    expect(result.usedAgentic).toBe(true)
    expect(captured.systemContent).toContain("RepairGuide SOUL")
    expect(captured.systemContent).toContain("RepairGuide IDENTITY")
    expect(captured.systemContent).toContain("diagnose-vault-expired.md")

    // RepairGuide proposals were extracted and surfaced to stdout
    const stdoutCalls = (deps.writeStdout as ReturnType<typeof vi.fn>).mock.calls.flat()
    const stdout = stdoutCalls.join("\n")
    expect(stdout).toContain("RepairGuide proposals")
    expect(stdout).toContain("vault-unlock")
  })

  it("falls back to today's diagnosis blob when RepairGuide bundle is missing", async () => {
    // Point the loader at an empty temp dir (no RepairGuide.ouro). The
    // diagnostic call still runs with the original system prompt and the
    // raw output is printed under "AI Diagnosis", not "RepairGuide proposals".
    const path = await import("path")
    const fs = await import("fs")
    const os = await import("os")
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "repair-guide-missing-"))

    const mockStreamTurn = vi.fn(async () => ({
      content: "plain-text diagnosis",
      toolCalls: [],
      outputItems: [],
    }))

    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "weird", fixHint: "" },
    ]
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
      runInteractiveRepair: vi.fn(async () => ({ repairsAttempted: true })),
      createProviderRuntime: vi.fn(() => ({ streamTurn: mockStreamTurn })),
      repoRootOverride: tmpRoot,
    })

    const result = await runAgenticRepair(degraded, deps)
    expect(result.usedAgentic).toBe(true)

    const stdoutCalls = (deps.writeStdout as ReturnType<typeof vi.fn>).mock.calls.flat()
    const stdout = stdoutCalls.join("\n")
    expect(stdout).toContain("AI Diagnosis")
    expect(stdout).toContain("plain-text diagnosis")
    expect(stdout).not.toContain("RepairGuide proposals")

    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("when RepairGuide present and LLM emits unparseable output, prints fallback blob (not proposals)", async () => {
    const path = await import("path")
    const repoRoot = path.resolve(__dirname, "../../../..")

    const mockStreamTurn = vi.fn(async () => ({
      content: "raw prose without JSON block",
      toolCalls: [],
      outputItems: [],
    }))

    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "weird", fixHint: "" },
    ]
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
      runInteractiveRepair: vi.fn(async () => ({ repairsAttempted: true })),
      createProviderRuntime: vi.fn(() => ({ streamTurn: mockStreamTurn })),
      repoRootOverride: repoRoot,
    })

    await runAgenticRepair(degraded, deps)
    const stdoutCalls = (deps.writeStdout as ReturnType<typeof vi.fn>).mock.calls.flat()
    const stdout = stdoutCalls.join("\n")
    expect(stdout).toContain("AI Diagnosis")
    expect(stdout).toContain("raw prose without JSON block")
    expect(stdout).not.toContain("RepairGuide proposals")
  })

  it("when RepairGuide proposal includes warnings, surfaces them under proposals", async () => {
    const path = await import("path")
    const repoRoot = path.resolve(__dirname, "../../../..")

    const mockStreamTurn = vi.fn(async () => ({
      content: "```json\n" + JSON.stringify({
        actions: [
          { kind: "vault-unlock", agent: "a", reason: "r" },
          { kind: "totally-bogus", agent: "b" },
        ],
      }) + "\n```",
      toolCalls: [],
      outputItems: [],
    }))

    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "weird", fixHint: "" },
    ]
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
      runInteractiveRepair: vi.fn(async () => ({ repairsAttempted: true })),
      createProviderRuntime: vi.fn(() => ({ streamTurn: mockStreamTurn })),
      repoRootOverride: repoRoot,
    })

    await runAgenticRepair(degraded, deps)
    const stdoutCalls = (deps.writeStdout as ReturnType<typeof vi.fn>).mock.calls.flat()
    const stdout = stdoutCalls.join("\n")
    expect(stdout).toContain("RepairGuide proposals")
    expect(stdout).toContain("vault-unlock")
    expect(stdout).toContain("warning")
    expect(stdout).toContain("totally-bogus")
  })

  it("when RepairGuide bundle exists but psyche+skills are empty, falls back to base prompt", async () => {
    // Create a RepairGuide.ouro with empty psyche/skills directories. The
    // loader returns an object with empty psyche{} and skills{} (not null);
    // buildSystemPromptWithRepairGuide should detect zero sections and
    // return the base prompt unchanged.
    const path = await import("path")
    const fs = await import("fs")
    const os = await import("os")
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "repair-guide-empty-"))
    fs.mkdirSync(path.join(tmpRoot, "RepairGuide.ouro", "psyche"), { recursive: true })
    fs.mkdirSync(path.join(tmpRoot, "RepairGuide.ouro", "skills"), { recursive: true })

    const captured: { systemContent?: string } = {}
    const mockStreamTurn = vi.fn(async (req: { messages: Array<{ role: string; content: string }> }) => {
      const sys = req.messages.find((m) => m.role === "system")
      captured.systemContent = sys?.content
      return { content: "diag", toolCalls: [], outputItems: [] }
    })

    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "weird", fixHint: "" },
    ]
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
      runInteractiveRepair: vi.fn(async () => ({ repairsAttempted: true })),
      createProviderRuntime: vi.fn(() => ({ streamTurn: mockStreamTurn })),
      repoRootOverride: tmpRoot,
    })

    await runAgenticRepair(degraded, deps)
    // Empty bundle → base prompt with NO RepairGuide markers
    expect(captured.systemContent).toBeDefined()
    expect(captured.systemContent).not.toContain("RepairGuide SOUL")
    expect(captured.systemContent).not.toContain("RepairGuide IDENTITY")
    expect(captured.systemContent).not.toContain("RepairGuide skill")

    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("when RepairGuide has skills but no SOUL or IDENTITY, prompt still includes the skills", async () => {
    // Edge case: psyche dir absent / both files missing but skills/ has
    // content. The two psyche `if` branches are hit on the falsy side.
    const path = await import("path")
    const fs = await import("fs")
    const os = await import("os")
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "repair-guide-skills-only-"))
    fs.mkdirSync(path.join(tmpRoot, "RepairGuide.ouro", "skills"), { recursive: true })
    fs.writeFileSync(
      path.join(tmpRoot, "RepairGuide.ouro", "skills", "only-skill.md"),
      "skill body content",
    )

    const captured: { systemContent?: string } = {}
    const mockStreamTurn = vi.fn(async (req: { messages: Array<{ role: string; content: string }> }) => {
      const sys = req.messages.find((m) => m.role === "system")
      captured.systemContent = sys?.content
      return { content: "diag", toolCalls: [], outputItems: [] }
    })

    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "weird", fixHint: "" },
    ]
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
      runInteractiveRepair: vi.fn(async () => ({ repairsAttempted: true })),
      createProviderRuntime: vi.fn(() => ({ streamTurn: mockStreamTurn })),
      repoRootOverride: tmpRoot,
    })

    await runAgenticRepair(degraded, deps)
    expect(captured.systemContent).toContain("only-skill.md")
    expect(captured.systemContent).toContain("skill body content")
    expect(captured.systemContent).not.toContain("RepairGuide SOUL")
    expect(captured.systemContent).not.toContain("RepairGuide IDENTITY")

    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("forceDiagnosis bypass: typed-only set with no local repair fires diagnostic", async () => {
    const path = await import("path")
    const repoRoot = path.resolve(__dirname, "../../../..")

    const mockStreamTurn = vi.fn(async () => ({
      content: "```json\n" + JSON.stringify({ actions: [] }) + "\n```",
      toolCalls: [],
      outputItems: [],
    }))

    // Three typed entries (issue.kind is known typed) — without
    // forceDiagnosis, runAgenticRepair would early-return because
    // hasKnownTypedRepair is true.
    const typed: DegradedAgent[] = [
      {
        agent: "slugger",
        errorReason: "vault locked",
        fixHint: "",
        issue: {
          kind: "vault-locked",
          severity: "blocked",
          actor: "human-required",
          summary: "",
          actions: [],
        },
      },
      {
        agent: "slugger",
        errorReason: "creds missing",
        fixHint: "",
        issue: {
          kind: "provider-credentials-missing",
          severity: "blocked",
          actor: "human-required",
          summary: "",
          actions: [],
        },
      },
      {
        agent: "slugger",
        errorReason: "live check failed",
        fixHint: "",
        issue: {
          kind: "provider-live-check-failed",
          severity: "blocked",
          actor: "human-required",
          summary: "",
          actions: [],
        },
      },
    ]
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
      runInteractiveRepair: vi.fn(async () => ({ repairsAttempted: false })),
      createProviderRuntime: vi.fn(() => ({ streamTurn: mockStreamTurn })),
      repoRootOverride: repoRoot,
      forceDiagnosis: true,
    })

    const result = await runAgenticRepair(typed, deps)
    // The diagnostic LLM call fired (usedAgentic === true), bypassing the
    // typed-only early-return.
    expect(result.usedAgentic).toBe(true)
  })
})

describe("RepairGuide gate wiring (function-level)", () => {
  it("shouldFireRepairGuide false → caller skips runAgenticRepair entirely", async () => {
    // When the gate decides NOT to fire, the caller must not even build the
    // deps for runAgenticRepair. Verifying via direct gate inspection.
    const decision = shouldFireRepairGuide({
      untypedDegraded: [],
      typedDegraded: [],
      noRepair: false,
    })
    expect(decision).toBe(false)
  })

  it("shouldFireRepairGuide true on untyped degraded → runAgenticRepair is the right next step", async () => {
    const untyped: DegradedAgent[] = [
      { agent: "slugger", errorReason: "weird", fixHint: "" },
    ]
    expect(
      shouldFireRepairGuide({ untypedDegraded: untyped, typedDegraded: [], noRepair: false }),
    ).toBe(true)

    // Verify runAgenticRepair still operates on this input shape unchanged
    // (no behavioral regression from layer 1/2/4 baseline).
    const deps = makeDeps({
      promptInput: vi.fn(async () => "n"),
      runInteractiveRepair: vi.fn(async () => ({ repairsAttempted: true })),
    })
    const result = await runAgenticRepair(untyped, deps)
    expect(result.repairsAttempted).toBe(true)
  })

  it("shouldFireRepairGuide true on stacked typed degraded → runAgenticRepair receives the typed entries", async () => {
    const typed: DegradedAgent[] = [
      { agent: "slugger", errorReason: "vault locked", fixHint: "", issue: { kind: "vault-locked", severity: "blocked", actor: "human-required", summary: "", actions: [] } },
      { agent: "slugger", errorReason: "auth missing", fixHint: "", issue: { kind: "provider-credentials-missing", severity: "blocked", actor: "human-required", summary: "", actions: [] } },
      { agent: "slugger", errorReason: "selection mismatch", fixHint: "", issue: { kind: "generic", severity: "degraded", actor: "human-required", summary: "", actions: [] } },
    ]
    expect(
      shouldFireRepairGuide({ untypedDegraded: [], typedDegraded: typed, noRepair: false }),
    ).toBe(true)

    // The call site at cli-exec.ts will pass the COMBINED set into
    // runAgenticRepair when the new path fires. Verify runAgenticRepair
    // accepts a degraded list with all-typed entries without throwing
    // (the existing implementation already returns early on hasKnownTypedRepair).
    const deps = makeDeps({
      runInteractiveRepair: vi.fn(async () => ({ repairsAttempted: false })),
    })
    const result = await runAgenticRepair(typed, deps)
    // hasKnownTypedRepair short-circuits when no local interactive repair is
    // runnable; verify the function returns the expected shape.
    expect(result).toHaveProperty("repairsAttempted")
    expect(result).toHaveProperty("usedAgentic")
  })

  it("--no-repair shortcuts: shouldFireRepairGuide returns false even when typedDegraded >= 3", () => {
    const typed: DegradedAgent[] = [
      { agent: "a", errorReason: "1", fixHint: "" },
      { agent: "a", errorReason: "2", fixHint: "" },
      { agent: "a", errorReason: "3", fixHint: "" },
    ]
    expect(
      shouldFireRepairGuide({ untypedDegraded: [], typedDegraded: typed, noRepair: true }),
    ).toBe(false)
  })

  it("--no-repair shortcuts: shouldFireRepairGuide returns false even when untypedDegraded > 0", () => {
    const untyped: DegradedAgent[] = [
      { agent: "a", errorReason: "weird", fixHint: "" },
    ]
    expect(
      shouldFireRepairGuide({ untypedDegraded: untyped, typedDegraded: [], noRepair: true }),
    ).toBe(false)
  })
})

describe("RepairGuide diagnostic prompt threads structured sync findings", () => {
  // cli-exec.ts collects BootSyncProbeFinding[] at boot time and threads it
  // into the diagnostic call via `deps.syncFindings`. The
  // `diagnose-broken-remote` / `diagnose-sync-blocked` skills reason over
  // that JSON block.

  function captureUserMessage(): {
    deps: ReturnType<typeof makeDeps>
    captured: { userContent?: string }
    mockStreamTurn: ReturnType<typeof vi.fn>
  } {
    const captured: { userContent?: string } = {}
    const mockStreamTurn = vi.fn(async (req: { messages: Array<{ role: string; content: string }> }) => {
      const user = req.messages.find((m) => m.role === "user")
      captured.userContent = user?.content
      return { content: "ok", toolCalls: [], outputItems: [] }
    })
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
      runInteractiveRepair: vi.fn(async () => ({ repairsAttempted: true })),
      createProviderRuntime: vi.fn(() => ({ streamTurn: mockStreamTurn })),
    })
    return { deps, captured, mockStreamTurn }
  }

  it("includes a bootSyncFindings JSON block when deps.syncFindings is non-empty", async () => {
    const { deps, captured } = captureUserMessage()
    const sync = [
      {
        agent: "slugger",
        classification: "not-found-404" as const,
        error: "fatal: repository 'https://github.com/me/old-repo.git/' not found",
        conflictFiles: [],
        warnings: [],
        advisory: false,
      },
    ]
    const degraded: DegradedAgent[] = [{ agent: "slugger", errorReason: "weird", fixHint: "" }]
    await runAgenticRepair(degraded, { ...deps, syncFindings: sync })
    expect(captured.userContent).toContain("bootSyncFindings")
    expect(captured.userContent).toContain("not-found-404")
    expect(captured.userContent).toContain("conflictFiles")
    expect(captured.userContent).toContain("advisory")
  })

  it("omits the sync block when deps.syncFindings is absent (back-compat)", async () => {
    const { deps, captured } = captureUserMessage()
    const degraded: DegradedAgent[] = [{ agent: "slugger", errorReason: "weird", fixHint: "" }]
    await runAgenticRepair(degraded, deps)
    expect(captured.userContent).not.toContain("bootSyncFindings")
    // Original prompt structure preserved
    expect(captured.userContent).toContain("Recent daemon logs:")
    expect(captured.userContent).toContain("What is the most likely cause")
  })

  it("omits the sync block when deps.syncFindings is an empty array", async () => {
    const { deps, captured } = captureUserMessage()
    const degraded: DegradedAgent[] = [{ agent: "slugger", errorReason: "weird", fixHint: "" }]
    await runAgenticRepair(degraded, { ...deps, syncFindings: [] })
    expect(captured.userContent).not.toContain("bootSyncFindings")
  })
})
