import { describe, expect, it, vi } from "vitest"

import {
  genericReadinessIssue,
  isKnownReadinessIssue,
  preferredConnectRepairAction,
  providerCredentialMissingIssue,
  providerLiveCheckFix,
  providerLiveCheckFailedIssue,
  renderReadinessIssue,
  renderReadinessIssueNextSteps,
  runGuidedReadinessRepair,
  vaultLockedIssue,
  vaultUnconfiguredIssue,
  type AgentReadinessReport,
} from "../../../heart/daemon/readiness-repair"

describe("readiness repair guidance", () => {
  it("builds a vault-locked issue with explicit human choices", () => {
    const issue = vaultLockedIssue("slugger")

    expect(issue).toMatchObject({
      kind: "vault-locked",
      severity: "blocked",
      actor: "human-required",
      summary: "slugger: vault locked",
    })
    expect(issue.actions.map((action) => action.kind)).toEqual([
      "vault-unlock",
      "vault-replace",
      "vault-recover",
    ])
    expect(issue.actions[0]).toMatchObject({
      label: "Unlock with saved secret",
      command: "ouro vault unlock --agent slugger",
      actor: "human-required",
    })
    expect(issue.actions[1]).toMatchObject({
      label: "Create empty replacement vault",
      command: "ouro vault replace --agent slugger",
      actor: "human-required",
    })
    expect(issue.actions[2]).toMatchObject({
      label: "Recover from JSON export",
      command: "ouro vault recover --agent slugger --from <json>",
      actor: "human-required",
    })
  })

  it("builds a vault-unconfigured issue with create-first guidance", () => {
    const issue = vaultUnconfiguredIssue("slugger")

    expect(issue).toMatchObject({
      kind: "vault-unconfigured",
      severity: "blocked",
      actor: "human-required",
      summary: "slugger: vault not configured",
    })
    expect(issue.actions.map((action) => action.kind)).toEqual([
      "vault-create",
      "vault-recover",
    ])
    expect(issue.actions[0]).toMatchObject({
      label: "Create this agent's vault",
      command: "ouro vault create --agent slugger",
      actor: "human-required",
    })
  })

  it("runs the selected typed repair action and keeps commands visible", async () => {
    const issue = vaultLockedIssue("slugger")
    const report: AgentReadinessReport = {
      agent: "slugger",
      ok: false,
      issues: [issue],
    }
    const promptInput = vi.fn(async () => "2")
    const writeStdout = vi.fn()
    const runRepairAction = vi.fn(async () => undefined)

    const result = await runGuidedReadinessRepair([report], {
      promptInput,
      writeStdout,
      runRepairAction,
    })

    expect(result.repairsAttempted).toBe(true)
    expect(runRepairAction).toHaveBeenCalledWith(
      "slugger",
      issue.actions[1],
      issue,
    )
    const output = writeStdout.mock.calls.map((call) => call[0]).join("\n")
    expect(output).toContain("slugger: vault locked")
    expect(output).toContain("1. Unlock with saved secret")
    expect(output).toContain("   ouro vault unlock --agent slugger")
    expect(output).toContain("2. Create empty replacement vault")
    expect(output).toContain("   ouro vault replace --agent slugger")
    expect(promptInput).toHaveBeenCalledWith("Choose [1-4]: ")
  })

  it("does not ask for AI when a known provider credential issue is declined", async () => {
    const issue = providerCredentialMissingIssue({
      agentName: "slugger",
      lane: "inner",
      provider: "openai-codex",
      model: "gpt-5.4",
      credentialPath: "vault:slugger:providers/*",
    })
    const report: AgentReadinessReport = {
      agent: "slugger",
      ok: false,
      issues: [issue],
    }
    const promptInput = vi.fn(async () => "4")
    const writeStdout = vi.fn()
    const runRepairAction = vi.fn(async () => undefined)

    const result = await runGuidedReadinessRepair([report], {
      promptInput,
      writeStdout,
      runRepairAction,
    })

    expect(result.repairsAttempted).toBe(false)
    expect(runRepairAction).not.toHaveBeenCalled()
    const output = writeStdout.mock.calls.map((call) => call[0]).join("\n")
    expect(output).toContain("slugger: missing openai-codex credentials (inner, gpt-5.4)")
    expect(output).toContain("   ouro auth --agent slugger --provider openai-codex")
    expect(output).not.toContain("AI-assisted diagnosis")
  })

  it("reports repair action errors without hiding the attempted repair", async () => {
    const issue = vaultLockedIssue("slugger")
    const report: AgentReadinessReport = {
      agent: "slugger",
      ok: false,
      issues: [issue],
    }
    const promptInput = vi.fn(async () => "1")
    const writeStdout = vi.fn()
    const runRepairAction = vi.fn(async () => {
      throw new Error("unlock failed")
    })

    const result = await runGuidedReadinessRepair([report], {
      promptInput,
      writeStdout,
      runRepairAction,
    })

    expect(result.repairsAttempted).toBe(true)
    const output = writeStdout.mock.calls.map((call) => call[0]).join("\n")
    expect(output).toContain("repair error for slugger: unlock failed")
  })

  it("reports non-Error repair action failures", async () => {
    const issue = vaultLockedIssue("slugger")
    const report: AgentReadinessReport = {
      agent: "slugger",
      ok: false,
      issues: [issue],
    }
    const writeStdout = vi.fn()

    const result = await runGuidedReadinessRepair([report], {
      promptInput: vi.fn(async () => "1"),
      writeStdout,
      runRepairAction: vi.fn(async () => {
        throw "unlock failed"
      }),
    })

    expect(result.repairsAttempted).toBe(true)
    expect(writeStdout.mock.calls.map((call) => call[0]).join("\n")).toContain(
      "repair error for slugger: unlock failed",
    )
  })

  it("builds provider live-check and generic issues without losing actor context", () => {
    const liveCheck = providerLiveCheckFailedIssue({
      agentName: "slugger",
      lane: "outward",
      provider: "minimax",
      model: "MiniMax-M2.5",
      classification: "server-error",
      message: "HTTP 500",
    })
    const genericWithFix = genericReadinessIssue({
      summary: "something odd happened",
      detail: "daemon log says no",
      fix: "ouro doctor",
    })
    const genericWithoutFix = genericReadinessIssue({
      summary: "something else happened",
    })

    expect(liveCheck).toMatchObject({
      kind: "provider-live-check-failed",
      actor: "human-choice",
      detail: "HTTP 500",
    })
    expect(liveCheck.actions.map((action) => action.kind)).toEqual(["provider-retry", "provider-use"])
    expect(liveCheck.actions[0]).toMatchObject({
      label: "Check again in a moment",
      command: "ouro repair --agent slugger",
      executable: false,
    })
    expect(genericWithFix.actions).toEqual([{
      kind: "provider-use",
      label: "Follow the printed fix",
      command: "ouro doctor",
      actor: "human-choice",
      executable: false,
    }])
    expect(genericWithoutFix.actions).toEqual([])
    expect(isKnownReadinessIssue(liveCheck)).toBe(true)
    expect(isKnownReadinessIssue(genericWithFix)).toBe(false)
    expect(isKnownReadinessIssue(undefined)).toBe(false)
    expect(renderReadinessIssue(genericWithoutFix)).toContain("1. Skip for now")
  })

  it("includes non-vault detail lines in next-step summaries", () => {
    const issue = providerCredentialMissingIssue({
      agentName: "slugger",
      lane: "outward",
      provider: "anthropic",
      model: "claude-opus-4-6",
      credentialPath: "vault:slugger:providers/*",
    })

    expect(renderReadinessIssueNextSteps(issue)).toContain("  source: vault:slugger:providers/*")
  })

  it("writes classification-aware fixes for retryable, quota, and unknown live-check failures", () => {
    expect(providerLiveCheckFix({
      agentName: "slugger",
      lane: "inner",
      provider: "minimax",
      classification: "server-error",
    })).toBe(
      "Run 'ouro up' again in a moment. If minimax keeps failing, run 'ouro use --agent slugger --lane inner --provider <provider> --model <model>' to choose another provider/model for this lane.",
    )

    expect(providerLiveCheckFix({
      agentName: "slugger",
      lane: "inner",
      provider: "minimax",
      classification: "rate-limit",
    })).toBe(
      "Run 'ouro up' again after a short wait. Or run 'ouro use --agent slugger --lane inner --provider <provider> --model <model>' to choose another provider/model for this lane.",
    )

    expect(providerLiveCheckFix({
      agentName: "slugger",
      lane: "inner",
      provider: "minimax",
      classification: "network-error",
    })).toBe(
      "Check the network or provider availability, then run 'ouro up' again. Or run 'ouro use --agent slugger --lane inner --provider <provider> --model <model>' to choose another provider/model for this lane.",
    )

    expect(providerLiveCheckFix({
      agentName: "slugger",
      lane: "inner",
      provider: "minimax",
      classification: "provider-error",
    })).toBe(
      "Run 'ouro up' again. If it keeps failing, run 'ouro auth --agent slugger --provider minimax' to refresh credentials or 'ouro use --agent slugger --lane inner --provider <provider> --model <model>' to choose another provider/model for this lane.",
    )
  })

  it("orders connect-friendly actions for busy, network, and unknown live-check failures", () => {
    const serverErrorIssue = providerLiveCheckFailedIssue({
      agentName: "slugger",
      lane: "inner",
      provider: "minimax",
      model: "MiniMax-M2.5",
      classification: "server-error",
      message: "HTTP 529 busy",
    })
    const networkIssue = providerLiveCheckFailedIssue({
      agentName: "slugger",
      lane: "inner",
      provider: "minimax",
      model: "MiniMax-M2.5",
      classification: "network-error",
      message: "fetch failed",
    })
    const unknownIssue = providerLiveCheckFailedIssue({
      agentName: "slugger",
      lane: "inner",
      provider: "minimax",
      model: "MiniMax-M2.5",
      classification: "provider-error",
      message: "weird failure",
    })

    expect(serverErrorIssue.actions.map((action) => action.kind)).toEqual(["provider-retry", "provider-use"])
    expect(providerLiveCheckFailedIssue({
      agentName: "slugger",
      lane: "inner",
      provider: "minimax",
      model: "MiniMax-M2.5",
      classification: "rate-limit",
      message: "429 try later",
    }).actions.map((action) => action.kind)).toEqual(["provider-retry", "provider-use"])
    expect(networkIssue.actions.map((action) => action.kind)).toEqual(["provider-retry", "provider-use", "provider-auth"])
    expect(unknownIssue.actions.map((action) => action.kind)).toEqual(["provider-retry", "provider-auth", "provider-use"])
    expect(preferredConnectRepairAction(serverErrorIssue)?.command).toBe(
      "ouro use --agent slugger --lane inner --provider <provider> --model <model>",
    )
    expect(preferredConnectRepairAction(unknownIssue)?.command).toBe(
      "ouro auth --agent slugger --provider minimax",
    )
  })

  it("falls back to the retry action when a live-check issue has nothing else to offer connect", () => {
    const retryOnlyIssue: AgentReadinessIssue = {
      kind: "provider-live-check-failed",
      severity: "blocked",
      actor: "human-choice",
      summary: "slugger: inner provider minimax / MiniMax-M2.5 failed live check",
      detail: "busy",
      actions: [{
        kind: "provider-retry",
        label: "Check again in a moment",
        command: "ouro repair --agent slugger",
        actor: "human-choice",
        executable: false,
      }],
    }

    expect(preferredConnectRepairAction(retryOnlyIssue)?.command).toBe("ouro repair --agent slugger")
  })

  it("handles ready reports, manual mode, invalid choices, manual actions, and missing runners", async () => {
    const readyReport: AgentReadinessReport = { agent: "ready", ok: true, issues: [vaultLockedIssue("ready")] }
    const emptyReport: AgentReadinessReport = { agent: "empty", ok: false, issues: [] }
    const manualIssue = providerCredentialMissingIssue({
      agentName: "slugger",
      lane: "inner",
      provider: "anthropic",
      model: "claude-opus-4-6",
      credentialPath: "vault:slugger:providers/*",
    })

    const noPromptOutput = vi.fn()
    const noPromptResult = await runGuidedReadinessRepair([
      readyReport,
      emptyReport,
      { agent: "slugger", ok: false, issues: [manualIssue] },
    ], {
      writeStdout: noPromptOutput,
    })
    expect(noPromptResult.repairsAttempted).toBe(false)
    expect(noPromptOutput.mock.calls.map((call) => call[0]).join("\n")).toContain(
      "manual repair required for slugger",
    )

    const invalidOutput = vi.fn()
    const invalidPromptInput = vi.fn()
      .mockResolvedValueOnce("banana")
      .mockResolvedValueOnce("99")
    const invalidResult = await runGuidedReadinessRepair([
      { agent: "slugger", ok: false, issues: [manualIssue, manualIssue] },
    ], {
      promptInput: invalidPromptInput,
      writeStdout: invalidOutput,
      runRepairAction: vi.fn(async () => undefined),
    })
    expect(invalidResult.repairsAttempted).toBe(false)
    expect(invalidOutput.mock.calls.map((call) => call[0]).join("\n")).toContain(
      "invalid choice for slugger; no repair attempted.",
    )

    const manualOutput = vi.fn()
    const manualResult = await runGuidedReadinessRepair([
      { agent: "slugger", ok: false, issues: [manualIssue] },
    ], {
      promptInput: vi.fn(async () => "2"),
      writeStdout: manualOutput,
      runRepairAction: vi.fn(async () => undefined),
    })
    expect(manualResult.repairsAttempted).toBe(false)
    expect(manualOutput.mock.calls.map((call) => call[0]).join("\n")).toContain(
      "manual step for slugger: ouro use --agent slugger --lane inner --provider <provider> --model <model>",
    )

    const noRunnerOutput = vi.fn()
    const noRunnerResult = await runGuidedReadinessRepair([
      { agent: "slugger", ok: false, issues: [manualIssue] },
    ], {
      promptInput: vi.fn(async () => "1"),
      writeStdout: noRunnerOutput,
    })
    expect(noRunnerResult.repairsAttempted).toBe(false)
    expect(noRunnerOutput.mock.calls.map((call) => call[0]).join("\n")).toContain(
      "repair runner unavailable for slugger; run `ouro auth --agent slugger --provider anthropic` manually.",
    )
  })
})
