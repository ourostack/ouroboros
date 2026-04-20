import { describe, expect, it } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"
import {
  buildHumanReadinessSnapshot,
  readinessItemFromIssue,
} from "../../../heart/daemon/human-readiness"
import {
  genericReadinessIssue,
  providerCredentialMissingIssue,
  providerLiveCheckFailedIssue,
  vaultUnconfiguredIssue,
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
          classification: "auth-failure",
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
    expect(snapshot.items[2]?.status).toBe("needs credentials")
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

  it("maps generic and setup issues into human-readable items", () => {
    emitTestEvent("human readiness generic and setup mapping")

    const generic = readinessItemFromIssue(genericReadinessIssue({
      summary: "Provider check did not complete.",
      fix: "ouro auth verify --agent slugger",
    }), {
      key: "generic",
      title: "Provider core",
    })

    const needsSetup = buildHumanReadinessSnapshot({
      agent: "slugger",
      title: "Portable capabilities",
      items: [
        {
          key: "teams",
          title: "Teams",
          status: "needs setup",
          summary: "Microsoft Teams sense credentials.",
          detailLines: [],
          actions: [
            {
              label: "Connect Teams",
              command: "ouro connect teams --agent slugger",
              actor: "human-required",
            },
          ],
        },
      ],
    })

    expect(generic.status).toBe("needs attention")
    expect(generic.detailLines).toEqual([])
    expect(generic.actions[0]).toMatchObject({
      command: "ouro auth verify --agent slugger",
      executable: false,
    })
    expect(needsSetup.status).toBe("needs setup")
    expect(needsSetup.summary).toContain("needs setup before it can be used")
  })

  it("keeps provider live-check failures in needs-attention when the issue is not credential-specific", () => {
    emitTestEvent("human readiness live check needs attention")

    const item = readinessItemFromIssue(providerLiveCheckFailedIssue({
      agentName: "slugger",
      lane: "inner",
      provider: "minimax",
      model: "MiniMax-M2.5",
      classification: "server-error",
      message: "529 provider busy",
    }), {
      key: "providers-inner-busy",
      title: "Inner lane",
    })

    expect(item.status).toBe("needs attention")
  })

  it("maps vault setup and missing-credential issues into the right status copy", () => {
    emitTestEvent("human readiness vault setup and missing credentials mapping")

    const vaultSetup = readinessItemFromIssue(vaultUnconfiguredIssue("slugger"), {
      key: "vault-setup",
      title: "Credential vault",
    })
    const needsCredentials = buildHumanReadinessSnapshot({
      agent: "slugger",
      title: "Provider health",
      items: [
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
      ],
    })

    expect(vaultSetup.status).toBe("needs setup")
    expect(vaultSetup.actions[0]).toMatchObject({
      command: "ouro vault create --agent slugger",
      actor: "human-required",
    })
    expect(needsCredentials.status).toBe("needs credentials")
    expect(needsCredentials.summary).toContain("credential is missing")
  })

  it("dedupes repeated actions while keeping the first one recommended", () => {
    emitTestEvent("human readiness dedupe repeated actions")

    const snapshot = buildHumanReadinessSnapshot({
      agent: "slugger",
      title: "Repair slugger",
      items: [
        {
          key: "vault",
          title: "Credential vault",
          status: "locked",
          summary: "Vault is locked on this machine.",
          detailLines: [],
          actions: [
            {
              label: "Unlock slugger's vault",
              command: "ouro vault unlock --agent slugger",
              actor: "human-required",
            },
          ],
        },
        {
          key: "providers",
          title: "Providers",
          status: "needs attention",
          summary: "Provider checks are blocked until the vault opens.",
          detailLines: [],
          actions: [
            {
              label: "Unlock slugger's vault",
              command: "ouro vault unlock --agent slugger",
              actor: "human-required",
            },
            {
              label: "Refresh openai-codex",
              command: "ouro auth --agent slugger --provider openai-codex",
              actor: "human-required",
            },
          ],
        },
      ],
    })

    expect(snapshot.nextActions).toHaveLength(2)
    expect(snapshot.nextActions[0]).toMatchObject({
      command: "ouro vault unlock --agent slugger",
      recommended: true,
    })
    expect(snapshot.nextActions[1]).toMatchObject({
      command: "ouro auth --agent slugger --provider openai-codex",
    })
  })

  it("uses the fallback summary for nonblocking missing items and for empty snapshots", () => {
    emitTestEvent("human readiness fallback summaries")

    const empty = buildHumanReadinessSnapshot({
      agent: "slugger",
      title: "Nothing to repair",
      items: [],
    })
    const missing = buildHumanReadinessSnapshot({
      agent: "slugger",
      title: "Portable capabilities",
      items: [
        {
          key: "teams",
          title: "Teams",
          status: "missing",
          summary: "Microsoft Teams sense credentials.",
          detailLines: [],
          actions: [],
        },
      ],
    })

    expect(empty.status).toBe("ready")
    expect(empty.summary).toContain("Everything needed here is ready.")
    expect(missing.status).toBe("missing")
    expect(missing.summary).toContain("still needs a little attention")
  })
})
