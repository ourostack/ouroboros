import { describe, expect, it, vi } from "vitest"

import {
  providerCredentialMissingIssue,
  runGuidedReadinessRepair,
  vaultLockedIssue,
  type AgentReadinessReport,
} from "../../../heart/daemon/readiness-repair"

describe("readiness repair guidance", () => {
  it("builds a vault-locked issue with explicit human choices", () => {
    const issue = vaultLockedIssue("slugger")

    expect(issue).toMatchObject({
      kind: "vault-locked",
      severity: "blocked",
      actor: "human-required",
      summary: "slugger needs its vault unlocked on this machine.",
    })
    expect(issue.actions.map((action) => action.kind)).toEqual([
      "vault-unlock",
      "vault-replace",
      "vault-recover",
    ])
    expect(issue.actions[0]).toMatchObject({
      label: "I have the saved vault unlock secret",
      command: "ouro vault unlock --agent slugger",
      actor: "human-required",
    })
    expect(issue.actions[1]).toMatchObject({
      label: "Nobody saved it; create an empty vault and re-enter credentials",
      command: "ouro vault replace --agent slugger",
      actor: "human-required",
    })
    expect(issue.actions[2]).toMatchObject({
      label: "I have an old JSON credential export",
      command: "ouro vault recover --agent slugger --from <json>",
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
    expect(output).toContain("slugger needs its vault unlocked on this machine.")
    expect(output).toContain("1. I have the saved vault unlock secret")
    expect(output).toContain("runs: ouro vault unlock --agent slugger")
    expect(output).toContain("2. Nobody saved it; create an empty vault and re-enter credentials")
    expect(output).toContain("runs: ouro vault replace --agent slugger")
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
    expect(output).toContain("slugger is missing openai-codex credentials for the inner lane.")
    expect(output).toContain("runs: ouro auth --agent slugger --provider openai-codex")
    expect(output).not.toContain("AI-assisted diagnosis")
  })
})
