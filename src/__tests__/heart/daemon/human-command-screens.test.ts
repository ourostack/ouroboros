import { describe, expect, it } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"
import {
  buildOuroHomeActions,
  renderAgentPickerScreen,
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

  it("renders the home deck and agent picker in the shared wizard family", () => {
    emitTestEvent("human command screens render wizards")

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
    expect(home).toContain("Agents")
    expect(home).toContain("Talk to slugger")
    expect(home).toContain("Start with Talk to slugger.")
    expect(home).not.toContain("Overview")
    expect(picker).toContain("Repair an agent")
    expect(picker).toContain("Agents")
    expect(picker).toContain("1. slugger")
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
      prompt: "Choose [1-2]: ",
    })

    expect(output).toContain("Repair slugger")
    expect(output).toContain("locked")
    expect(output).toContain("What needs attention")
    expect(output).toContain("Ways forward")
    expect(output).toContain("Unlock slugger's vault")
    expect(output).toContain("Skip for now")
    expect(output).toContain("Choose [1-2]: ")
  })

  it("renders a calm ready-state readiness board without inventing action rows", () => {
    emitTestEvent("human command screens ready readiness board")

    const snapshot = buildHumanReadinessSnapshot({
      agent: "slugger",
      title: "Provider health",
      items: [],
    })

    const output = renderHumanReadinessBoard({
      agent: "slugger",
      title: "Provider health",
      subtitle: "Checked live just now.",
      snapshot,
      isTTY: false,
    })

    expect(output).toContain("Everything needed here is ready.")
    expect(output).toContain("You can keep going or leave this area alone.")
    expect(output).not.toContain("Ways forward")
  })

  it("renders attached readiness states as already usable when there is nothing to do", () => {
    emitTestEvent("human command screens attached readiness board")

    const output = renderHumanReadinessBoard({
      agent: "slugger",
      title: "BlueBubbles on this machine",
      subtitle: "Local attachment is already present.",
      snapshot: {
        agent: "slugger",
        title: "BlueBubbles on this machine",
        status: "attached",
        summary: "Everything needed here is ready.",
        items: [],
        nextActions: [],
      },
      isTTY: false,
    })

    expect(output).toContain("Everything needed here is ready.")
    expect(output).toContain("You can keep going or leave this area alone.")
    expect(output).not.toContain("Ways forward")
  })

  it("does not invent a next step when a non-ready snapshot has no primary action", () => {
    emitTestEvent("human command screens no-primary non-ready board")

    const output = renderHumanReadinessBoard({
      agent: "slugger",
      title: "Perplexity search",
      subtitle: "Still needs setup.",
      snapshot: {
        agent: "slugger",
        title: "Perplexity search",
        status: "needs setup",
        summary: "This capability still needs setup.",
        items: [],
        nextActions: [],
      },
      isTTY: false,
    })

    expect(output).toContain("Perplexity search")
    expect(output).toContain("This capability still needs setup.")
    expect(output).not.toContain("Recommended next step")
    expect(output).not.toContain("Everything needed here is ready.")
  })
})
