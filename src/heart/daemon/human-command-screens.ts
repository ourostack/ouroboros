import { emitNervesEvent } from "../../nerves/runtime"
import {
  renderTerminalBoard,
  type TerminalAction,
  type TerminalSection,
} from "./terminal-ui"
import type { HumanReadinessSnapshot } from "./human-readiness"
import type { StatusPayload } from "./cli-render"

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

function renderScreenEvent(screen: string): void {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.human_screen_rendered",
    message: "rendered human command screen",
    meta: { screen },
  })
}

export function buildOuroHomeActions(agents: string[]): HomeScreenAction[] {
  if (agents.length === 0) {
    return [
      { key: "1", label: "Hatch a new agent", kind: "hatch", command: "ouro hatch" },
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
    { key: String(actions.length + 1), label: "Prepare the house", kind: "up", command: "ouro up" },
    { key: String(actions.length + 2), label: "Connect an agent", kind: "connect", command: "ouro connect --agent <agent>" },
    { key: String(actions.length + 3), label: "Repair an agent", kind: "repair", command: "ouro repair --agent <agent>" },
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
  const sections: TerminalSection[] = [
    {
      title: options.agents.length === 0 ? "Start here" : "Around the house",
      lines: options.agents.length === 0
        ? ["No agents are home yet. Hatch someone new or bring an existing bundle aboard."]
        : options.agents.map((agent) => `${agent} is home and ready when called.`),
    },
  ]
  const actionRows: TerminalAction[] = actions.map((action, index) => ({
    label: action.label,
    actor: "agent-runnable",
    command: action.command,
    ...(index === 0 ? { recommended: true } : {}),
  }))

  return renderTerminalBoard({
    isTTY: options.isTTY,
    columns: options.columns,
    masthead: {
      subtitle: options.agents.length === 0
        ? "No agents are home yet."
        : "Welcome home.",
    },
    title: "Ouro home",
    summary: options.agents.length === 0
      ? "Hatch someone new or bring an existing bundle aboard."
      : "Choose who to wake or what to prepare without memorizing commands.",
    sections,
    actions: actionRows,
    prompt: `Choose [1-${actions.length}] or type a name: `,
  })
}

export function renderAgentPickerScreen(options: AgentPickerOptions): string {
  renderScreenEvent("agent-picker")
  return renderTerminalBoard({
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
        lines: options.agents.map((agent, index) => `${index + 1}. ${agent}`),
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

function statusLabel(status: string): string {
  return status.replace(/-/g, " ")
}

export function renderHumanReadinessBoard(options: HumanReadinessBoardOptions): string {
  renderScreenEvent("readiness")
  const sections: TerminalSection[] = options.snapshot.items.map((item) => ({
    title: item.title,
    lines: [
      `${statusLabel(item.status)} — ${item.summary}`,
      ...item.detailLines,
    ],
  }))

  return renderTerminalBoard({
    isTTY: options.isTTY,
    columns: options.columns,
    masthead: {
      subtitle: options.subtitle,
    },
    title: options.title,
    summary: options.snapshot.summary,
    sections,
    actions: options.snapshot.nextActions,
    prompt: options.prompt,
  })
}

export function renderHouseStatusScreen(options: {
  payload: StatusPayload
  isTTY: boolean
  columns?: number
}): string {
  renderScreenEvent("house-status")
  const sections: TerminalSection[] = [
    {
      title: "House pulse",
      lines: [
        `Daemon: ${options.payload.overview.daemon}`,
        `Health: ${options.payload.overview.health}`,
        `Outlook: ${options.payload.overview.outlookUrl}`,
        `Updated: ${options.payload.overview.lastUpdated}`,
      ],
    },
  ]

  if (options.payload.agents.length > 0) {
    sections.push({
      title: "Agents",
      lines: options.payload.agents.map((agent) => `${agent.name} — ${agent.enabled ? "enabled" : "disabled"}`),
    })
  }

  if (options.payload.providers.length > 0) {
    sections.push({
      title: "Providers",
      lines: options.payload.providers.map((provider) => {
        const detail = [provider.readiness, provider.detail, provider.source, provider.credential].filter(Boolean).join("; ")
        return `${provider.agent} ${provider.lane} — ${provider.provider} / ${provider.model}${detail ? ` — ${detail}` : ""}`
      }),
    })
  }

  if (options.payload.senses.length > 0) {
    sections.push({
      title: "Senses",
      lines: options.payload.senses.map((sense) => {
        const status = sense.enabled ? sense.status : "disabled"
        return `${sense.agent} — ${sense.label ?? sense.sense} — ${status}${sense.detail ? ` — ${sense.detail}` : ""}`
      }),
    })
  }

  if (options.payload.workers.length > 0) {
    sections.push({
      title: "Workers",
      lines: options.payload.workers.map((worker) => {
        const details = [`restarts: ${worker.restartCount}`]
        if (worker.pid !== null) details.unshift(`pid ${worker.pid}`)
        if (worker.lastExitCode !== null) details.push(`exit=${worker.lastExitCode}`)
        if (worker.lastSignal !== null) details.push(`signal=${worker.lastSignal}`)
        if (worker.errorReason) details.push(`error: ${worker.errorReason}`)
        if (worker.fixHint) details.push(`fix: ${worker.fixHint}`)
        return `${worker.agent} — ${worker.worker} — ${worker.status}${details.length > 0 ? ` — ${details.join("; ")}` : ""}`
      }),
    })
  }

  if (options.payload.sync.length > 0) {
    sections.push({
      title: "Git sync",
      lines: options.payload.sync.map((row) => {
        if (!row.enabled) return `${row.agent} — disabled`
        if (row.gitInitialized === false) return `${row.agent} — needs git init`
        if (row.remoteUrl) return `${row.agent} — ${row.remote} -> ${row.remoteUrl}`
        return `${row.agent} — local only`
      }),
    })
  }

  return renderTerminalBoard({
    isTTY: options.isTTY,
    columns: options.columns,
    masthead: {
      subtitle: "The house is awake enough to answer clearly.",
    },
    title: "House status",
    summary: "What is awake, resting, or asking for care.",
    sections,
  })
}
