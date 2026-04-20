import { describe, expect, it } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"
import {
  buildOuroHomeActions,
  renderAgentPickerScreen,
  renderHouseStatusScreen,
  renderHumanReadinessBoard,
  renderOuroHomeScreen,
  resolveNamedAgentSelection,
  resolveOuroHomeAction,
} from "../../../heart/daemon/human-command-screens"
import { buildHumanReadinessSnapshot } from "../../../heart/daemon/human-readiness"

describe("human command screens", () => {
  function emitTestEvent(testName: string): void {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.test_run",
      message: testName,
      meta: { test: true },
    })
  }

  it("builds the no-agent home actions in onboarding order", () => {
    emitTestEvent("human command screens no-agent actions")

    expect(buildOuroHomeActions([])).toEqual([
      { key: "1", label: "Create a new agent", kind: "hatch", command: "ouro hatch" },
      { key: "2", label: "Clone an existing bundle", kind: "clone", command: "ouro clone <remote>" },
      { key: "3", label: "Show help", kind: "help", command: "ouro --help" },
      { key: "4", label: "Exit", kind: "exit", command: "exit" },
    ])
  })

  it("resolves home actions by key, agent, kind, and label", () => {
    emitTestEvent("human command screens action resolution")

    const actions = buildOuroHomeActions(["slugger", "ouroboros"])

    expect(resolveOuroHomeAction("2", actions)?.agent).toBe("ouroboros")
    expect(resolveOuroHomeAction("slugger", actions)?.kind).toBe("chat")
    expect(resolveOuroHomeAction("repair", actions)?.kind).toBe("repair")
    expect(resolveOuroHomeAction("Show help", actions)?.kind).toBe("help")
    expect(resolveOuroHomeAction("   ", actions)).toBeUndefined()
  })

  it("renders the home deck and agent picker in the shared board family", () => {
    emitTestEvent("human command screens render boards")

    const home = renderOuroHomeScreen({
      agents: ["slugger", "ouroboros"],
      isTTY: true,
      columns: 74,
    })
    const picker = renderAgentPickerScreen({
      title: "Repair an agent",
      subtitle: "Choose who needs attention.",
      agents: ["slugger", "ouroboros"],
      isTTY: false,
    })

    expect(home).toContain("___    _   _")
    expect(home).toContain("Ouro home")
    expect(home).toContain("Available agents")
    expect(home).toContain("Talk to slugger")
    expect(picker).toContain("Repair an agent")
    expect(picker).toContain("Choose [1-2] or type a name:")
    expect(picker).not.toContain("\x1b[")
  })

  it("resolves agent picker answers by number and exact name", () => {
    emitTestEvent("human command screens named selection")

    expect(resolveNamedAgentSelection("2", ["slugger", "ouroboros"])).toBe("ouroboros")
    expect(resolveNamedAgentSelection("slugger", ["slugger", "ouroboros"])).toBe("slugger")
    expect(resolveNamedAgentSelection("3", ["slugger", "ouroboros"])).toBeUndefined()
    expect(resolveNamedAgentSelection("   ", ["slugger", "ouroboros"])).toBeUndefined()
  })

  it("renders readiness boards from the shared snapshot model", () => {
    emitTestEvent("human command screens readiness board")

    const snapshot = buildHumanReadinessSnapshot({
      agent: "slugger",
      title: "Repair slugger",
      items: [
        {
          key: "vault",
          title: "Credential vault",
          status: "locked",
          summary: "Vault is locked on this machine.",
          detailLines: ["Unlock it, then continue."],
          actions: [
            {
              label: "Unlock slugger's vault",
              command: "ouro vault unlock --agent slugger",
              actor: "human-required",
            },
          ],
        },
      ],
    })

    const output = renderHumanReadinessBoard({
      agent: "slugger",
      title: "Repair slugger",
      subtitle: "Bring one thing back online.",
      snapshot,
      isTTY: true,
      columns: 72,
      prompt: "Choose [1-1]: ",
    })

    expect(output).toContain("Repair slugger")
    expect(output).toContain("locked")
    expect(output).toContain("Unlock slugger's vault")
    expect(output).toContain("Choose [1-1]: ")
  })

  it("renders house-status sections for senses and git-sync variants", () => {
    emitTestEvent("human command screens house status variants")

    const output = renderHouseStatusScreen({
      payload: {
        overview: {
          daemon: "running",
          health: "ok",
          socketPath: "/tmp/ouro.sock",
          outlookUrl: "http://127.0.0.1:4310/outlook",
          version: "0.1.0-alpha.432",
          lastUpdated: "2026-04-19T20:10:00.000Z",
          repoRoot: "/tmp/ouro",
          configFingerprint: "cfg",
          workerCount: 1,
          senseCount: 2,
          entryPath: "/tmp/ouro/dist/daemon-entry.js",
          mode: "production",
        },
        agents: [{ name: "slugger", enabled: true }, { name: "ouroboros", enabled: false }],
        providers: [
          {
            agent: "slugger",
            lane: "outward",
            provider: "openai-codex",
            model: "gpt-5.4",
            readiness: "ready",
            detail: "live check passed",
            source: "vault",
            credential: "oauth",
          },
          {
            agent: "slugger",
            lane: "inner",
            provider: "minimax",
            model: "MiniMax-M2.5",
            readiness: "",
            detail: "",
            source: "",
            credential: "",
          },
        ],
        senses: [
          {
            agent: "slugger",
            sense: "cli",
            label: "CLI",
            enabled: true,
            status: "interactive",
            detail: "local terminal",
          },
          {
            agent: "slugger",
            sense: "bluebubbles",
            enabled: false,
            status: "disabled",
            detail: "not attached here",
          },
          {
            agent: "slugger",
            sense: "teams",
            enabled: true,
            status: "running",
            detail: "",
          },
        ],
        workers: [
          {
            agent: "slugger",
            worker: "inner-dialog",
            status: "crashed",
            pid: 42,
            restartCount: 2,
            lastExitCode: 1,
            lastSignal: "SIGTERM",
            errorReason: "provider auth failed",
            fixHint: "run ouro auth",
          },
        ],
        sync: [
          { agent: "slugger", enabled: false, remote: "origin" },
          { agent: "ouroboros", enabled: true, remote: "origin", gitInitialized: false },
          { agent: "alpha", enabled: true, remote: "origin", gitInitialized: true, remoteUrl: "git@github.com:me/alpha.git" },
          { agent: "beta", enabled: true, remote: "origin", gitInitialized: true },
        ],
      },
      isTTY: false,
    })

    expect(output).toContain("Ouro status")
    expect(output).toContain("slugger outward — openai-codex / gpt-5.4 — ready; live check passed; vault; oauth")
    expect(output).toContain("slugger inner — minimax / MiniMax-M2.5")
    expect(output).toContain("CLI — interactive — local terminal")
    expect(output).toContain("bluebubbles — disabled — not attached here")
    expect(output).toContain("teams — running")
    expect(output).toContain("inner-dialog — crashed — pid 42; restarts: 2; exit=1; signal=SIGTERM; error: provider auth failed; fix: run ouro auth")
    expect(output).toContain("ouroboros — disabled")
    expect(output).toContain("slugger — disabled")
    expect(output).toContain("ouroboros — needs git init")
    expect(output).toContain("alpha — origin -> git@github.com:me/alpha.git")
    expect(output).toContain("beta — local only")
  })

  it("renders a minimal house-status screen without optional sections", () => {
    emitTestEvent("human command screens minimal house status")

    const output = renderHouseStatusScreen({
      payload: {
        overview: {
          daemon: "sleeping",
          health: "warn",
          socketPath: "/tmp/ouro.sock",
          outlookUrl: "unavailable",
          version: "0.1.0-alpha.432",
          lastUpdated: "2026-04-19T20:10:00.000Z",
          repoRoot: "/tmp/ouro",
          configFingerprint: "cfg",
          workerCount: 0,
          senseCount: 0,
          entryPath: "/tmp/ouro/dist/daemon-entry.js",
          mode: "production",
        },
        agents: [],
        providers: [],
        senses: [],
        workers: [],
        sync: [],
      },
      isTTY: false,
    })

    expect(output).toContain("Runtime")
    expect(output).not.toContain("Agents")
    expect(output).not.toContain("Providers")
    expect(output).not.toContain("Senses")
    expect(output).not.toContain("Workers")
    expect(output).not.toContain("Git sync")
  })
})
