import { describe, expect, it } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"
import {
  renderConnectBay,
  summarizeProvidersForConnect,
  type ConnectMenuEntry,
} from "../../../heart/daemon/connect-bay"
import {
  providerCredentialMissingIssue,
  providerLiveCheckFailedIssue,
  vaultLockedIssue,
  vaultUnconfiguredIssue,
} from "../../../heart/daemon/readiness-repair"
import type { AgentProviderVisibility, ProviderVisibilityLane } from "../../../heart/provider-visibility"

function emitTestEvent(testName: string): void {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.test_run",
    message: testName,
    meta: { test: true },
  })
}

function configuredLane(
  lane: "outward" | "inner",
  provider: string,
  model: string,
  overrides: Partial<ProviderVisibilityLane> = {},
): ProviderVisibilityLane {
  return {
    lane,
    status: "configured",
    provider,
    model,
    source: "local",
    readiness: { status: "ready" },
    credential: { status: "present", source: "vault", revision: `${provider}-rev-1` },
    warnings: [],
    ...overrides,
  } as ProviderVisibilityLane
}

function providerVisibility(lanes: ProviderVisibilityLane[]): AgentProviderVisibility {
  return {
    agentName: "Slugger",
    lanes,
  }
}

function connectEntries(overrides: Partial<Record<"provider" | "perplexity" | "embeddings" | "teams" | "bluebubbles", Partial<ConnectMenuEntry>>> = {}): ConnectMenuEntry[] {
  return [
    {
      option: "1",
      name: "Providers",
      section: "Providers",
      status: "ready",
      laneSummaries: [
        { lane: "outward", status: "ready", title: "anthropic / claude-opus-4-6", detail: "ready" },
        { lane: "inner", status: "ready", title: "minimax / MiniMax-M2.5", detail: "ready" },
      ],
      ...overrides.provider,
    },
    {
      option: "2",
      name: "Perplexity search",
      section: "Portable",
      status: "ready",
      description: "Web search via Perplexity.",
      ...overrides.perplexity,
    },
    {
      option: "3",
      name: "Memory embeddings",
      section: "Portable",
      status: "missing",
      description: "Memory retrieval and note search.",
      ...overrides.embeddings,
    },
    {
      option: "4",
      name: "Teams",
      section: "Portable",
      status: "missing",
      description: "Microsoft Teams sense credentials.",
      ...overrides.teams,
    },
    {
      option: "5",
      name: "BlueBubbles iMessage",
      section: "This machine",
      status: "not attached",
      description: "Local Mac Messages bridge.",
      ...overrides.bluebubbles,
    },
  ]
}

