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
})
