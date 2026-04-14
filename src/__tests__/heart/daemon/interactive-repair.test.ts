import { describe, expect, it, vi } from "vitest"

import { emitNervesEvent } from "../../../nerves/runtime"
import { runInteractiveRepair } from "../../../heart/daemon/interactive-repair"
import type { InteractiveRepairDeps, DegradedAgent } from "../../../heart/daemon/interactive-repair"

// Silence nerves events during tests
vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

function makeDeps(overrides: Partial<InteractiveRepairDeps> = {}): InteractiveRepairDeps {
  return {
    promptInput: vi.fn(async () => "n"),
    writeStdout: vi.fn(),
    runAuthFlow: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe("runInteractiveRepair", () => {
  it("returns immediately with repairsAttempted false when no degraded agents", async () => {
    const deps = makeDeps()
    const result = await runInteractiveRepair([], deps)
    expect(result).toEqual({ repairsAttempted: false })
    expect(deps.promptInput).not.toHaveBeenCalled()
    expect(deps.writeStdout).not.toHaveBeenCalled()
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("prompts for auth and runs auth flow when user says y for missing credentials (errorReason)", async () => {
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
    })
    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "missing credentials for provider", fixHint: "run ouro auth slugger" },
    ]
    const result = await runInteractiveRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: true })
    expect(deps.promptInput).toHaveBeenCalledWith(
      expect.stringContaining("ouro auth slugger"),
    )
    expect(deps.runAuthFlow).toHaveBeenCalledWith("slugger")
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("prompts for auth and runs auth flow when user says y for missing credentials (fixHint contains ouro auth)", async () => {
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
    })
    const degraded: DegradedAgent[] = [
      { agent: "mybot", errorReason: "startup failed", fixHint: "try running ouro auth mybot" },
    ]
    const result = await runInteractiveRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: true })
    expect(deps.runAuthFlow).toHaveBeenCalledWith("mybot")
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("treats yes as affirmative for auth repairs", async () => {
    const deps = makeDeps({
      promptInput: vi.fn(async () => "yes"),
    })
    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "missing credentials", fixHint: "ouro auth slugger" },
    ]

    const result = await runInteractiveRepair(degraded, deps)

    expect(result).toEqual({ repairsAttempted: true })
    expect(deps.runAuthFlow).toHaveBeenCalledWith("slugger")
  })

  it("preserves provider-specific auth repair commands from fix hints", async () => {
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
    })
    const degraded: DegradedAgent[] = [
      {
        agent: "slugger",
        errorReason: "selected provider github-copilot for agentFacing failed health check: token expired",
        fixHint: "Run 'ouro auth --agent slugger --provider github-copilot' to refresh credentials.",
      },
    ]
    const result = await runInteractiveRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: true })
    expect(deps.promptInput).toHaveBeenCalledWith(
      "run `ouro auth --agent slugger --provider github-copilot` now? [y/n] ",
    )
    expect(deps.runAuthFlow).toHaveBeenCalledWith("slugger", "github-copilot")
  })

  it("extracts unquoted auth repair commands without trailing prose", async () => {
    const deps = makeDeps({
      promptInput: vi.fn(async () => "n"),
    })
    const degraded: DegradedAgent[] = [
      {
        agent: "slugger",
        errorReason: "provider credentials failed",
        fixHint: "Try ouro auth --agent slugger --provider github-copilot, then run ouro up again.",
      },
    ]

    const result = await runInteractiveRepair(degraded, deps)

    expect(result).toEqual({ repairsAttempted: false })
    expect(deps.promptInput).toHaveBeenCalledWith(
      "run `ouro auth --agent slugger --provider github-copilot` now? [y/n] ",
    )
    expect(deps.runAuthFlow).not.toHaveBeenCalled()
  })

  it("prompts for vault unlock before auth when provider credentials are blocked by a locked vault", async () => {
    const runVaultUnlock = vi.fn(async () => undefined)
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
      runVaultUnlock,
    })
    const degraded: DegradedAgent[] = [
      {
        agent: "slugger",
        errorReason: "outward provider openai-codex model gpt-5.4 cannot read provider credentials because slugger's credential vault is locked on this machine.",
        fixHint: "Run 'ouro vault unlock --agent slugger', then run 'ouro up' again.",
      },
    ]

    const result = await runInteractiveRepair(degraded, deps)

    expect(result).toEqual({ repairsAttempted: true })
    expect(deps.promptInput).toHaveBeenCalledWith(
      "run `ouro vault unlock --agent slugger` now? [y/n] ",
    )
    expect(deps.promptInput).not.toHaveBeenCalledWith(
      expect.stringContaining("ouro auth"),
    )
    expect(runVaultUnlock).toHaveBeenCalledWith("slugger")
    expect(deps.runAuthFlow).not.toHaveBeenCalled()
  })

  it("trims affirmative answers for vault unlock repairs", async () => {
    const runVaultUnlock = vi.fn(async () => undefined)
    const deps = makeDeps({
      promptInput: vi.fn(async () => " YES "),
      runVaultUnlock,
    })
    const degraded: DegradedAgent[] = [
      {
        agent: "slugger",
        errorReason: "vault locked",
        fixHint: "Run 'ouro vault unlock --agent slugger'.",
      },
    ]

    const result = await runInteractiveRepair(degraded, deps)

    expect(result).toEqual({ repairsAttempted: true })
    expect(runVaultUnlock).toHaveBeenCalledWith("slugger")
  })


  it("reports vault unlock errors without relabeling them as auth flow errors", async () => {
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
      runVaultUnlock: vi.fn(async () => {
        throw new Error("operator cancelled unlock")
      }),
    })
    const degraded: DegradedAgent[] = [
      {
        agent: "slugger",
        errorReason: "credential vault is locked",
        fixHint: "Run 'ouro vault unlock --agent slugger', then run 'ouro up' again.",
      },
    ]

    const result = await runInteractiveRepair(degraded, deps)

    expect(result).toEqual({ repairsAttempted: true })
    expect(deps.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining("vault unlock error for slugger: operator cancelled unlock"),
    )
    expect(deps.writeStdout).not.toHaveBeenCalledWith(
      expect.stringContaining("auth flow error"),
    )
  })

  it("reports non-Error vault unlock failures", async () => {
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
      runVaultUnlock: vi.fn(async () => {
        throw "operator cancelled unlock"
      }),
    })
    const degraded: DegradedAgent[] = [
      {
        agent: "slugger",
        errorReason: "vault locked",
        fixHint: "Run 'ouro vault unlock --agent slugger', then run 'ouro up' again.",
      },
    ]

    const result = await runInteractiveRepair(degraded, deps)

    expect(result).toEqual({ repairsAttempted: true })
    expect(deps.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining("vault unlock error for slugger: operator cancelled unlock"),
    )
  })

  it("shows the vault unlock fix hint when no unlock runner is available", async () => {
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
    })
    const degraded: DegradedAgent[] = [
      {
        agent: "slugger",
        errorReason: "vault locked",
        fixHint: "Run 'ouro vault unlock --agent slugger', then run 'ouro up' again.",
      },
    ]

    const result = await runInteractiveRepair(degraded, deps)

    expect(result).toEqual({ repairsAttempted: false })
    expect(deps.writeStdout).toHaveBeenCalledWith(
      "fix hint for slugger: Run 'ouro vault unlock --agent slugger', then run 'ouro up' again.",
    )
    expect(deps.runAuthFlow).not.toHaveBeenCalled()
  })

  it("falls back to an agent-scoped vault unlock command when the hint has no command", async () => {
    const deps = makeDeps({
      promptInput: vi.fn(async () => "n"),
    })
    const degraded: DegradedAgent[] = [
      {
        agent: "slugger",
        errorReason: "vault locked",
        fixHint: "Unlock the vault before retrying.",
      },
    ]

    const result = await runInteractiveRepair(degraded, deps)

    expect(result).toEqual({ repairsAttempted: false })
    expect(deps.promptInput).toHaveBeenCalledWith(
      expect.stringContaining("ouro vault unlock --agent slugger"),
    )
    expect(deps.runAuthFlow).not.toHaveBeenCalled()
  })

  it("skips auth flow when user says n for missing credentials", async () => {
    const deps = makeDeps({
      promptInput: vi.fn(async () => "n"),
    })
    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "missing credentials", fixHint: "run ouro auth slugger" },
    ]
    const result = await runInteractiveRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: false })
    expect(deps.runAuthFlow).not.toHaveBeenCalled()
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("falls back to an agent-scoped auth command when a credential issue has no command hint", async () => {
    const deps = makeDeps({
      promptInput: vi.fn(async () => "n"),
    })
    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "credentials are invalid", fixHint: "refresh the token" },
    ]
    const result = await runInteractiveRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: false })
    expect(deps.promptInput).toHaveBeenCalledWith(
      expect.stringContaining("ouro auth --agent slugger"),
    )
    expect(deps.runAuthFlow).not.toHaveBeenCalled()
  })

  it("shows fix hint and offers retry for config errors with actionable fixHint", async () => {
    const deps = makeDeps({
      promptInput: vi.fn(async () => "n"),
    })
    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "config parse error", fixHint: "check ~/.agentsecrets/slugger/secrets.json for syntax errors" },
    ]
    const result = await runInteractiveRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: false })
    // Should display the fix hint
    expect(deps.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining("check ~/.agentsecrets/slugger/secrets.json"),
    )
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("handles unknown error type by displaying fix hint without auto-fix prompt", async () => {
    const deps = makeDeps()
    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "unknown internal error", fixHint: "" },
    ]
    const result = await runInteractiveRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: false })
    // Should display the error but not prompt for auto-fix since fixHint is empty
    expect(deps.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining("unknown internal error"),
    )
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("handles multiple degraded agents, prompting for each", async () => {
    let callCount = 0
    const deps = makeDeps({
      promptInput: vi.fn(async () => {
        callCount++
        return callCount === 1 ? "y" : "n"
      }),
    })
    const degraded: DegradedAgent[] = [
      { agent: "agent1", errorReason: "missing credentials", fixHint: "ouro auth agent1" },
      { agent: "agent2", errorReason: "missing credentials", fixHint: "ouro auth agent2" },
    ]
    const result = await runInteractiveRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: true })
    expect(deps.runAuthFlow).toHaveBeenCalledWith("agent1")
    expect(deps.runAuthFlow).not.toHaveBeenCalledWith("agent2")
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("catches auth flow errors and continues to next agent", async () => {
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
      runAuthFlow: vi.fn(async (agent: string) => {
        if (agent === "agent1") throw new Error("auth failed")
      }),
    })
    const degraded: DegradedAgent[] = [
      { agent: "agent1", errorReason: "missing credentials", fixHint: "ouro auth agent1" },
      { agent: "agent2", errorReason: "missing credentials", fixHint: "ouro auth agent2" },
    ]
    const result = await runInteractiveRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: true })
    // Both auth flows attempted despite first one throwing
    expect(deps.runAuthFlow).toHaveBeenCalledWith("agent1")
    expect(deps.runAuthFlow).toHaveBeenCalledWith("agent2")
    // Error logged
    expect(deps.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining("auth failed"),
    )
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("handles non-Error thrown from auth flow", async () => {
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
      runAuthFlow: vi.fn(async () => {
        throw "string-error"  // eslint-disable-line no-throw-literal
      }),
    })
    const degraded: DegradedAgent[] = [
      { agent: "agent1", errorReason: "missing credentials", fixHint: "ouro auth agent1" },
    ]
    const result = await runInteractiveRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: true })
    expect(deps.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining("string-error"),
    )
    expect(emitNervesEvent).toHaveBeenCalled()
  })

  it("treats Y (uppercase) as yes", async () => {
    const deps = makeDeps({
      promptInput: vi.fn(async () => "Y"),
    })
    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "credentials not found", fixHint: "ouro auth slugger" },
    ]
    const result = await runInteractiveRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: true })
    expect(deps.runAuthFlow).toHaveBeenCalledWith("slugger")
    expect(emitNervesEvent).toHaveBeenCalled()
  })
})
