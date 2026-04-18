import { describe, expect, it } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"
import {
  buildHumanReadinessSnapshot,
  readinessItemFromIssue,
} from "../../../heart/daemon/human-readiness"
import {
  providerCredentialMissingIssue,
  providerLiveCheckFailedIssue,
  vaultLockedIssue,
} from "../../../heart/daemon/readiness-repair"

describe("human readiness", () => {
  function emitTestEvent(testName: string): void {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.test_run",
      message: testName,
      meta: { test: true },
    })
  }

  it("promotes the most blocking action to the top and keeps next steps deduped", () => {
    emitTestEvent("human readiness primary action ranking")

    const snapshot = buildHumanReadinessSnapshot({
      agent: "slugger",
      title: "Provider health",
      items: [
        readinessItemFromIssue(vaultLockedIssue("slugger"), {
          key: "providers-vault",
          title: "Providers",
        }),
        readinessItemFromIssue(providerCredentialMissingIssue({
          agentName: "slugger",
          lane: "outward",
          provider: "openai-codex",
          model: "gpt-5.4",
          credentialPath: "vault:slugger:providers/*",
        }), {
          key: "providers-outward",
          title: "Outward lane",
        }),
        readinessItemFromIssue(providerLiveCheckFailedIssue({
          agentName: "slugger",
          lane: "inner",
          provider: "minimax",
          model: "MiniMax-M2.5",
          message: "400 status code (no body)",
        }), {
          key: "providers-inner",
          title: "Inner lane",
        }),
      ],
    })

    expect(snapshot.status).toBe("locked")
    expect(snapshot.primaryAction).toMatchObject({
      command: "ouro vault unlock --agent slugger",
      actor: "human-required",
    })
    expect(snapshot.nextActions.map((action) => action.command)).toEqual([
      "ouro vault unlock --agent slugger",
      "ouro vault replace --agent slugger",
      "ouro vault recover --agent slugger --from <json>",
      "ouro auth --agent slugger --provider openai-codex",
      "ouro use --agent slugger --lane outward --provider <provider> --model <model>",
      "ouro auth --agent slugger --provider minimax",
      "ouro use --agent slugger --lane inner --provider <provider> --model <model>",
    ])
  })

  it("stays calm when everything is ready", () => {
    emitTestEvent("human readiness ready state")

    const snapshot = buildHumanReadinessSnapshot({
      agent: "slugger",
      title: "Portable capabilities",
      items: [
        {
          key: "perplexity",
          title: "Perplexity search",
          status: "ready",
          summary: "Portable web search via Perplexity.",
          detailLines: [
            "Stored in slugger's runtime vault config.",
          ],
          actions: [],
        },
        {
          key: "embeddings",
          title: "Memory embeddings",
          status: "ready",
          summary: "Memory retrieval and note search.",
          detailLines: [
            "Portable embeddings key is present.",
          ],
          actions: [],
        },
      ],
    })

    expect(snapshot.status).toBe("ready")
    expect(snapshot.primaryAction).toBeUndefined()
    expect(snapshot.summary).toContain("Everything needed here is ready.")
  })
})
