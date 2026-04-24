import { emitNervesEvent } from "../../nerves/runtime"
import {
  OUTLOOK_RELEASE_INTERACTION_MODEL,
  OUTLOOK_PRODUCT_NAME,
  type OutlookAgentState,
  type OutlookAgentSummary,
  type OutlookAgentView,
  type OutlookInnerSummary,
  type OutlookMachineDaemonSummary,
  type OutlookMachineMood,
  type OutlookMachineView,
  type OutlookMachineAgentView,
  type OutlookRecentActivityItem,
  type OutlookMachineState,
  type OutlookMachineTotals,
  type OutlookViewer,
} from "./outlook-types"

function deriveAttention(agent: OutlookAgentSummary): OutlookMachineAgentView["attention"] {
  if (agent.degraded.status === "degraded") {
    return { level: "degraded", label: "Degraded" }
  }

  if (agent.freshness.status === "stale") {
    return { level: "stale", label: "Stale" }
  }

  if (agent.tasks.blockedCount > 0 || agent.coding.blockedCount > 0) {
    return { level: "blocked", label: "Blocked" }
  }

  if (agent.tasks.liveCount > 0 || agent.coding.activeCount > 0 || agent.obligations.openCount > 0) {
    return { level: "active", label: "Active" }
  }

  return { level: "idle", label: "Idle" }
}

function deriveAgentAttention(agent: OutlookAgentState): OutlookMachineAgentView["attention"] {
  return deriveAttention({
    agentName: agent.agentName,
    enabled: agent.enabled,
    freshness: agent.freshness,
    degraded: agent.degraded,
    tasks: {
      liveCount: agent.tasks.liveCount,
      blockedCount: agent.tasks.blockedCount,
    },
    obligations: {
      openCount: agent.obligations.openCount,
    },
    coding: {
      activeCount: agent.coding.activeCount,
      blockedCount: agent.coding.blockedCount,
    },
  })
}

function buildTotals(machine: OutlookMachineState): OutlookMachineTotals {
  return machine.agents.reduce<OutlookMachineTotals>((totals, agent) => ({
    agents: totals.agents + 1,
    enabledAgents: totals.enabledAgents + (agent.enabled ? 1 : 0),
    degradedAgents: totals.degradedAgents + (agent.degraded.status === "degraded" ? 1 : 0),
    staleAgents: totals.staleAgents + (agent.freshness.status === "stale" ? 1 : 0),
    liveTasks: totals.liveTasks + agent.tasks.liveCount,
    blockedTasks: totals.blockedTasks + agent.tasks.blockedCount,
    openObligations: totals.openObligations + agent.obligations.openCount,
    activeCodingAgents: totals.activeCodingAgents + (agent.coding.activeCount > 0 ? 1 : 0),
    blockedCodingAgents: totals.blockedCodingAgents + (agent.coding.blockedCount > 0 ? 1 : 0),
  }), {
    agents: 0,
    enabledAgents: 0,
    degradedAgents: 0,
    staleAgents: 0,
    liveTasks: 0,
    blockedTasks: 0,
    openObligations: 0,
    activeCodingAgents: 0,
    blockedCodingAgents: 0,
  })
}

function deriveMood(machine: OutlookMachineState, daemon: OutlookMachineDaemonSummary): OutlookMachineMood {
  if (machine.degraded.status === "degraded" || daemon.health === "warn") {
    return "strained"
  }

  if (machine.freshness.status === "stale") {
    return "watchful"
  }

  return "calm"
}

