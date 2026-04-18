import { describe, expect, it } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"
import {
  padAnsi,
  renderOuroMasthead,
  renderTerminalBoard,
  formatActionActorLabel,
  wrapPlain,
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

  it("keeps non-TTY boards free of ANSI escapes", () => {
    emitTestEvent("terminal ui plain board rendering")

    const output = renderTerminalBoard({
      isTTY: false,
      title: "Ouro home",
      summary: "Pick an agent or system action without memorizing commands.",
      sections: [
        {
          title: "Around the house",
          lines: ["1. Talk to slugger"],
        },
      ],
      actions: [
        {
          label: "Bring the system online",
          actor: "agent-runnable",
          command: "ouro up",
          recommended: true,
        },
      ],
      prompt: "Choose [1-2]: ",
    })

    expect(output).toContain("Ouro home")
    expect(output).toContain("Bring the system online")
    expect(output).not.toContain("\x1b[")
  })

  it("renders a compact fallback masthead and quiet board when optional sections are absent", () => {
    emitTestEvent("terminal ui compact fallback")

    const masthead = renderOuroMasthead({
      isTTY: false,
      columns: 60,
    })
    const board = renderTerminalBoard({
      isTTY: false,
      columns: 60,
      title: "Quick check",
    })

    expect(masthead).toContain("O U R O B O R O S")
    expect(board).toContain("Quick check")
    expect(board).not.toContain("Actions")
  })

  it("renders tty subtitles, blank section lines, and action lists without losing structure", () => {
    emitTestEvent("terminal ui tty subtitle and actions")

    const masthead = renderOuroMasthead({
      isTTY: true,
      columns: 80,
      subtitle: "Welcome home.",
    })
    const board = renderTerminalBoard({
      isTTY: true,
      columns: 68,
      title: "Signal check",
      sections: [
        {
          title: "Quiet corner",
          lines: [""],
        },
      ],
      actions: [
        {
          label: "Warm up the room",
          actor: "agent-runnable",
          command: "ouro up",
        },
      ],
    })

    expect(masthead).toContain("Welcome home.")
    expect(masthead).toContain("\x1b[")
    expect(board).toContain("Quiet corner")
    expect(board).toContain("1. Warm up the room")
    expect(board).toContain("ouro up")
    expect(board).toContain("\x1b[")
  })

  it("wraps plain text deterministically and pads ANSI-aware widths", () => {
    emitTestEvent("terminal ui wrapping helpers")

    expect(wrapPlain("   ", 20)).toEqual([""])
    expect(wrapPlain("carry on", 0)).toEqual(["carry on"])
    expect(wrapPlain("carry on steadily", 8)).toEqual(["carry on", "steadily"])
    expect(padAnsi("\x1b[32mok\x1b[0m", 4)).toBe("\x1b[32mok\x1b[0m  ")
  })

  it("formats actor labels in calm human language", () => {
    emitTestEvent("terminal ui actor labels")

    expect(formatActionActorLabel("agent-runnable")).toBe("agent runnable")
    expect(formatActionActorLabel("human-required")).toBe("human required")
    expect(formatActionActorLabel("human-choice")).toBe("human choice")
  })
})
