import { describe, expect, it, vi } from "vitest"

import { emitNervesEvent } from "../../../nerves/runtime"
import { runInteractiveRepair } from "../../../heart/daemon/interactive-repair"
import type { InteractiveRepairDeps, DegradedAgent } from "../../../heart/daemon/interactive-repair"
import { vaultLockedIssue, type AgentReadinessIssue } from "../../../heart/daemon/readiness-repair"

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

function stdoutText(deps: InteractiveRepairDeps): string {
  return (deps.writeStdout as any).mock.calls.map((call: any[]) => call[0]).join("\n")
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
    expect(deps.promptInput).toHaveBeenCalledWith("Open the auth flow now? [y/N] ")
    expect(stdoutText(deps)).toContain("run:   ouro auth slugger")
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
    expect(deps.promptInput).toHaveBeenCalledWith("Open the auth flow now? [y/N] ")
    expect(stdoutText(deps)).toContain("run:   ouro auth --agent slugger --provider github-copilot")
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
    expect(deps.promptInput).toHaveBeenCalledWith("Open the auth flow now? [y/N] ")
    expect(stdoutText(deps)).toContain("run:   ouro auth --agent slugger --provider github-copilot")
    expect(deps.runAuthFlow).not.toHaveBeenCalled()
  })

  it("prints a later auth command when the user declines credential repair", async () => {
    const deps = makeDeps({
      promptInput: vi.fn(async () => "n"),
    })
    const degraded: DegradedAgent[] = [
      {
        agent: "slugger",
        errorReason: "provider credentials failed",
        fixHint: "Run 'ouro auth --agent slugger --provider github-copilot' to refresh credentials.",
      },
    ]

    const result = await runInteractiveRepair(degraded, deps)

    expect(result).toEqual({ repairsAttempted: false })
    expect(deps.runAuthFlow).not.toHaveBeenCalled()
    expect(stdoutText(deps)).toContain("Leaving slugger for later.")
    expect(stdoutText(deps)).toContain("next: ouro auth --agent slugger --provider github-copilot")
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
    expect(deps.promptInput).toHaveBeenCalledWith("Unlock it now? [y/N] ")
    expect(stdoutText(deps)).toContain("run:   ouro vault unlock --agent slugger")
    expect(stdoutText(deps)).toContain("note:  use the saved vault unlock secret")
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

  it("uses typed vault unlock repair actions before legacy text matching", async () => {
    const runVaultUnlock = vi.fn(async () => undefined)
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
      runVaultUnlock,
    })
    const degraded: DegradedAgent[] = [
      {
        agent: "slugger",
        errorReason: "provider failed",
        fixHint: "",
        issue: vaultLockedIssue("slugger"),
      },
    ]

    const result = await runInteractiveRepair(degraded, deps)

    expect(result).toEqual({ repairsAttempted: true })
    expect(deps.promptInput).toHaveBeenCalledWith("Unlock it now? [y/N] ")
    expect(stdoutText(deps)).toContain("run:   ouro vault unlock --agent slugger")
    expect(runVaultUnlock).toHaveBeenCalledWith("slugger")
  })

  it("ignores typed actions that are not locally runnable", async () => {
    const nonRunnableIssue: AgentReadinessIssue = {
      kind: "vault-locked",
      severity: "blocked",
      actor: "human-required",
      summary: "replace required",
      actions: [{
        kind: "vault-replace",
        label: "replace vault",
        command: "ouro vault replace --agent slugger",
        actor: "human-required",
      }],
    }
    const deps = makeDeps({
      promptInput: vi.fn(async () => "y"),
    })
    const degraded: DegradedAgent[] = [
      {
        agent: "slugger",
        errorReason: "provider failed",
        fixHint: "",
        issue: nonRunnableIssue,
      },
    ]

    const result = await runInteractiveRepair(degraded, deps)

    expect(result).toEqual({ repairsAttempted: false })
    expect(deps.promptInput).not.toHaveBeenCalled()
    expect(deps.writeStdout).toHaveBeenCalledWith("slugger\n  provider failed")
  })

  it("falls back to an agent-scoped command for typed provider auth actions with an empty command", async () => {
    const issue: AgentReadinessIssue = {
      kind: "provider-credentials-missing",
      severity: "blocked",
      actor: "human-required",
      summary: "auth required",
      actions: [{
        kind: "provider-auth",
        label: "Authenticate provider",
        command: "",
        actor: "human-required",
        provider: "minimax",
      }],
    }
    const deps = makeDeps({
      promptInput: vi.fn(async () => "n"),
    })
    const degraded: DegradedAgent[] = [
      {
        agent: "slugger",
        errorReason: "provider failed",
        fixHint: "",
        issue,
      },
    ]

    const result = await runInteractiveRepair(degraded, deps)

    expect(result).toEqual({ repairsAttempted: false })
    expect(deps.promptInput).toHaveBeenCalledWith("Open the auth flow now? [y/N] ")
    expect(stdoutText(deps)).toContain("run:   ouro auth --agent slugger")
    expect(stdoutText(deps)).toContain("next: ouro auth --agent slugger")
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
        fixHint: "Run 'ouro vault unlock --agent slugger' if you have the saved secret. If nobody saved it, run 'ouro vault replace --agent slugger'. Then run 'ouro up' again.",
      },
    ]

    const result = await runInteractiveRepair(degraded, deps)

    expect(result).toEqual({ repairsAttempted: true })
    expect(stdoutText(deps)).toContain("Vault unlock did not finish for slugger.")
    expect(stdoutText(deps)).toContain("operator cancelled unlock")
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
    expect(stdoutText(deps)).toContain("Vault unlock did not finish for slugger.")
    expect(stdoutText(deps)).toContain("operator cancelled unlock")
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
    expect(stdoutText(deps)).toContain("slugger\n  needs manual attention")
    expect(stdoutText(deps)).toContain("next: Run 'ouro vault unlock --agent slugger', then run 'ouro up' again.")
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
    expect(deps.promptInput).toHaveBeenCalledWith("Unlock it now? [y/N] ")
    expect(stdoutText(deps)).toContain("run:   ouro vault unlock --agent slugger")
    expect(deps.runAuthFlow).not.toHaveBeenCalled()
  })

  it("prints a later vault unlock command when the user declines unlock repair", async () => {
    const deps = makeDeps({
      promptInput: vi.fn(async () => " no "),
    })
    const degraded: DegradedAgent[] = [
      {
        agent: "slugger",
        errorReason: "credential vault is locked",
        fixHint: "Run 'ouro vault unlock --agent slugger' if you have the saved secret. If nobody saved it, run 'ouro vault replace --agent slugger'. Then run 'ouro up' again.",
      },
    ]

    const result = await runInteractiveRepair(degraded, deps)

    expect(result).toEqual({ repairsAttempted: false })
    expect(stdoutText(deps)).toContain("Leaving slugger for later.")
    expect(stdoutText(deps)).toContain("next: ouro vault unlock --agent slugger")
    expect(stdoutText(deps)).toContain("or: ouro vault replace --agent slugger")
    expect(deps.runAuthFlow).not.toHaveBeenCalled()
  })

  it("deduplicates overlapping fallback commands in deferred repair guidance", async () => {
    const issue: AgentReadinessIssue = {
      kind: "vault-locked",
      severity: "blocked",
      actor: "human-required",
      summary: "slugger: vault locked",
      actions: [
        {
          kind: "vault-unlock",
          label: "Unlock with saved secret",
          command: "ouro vault unlock --agent slugger",
          actor: "human-required",
        },
        {
          kind: "vault-replace",
          label: "Create empty replacement vault",
          command: "ouro vault replace --agent slugger",
          actor: "human-required",
        },
      ],
    }
    const deps = makeDeps({
      promptInput: vi.fn(async () => "n"),
    })
    const degraded: DegradedAgent[] = [
      {
        agent: "slugger",
        errorReason: "vault locked",
        fixHint: "Run 'ouro vault unlock --agent slugger'. If nobody saved it, run 'ouro vault replace --agent slugger'.",
        issue,
      },
    ]

    const result = await runInteractiveRepair(degraded, deps)

    expect(result).toEqual({ repairsAttempted: false })
    expect(stdoutText(deps)).toContain("next: ouro vault unlock --agent slugger")
    expect(stdoutText(deps)).toContain("or: ouro vault replace --agent slugger")
    expect(stdoutText(deps)).not.toContain("or: ouro vault unlock --agent slugger")
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
    expect(deps.promptInput).toHaveBeenCalledWith("Open the auth flow now? [y/N] ")
    expect(stdoutText(deps)).toContain("run:   ouro auth --agent slugger")
    expect(deps.runAuthFlow).not.toHaveBeenCalled()
  })

  it("shows fix hint and offers retry for config errors with actionable fixHint", async () => {
    const deps = makeDeps({
      promptInput: vi.fn(async () => "n"),
    })
    const degraded: DegradedAgent[] = [
      { agent: "slugger", errorReason: "config parse error", fixHint: "check the agent vault runtime/config item for malformed fields" },
    ]
    const result = await runInteractiveRepair(degraded, deps)
    expect(result).toEqual({ repairsAttempted: false })
    // Should display the fix hint
    expect(deps.writeStdout).toHaveBeenCalledWith(
      expect.stringContaining("check the agent vault runtime/config item"),
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

  it("prints a grouped repair queue before prompting for multiple runnable repairs", async () => {
    const deps = makeDeps({
      promptInput: vi.fn(async () => "n"),
    })
    const degraded: DegradedAgent[] = [
      {
        agent: "ouroboros",
        errorReason: "credential vault is locked",
        fixHint: "Run 'ouro vault unlock --agent ouroboros', then run 'ouro up' again.",
      },
      {
        agent: "slugger",
        errorReason: "provider credentials failed",
        fixHint: "Run 'ouro auth --agent slugger --provider openai-codex' to refresh credentials.",
      },
    ]

    const result = await runInteractiveRepair(degraded, deps)

    expect(result).toEqual({ repairsAttempted: false })
    expect(deps.writeStdout).toHaveBeenNthCalledWith(
      1,
      [
        "Repair queue",
        "2 agents need attention before startup can finish.",
        "",
        "ouroboros - vault unlock",
        "  ouro vault unlock --agent ouroboros",
        "",
        "slugger - provider auth",
        "  ouro auth --agent slugger --provider openai-codex",
      ].join("\n"),
    )
    expect(deps.promptInput).toHaveBeenCalledWith("Unlock it now? [y/N] ")
    expect(deps.promptInput).toHaveBeenCalledWith("Open the auth flow now? [y/N] ")
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

  describe("recheckAgent callback", () => {
    it("calls recheckAgent after a successful vault unlock repair", async () => {
      const recheckAgent = vi.fn(async () => null)
      const deps = makeDeps({
        promptInput: vi.fn(async () => "y"),
        runVaultUnlock: vi.fn(async () => undefined),
        recheckAgent,
      })
      const degraded: DegradedAgent[] = [
        {
          agent: "slugger",
          errorReason: "credential vault is locked",
          fixHint: "Run 'ouro vault unlock --agent slugger'.",
        },
      ]

      await runInteractiveRepair(degraded, deps)

      expect(recheckAgent).toHaveBeenCalledWith("slugger")
    })

    it("calls recheckAgent after a successful auth flow repair", async () => {
      const recheckAgent = vi.fn(async () => null)
      const deps = makeDeps({
        promptInput: vi.fn(async () => "y"),
        recheckAgent,
      })
      const degraded: DegradedAgent[] = [
        {
          agent: "slugger",
          errorReason: "missing credentials",
          fixHint: "ouro auth --agent slugger --provider openai-codex",
        },
      ]

      await runInteractiveRepair(degraded, deps)

      expect(recheckAgent).toHaveBeenCalledWith("slugger")
    })

    it("prints recovered message and skips remaining actions when recheckAgent returns null", async () => {
      const recheckAgent = vi.fn(async () => null)
      const deps = makeDeps({
        promptInput: vi.fn(async () => "y"),
        runVaultUnlock: vi.fn(async () => undefined),
        recheckAgent,
      })
      const degraded: DegradedAgent[] = [
        {
          agent: "ouroboros",
          errorReason: "credential vault is locked",
          fixHint: "Run 'ouro vault unlock --agent ouroboros'.",
        },
      ]

      await runInteractiveRepair(degraded, deps)

      expect(stdoutText(deps)).toContain("ouroboros recovered.")
    })

    it("presents new error when recheckAgent returns a different DegradedAgent", async () => {
      const newDegraded: DegradedAgent = {
        agent: "slugger",
        errorReason: "provider credentials expired",
        fixHint: "ouro auth --agent slugger --provider anthropic",
      }
      let callCount = 0
      const recheckAgent = vi.fn(async () => {
        callCount++
        // First recheck returns a new degraded state, second returns null
        return callCount === 1 ? newDegraded : null
      })
      const deps = makeDeps({
        promptInput: vi.fn(async () => "y"),
        runVaultUnlock: vi.fn(async () => undefined),
        recheckAgent,
      })
      const degraded: DegradedAgent[] = [
        {
          agent: "slugger",
          errorReason: "credential vault is locked",
          fixHint: "Run 'ouro vault unlock --agent slugger'.",
        },
      ]

      await runInteractiveRepair(degraded, deps)

      // After vault unlock, recheckAgent returns a new error, so the auth flow prompt should appear
      expect(recheckAgent).toHaveBeenCalledWith("slugger")
      expect(stdoutText(deps)).toContain("provider auth")
      expect(stdoutText(deps)).toContain("ouro auth --agent slugger --provider anthropic")
    })

    it("does not call recheckAgent when repair action is declined", async () => {
      const recheckAgent = vi.fn(async () => null)
      const deps = makeDeps({
        promptInput: vi.fn(async () => "n"),
        runVaultUnlock: vi.fn(async () => undefined),
        recheckAgent,
      })
      const degraded: DegradedAgent[] = [
        {
          agent: "slugger",
          errorReason: "credential vault is locked",
          fixHint: "Run 'ouro vault unlock --agent slugger'.",
        },
      ]

      await runInteractiveRepair(degraded, deps)

      expect(recheckAgent).not.toHaveBeenCalled()
    })

    it("does not call recheckAgent when repair action throws an error", async () => {
      const recheckAgent = vi.fn(async () => null)
      const deps = makeDeps({
        promptInput: vi.fn(async () => "y"),
        runVaultUnlock: vi.fn(async () => {
          throw new Error("unlock failed")
        }),
        recheckAgent,
      })
      const degraded: DegradedAgent[] = [
        {
          agent: "slugger",
          errorReason: "credential vault is locked",
          fixHint: "Run 'ouro vault unlock --agent slugger'.",
        },
      ]

      await runInteractiveRepair(degraded, deps)

      expect(recheckAgent).not.toHaveBeenCalled()
    })

    it("works without recheckAgent (backward compat)", async () => {
      const deps = makeDeps({
        promptInput: vi.fn(async () => "y"),
        runVaultUnlock: vi.fn(async () => undefined),
      })
      const degraded: DegradedAgent[] = [
        {
          agent: "slugger",
          errorReason: "credential vault is locked",
          fixHint: "Run 'ouro vault unlock --agent slugger'.",
        },
      ]

      const result = await runInteractiveRepair(degraded, deps)

      expect(result).toEqual({ repairsAttempted: true })
      // No crash, no recovered message
      expect(stdoutText(deps)).not.toContain("recovered")
    })
  })
})