export function buildOutlookMachineView(input: {
  machine: OutlookMachineState
  daemon: OutlookMachineDaemonSummary
}): OutlookMachineView {
  const totals = buildTotals(input.machine)
  const agents = input.machine.agents
    .map((agent) => ({
      ...agent,
      attention: deriveAttention(agent),
    }))
    .sort((left, right) => {
      const leftAt = left.freshness.latestActivityAt ?? ""
      const rightAt = right.freshness.latestActivityAt ?? ""
      return rightAt.localeCompare(leftAt)
    })

  return {
    overview: {
      productName: OUTLOOK_PRODUCT_NAME,
      observedAt: input.machine.observedAt,
      primaryEntryPoint: input.daemon.outlookUrl,
      daemon: input.daemon,
      runtime: input.machine.runtime,
      freshness: input.machine.freshness,
      degraded: input.machine.degraded,
      totals,
      mood: deriveMood(input.machine, input.daemon),
      entrypoints: [
        { kind: "web", label: "Open Mailbox", target: input.daemon.outlookUrl },
        { kind: "cli", label: "CLI JSON", target: "ouro mailbox --json" },
      ],
    },
    agents,
  }
}

function normalizeViewer(viewer: OutlookViewer | undefined): OutlookAgentView["viewer"] {
  return {
    kind: viewer?.kind ?? "human",
    agentName: viewer?.agentName,
    innerDetail: viewer?.innerDetail ?? "summary",
  }
}

function buildInnerView(inner: OutlookInnerSummary, viewer: OutlookAgentView["viewer"]): OutlookAgentView["inner"] {
  if (viewer.innerDetail === "deep") {
    return {
      mode: "deep",
      status: inner.status,
      summary: inner.surfacedSummary,
      hasPending: inner.hasPending,
      origin: inner.origin,
      obligationStatus: inner.obligationStatus,
    }
  }

  return {
    mode: "summary",
    status: inner.status,
    summary: inner.surfacedSummary,
    hasPending: inner.hasPending,
  }
}

function buildRecentActivity(agent: OutlookAgentState): OutlookRecentActivityItem[] {
  const items: OutlookRecentActivityItem[] = [
    ...agent.coding.items.map((item) => ({
      kind: "coding" as const,
      at: item.lastActivityAt,
      label: item.checkpoint ?? `${item.runner} ${item.status}`,
      detail: item.workdir,
    })),
    ...agent.sessions.items.map((item) => ({
      kind: "session" as const,
      at: item.lastActivityAt,
      label: `${item.friendName} via ${item.channel}`,
      detail: item.key,
    })),
    ...agent.obligations.items.map((item) => ({
      kind: "obligation" as const,
      at: item.updatedAt,
      label: item.content,
      detail: item.nextAction ?? item.status,
    })),
  ]

  if (agent.inner.latestActivityAt) {
    items.push({
      kind: "inner",
      at: agent.inner.latestActivityAt,
      label: agent.inner.surfacedSummary ?? agent.inner.status,
      detail: agent.inner.hasPending ? "pending inner work" : agent.inner.obligationStatus ?? "no linked obligation",
    })
  }

  return items
    .filter((item) => Number.isFinite(Date.parse(item.at)))
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, 4)
}

export function buildOutlookAgentView(input: {
  agent: OutlookAgentState
  viewer?: OutlookViewer
}): OutlookAgentView {
  /* v8 ignore next */
  emitNervesEvent({ component: "daemon", event: "daemon.outlook_view_agent", message: `building mailbox view for ${input.agent.agentName}`, meta: { agent: input.agent.agentName } })
  const viewer = normalizeViewer(input.viewer)

  return {
    productName: OUTLOOK_PRODUCT_NAME,
    interactionModel: OUTLOOK_RELEASE_INTERACTION_MODEL,
    viewer,
    agent: {
      agentName: input.agent.agentName,
      agentRoot: input.agent.agentRoot,
      enabled: input.agent.enabled,
      provider: input.agent.provider,
      providers: input.agent.providers ?? null,
      senses: input.agent.senses,
      freshness: input.agent.freshness,
      degraded: input.agent.degraded,
      attention: deriveAgentAttention(input.agent),
    },
    work: {
      tasks: input.agent.tasks,
      obligations: input.agent.obligations,
      sessions: input.agent.sessions,
      coding: input.agent.coding,
      bridges: input.agent.tasks.activeBridges,
    },
    inner: buildInnerView(input.agent.inner, viewer),
    activity: {
      freshness: input.agent.freshness,
      recent: buildRecentActivity(input.agent),
    },
  }
}
