import { describe, expect, it } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"
import {
  renderOuroMasthead,
  renderTerminalBoard,
  formatActionActorLabel,
} from "../../../heart/daemon/terminal-ui"

describe("terminal ui", () => {
  function emitTestEvent(testName: string): void {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.test_run",
      message: testName,
      meta: { test: true },
    })
  }

  it("renders an Ouroboros masthead that still reads clearly in plain text", () => {
    emitTestEvent("terminal ui plain masthead")

    const output = renderOuroMasthead({
      isTTY: false,
      subtitle: "A warm home for your agents.",
    })

    expect(output).toContain("OUROBOROS")
    expect(output).toContain("A warm home for your agents.")
    expect(output).not.toContain("\x1b[")
  })

  it("renders a framed board with sections, wrapped copy, and actor-labelled actions", () => {
    emitTestEvent("terminal ui board rendering")

    const output = renderTerminalBoard({
      isTTY: true,
      columns: 74,
      masthead: {
        subtitle: "Bring one capability online at a time.",
      },
      title: "slugger // connect bay",
      summary: "Bring one capability online at a time without turning the terminal into a wall of text.",
      sections: [
        {
          title: "Next move",
          lines: [
            "Slugger's provider lane is blocked because the vault is locked on this machine.",
          ],
        },
        {
          title: "Ready now",
          lines: [
            "Perplexity search is already connected and ready to use.",
          ],
        },
      ],
      actions: [
        {
          label: "Unlock slugger's vault",
          actor: "human-required",
          command: "ouro vault unlock --agent slugger",
          recommended: true,
        },
        {
          label: "Switch to another provider/model",
          actor: "human-choice",
          command: "ouro use --agent slugger --lane outward --provider <provider> --model <model>",
        },
      ],
      prompt: "Choose [1-2]: ",
    })

    expect(output).toContain("OUROBOROS")
    expect(output).toContain("slugger // connect bay")
    expect(output).toContain("Bring one capability online at a time without turning the")
    expect(output).toContain("into a wall of text.")
    expect(output).toContain("Unlock slugger's vault")
    expect(output).toContain("[human required]")
    expect(output).toContain("[recommended]")
    expect(output).toContain("Choose [1-2]: ")
    expect(output).toContain("╭")
  })

  it("formats actor labels in calm human language", () => {
    emitTestEvent("terminal ui actor labels")

    expect(formatActionActorLabel("agent-runnable")).toBe("agent runnable")
    expect(formatActionActorLabel("human-required")).toBe("human required")
    expect(formatActionActorLabel("human-choice")).toBe("human choice")
  })
})
