/**
 * Screens and events Shepherd sees, modelled on real sessions of each coding agent in cmux
 * (0.64.22). Text is synthetic; the shapes (input boxes, footers, menus, the cmux event envelope)
 * follow what those agents and cmux draw.
 */
export const SCREENS = {
  /** Claude Code stops after a plan and asks whether to go on: premature. */
  claudePremature: [
    "⏺ I traced the failing test to the date parser. Here is the plan:",
    "  1. Accept ISO week dates in parseDate",
    "  2. Add the two fixtures from the bug report",
    "  3. Run the suite",
    "",
    "  Want me to go ahead and implement this?",
    "",
    "╭──────────────────────────────────────────────────────────────╮",
    "│ >                                                            │",
    "╰──────────────────────────────────────────────────────────────╯",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join("\n"),
  /** Codex asks for a choice in a selection menu: premature, answered with a key. */
  codexMenu: [
    "• I can fix the flaky retry test two ways.",
    "",
    "  Which should I do?",
    "› 1. Raise the timeout to 30s",
    "  2. Mock the clock (recommended)",
    "",
    "  Press enter to confirm or esc to cancel",
    "",
    "  ⏎ send   ⇧⏎ newline   ⌃T transcript   ⌃C quit",
  ].join("\n"),
  /** Copilot CLI needs the human to sign in: a gate. */
  copilotGate: [
    " ● The deploy needs a production token. I can't create one: it has to come from your Azure account.",
    "   Run `az login` in this terminal and tell me when you're done.",
    "",
    " ~/code/service [⎇ main]                                                     Session: 3.2 premium requests",
    "┃  ",
    " ← open sidebar · Interactive · / commands · ? help                                   GitHub Copilot • GPT-6.1",
  ].join("\n"),
  /** Agency (Copilot CLI host) finished and delivered with proof: done. */
  agencyDone: [
    " ● Finished. PR https://github.com/acme/app/pull/42 is merged; CI passed on the merge commit and the release",
    "   workflow published v1.4.2. Worktrees and branches are cleaned up.",
    "",
    " ~/personal-desk [⎇ main]                                                         Session: 12.47 AIC used",
    "┃  ",
    " ← open sidebar · Interactive · Allow All · / commands · ? help                  worker · Claude Opus 5.5",
    "Desk-Task: ouro-md/toolbar-polish",
  ].join("\n"),
  /** A plain shell: not a coding agent. */
  shell: ["$ npm test", "", " Test Files  12 passed (12)", "$ "].join("\n"),
}

export const BOOT = "8D4C65E6-1A99-4831-85E4-6B950EE7AB82"

/** One `agent.hook.<name>` frame as cmux 0.64.22 publishes it (live cmux names sessions `<agent>-<id>`). */
export function hookEvent(seq: number, hook: string, overrides: { source?: string; surface?: string | null; session?: string; phase?: string; cwd?: string } = {}): Record<string, unknown> {
  const source = overrides.source ?? "claude"
  const surface = overrides.surface === undefined ? "SF-1" : overrides.surface
  return {
    type: "event",
    protocol: "cmux-events",
    version: 1,
    boot_id: BOOT,
    seq,
    id: `${BOOT}-${seq}`,
    name: `agent.hook.${hook}`,
    category: "agent",
    source,
    workspace_id: "WS-1",
    surface_id: surface,
    payload: {
      _source: source,
      hook_event_name: hook,
      phase: overrides.phase ?? "received",
      session_id: overrides.session ?? `${source}-s1`,
      surface_id: surface,
      workspace_id: "WS-1",
      cwd: overrides.cwd ?? "/Users/a/code/app",
      tool_name: null,
    },
  }
}

export function surfaceEvent(seq: number, name: string, surface: string): Record<string, unknown> {
  return { type: "event", protocol: "cmux-events", version: 1, boot_id: BOOT, seq, name, category: "surface", source: "workspace.lifecycle", workspace_id: "WS-1", surface_id: surface, payload: { kind: "terminal", surface_id: surface } }
}

/** `system.tree` with the given terminal surfaces in one workspace. */
export function tree(surfaces: Array<{ id: string; ref: string; title?: string; type?: string }>): Record<string, unknown> {
  return {
    windows: [{
      id: "WIN-1",
      workspaces: [{ id: "WS-1", ref: "workspace:1", title: "app", selected: true, panes: [{ id: "P-1", surfaces: surfaces.map((surface) => ({ title: "", type: "terminal", ...surface })) }] }],
    }],
  }
}
