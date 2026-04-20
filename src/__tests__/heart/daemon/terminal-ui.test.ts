import { beforeEach, describe, expect, it, vi } from "vitest"
import * as nervesRuntime from "../../../nerves/runtime"
import {
  padAnsi,
  renderOuroMasthead,
  renderTerminalOperation,
  renderTerminalBoard,
  formatActionActorLabel,
  wrapPlain,
} from "../../../heart/daemon/terminal-ui"

describe("terminal ui", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  function emitTestEvent(testName: string): void {
    nervesRuntime.emitNervesEvent({
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
      subtitle: "Built for people and agents.",
    })

    expect(output).toContain("OUROBOROS")
    expect(output).toContain("Built for people and agents.")
    expect(output).not.toContain("\x1b[")
  })

  it("renders the wide masthead as a correctly spelled classic wordmark", () => {
    emitTestEvent("terminal ui classic masthead")

    const output = renderOuroMasthead({
      isTTY: false,
      columns: 80,
    })

    expect(output.trim()).toBe("OUROBOROS")
    expect(output).not.toContain("OUROROBOR")
    expect(output).not.toContain(".----------------------------.")
  })

  it("renders a framed board with sections, wrapped copy, and actor-labelled actions", () => {
    emitTestEvent("terminal ui board rendering")

    const output = renderTerminalBoard({
      isTTY: true,
      columns: 74,
      masthead: {
        subtitle: "Set up connections one step at a time.",
      },
      title: "slugger connections",
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

    expect(output).toContain("___    _   _")
    expect(output).toContain("slugger connections")
    expect(output).toContain("Bring one capability online at a time without turning the")
    expect(output).toContain("into a wall of text.")
    expect(output).toContain("Unlock slugger's vault")
    expect(output).toContain("[human required]")
    expect(output).toContain("[recommended]")
    expect(output).toContain("Choose [1-2]: ")
    expect(output).toContain("╭")
  })

  it("renders a shared operation deck with a live step, completed steps, and queued path", () => {
    emitTestEvent("terminal ui operation deck rendering")

    const output = renderTerminalOperation({
      isTTY: true,
      columns: 76,
      masthead: {
        subtitle: "Starting the local agent runtime.",
      },
      title: "Starting Ouro",
      summary: "Ouro is starting the background runtime, checking credentials, and surfacing anything that needs attention before chat begins.",
      currentStep: {
        label: "provider checks",
        detailLines: [
          "slugger: checking openai-codex",
          "ouroboros: waiting for vault unlock",
        ],
      },
      steps: [
        { label: "update check", status: "done", detail: "up to date" },
        { label: "system setup", status: "done" },
        { label: "provider checks", status: "active" },
        { label: "vault unlock", status: "failed", detail: "still locked" },
        { label: "daemon handshake", status: "pending" },
      ],
    })

    expect(output).toContain("Starting Ouro")
    expect(output).toContain("Right now")
    expect(output).toContain("Progress")
    expect(output).toContain("slugger: checking openai-codex")
    expect(output).toContain("vault unlock")
    expect(output).toContain("daemon handshake")
    expect(output).toContain("╭")
  })

  it("renders operation fallbacks when nothing is active yet", () => {
    emitTestEvent("terminal ui operation fallbacks")

    const output = renderTerminalOperation({
      isTTY: false,
      title: "Waiting on Ouro",
    })

    expect(output).toContain("Waiting on Ouro")
    expect(output).toContain("Standing by.")
    expect(output).toContain("No active steps yet.")
    expect(output).not.toContain("\x1b[")
  })

  it("renders an operation step even when the current step has no detail lines", () => {
    emitTestEvent("terminal ui operation current step without detail")

    const output = renderTerminalOperation({
      isTTY: false,
      title: "Still moving",
      currentStep: {
        label: "provider checks",
      },
      steps: [
        { label: "provider checks", status: "active" },
      ],
    })

    expect(output).toContain("provider checks")
    expect(output).toContain("→ provider checks")
    expect(output).not.toContain("\x1b[")
  })

  it("treats an explicitly empty step list as no active steps yet", () => {
    emitTestEvent("terminal ui operation explicit empty steps")

    const output = renderTerminalOperation({
      isTTY: false,
      title: "Quiet check",
      steps: [],
    })

    expect(output).toContain("Quiet check")
    expect(output).toContain("No active steps yet.")
  })

  it("keeps non-TTY boards free of ANSI escapes", () => {
    emitTestEvent("terminal ui plain board rendering")

    const output = renderTerminalBoard({
      isTTY: false,
      title: "Ouro home",
      summary: "Pick an agent or system action without memorizing commands.",
      sections: [
        {
          title: "Available agents",
          lines: ["1. Talk to slugger"],
        },
      ],
      actions: [
        {
          label: "Start or check Ouro",
          actor: "agent-runnable",
          command: "ouro up",
          recommended: true,
        },
      ],
      prompt: "Choose [1-2]: ",
    })

    expect(output).toContain("Ouro home")
    expect(output).toContain("Start or check Ouro")
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

    expect(masthead.trim()).toBe("OUROBOROS")
    expect(board).toContain("Quick check")
    expect(board).not.toContain("Actions")
  })

  it("renders tty subtitles, blank section lines, and action lists without losing structure", () => {
    emitTestEvent("terminal ui tty subtitle and actions")

    const masthead = renderOuroMasthead({
      isTTY: true,
      columns: 80,
      subtitle: "Choose an agent or a setup task.",
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

    expect(masthead).toContain("Choose an agent or a setup task.")
    expect(masthead).toContain("\x1b[")
    expect(board).toContain("Quiet corner")
    expect(board).toContain("1. Warm up the room")
    expect(board).toContain("ouro up")
    expect(board).toContain("\x1b[")
  })

  it("can suppress board render events when progress rendering already owns the screen", () => {
    emitTestEvent("terminal ui suppress event")
    const spy = vi.spyOn(nervesRuntime, "emitNervesEvent")

    renderTerminalBoard({
      isTTY: false,
      title: "Quiet render",
      suppressEvent: true,
    })

    expect(spy).not.toHaveBeenCalledWith(expect.objectContaining({
      event: "daemon.terminal_board_rendered",
    }))
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
