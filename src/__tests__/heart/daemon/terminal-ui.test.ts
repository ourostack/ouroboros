import { beforeEach, describe, expect, it, vi } from "vitest"
import * as nervesRuntime from "../../../nerves/runtime"
import {
  padAnsi,
  renderOuroMasthead,
  renderOverwriteFrame,
  renderTerminalOperation,
  renderTerminalBoard,
  renderTerminalGuide,
  renderTerminalWizard,
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

  it("renders the tty masthead without adding an implied subtitle", () => {
    emitTestEvent("terminal ui tty masthead without subtitle")

    const output = renderOuroMasthead({
      isTTY: true,
      columns: 80,
    })

    expect(output).toContain("___    _   _")
    expect(output).toContain("\x1b[")
    expect(output).not.toContain("Starting the local agent runtime.")
  })

  it("renders the compact tty masthead when the terminal is narrow", () => {
    emitTestEvent("terminal ui compact tty masthead")

    const output = renderOuroMasthead({
      isTTY: true,
      columns: 60,
    })

    expect(output).toContain("OUROBOROS")
    expect(output).toContain("\x1b[")
    expect(output).not.toContain("___    _   _")
  })

  it("falls back to the compact tty masthead when the wide art would overflow", () => {
    emitTestEvent("terminal ui masthead fit check")

    const output = renderOuroMasthead({
      isTTY: true,
      columns: 70,
    })

    expect(output).toContain("OUROBOROS")
    expect(output).not.toContain("___    _   _")
  })

  it("falls back to the default tty width when columns are unknown", () => {
    emitTestEvent("terminal ui default tty masthead width")

    const output = renderOuroMasthead({
      isTTY: true,
    })

    expect(output).toContain("___    _   _")
    expect(output).toContain("\x1b[")
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

  it("renders a shared guide for info-heavy command flows without falling back to card stacks", () => {
    emitTestEvent("terminal ui guide rendering")

    const output = renderTerminalGuide({
      isTTY: true,
      columns: 80,
      masthead: {
        subtitle: "Portable web search for slugger.",
      },
      title: "Connect Perplexity",
      summary: "Add one hidden API key, verify it live, and keep this capability portable with the agent.",
      sections: [
        {
          title: "What you need",
          lines: [
            "One Perplexity API key.",
            "Ouro keeps it hidden while you type.",
          ],
        },
      ],
      actions: [
        {
          label: "Paste the API key now",
          actor: "human-required",
          command: "promptSecret()",
          recommended: true,
        },
      ],
      prompt: "Press Enter to continue",
    })

    expect(output).toContain("Connect Perplexity")
    expect(output).toContain("What you need")
    expect(output).toContain("One Perplexity API key.")
    expect(output).toContain("Next moves")
    expect(output).toContain("[human required]")
    expect(output).toContain("Press Enter to continue")
    expect(output).not.toContain("╭")
  })

  it("renders plain guides cleanly when actions and prompts are shown without tty chrome", () => {
    emitTestEvent("terminal ui plain guide rendering")

    const output = renderTerminalGuide({
      isTTY: false,
      title: "Connect Perplexity",
      summary: "Add one API key and verify it before search goes live.",
      sections: [
        {
          title: "What you need",
          lines: [
            "A Perplexity API key.",
          ],
        },
      ],
      actions: [
        {
          label: "Paste the API key now",
          actor: "human-required",
          command: "promptSecret()",
        },
      ],
      prompt: "Press Enter to continue",
    })

    expect(output).toContain("Connect Perplexity")
    expect(output).toContain("What you need")
    expect(output).toContain("1. Paste the API key now [human required]")
    expect(output).toContain("run: promptSecret()")
    expect(output).toContain("Press Enter to continue")
    expect(output).not.toContain("\x1b[")
  })

  it("renders minimal shared surfaces without inventing missing sections or metadata", () => {
    emitTestEvent("terminal ui minimal shared surfaces")

    const wizard = renderTerminalWizard({
      isTTY: false,
      title: "Quick check",
      nextStep: {
        label: "Start here.",
      },
    })
    const guide = renderTerminalGuide({
      isTTY: false,
      title: "Connect later",
    })

    expect(wizard).toContain("Quick check")
    expect(wizard).toContain("Recommended next step")
    expect(wizard).toContain("Start here.")
    expect(wizard).not.toContain("run:")
    expect(guide).toContain("Connect later")
    expect(guide).not.toContain("Next moves")
  })

  it("renders a shared wizard with a next step and grouped choices", () => {
    emitTestEvent("terminal ui wizard rendering")

    const output = renderTerminalWizard({
      isTTY: true,
      columns: 80,
      masthead: {
        subtitle: "Set up connections one step at a time.",
      },
      title: "Connect slugger",
      summary: "Choose one thing to bring online. Providers were checked live just now, and local attachments reflect this machine.",
      nextStep: {
        label: "Providers need attention first.",
        detail: "The outward lane failed its live check, so auth or a lane switch is the next move.",
        command: "ouro auth --agent slugger --provider openai-codex",
      },
      sections: [
        {
          title: "Providers",
          items: [
            {
              key: "1",
              label: "Providers",
              status: "needs attention",
              summary: "Outward lane: openai-codex / gpt-5.4.",
              detailLines: ["Inner lane: minimax / MiniMax-M2.5 is ready."],
              command: "ouro auth --agent slugger --provider openai-codex",
            },
          ],
        },
        {
          title: "Portable",
          items: [
            {
              key: "2",
              label: "Perplexity search",
              status: "ready",
              summary: "Portable web search via Perplexity.",
            },
            {
              key: "3",
              label: "Unlock slugger's vault",
              actor: "human-required",
              command: "ouro vault unlock --agent slugger",
              recommended: true,
            },
          ],
        },
      ],
      footerLines: ["Choose a number, or type the capability name."],
      prompt: "Choose [1-3]: ",
    })

    expect(output).toContain("Connect slugger")
    expect(output).toContain("Recommended next step")
    expect(output).toContain("Providers need attention first.")
    expect(output).toContain("run: ouro auth --agent slugger --provider openai-codex")
    expect(output).toContain("● ready")
    expect(output).toContain("◆ needs attention")
    expect(output).toContain("[human required]")
    expect(output).toContain("[recommended]")
    expect(output).toContain("Choose [1-3]: ")
    expect(output).not.toContain("Overview")
    expect(output).not.toContain("╭")
  })

  it("keeps non-TTY wizards plain and readable", () => {
    emitTestEvent("terminal ui plain wizard rendering")

    const output = renderTerminalWizard({
      isTTY: false,
      title: "Repair slugger",
      summary: "Pick the path that matches what the human actually has.",
      sections: [
        {
          title: "Ways forward",
          items: [
            {
              key: "1",
              label: "Unlock with saved secret",
              actor: "human-required",
              command: "ouro vault unlock --agent slugger",
            },
            {
              key: "2",
              label: "Skip for now",
            },
          ],
        },
      ],
      prompt: "Choose [1-2]: ",
    })

    expect(output).toContain("Repair slugger")
    expect(output).toContain("Ways forward")
    expect(output).toContain("Unlock with saved secret  [human required]")
    expect(output).toContain("run: ouro vault unlock --agent slugger")
    expect(output).not.toContain("\x1b[")
  })

  it("renders agent-runnable badges in the wizard without treating them like human-required warnings", () => {
    emitTestEvent("terminal ui wizard agent-runnable badge")

    const output = renderTerminalWizard({
      isTTY: true,
      title: "Quick action",
      sections: [
        {
          title: "Next move",
          items: [
            {
              key: "1",
              label: "Refresh local cache",
              actor: "agent-runnable",
              command: "ouro provider refresh --agent slugger",
            },
          ],
        },
      ],
    })

    expect(output).toContain("[agent runnable]")
    expect(output).toContain("ouro provider refresh --agent slugger")
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
    expect(output).toContain("Checklist")
    expect(output).toContain("Current work")
    expect(output).toContain("slugger: checking openai-codex")
    expect(output).toContain("vault unlock")
    expect(output).toContain("daemon handshake")
    expect(output).not.toContain("Overview")
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

  it("renders operation prompts in both tty and plain modes", () => {
    emitTestEvent("terminal ui operation prompt rendering")

    const ttyOutput = renderTerminalOperation({
      isTTY: true,
      title: "Starting Ouro",
      prompt: "Press Enter to continue",
    })
    const plainOutput = renderTerminalOperation({
      isTTY: false,
      title: "Starting Ouro",
      prompt: "Press Enter to continue",
    })

    expect(ttyOutput).toContain("Press Enter to continue")
    expect(ttyOutput).toContain("\x1b[")
    expect(plainOutput).toContain("Press Enter to continue")
    expect(plainOutput).not.toContain("\x1b[")
  })

  it("renders plain operation summaries and step markers for every status", () => {
    emitTestEvent("terminal ui plain operation status rendering")

    const output = renderTerminalOperation({
      isTTY: false,
      columns: 64,
      title: "Starting Ouro",
      summary: "Check the local runtime, keep the checklist truthful, and surface the next thing a human should do.",
      steps: [
        { label: "update check", status: "done", detail: "up to date" },
        { label: "provider checks", status: "active" },
        { label: "vault unlock", status: "failed", detail: "still locked" },
        { label: "daemon handshake", status: "pending" },
      ],
    })

    expect(output).toContain("Check the local runtime, keep the checklist truthful, and")
    expect(output).toContain("surface the next thing a human should do.")
    expect(output).toContain("✓ update check — up to date")
    expect(output).toContain("→ provider checks")
    expect(output).toContain("✗ vault unlock — still locked")
    expect(output).toContain("○ daemon handshake")
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

  it("returns a plain overwrite frame when tty repaint is unavailable", () => {
    emitTestEvent("terminal ui plain overwrite frame")

    const output = renderOverwriteFrame(["one", "two"], 4, false)

    expect(output).toBe("one\ntwo\n")
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

  it("can suppress wizard render events when a parent surface already owns the screen", () => {
    emitTestEvent("terminal ui suppress wizard event")
    const spy = vi.spyOn(nervesRuntime, "emitNervesEvent")

    renderTerminalWizard({
      isTTY: false,
      title: "Quiet wizard",
      suppressEvent: true,
    })

    expect(spy).not.toHaveBeenCalledWith(expect.objectContaining({
      event: "daemon.terminal_wizard_rendered",
    }))
  })

  it("can suppress guide render events when a parent surface already owns the screen", () => {
    emitTestEvent("terminal ui suppress guide event")
    const spy = vi.spyOn(nervesRuntime, "emitNervesEvent")

    renderTerminalGuide({
      isTTY: false,
      title: "Quiet guide",
      suppressEvent: true,
    })

    expect(spy).not.toHaveBeenCalledWith(expect.objectContaining({
      event: "daemon.terminal_guide_rendered",
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

  it("moves back to the new frame bottom after clearing stale tty lines", () => {
    emitTestEvent("terminal ui shrinking overwrite frame")

    const output = renderOverwriteFrame([
      "Ouro boot checklist",
      "Doing now",
      "provider checks",
    ], 5, true)

    expect(output.startsWith("\x1b[5A")).toBe(true)
    expect((output.match(/\x1b\[2K/g) || [])).toHaveLength(5)
    expect(output.endsWith("\x1b[2A")).toBe(true)
  })
})
