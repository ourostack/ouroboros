import type { MailboxAgentView, MailboxDeskPrefs, MailboxMachineView } from "./contracts"

export class TestEventSource extends EventTarget {
  static instances: TestEventSource[] = []
  onerror: ((event: Event) => void) | null = null
  onopen: ((event: Event) => void) | null = null
  closed = false

  constructor(public readonly url: string) {
    super()
    TestEventSource.instances.push(this)
  }

  open(): void { this.onopen?.(new Event("open")) }
  disconnect(): void { this.onerror?.(new Event("error")) }
  change(): void { this.dispatchEvent(new MessageEvent("state-changed", { data: "{}" })) }
  close(): void { this.closed = true }
}

export function machineView(version = "test-current"): MailboxMachineView {
  return {
    overview: {
      productName: "Ouro Mailbox",
      observedAt: "2026-10-17T20:00:00.000Z",
      primaryEntryPoint: "http://127.0.0.1:6876",
      daemon: {
        status: "running", health: "ok", mode: "production", socketPath: "/tmp/test.sock",
        mailboxUrl: "http://127.0.0.1:6876", entryPath: "/test/entry.js", workerCount: 0, senseCount: 0,
      },
      runtime: { version, lastUpdated: "2026-10-17T20:00:00.000Z", repoRoot: "/test", configFingerprint: "test-config" },
      freshness: { status: "fresh", latestActivityAt: null, ageMs: null },
      degraded: { status: "ok", issues: [] },
      totals: {
        agents: 2, enabledAgents: 2, degradedAgents: 0, staleAgents: 0, liveTasks: 0,
        blockedTasks: 0, openObligations: 0, activeCodingAgents: 0, blockedCodingAgents: 0,
      },
      mood: "calm",
      entrypoints: [],
    },
    agents: ["alpha", "beta"].map((agentName) => ({
      agentName, enabled: true, freshness: { status: "fresh", latestActivityAt: null, ageMs: null },
      degraded: { status: "ok", issues: [] }, tasks: { liveCount: 0, blockedCount: 0 },
      obligations: { openCount: 0 }, coding: { activeCount: 0, blockedCount: 0 },
      attention: { level: "idle", label: "Idle" },
    })),
  }
}

export function agentView(agentName: string): MailboxAgentView {
  return {
    productName: "Ouro Mailbox",
    interactionModel: "read-only",
    viewer: { kind: "human", innerDetail: "summary" },
    agent: {
      agentName, agentRoot: `/test/${agentName}.ouro`, enabled: true, provider: "openai", senses: [],
      freshness: { status: "fresh", latestActivityAt: null, ageMs: null },
      degraded: { status: "ok", issues: [] }, attention: { level: "idle", label: `${agentName} detail` },
    },
    work: {
      tasks: {
        totalCount: 0, liveCount: 0, blockedCount: 0,
        byStatus: { drafting: 0, processing: 0, validating: 0, collaborating: 0, paused: 0, blocked: 0, done: 0, cancelled: 0 },
        liveTaskNames: [], actionRequired: [], activeBridges: [],
      },
      obligations: { openCount: 0, items: [] }, sessions: { liveCount: 0, items: [] },
      coding: { totalCount: 0, activeCount: 0, blockedCount: 0, items: [] }, bridges: [],
    },
    inner: {
      mode: "summary", status: "idle", summary: null, hasPending: false,
      returnObligationQueue: { queuedCount: 0, runningCount: 0, oldestActiveAt: null },
    },
    activity: { freshness: { status: "fresh", latestActivityAt: null, ageMs: null }, recent: [] },
  }
}

export function deskPrefs(agentName: string): MailboxDeskPrefs {
  return {
    carrying: `Owned by ${agentName}`, statusLine: null, tabOrder: null,
    starredFriends: [], pinnedConstellations: [], dismissedObligations: [],
  }
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
}

export function defaultResponse(url: string): Response {
  if (url === "/api/machine") return jsonResponse(machineView())
  const name = /^\/api\/agents\/([^/]+)$/.exec(url)?.[1]
  if (name) return jsonResponse(agentView(name))
  const owner = /^\/api\/agents\/([^/]+)\/desk-prefs$/.exec(url)?.[1]
  if (owner) return jsonResponse(deskPrefs(owner))
  if (url.endsWith("/needs-me")) return jsonResponse({ items: [] })
  if (url.endsWith("/coding")) return jsonResponse({ totalCount: 0, activeCount: 0, blockedCount: 0, items: [] })
  return jsonResponse({ error: "not available in this fixture" }, 503)
}