describe("connect bay", () => {
  it("wraps long capability detail lines inside the shared wizard surface", () => {
    emitTestEvent("connect bay wraps long capability detail lines")
    const longDetail = "Portable notes should wrap cleanly across the framed panel without turning into a jagged wall of text for the human staring at the terminal."
    const output = renderConnectBay(connectEntries({
      perplexity: {
        detailLines: [longDetail],
      },
    }), {
      agent: "Slugger",
      isTTY: true,
      columns: 72,
      prompt: "Choose [1-6] or type a name: ",
    })

    expect(output).toContain("Recommended next step")
    expect(output).toContain("Portable notes should wrap cleanly across the framed panel")
    expect(output).toContain("turning into a jagged wall of text for the human staring at the")
    expect(output).toContain("terminal.")
    expect(output).not.toContain("╭")
  })

  it("renders non-TTY detail lines without dropping them on the floor", () => {
    emitTestEvent("connect bay non-tty detail lines")
    const output = renderConnectBay(connectEntries({
      perplexity: {
        detailLines: ["Stored in the portable runtime vault item."],
      },
    }), {
      agent: "Slugger",
      isTTY: false,
      prompt: "Choose [1-6] or type a name: ",
    })

    expect(output).toContain("Stored in the portable runtime vault item.")
    expect(output).toContain("2. Perplexity search  ● ready")
    expect(output).toContain("OUROBOROS")
    expect(output).toContain("Connect Slugger")
  })

  it("handles whitespace-only wrapped detail lines without breaking the panel layout", () => {
    emitTestEvent("connect bay whitespace-only wrapped detail")
    const output = renderConnectBay(connectEntries({
      perplexity: {
        detailLines: [" ".repeat(120)],
      },
    }), {
      agent: "Slugger",
      isTTY: true,
      columns: 72,
      prompt: "Choose [1-6] or type a name: ",
    })

    expect(output).toContain("2. Perplexity search")
    expect(output).toContain("3. Memory embeddings")
  })

  it("keeps ready provider summaries quiet when no repair hint is needed", () => {
    emitTestEvent("connect bay healthy provider summary")
    const summary = summarizeProvidersForConnect("Slugger", providerVisibility([
      configuredLane("outward", "anthropic", "claude-opus-4-6"),
      configuredLane("inner", "minimax", "MiniMax-M2.5"),
    ]))

    expect(summary.status).toBe("ready")
    expect(summary.nextAction).toBeUndefined()
    expect(summary.nextNote).toBeUndefined()
  })

  it("trusts a fresh live provider check over stale lane readiness when connect just checked live", () => {
    emitTestEvent("connect bay live truth beats stale lane state")
    const summary = summarizeProvidersForConnect("Slugger", providerVisibility([
      configuredLane("outward", "openai-codex", "gpt-5.4", {
        readiness: { status: "failed", error: "400 status code (no body)" },
      }),
      configuredLane("inner", "minimax", "MiniMax-M2.5"),
    ]), { ok: true })

    expect(summary.status).toBe("ready")
    expect(summary.laneSummaries[0]).toMatchObject({
      lane: "outward",
      status: "ready",
      detail: "ready",
    })
    expect(summary.nextAction).toBeUndefined()
  })

  it("trusts a fresh live provider check over a stale missing-credential cache", () => {
    emitTestEvent("connect bay live truth beats stale credential cache")
    const summary = summarizeProvidersForConnect("Slugger", providerVisibility([
      configuredLane("outward", "github-copilot", "claude-sonnet-4.6", {
        credential: { status: "missing", repairCommand: "ouro auth --agent Slugger --provider github-copilot" },
      }),
    ]), { ok: true })

    expect(summary.status).toBe("ready")
    expect(summary.laneSummaries[0]).toMatchObject({
      lane: "outward",
      status: "ready",
      detail: "ready",
    })
    expect(summary.nextAction).toBeUndefined()
  })

  it("shows a fresh live-check failure instead of stale missing-credential guidance", () => {
    emitTestEvent("connect bay live failure beats stale credential cache")
    const summary = summarizeProvidersForConnect("Slugger", providerVisibility([
      configuredLane("outward", "github-copilot", "claude-sonnet-4.6", {
        credential: { status: "missing", repairCommand: "ouro auth --agent Slugger --provider github-copilot" },
      }),
      configuredLane("inner", "minimax", "MiniMax-M2.5"),
    ]), {
      ok: false,
      error: "outward provider github-copilot model claude-sonnet-4.6 failed live check: 400 status code (no body)",
      fix: "Run 'ouro auth --agent Slugger --provider github-copilot' to refresh credentials.",
      issue: providerLiveCheckFailedIssue({
        agentName: "Slugger",
        lane: "outward",
        provider: "github-copilot",
        model: "claude-sonnet-4.6",
        classification: "auth-failure",
        message: "400 status code (no body)",
      }),
    })

    expect(summary.status).toBe("needs attention")
    expect(summary.laneSummaries[0]).toMatchObject({
      lane: "outward",
      status: "needs attention",
      detail: "failed live check: 400 status code (no body)",
    })
    expect(summary.laneSummaries[1]).toMatchObject({
      lane: "inner",
      status: "ready",
      detail: "ready",
    })
    expect(summary.nextAction).toBe("ouro auth --agent Slugger --provider github-copilot")
  })

  it("shows the calm ready-state next move on TTY when nothing needs repair", () => {
    emitTestEvent("connect bay tty everything ready")
    const output = renderConnectBay(connectEntries({
      perplexity: { status: "ready" },
      embeddings: { status: "ready" },
      teams: { status: "ready" },
      bluebubbles: { status: "attached" },
    }), {
      agent: "Slugger",
      isTTY: true,
      columns: 72,
      prompt: "Choose [1-6] or type a name: ",
    })

    expect(output).toContain("Everything here is already connected.")
    expect(output).toContain("Pick any capability if you want to review it, refresh it, or")
    expect(output).toContain("its setup.")
  })

  it("renders provider-core fallback detail lines when lane summaries are absent", () => {
    emitTestEvent("connect bay provider core fallback details")
    const output = renderConnectBay(connectEntries({
      provider: {
        laneSummaries: undefined,
        detailLines: [
          "Outward lane: anthropic / claude-opus-4-6",
          "Inner lane: minimax / MiniMax-M2.5",
        ],
      },
    }), {
      agent: "Slugger",
      isTTY: true,
      columns: 72,
      prompt: "Choose [1-6] or type a name: ",
    })

    expect(output).toContain("Outward lane: anthropic / claude-opus-4-6")
    expect(output).toContain("Inner lane: minimax / MiniMax-M2.5")
  })

  it("keeps the provider core stable even when fallback detail lines are absent", () => {
    emitTestEvent("connect bay provider core empty fallback")
    const output = renderConnectBay(connectEntries({
      provider: {
        laneSummaries: undefined,
        detailLines: undefined,
      },
    }), {
      agent: "Slugger",
      isTTY: true,
      columns: 72,
      prompt: "Choose [1-6] or type a name: ",
    })

    expect(output).toContain("1. Providers")
    expect(output).not.toContain("undefined")
  })

  it("renders problem lane detail without dimming it in the provider core", () => {
    emitTestEvent("connect bay provider problem lane detail")
    const output = renderConnectBay(connectEntries({
      provider: {
        status: "needs attention",
        laneSummaries: [
          { lane: "outward", status: "needs attention", title: "openai-codex / gpt-5.4", detail: "failed live check: bad token" },
          { lane: "inner", status: "ready", title: "minimax / MiniMax-M2.5", detail: "ready" },
        ],
      },
    }), {
      agent: "Slugger",
      isTTY: true,
      columns: 72,
      prompt: "Choose [1-6] or type a name: ",
    })

    expect(output).toContain("failed live check: bad")
    expect(output).toContain("token")
    expect(output).toContain("Inner lane")
  })

  it("falls back to an unknown-error label when a failed live check has no message", () => {
    emitTestEvent("connect bay failed lane unknown error fallback")
    const summary = summarizeProvidersForConnect("Slugger", providerVisibility([
      configuredLane("outward", "openai-codex", "gpt-5.4", {
        readiness: { status: "failed" },
      }),
      configuredLane("inner", "minimax", "MiniMax-M2.5"),
    ]))

    expect(summary.laneSummaries[0]).toMatchObject({
      detail: "failed live check: unknown error",
    })
  })

  it("pads wide columns cleanly when panel heights do not match", () => {
    emitTestEvent("connect bay wide layout pads uneven columns")
    const output = renderConnectBay(connectEntries({
      provider: {
        laneSummaries: undefined,
        detailLines: [
          "Outward lane: anthropic / claude-opus-4-6",
          "Inner lane: minimax / MiniMax-M2.5",
          "Repair hints stay grouped with the provider core.",
          "The provider core can be much taller than the portable side.",
          "That should still render a stable right column.",
        ],
      },
      bluebubbles: {
        status: "attached",
        detailLines: [
          "Mac mini bridge online.",
          "Last heartbeat: just now.",
          "Local messages relay is warm.",
        ],
      },
    }), {
      agent: "Slugger",
      isTTY: true,
      columns: 132,
      prompt: "Choose [1-6] or type a name: ",
    })

    expect(output).toContain("Providers")
    expect(output).toContain("This machine")
    expect(output).toContain("Mac mini bridge online.")
    expect(output).toContain("Repair hints stay grouped with the provider core.")
  })

  it("pads the right column when the left side runs much taller", () => {
    emitTestEvent("connect bay wide layout right padding")
    const output = renderConnectBay(connectEntries({
      provider: {
        laneSummaries: undefined,
        detailLines: [
          "Outward lane: anthropic / claude-opus-4-6",
          "Inner lane: minimax / MiniMax-M2.5",
          "Repair hints stay grouped with the provider core.",
          "The provider core can be much taller than the portable side.",
          "That should still render a stable right column.",
          "One more line keeps the left column taller.",
          "And one final line seals the deal.",
        ],
      },
      perplexity: { description: undefined, detailLines: undefined },
      embeddings: { description: undefined, detailLines: undefined },
      teams: { description: undefined, detailLines: undefined },
      bluebubbles: { description: undefined, detailLines: undefined },
    }), {
      agent: "Slugger",
      isTTY: true,
      columns: 132,
      prompt: "Choose [1-6] or type a name: ",
    })

    expect(output).toContain("And one final line seals the deal.")
    expect(output).toContain("Portable")
  })

  it("keeps capability rows stable even when a capability omits a description", () => {
    emitTestEvent("connect bay capability without description")
    const output = renderConnectBay(connectEntries({
      teams: {
        description: undefined,
      },
    }), {
      agent: "Slugger",
      isTTY: true,
      columns: 72,
      prompt: "Choose [1-6] or type a name: ",
    })

    expect(output).toContain("4. Teams")
    expect(output).not.toContain("undefined")
  })

  it("shows the next move note and command when a capability carries both", () => {
    emitTestEvent("connect bay next move note and command")
    const output = renderConnectBay(connectEntries({
      provider: {
        status: "locked",
        nextNote: "Unlock this agent's credential vault on this machine.",
        nextAction: "ouro vault unlock --agent Slugger",
      },
    }), {
      agent: "Slugger",
      isTTY: true,
      columns: 72,
      prompt: "Choose [1-6] or type a name: ",
    })

    expect(output).toContain("Unlock this agent's credential vault on this machine.")
    expect(output).toContain("ouro vault unlock --agent Slugger")
  })

  it("keeps capability-level next notes with the capability they belong to", () => {
    emitTestEvent("connect bay capability next note")
    const output = renderConnectBay(connectEntries({
      teams: {
        status: "needs attention",
        nextNote: "Sense is enabled, but this machine still needs the Teams runtime fields.",
      },
    }), {
      agent: "Slugger",
      isTTY: false,
      prompt: "Choose [1-6] or type a name: ",
    })

    expect(output).toContain("Sense is enabled, but this machine still needs the Teams runtime fields.")
  })

  it("extracts ouro use as the next move when provider setup is missing", () => {
    emitTestEvent("connect bay extracts ouro use repair command")
    const summary = summarizeProvidersForConnect(
      "Slugger",
      providerVisibility([
        configuredLane("outward", "anthropic", "claude-opus-4-6"),
        configuredLane("inner", "minimax", "MiniMax-M2.5"),
      ]),
      {
        ok: false,
        error: "missing provider binding for outward lane",
        fix: "Run 'ouro use --agent Slugger --lane outward --provider <provider> --model <model>' to configure this machine's provider binding.",
      },
    )

    expect(summary.status).toBe("needs setup")
    expect(summary.nextAction).toBe("ouro use --agent Slugger --lane outward --provider <provider> --model <model>")
  })

  it("extracts ouro auth when provider health only offers an auth repair", () => {
    emitTestEvent("connect bay extracts ouro auth repair command")
    const summary = summarizeProvidersForConnect(
      "Slugger",
      providerVisibility([
        configuredLane("outward", "openai-codex", "gpt-5.4", {
          credential: { status: "missing", repairCommand: "ouro auth --agent Slugger --provider openai-codex" },
        }),
        configuredLane("inner", "minimax", "MiniMax-M2.5"),
      ]),
      {
        ok: false,
        error: "provider auth is required",
        fix: "Run 'ouro auth --agent Slugger --provider openai-codex' to authenticate.",
      },
    )

    expect(summary.status).toBe("needs credentials")
    expect(summary.nextAction).toBe("ouro auth --agent Slugger --provider openai-codex")
  })

  it("derives connect status from structured readiness issues before falling back to string parsing", () => {
    emitTestEvent("connect bay derives status from readiness issues")
    const visibility = providerVisibility([
      configuredLane("outward", "openai-codex", "gpt-5.4"),
      configuredLane("inner", "minimax", "MiniMax-M2.5"),
    ])

    expect(summarizeProvidersForConnect("Slugger", visibility, {
      ok: false,
      issue: vaultUnconfiguredIssue("Slugger"),
    }).status).toBe("needs setup")

    expect(summarizeProvidersForConnect("Slugger", visibility, {
      ok: false,
      issue: vaultLockedIssue("Slugger"),
    }).status).toBe("locked")

    expect(summarizeProvidersForConnect("Slugger", visibility, {
      ok: false,
      issue: providerCredentialMissingIssue({
        agentName: "Slugger",
        lane: "outward",
        provider: "openai-codex",
        model: "gpt-5.4",
        credentialPath: "vault:Slugger:providers/*",
      }),
    }).status).toBe("needs credentials")

    expect(summarizeProvidersForConnect("Slugger", visibility, {
      ok: false,
      issue: providerLiveCheckFailedIssue({
        agentName: "Slugger",
        lane: "outward",
        provider: "openai-codex",
        model: "gpt-5.4",
        classification: "auth-failure",
        message: "401 invalid API key",
      }),
    }).status).toBe("needs attention")
  })

  it("extracts provider refresh when health guidance is generic attention work", () => {
    emitTestEvent("connect bay extracts provider refresh repair command")
    const summary = summarizeProvidersForConnect(
      "Slugger",
      providerVisibility([
        configuredLane("outward", "anthropic", "claude-opus-4-6"),
        configuredLane("inner", "minimax", "MiniMax-M2.5"),
      ]),
      {
        ok: false,
        error: "provider verification summary unavailable",
        fix: "Run 'ouro provider refresh --agent Slugger' to reload cached credentials.",
      },
    )

    expect(summary.status).toBe("needs attention")
    expect(summary.nextAction).toBe("ouro provider refresh --agent Slugger")
  })

  it("targets string-only live provider health at the inner lane when the error says inner provider", () => {
    emitTestEvent("connect bay string health targets inner lane")
    const summary = summarizeProvidersForConnect(
      "Slugger",
      providerVisibility([
        configuredLane("outward", "openai-codex", "gpt-5.4"),
        configuredLane("inner", "minimax", "MiniMax-M2.5", {
          credential: { status: "missing", repairCommand: "ouro auth --agent Slugger --provider minimax" },
        }),
      ]),
      {
        ok: false,
        error: "inner provider minimax model MiniMax-M2.5 failed live check: provider offline",
        fix: "Run 'ouro use --agent Slugger --lane inner --provider <provider> --model <model>' to choose another provider/model.",
      },
    )

    expect(summary.status).toBe("needs attention")
    expect(summary.laneSummaries[0]).toMatchObject({
      lane: "outward",
      status: "ready",
      detail: "ready",
    })
    expect(summary.laneSummaries[1]).toMatchObject({
      lane: "inner",
      status: "needs attention",
      detail: "inner provider minimax model MiniMax-M2.5 failed live check: provider offline",
    })
  })

  it("uses provider-health error text for setup guidance when there is no structured issue detail", () => {
    emitTestEvent("connect bay provider setup error fallback")
    const summary = summarizeProvidersForConnect(
      "Slugger",
      providerVisibility([
        configuredLane("outward", "openai-codex", "gpt-5.4"),
      ]),
      {
        ok: false,
        error: "missing provider binding for outward lane",
        fix: "Run 'ouro use --agent Slugger --lane outward --provider <provider> --model <model>' to configure this machine's provider binding.",
      },
    )

    expect(summary.status).toBe("needs setup")
    expect(summary.laneSummaries[0]).toMatchObject({
      status: "needs setup",
      detail: "missing provider binding for outward lane",
    })
  })

  it("uses calm fallback copy when setup or attention health lacks detail text", () => {
    emitTestEvent("connect bay provider health detail fallbacks")
    const visibility = providerVisibility([
      configuredLane("outward", "openai-codex", "gpt-5.4"),
    ])

    expect(summarizeProvidersForConnect("Slugger", visibility, {
      ok: false,
      fix: "Run 'ouro use --agent Slugger --lane outward --provider <provider> --model <model>' to configure this machine's provider binding.",
    }).laneSummaries[0]).toMatchObject({
      status: "needs setup",
      detail: "needs setup",
    })

    expect(summarizeProvidersForConnect("Slugger", visibility, {
      ok: false,
      fix: "Run 'ouro provider refresh --agent Slugger' to reload cached credentials.",
    }).laneSummaries[0]).toMatchObject({
      status: "needs attention",
      detail: "live check needs attention",
    })
  })

  it("falls back to provider-health error text when no structured issue is available", () => {
    emitTestEvent("connect bay falls back to provider health strings")
    const visibility = providerVisibility([
      configuredLane("outward", "openai-codex", "gpt-5.4"),
      configuredLane("inner", "minimax", "MiniMax-M2.5"),
    ])

    expect(summarizeProvidersForConnect("Slugger", visibility, {
      ok: false,
      error: "outward provider openai-codex model gpt-5.4 failed live check: bad token",
    }).status).toBe("needs attention")

    expect(summarizeProvidersForConnect("Slugger", visibility, {
      ok: false,
      error: "outward provider openai-codex model gpt-5.4 has no credentials in slugger's vault",
    }).status).toBe("needs credentials")

    expect(summarizeProvidersForConnect("Slugger", visibility, {
      ok: false,
      error: "outward provider openai-codex model gpt-5.4 cannot read provider credentials because slugger's credential vault is locked on this machine.",
    }).status).toBe("locked")
  })

  it("prefers switching providers over re-auth when the live check failed because the provider is busy", () => {
    emitTestEvent("connect bay prefers provider switch on provider outage")
    const summary = summarizeProvidersForConnect(
      "Slugger",
      providerVisibility([
        configuredLane("outward", "openai-codex", "gpt-5.4", {
          readiness: { status: "failed", error: "529 provider busy" },
        }),
        configuredLane("inner", "minimax", "MiniMax-M2.5"),
      ]),
      {
        ok: false,
        error: "outward provider openai-codex model gpt-5.4 failed live check: 529 provider busy",
        fix: "Run 'ouro up' again in a moment. If openai-codex keeps failing, run 'ouro use --agent Slugger --lane outward --provider <provider> --model <model>' to choose another provider/model for this lane.",
        issue: providerLiveCheckFailedIssue({
          agentName: "Slugger",
          lane: "outward",
          provider: "openai-codex",
          model: "gpt-5.4",
          classification: "server-error",
          message: "529 provider busy",
        }),
      },
    )

    expect(summary.status).toBe("needs attention")
    expect(summary.nextAction).toBe("ouro use --agent Slugger --lane outward --provider <provider> --model <model>")
    expect(summary.nextAction).not.toContain("ouro auth")
  })

  it("surfaces the next lane note when a specific lane is the blocker", () => {
    emitTestEvent("connect bay summarizes lane-specific blocker")
    const summary = summarizeProvidersForConnect("Slugger", providerVisibility([
      configuredLane("outward", "openai-codex", "gpt-5.4", {
        readiness: { status: "failed", error: "bad token" },
      }),
      configuredLane("inner", "minimax", "MiniMax-M2.5"),
    ]))

    expect(summary.status).toBe("needs attention")
    expect(summary.nextNote).toBe("Outward lane: failed live check: bad token")
  })

  it("uses the inner-lane label when the blocker is on the inner lane", () => {
    emitTestEvent("connect bay inner lane blocker note")
    const summary = summarizeProvidersForConnect("Slugger", providerVisibility([
      configuredLane("outward", "anthropic", "claude-opus-4-6"),
      configuredLane("inner", "minimax", "MiniMax-M2.5", {
        readiness: { status: "failed", error: "provider offline" },
      }),
    ]))

    expect(summary.status).toBe("needs attention")
    expect(summary.nextNote).toBe("Inner lane: failed live check: provider offline")
  })
})
