import { emitNervesEvent } from "../../nerves/runtime"
import {
  renderTerminalWizard,
  renderTerminalGuide,
  type TerminalAction,
  type TerminalSection,
  type TerminalWizardItem,
  type TerminalWizardSection,
} from "./terminal-ui"
import type { HumanReadinessSnapshot } from "./human-readiness"

export type HomeScreenActionKind = "chat" | "up" | "connect" | "repair" | "help" | "hatch" | "clone" | "exit"

export interface HomeScreenAction {
  key: string
  label: string
  kind: HomeScreenActionKind
  command: string
  agent?: string
}

interface HomeScreenOptions {
  agents: string[]
  isTTY: boolean
  columns?: number
}

interface AgentPickerOptions {
  title: string
  subtitle: string
  agents: string[]
  isTTY: boolean
  columns?: number
}

interface HumanReadinessBoardOptions {
  agent: string
  title: string
  subtitle: string
  snapshot: HumanReadinessSnapshot
  isTTY: boolean
  columns?: number
  prompt?: string
}

export interface HumanCommandBoardOptions {
  title: string
  subtitle: string
  summary: string
  isTTY: boolean
  columns?: number
  sections?: TerminalSection[]
  actions?: TerminalAction[]
  prompt?: string
}

function renderScreenEvent(screen: string): void {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.human_screen_rendered",
    message: "rendered human command screen",
    meta: { screen },
  })
}

function homeActionSummary(action: HomeScreenAction): string {
  switch (action.kind) {
    case "chat":
      return `Open chat with ${action.agent}.`
    case "up":
      return "Start the local runtime and check what still needs attention."
    case "connect":
      return "Set up providers, portable tools, and machine-specific attachments."
    case "repair":
      return "Walk through repairs for anything blocking startup or chat."
    case "help":
      return "Show the command guide."
    case "hatch":
      return "Create a new agent on this machine."
    case "clone":
      return "Bring an existing bundle onto this machine."
    case "exit":
      return "Leave the prompt."
  }
}

function actionToWizardItem(action: HomeScreenAction): TerminalWizardItem {
  return {
    key: action.key,
    label: action.label,
    summary: homeActionSummary(action),
    ...(action.key === "1" ? { recommended: true } : {}),
  }
}

export function buildOuroHomeActions(agents: string[]): HomeScreenAction[] {
  if (agents.length === 0) {
    return [
      { key: "1", label: "Create a new agent", kind: "hatch", command: "ouro hatch" },
      { key: "2", label: "Clone an existing bundle", kind: "clone", command: "ouro clone <remote>" },
      { key: "3", label: "Show help", kind: "help", command: "ouro --help" },
      { key: "4", label: "Exit", kind: "exit", command: "exit" },
    ]
  }

  const actions = agents.map((agent, index) => ({
    key: String(index + 1),
    label: `Talk to ${agent}`,
    kind: "chat" as const,
    command: `ouro chat ${agent}`,
    agent,
  }))

  return [
    ...actions,
    { key: String(actions.length + 1), label: "Start or check Ouro", kind: "up", command: "ouro up" },
    { key: String(actions.length + 2), label: "Set up connections", kind: "connect", command: "ouro connect --agent <agent>" },
    { key: String(actions.length + 3), label: "Fix setup issues", kind: "repair", command: "ouro repair --agent <agent>" },
    { key: String(actions.length + 4), label: "Show help", kind: "help", command: "ouro --help" },
    { key: String(actions.length + 5), label: "Exit", kind: "exit", command: "exit" },
  ]
}

export function resolveOuroHomeAction(answer: string, actions: HomeScreenAction[]): HomeScreenAction | undefined {
  const normalized = answer.trim().toLowerCase()
  if (!normalized) return undefined
  const byKey = actions.find((action) => action.key === normalized)
  if (byKey) return byKey
  const byAgent = actions.find((action) => action.agent?.toLowerCase() === normalized)
  if (byAgent) return byAgent
  return actions.find((action) => action.kind === normalized || action.label.toLowerCase() === normalized)
}

