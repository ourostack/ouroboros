import { describe, expect, it } from "vitest"
import { inspectCodingPrompt } from "../../../senses/shepherd/prompt-state"
import { SCREENS } from "./fixtures"

// Synthetic renderings, not private terminal transcripts.
const copilot = (input = "┃  ", footer = " Interactive · Allow All · / commands · ? help · worker · Claude Opus 5.5") =>
  ["● Synthetic task returned.", "╭" + "▄".repeat(30), input, "╹" + "▀".repeat(30), footer].join("\n")
const codex = (input = "› ", footer = "  ? for shortcuts · 100% context left") =>
  ["• Synthetic result.", "", input, "", footer].join("\n")

describe("known rendered coding composers", () => {
  it.each(["Copilot", "copilot"])("recognizes %s regardless of footer model identity and ignores a timer-only badge", agent => {
    expect(inspectCodingPrompt(agent, copilot())).toEqual({ activity: "idle", composer: "empty" })
    expect(inspectCodingPrompt(agent, copilot("┃  ", " Interactive · / commands · 1 scheduled"))).toEqual({ activity: "idle", composer: "empty" })
  })
  it("recognizes supported Claude and Codex empty composers", () => {
    expect(inspectCodingPrompt("Claude Code", SCREENS.claudePremature)).toEqual({ activity: "idle", composer: "empty" })
    expect(inspectCodingPrompt("claude", SCREENS.claudePremature)).toEqual({ activity: "idle", composer: "empty" })
    expect(inspectCodingPrompt("Codex", codex())).toEqual({ activity: "idle", composer: "empty" })
  })
  it("preserves multiline and whitespace-separated draft truth and strips ANSI only for classification", () => {
    for (const screen of [copilot("┃  first\n┃  second"), copilot("┃ \n┃    unfinished"), copilot("┃ \u001b[31mtext\u001b[0m")]) {
      expect(inspectCodingPrompt("Copilot", screen).composer).toBe("draft")
    }
    expect(inspectCodingPrompt("claude", SCREENS.claudePremature.replace("│ >", "│ > draft")).composer).toBe("draft")
    expect(inspectCodingPrompt("codex", codex("› first\n  second")).composer).toBe("draft")
    expect(inspectCodingPrompt("Copilot", `\u001b[32m${copilot()}\u001b[0m`).composer).toBe("empty")
  })
  it("active footers and real background work outrank an empty input and scheduled badge", () => {
    expect(inspectCodingPrompt("Copilot", copilot("┃ ", " Working · esc interrupt · 1 scheduled")).activity).toBe("working")
    expect(inspectCodingPrompt("claude", SCREENS.claudeBackground).activity).toBe("working")
    expect(inspectCodingPrompt("codex", codex("› ", "  1 background terminal running · ? for shortcuts")).activity).toBe("working")
    expect(inspectCodingPrompt("copilot", copilot("┃ ", " Interactive · / commands · 1 running · 1 scheduled")).activity).toBe("working")
  })
  it.each([
    ["unknown", copilot()], ["Claude Code", copilot()], ["Copilot", SCREENS.shell],
    ["Copilot", SCREENS.agencyDone], ["Copilot", copilot().replace("╹" + "▀".repeat(30), "")],
    ["Copilot", copilot("┃ Enter a prompt")], ["Copilot", copilot("┃ ", " mystery footer")],
    ["codex", SCREENS.codexMenu], ["codex", codex("› 1. Yes")],
    ["claude", SCREENS.claudePremature.replace("╭──────────────────────────────────────────────────────────────╮", "")],
    ["claude", SCREENS.claudePremature.replace("│ >", "│ > [placeholder]")],
    ["Copilot", copilot() + "\n  Press enter to confirm or esc to cancel"],
    ["Copilot", copilot("plain text without an input boundary")],
    ["claude", SCREENS.claudePremature.replace("│ >", "│ not a prompt")],
    ["claude", SCREENS.claudePremature.replace("│ >                                                            │", "│ >\nnot a boxed continuation")],
    ["claude", SCREENS.claudePremature.replace("  ⏵⏵ bypass permissions on (shift+tab to cycle)", "  unknown footer")],
    ["codex", codex() + "\n unexplained content below footer"],
    ["codex", "› "],
    ["Copilot", copilot().replace("╹" + "▀".repeat(30), "╹" + "▀".repeat(12))],
    ["claude", SCREENS.claudePremature.replace(/╰─+╯/, "╰────────╯")],
  ])("refuses unknown, clipped or menu layouts (%s)", (agent, screen) => {
    const state = inspectCodingPrompt(agent, screen)
    expect(state.activity === "idle" && state.composer === "empty").toBe(false)
  })
  it("retains boxed Claude multiline drafts rather than trimming them to an empty first row", () => {
    const screen = SCREENS.claudePremature.replace("│ >                                                            │", "│ >                                                            │\n│   pending second line                                         │")
    expect(inspectCodingPrompt("claude", screen)).toEqual({ activity: "idle", composer: "draft" })
  })
})