export function renderOuroHomeScreen(options: HomeScreenOptions): string {
  renderScreenEvent("home")
  const actions = buildOuroHomeActions(options.agents)
  const chatActions = actions.filter((action) => action.kind === "chat")
  const setupActions = actions.filter((action) => action.kind !== "chat")
  const sections: TerminalWizardSection[] = options.agents.length === 0
    ? [
        {
          title: "Start here",
          summary: "There are no agents on this machine yet.",
          items: setupActions.map((action) => actionToWizardItem(action)),
        },
      ]
    : [
        {
          title: "Agents",
          summary: "Jump straight into conversation or pick a setup path below.",
          items: chatActions.map((action) => actionToWizardItem(action)),
        },
        {
          title: "System",
          items: setupActions.map((action) => actionToWizardItem(action)),
        },
      ]

  return renderTerminalWizard({
    isTTY: options.isTTY,
    columns: options.columns,
    masthead: {
      subtitle: options.agents.length === 0
        ? "No agents are set up on this machine yet."
        : "Choose an agent or a setup task.",
    },
    title: "Ouro home",
    summary: options.agents.length === 0
      ? "Create a new agent or clone an existing bundle to get started."
      : "Choose an agent or a setup task without memorizing commands.",
    sections,
    nextStep: {
      label: options.agents.length === 0 ? "Start by creating or cloning an agent." : `Start with ${actions[0]!.label}.`,
      detail: options.agents.length === 0
        ? "Once one agent bundle exists here, the rest of the command surface becomes interactive."
        : "You can always type the number or the agent name instead of remembering a command.",
    },
    prompt: `Choose [1-${actions.length}] or type a name: `,
  })
}

export function renderAgentPickerScreen(options: AgentPickerOptions): string {
  renderScreenEvent("agent-picker")
  return renderTerminalWizard({
    isTTY: options.isTTY,
    columns: options.columns,
    masthead: {
      subtitle: options.subtitle,
    },
    title: options.title,
    summary: "Type the number or name that matches the agent you want.",
    sections: [
      {
        title: "Agents",
        items: options.agents.map((agent, index) => ({
          key: String(index + 1),
          label: agent,
          summary: "Available on this machine.",
          ...(index === 0 ? { recommended: true } : {}),
        })),
      },
    ],
    prompt: `Choose [1-${options.agents.length}] or type a name: `,
  })
}

export function resolveNamedAgentSelection(answer: string, agents: string[]): string | undefined {
  const normalized = answer.trim().toLowerCase()
  if (!normalized) return undefined
  const numbered = Number.parseInt(normalized, 10)
  if (Number.isFinite(numbered)) return agents[numbered - 1]
  return agents.find((agent) => agent.toLowerCase() === normalized)
}

export function renderHumanReadinessBoard(options: HumanReadinessBoardOptions): string {
  renderScreenEvent("readiness")
  const issueItems: TerminalWizardItem[] = options.snapshot.items.map((item) => ({
    label: item.title,
    status: item.status,
    summary: item.summary,
    detailLines: item.detailLines,
  }))
  const actionItems: TerminalWizardItem[] = options.snapshot.nextActions.map((action, index) => ({
    key: String(index + 1),
    label: action.label,
    actor: action.actor,
    command: action.command,
    ...(action.recommended ? { recommended: true } : {}),
  }))
  if (options.prompt) {
    actionItems.push({
      key: String(actionItems.length + 1),
      label: "Skip for now",
    })
  }

  return renderTerminalWizard({
    isTTY: options.isTTY,
    columns: options.columns,
    masthead: {
      subtitle: options.subtitle,
    },
    title: options.title,
    summary: options.snapshot.summary,
    nextStep: options.snapshot.primaryAction
      ? {
          label: options.snapshot.primaryAction.label,
          detail: options.snapshot.summary,
          command: options.snapshot.primaryAction.command,
        }
      : options.snapshot.status === "ready" || options.snapshot.status === "attached"
        ? {
            label: "Everything needed here is ready.",
            detail: "You can keep going or leave this area alone.",
          }
        : undefined,
    sections: [
      {
        title: "What needs attention",
        items: issueItems,
      },
      ...(actionItems.length > 0
        ? [{
            title: "Ways forward",
            items: actionItems,
          }]
        : []),
    ],
    prompt: options.prompt,
  })
}

export function renderHumanCommandBoard(options: HumanCommandBoardOptions): string {
  renderScreenEvent("command-board")
  return renderTerminalGuide({
    isTTY: options.isTTY,
    columns: options.columns,
    masthead: {
      subtitle: options.subtitle,
    },
    title: options.title,
    summary: options.summary,
    sections: options.sections,
    actions: options.actions,
    prompt: options.prompt,
  })
}
