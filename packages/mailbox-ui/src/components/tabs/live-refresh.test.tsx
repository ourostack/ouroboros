import { act, StrictMode } from "react"
import { fireEvent, render, waitFor, cleanup } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NavigationContext } from "../../navigation"
import { AgentInspector } from "../agent-inspector"
import { OverviewTab } from "./overview"
import { SessionsTab } from "./sessions"
import { WorkTab } from "./work"
import { ConnectionsTab } from "./connections"
import { InnerTab } from "./inner"
import { MailboxTab } from "./mailbox"
import { NotesTab } from "./notes"
import { RuntimeTab } from "./runtime"
import type { MailboxAgentView, MailboxSentinelReceipt, MailboxSentinelView, MailboxTranscriptMessage } from "../../contracts"

const BOTTOM_STICKINESS_PX = 48

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function expectNearBottom(element: HTMLElement): void {
  expect(element.scrollHeight - element.scrollTop - element.clientHeight).toBeLessThanOrEqual(BOTTOM_STICKINESS_PX)
}

async function flushRefresh(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

type AgentViewOverrides = {
  agent?: Partial<MailboxAgentView["agent"]>
  work?: {
    tasks?: Partial<MailboxAgentView["work"]["tasks"]>
    obligations?: Partial<MailboxAgentView["work"]["obligations"]>
    sessions?: Partial<MailboxAgentView["work"]["sessions"]>
    coding?: Partial<MailboxAgentView["work"]["coding"]>
    bridges?: string[]
  }
  inner?: MailboxAgentView["inner"]
  activity?: Partial<MailboxAgentView["activity"]>
}

function makeAgentView(overrides: AgentViewOverrides = {}): MailboxAgentView {
  const base: MailboxAgentView = {
    productName: "Ouro Mailbox",
    interactionModel: "read-only",
    viewer: { kind: "human", innerDetail: "summary" },
    agent: {
      agentName: "slugger",
      agentRoot: "/tmp/slugger.ouro",
      enabled: true,
      provider: "openai",
      freshness: { status: "fresh", latestActivityAt: null, ageMs: null },
      degraded: { status: "ok", issues: [] },
      attention: { level: "idle", label: "steady" },
      senses: [],
    },
    work: {
      tasks: {
        totalCount: 0,
        liveCount: 0,
        blockedCount: 0,
        byStatus: {
          drafting: 0,
          processing: 0,
          validating: 0,
          collaborating: 0,
          paused: 0,
          blocked: 0,
          done: 0,
          cancelled: 0,
        },
        liveTaskNames: [],
        actionRequired: [],
        activeBridges: [],
      },
      obligations: { openCount: 0, items: [] },
      sessions: { liveCount: 0, items: [] },
      coding: { totalCount: 0, activeCount: 0, blockedCount: 0, items: [] },
      bridges: [],
    },
    inner: { mode: "summary", status: "idle", summary: null, hasPending: false, returnObligationQueue: { queuedCount: 0, runningCount: 0, oldestActiveAt: null } },
    activity: { freshness: { status: "fresh", latestActivityAt: null, ageMs: null }, recent: [] },
  }

  return {
    ...base,
    agent: { ...base.agent, ...overrides.agent },
    work: {
      ...base.work,
      tasks: {
        ...base.work.tasks,
        ...overrides.work?.tasks,
        byStatus: {
          ...base.work.tasks.byStatus,
          ...overrides.work?.tasks?.byStatus,
        },
      },
      obligations: { ...base.work.obligations, ...overrides.work?.obligations },
      sessions: { ...base.work.sessions, ...overrides.work?.sessions },
      coding: { ...base.work.coding, ...overrides.work?.coding },
      bridges: overrides.work?.bridges ?? base.work.bridges,
    },
    inner: overrides.inner ?? base.inner,
    activity: { ...base.activity, ...overrides.activity },
  }
}

function makeSentinelReceipt(overrides: Partial<MailboxSentinelReceipt> = {}): MailboxSentinelReceipt {
  const id = overrides.id ?? "sentinel-ready-1"
  const trigger = overrides.trigger ?? "post_turn"
  const verdict = overrides.verdict ?? "ready"
  return {
    schemaVersion: 1,
    id,
    agent: overrides.agent ?? "slugger",
    trigger,
    generatedAt: overrides.generatedAt ?? "2026-06-08T12:00:00.000Z",
    verdict,
    summary: overrides.summary ?? "latest-ready recovery anchor is usable",
    receiptLocator: overrides.receiptLocator ?? `arc/flight-recorder/context-loss-sentinel/receipts/${id}.json`,
    latestReadyLocator: overrides.latestReadyLocator ?? "arc/flight-recorder/context-loss-sentinel/latest-ready.json",
    recoveryAnchor: overrides.recoveryAnchor ?? {
      kind: "latest-ready",
      currentAsk: "finish the visibility layer",
      nextSafeAction: "continue Unit 4 from the doing doc",
      flightRecorderLatestLocator: "arc/flight-recorder/latest.json",
      sourceEventIds: ["evt_user_full_moon"],
      recordedAt: "2026-06-08T11:55:00.000Z",
    },
    gauntlet: overrides.gauntlet ?? {
      verdict,
      scorePercentage: verdict === "ready" ? 100 : verdict === "watch" ? 86 : 58,
      failedChecks: verdict === "blocked" ? ["provider:outward"] : [],
      warnedChecks: verdict === "watch" ? ["sense:mail"] : [],
      sourceLocator: "arc/flight-recorder/latest.json",
    },
    signals: overrides.signals ?? [{
      id: "gauntlet:ready",
      kind: "gauntlet",
      status: "pass",
      severity: "info",
      verdictImpact: "none",
      summary: "context recovery gauntlet passed",
      source: { kind: "context-loss-gauntlet", locator: "arc/flight-recorder/latest.json" },
    }],
    sourceLocators: overrides.sourceLocators ?? ["arc/flight-recorder/latest.json"],
    resumeSnapshot: overrides.resumeSnapshot ?? {},
  }
}

function makeSentinelView(overrides: Partial<MailboxSentinelView> = {}): MailboxSentinelView {
  const latestReady = makeSentinelReceipt({
    id: "sentinel-ready-1",
    trigger: "post_turn",
    verdict: "ready",
    summary: "latest-ready recovery anchor is usable",
  })
  const watch = makeSentinelReceipt({
    id: "sentinel-watch-1",
    trigger: "daemon_startup",
    generatedAt: "2026-06-08T12:04:00.000Z",
    verdict: "watch",
    summary: "mail sense is lagging but recovery is possible",
    signals: [{
      id: "sense:mail",
      kind: "sense",
      status: "warn",
      severity: "warn",
      verdictImpact: "watch",
      summary: "mail sense has not refreshed recently",
      source: { kind: "mail-sense", locator: "state/mail/latest.json" },
    }],
  })
  const latest = makeSentinelReceipt({
    id: "sentinel-blocked-1",
    trigger: "session_start",
    generatedAt: "2026-06-08T12:08:00.000Z",
    verdict: "blocked",
    summary: "outward provider lane is unavailable",
    recoveryAnchor: {
      kind: "latest-ready",
      currentAsk: "finish the visibility layer",
      nextSafeAction: "run ouro provider refresh --agent slugger",
      flightRecorderLatestLocator: "arc/flight-recorder/latest.json",
      sourceEventIds: ["evt_user_full_moon"],
      recordedAt: "2026-06-08T12:06:00.000Z",
    },
    gauntlet: {
      verdict: "ready",
      scorePercentage: 100,
      failedChecks: [],
      warnedChecks: [],
      sourceLocator: "arc/flight-recorder/latest.json",
    },
    signals: [{
      id: "provider:outward",
      kind: "provider_lane",
      status: "fail",
      severity: "critical",
      verdictImpact: "blocked",
      summary: "outward provider down",
      source: { kind: "provider-visibility", locator: "agent.json#providers.outward" },
      repair: {
        actor: "agent-runnable",
        kind: "provider-credential-cache",
        command: "ouro provider refresh --agent slugger",
        detail: "Refresh the provider credential cache.",
      },
    }],
  })

  return {
    schemaVersion: 1,
    latest,
    latestReady,
    history: [latest, watch, latestReady],
    degraded: { issues: [] },
    ...overrides,
  }
}

function transcriptMessage(sequence: number, role: "user" | "assistant", content: string): MailboxTranscriptMessage {
  const recordedAt = `2026-04-09T17:${String(sequence).padStart(2, "0")}:00.000Z`
  return {
    id: `msg_${sequence}`,
    sequence,
    role,
    content,
    name: null,
    toolCallId: null,
    toolCalls: [],
    attachments: [],
    time: {
      authoredAt: recordedAt,
      authoredAtSource: "local",
      observedAt: null,
      observedAtSource: "unknown",
      recordedAt,
      recordedAtSource: "local",
    },
    relations: {
      replyToEventId: null,
      threadRootEventId: null,
      references: [],
      toolCallId: null,
      supersedesEventId: null,
      redactsEventId: null,
    },
    provenance: {
      captureKind: "synthetic",
      legacyVersion: null,
      sourceMessageIndex: null,
    },
  }
}

function transcriptPayload(messages: MailboxTranscriptMessage[], channel = "bluebubbles", truncatedHistory = false) {
  return {
    friendId: "ari",
    friendName: "Ari",
    channel,
    key: "main",
    sessionPath: "/tmp/session.json",
    messageCount: messages.length,
    truncatedHistory,
    lastUsage: null,
    continuity: null,
    messages,
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("Mailbox deep-tab live refresh", () => {
  it("keeps the initial hash tab under StrictMode", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/mail")) {
        return jsonResponse({
          status: "ready",
          agentName: "slugger",
          mailboxAddress: "slugger@ouro.bot",
          generatedAt: "2026-04-23T01:35:00.000Z",
          store: { kind: "file", label: "/tmp/mailroom" },
          folders: [],
          messages: [],
          screener: [],
          outbound: [],
          recovery: { discardedCount: 0, quarantineCount: 0, undecryptableCount: 0, missingKeyIds: [] },
          accessLog: [],
          error: null,
        })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const ui = render(
      <StrictMode>
        <AgentInspector
          agentName="slugger"
          view={makeAgentView()}
          deskPrefs={null}
          refreshGeneration={0}
          initialRoute={{ agent: "slugger", tab: "mail", focus: undefined }}
        />
      </StrictMode>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await flushRefresh()

    expect(ui.container.textContent).toContain("Agent mailbox")
    expect(ui.container.textContent).not.toContain("CENTER OF GRAVITY")
  })

  it("uses private-runtime vocabulary for the private runtime tab and overview meter", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/habits")) return jsonResponse({ totalCount: 0, items: [] })
      if (url.endsWith("/habit-runs")) return jsonResponse({ totalCount: 0, limit: 20, items: [] })
      if (url.endsWith("/needs-me")) return jsonResponse({ items: [] })
      if (url.endsWith("/coding")) return jsonResponse({ items: [] })
      if (url.endsWith("/continuity")) return jsonResponse({ presence: { self: null, peers: [] }, cares: { activeCount: 0, items: [] }, episodes: { recentCount: 0, items: [] } })
      if (url.endsWith("/orientation")) return jsonResponse({ currentSession: null, centerOfGravity: "steady", primaryObligation: null, resumeHandle: null, otherActiveSessions: [] })
      if (url.endsWith("/changes")) return jsonResponse({ changeCount: 0, items: [], snapshotAge: null, formatted: "none" })
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const view = makeAgentView({
      inner: {
        mode: "summary",
        status: "idle",
        summary: "ready for routine private work",
        hasPending: true,
        returnObligationQueue: { queuedCount: 0, runningCount: 0, oldestActiveAt: null },
      },
    })

    const inspector = render(
      <AgentInspector
        agentName="slugger"
        view={view}
        deskPrefs={null}
        refreshGeneration={0}
        initialRoute={{ agent: "slugger", tab: "inner", focus: undefined }}
      />
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    expect(inspector.container.textContent).toContain("Private Runtime")
    expect(inspector.container.textContent).toContain("Private runtime work queued.")
    expect(inspector.container.textContent).not.toContain("Inner work")
    expect(inspector.container.textContent).not.toContain("Pending inner work queued.")
    inspector.unmount()

    const overview = render(
      <NavigationContext.Provider value={() => {}}>
        <OverviewTab view={view} refreshGeneration={0} deskPrefs={null} />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7))

    expect(overview.container.textContent).toContain("Private Runtime")
    expect(overview.container.textContent).not.toContain("Inner")
  })

  it("re-fetches overview deep data when refreshGeneration advances", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/needs-me")) return jsonResponse({ items: [] })
      if (url.endsWith("/coding")) return jsonResponse({ items: [] })
      if (url.endsWith("/continuity")) return jsonResponse({ presence: { self: null, peers: [] }, cares: { activeCount: 0, items: [] }, episodes: { recentCount: 0, items: [] } })
      if (url.endsWith("/orientation")) return jsonResponse({ currentSession: null, centerOfGravity: "steady", primaryObligation: null, resumeHandle: null, otherActiveSessions: [] })
      if (url.endsWith("/changes")) return jsonResponse({ changeCount: 0, items: [], snapshotAge: null, formatted: "none" })
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const view = makeAgentView()

    const ui = render(
      <NavigationContext.Provider value={() => {}}>
        <OverviewTab view={view} refreshGeneration={0} deskPrefs={null} />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5))

    ui.rerender(
      <NavigationContext.Provider value={() => {}}>
        <OverviewTab view={view} refreshGeneration={1} deskPrefs={null} />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(10))
  })

  it("re-fetches session inventory and open transcript on refresh", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/sessions")) {
        return jsonResponse({
          totalCount: 1,
          activeCount: 1,
          staleCount: 0,
          items: [{
            friendId: "ari",
            friendName: "Ari",
            channel: "bluebubbles",
            key: "main",
            sessionPath: "/tmp/session.json",
            lastActivityAt: "2026-04-09T17:00:00.000Z",
            activitySource: "event-timeline",
            replyState: "needs-reply",
            messageCount: 2,
            lastUsage: null,
            continuity: null,
            latestUserExcerpt: "hi",
            latestAssistantExcerpt: "hello",
            latestToolCallNames: [],
            estimatedTokens: 12,
          }],
        })
      }
      if (url.endsWith("/sessions/ari/bluebubbles/main")) {
        return jsonResponse({
          friendId: "ari",
          friendName: "Ari",
          channel: "bluebubbles",
          key: "main",
          sessionPath: "/tmp/session.json",
          messageCount: 1,
          lastUsage: null,
          continuity: null,
          messages: [],
        })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const ui = render(
      <NavigationContext.Provider value={() => {}}>
        <SessionsTab
          agentName="slugger"
          focus="ari/bluebubbles/main"
          onFocusConsumed={() => {}}
          deskPrefs={null}
          refreshGeneration={0}
        />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(ui.container.textContent).toContain("iMessage")

    ui.rerender(
      <NavigationContext.Provider value={() => {}}>
        <SessionsTab
          agentName="slugger"
          focus={undefined}
          onFocusConsumed={() => {}}
          deskPrefs={null}
          refreshGeneration={1}
        />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
  })

  it("renders voice sessions as text transcripts", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/sessions")) {
        return jsonResponse({
          totalCount: 1,
          activeCount: 1,
          staleCount: 0,
          items: [{
            friendId: "ari",
            friendName: "Ari",
            channel: "voice",
            key: "riverside",
            sessionPath: "/tmp/session.json",
            lastActivityAt: "2026-04-09T17:00:00.000Z",
            activitySource: "event-timeline",
            replyState: "monitoring",
            messageCount: 2,
            lastUsage: null,
            continuity: null,
            latestUserExcerpt: "can you hear me?",
            latestAssistantExcerpt: "yes, loud and clear.",
            latestToolCallNames: [],
            estimatedTokens: 12,
          }],
        })
      }
      if (url.endsWith("/sessions/ari/voice/riverside")) {
        return jsonResponse(transcriptPayload([
          transcriptMessage(1, "user", "can you hear me?"),
          transcriptMessage(2, "assistant", "yes, loud and clear."),
        ], "voice"))
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const ui = render(
      <NavigationContext.Provider value={() => {}}>
        <SessionsTab
          agentName="slugger"
          focus="ari/voice/riverside"
          onFocusConsumed={() => {}}
          deskPrefs={null}
          refreshGeneration={0}
        />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(ui.container.textContent).toContain("Voice")
    expect(ui.container.textContent).toContain("can you hear me?")
    expect(ui.container.textContent).toContain("yes, loud and clear.")
  })

  it("shows a footnote when a session transcript has truncated history", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/sessions")) {
        return jsonResponse({
          totalCount: 1,
          activeCount: 1,
          staleCount: 0,
          items: [{
            friendId: "ari",
            friendName: "Ari",
            channel: "bluebubbles",
            key: "main",
            sessionPath: "/tmp/session.json",
            lastActivityAt: "2026-04-09T17:00:00.000Z",
            activitySource: "event-timeline",
            replyState: "monitoring",
            messageCount: 1,
            lastUsage: null,
            continuity: null,
            latestUserExcerpt: "still here",
            latestAssistantExcerpt: null,
            latestToolCallNames: [],
            estimatedTokens: 12,
          }],
        })
      }
      if (url.endsWith("/sessions/ari/bluebubbles/main")) {
        return jsonResponse(transcriptPayload([
          transcriptMessage(1, "user", "still here"),
        ], "bluebubbles", true))
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const ui = render(
      <NavigationContext.Provider value={() => {}}>
        <SessionsTab
          agentName="slugger"
          focus="ari/bluebubbles/main"
          onFocusConsumed={() => {}}
          deskPrefs={null}
          refreshGeneration={0}
        />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(await ui.findByText("older context not available; the agent's curated record is in Desk record")).toBeTruthy()
  })

  it("does not yank an open session transcript back to the bottom while the reader is scrolled up", async () => {
    let transcriptFetches = 0
    let resolveSecondTranscript: ((response: Response) => void) | null = null
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/sessions")) {
        return jsonResponse({
          totalCount: 1,
          activeCount: 1,
          staleCount: 0,
          items: [{
            friendId: "ari",
            friendName: "Ari",
            channel: "bluebubbles",
            key: "main",
            sessionPath: "/tmp/session.json",
            lastActivityAt: "2026-04-09T17:00:00.000Z",
            activitySource: "event-timeline",
            replyState: "monitoring",
            messageCount: 3,
            lastUsage: null,
            continuity: null,
            latestUserExcerpt: "scrolling",
            latestAssistantExcerpt: "reading",
            latestToolCallNames: [],
            estimatedTokens: 12,
          }],
        })
      }
      if (url.endsWith("/sessions/ari/bluebubbles/main")) {
        transcriptFetches += 1
        if (transcriptFetches === 2) {
          return new Promise<Response>((resolve) => {
            resolveSecondTranscript = resolve
          })
        }
        return jsonResponse(transcriptPayload([
          transcriptMessage(1, "user", "first"),
          transcriptMessage(2, "assistant", "second"),
        ]))
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const ui = render(
      <NavigationContext.Provider value={() => {}}>
        <SessionsTab
          agentName="slugger"
          focus="ari/bluebubbles/main"
          onFocusConsumed={() => {}}
          deskPrefs={null}
          refreshGeneration={0}
        />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(transcriptFetches).toBe(1))
    const panel = await ui.findByTestId("session-transcript-scroll")
    Object.defineProperty(panel, "scrollHeight", { configurable: true, value: 1000 })
    Object.defineProperty(panel, "clientHeight", { configurable: true, value: 200 })
    panel.scrollTop = 250
    fireEvent.scroll(panel)

    ui.rerender(
      <NavigationContext.Provider value={() => {}}>
        <SessionsTab
          agentName="slugger"
          focus={undefined}
          onFocusConsumed={() => {}}
          deskPrefs={null}
          refreshGeneration={1}
        />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(transcriptFetches).toBe(2))
    expect(ui.queryByText(/Loading transcript/)).toBeNull()
    expect(panel.scrollTop).toBe(250)

    await act(async () => {
      resolveSecondTranscript?.(jsonResponse(transcriptPayload([
        transcriptMessage(1, "user", "first"),
        transcriptMessage(2, "assistant", "second"),
        transcriptMessage(3, "assistant", "new heartbeat"),
      ])))
    })

    await waitFor(() => expect(ui.container.textContent).toContain("new heartbeat"))
    expect(panel.scrollTop).toBe(250)
  })

  it("keeps an open session transcript pinned to the bottom when the reader is already there", async () => {
    let transcriptFetches = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/sessions")) {
        return jsonResponse({
          totalCount: 1,
          activeCount: 1,
          staleCount: 0,
          items: [{
            friendId: "ari",
            friendName: "Ari",
            channel: "bluebubbles",
            key: "main",
            sessionPath: "/tmp/session.json",
            lastActivityAt: "2026-04-09T17:00:00.000Z",
            activitySource: "event-timeline",
            replyState: "monitoring",
            messageCount: 3,
            lastUsage: null,
            continuity: null,
            latestUserExcerpt: "scrolling",
            latestAssistantExcerpt: "reading",
            latestToolCallNames: [],
            estimatedTokens: 12,
          }],
        })
      }
      if (url.endsWith("/sessions/ari/bluebubbles/main")) {
        transcriptFetches += 1
        const messages = transcriptFetches === 1
          ? [transcriptMessage(1, "user", "first"), transcriptMessage(2, "assistant", "second")]
          : [transcriptMessage(1, "user", "first"), transcriptMessage(2, "assistant", "second"), transcriptMessage(3, "assistant", "new bottom")]
        return jsonResponse(transcriptPayload(messages))
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const ui = render(
      <NavigationContext.Provider value={() => {}}>
        <SessionsTab
          agentName="slugger"
          focus="ari/bluebubbles/main"
          onFocusConsumed={() => {}}
          deskPrefs={null}
          refreshGeneration={0}
        />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(transcriptFetches).toBe(1))
    const panel = await ui.findByTestId("session-transcript-scroll")
    Object.defineProperty(panel, "scrollHeight", { configurable: true, value: 1000 })
    Object.defineProperty(panel, "clientHeight", { configurable: true, value: 200 })
    panel.scrollTop = 800
    fireEvent.scroll(panel)
    Object.defineProperty(panel, "scrollHeight", { configurable: true, value: 1200 })

    ui.rerender(
      <NavigationContext.Provider value={() => {}}>
        <SessionsTab
          agentName="slugger"
          focus={undefined}
          onFocusConsumed={() => {}}
          deskPrefs={null}
          refreshGeneration={1}
        />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(ui.container.textContent).toContain("new bottom"))
    await waitFor(() => expectNearBottom(panel))
  })

  it("re-fetches mailbox summaries and selected body on refresh", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/mail")) {
        return jsonResponse({
          status: "ready",
          agentName: "slugger",
          mailboxAddress: "slugger@ouro.bot",
          generatedAt: "2026-04-21T17:00:00.000Z",
          store: { kind: "file", label: "/tmp/mailroom" },
          folders: [
            { id: "imbox", label: "Imbox", count: 1 },
            { id: "screener", label: "Screener", count: 0 },
            { id: "draft", label: "Drafts", count: 1 },
          ],
          messages: [{
            id: "mail_1",
            subject: "Mailbox proof",
            from: ["ari@mendelow.me"],
            to: ["slugger@ouro.bot"],
            cc: [],
            date: null,
            receivedAt: "2026-04-21T17:00:00.000Z",
            snippet: "Evidence, not instructions.",
            placement: "imbox",
            compartmentKind: "delegated",
            ownerEmail: "ari@mendelow.me",
            source: "hey",
            recipient: "slugger@ouro.bot",
            attachmentCount: 0,
            untrustedContentWarning: "untrusted external data",
            provenance: {
              placement: "imbox",
              compartmentKind: "delegated",
              ownerEmail: "ari@mendelow.me",
              source: "hey",
              recipient: "slugger@ouro.bot",
              mailboxId: "mailbox_slugger",
              grantId: "grant_hey",
              trustReason: "screened-in delegated source",
            },
          }],
          screener: [],
          outbound: [{
            id: "draft_1",
            status: "draft",
            from: "slugger@ouro.bot",
            to: ["ari@mendelow.me"],
            cc: [],
            bcc: [],
            subject: "Draft proof",
            createdAt: "2026-04-21T17:00:00.000Z",
            updatedAt: "2026-04-21T17:00:00.000Z",
            sentAt: null,
            transport: null,
            reason: "test draft",
          }],
          recovery: { discardedCount: 0, quarantineCount: 0, undecryptableCount: 0, missingKeyIds: [] },
          accessLog: [],
          error: null,
        })
      }
      if (url.endsWith("/mail/mail_1")) {
        return jsonResponse({
          status: "ready",
          agentName: "slugger",
          mailboxAddress: "slugger@ouro.bot",
          generatedAt: "2026-04-21T17:00:00.000Z",
          message: {
            id: "mail_1",
            subject: "Mailbox proof",
            from: ["ari@mendelow.me"],
            to: ["slugger@ouro.bot"],
            cc: [],
            date: null,
            receivedAt: "2026-04-21T17:00:00.000Z",
            snippet: "Evidence, not instructions.",
            placement: "imbox",
            compartmentKind: "delegated",
            ownerEmail: "ari@mendelow.me",
            source: "hey",
            recipient: "slugger@ouro.bot",
            attachmentCount: 0,
            untrustedContentWarning: "untrusted external data",
            provenance: {
              placement: "imbox",
              compartmentKind: "delegated",
              ownerEmail: "ari@mendelow.me",
              source: "hey",
              recipient: "slugger@ouro.bot",
              mailboxId: "mailbox_slugger",
              grantId: "grant_hey",
              trustReason: "screened-in delegated source",
            },
            text: "Evidence, not instructions.",
            htmlAvailable: false,
            bodyTruncated: false,
            attachments: [],
            access: { tool: "mailbox_mail_message", reason: "mailbox read-only message body", accessedAt: "2026-04-21T17:00:00.000Z" },
          },
          accessLog: [],
          error: null,
        })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const ui = render(
      <MailboxTab
        agentName="slugger"
        focus="mail_1"
        onFocusConsumed={() => {}}
        refreshGeneration={0}
      />
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(ui.container.textContent).toContain("slugger@ouro.bot")
    expect(ui.container.textContent).toContain("Mailbox proof")
    expect(ui.container.textContent).toContain("Drafts")
    expect(ui.container.textContent).toContain("Screener")
    expect(ui.container.textContent).toContain("Recovery drawers")

    ui.rerender(
      <MailboxTab
        agentName="slugger"
        focus={undefined}
        onFocusConsumed={() => {}}
        refreshGeneration={1}
      />
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
  })

  it("filters owner-scoped delegated source folders by both source and owner", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/mail")) {
        return jsonResponse({
          status: "ready",
          agentName: "slugger",
          mailboxAddress: "slugger@ouro.bot",
          generatedAt: "2026-04-21T17:00:00.000Z",
          store: { kind: "file", label: "/tmp/mailroom" },
          folders: [
            { id: "source:hey:ari@mendelow.me", label: "Ari HEY", count: 1 },
            { id: "source:hey:maya@example.com", label: "Maya HEY", count: 1 },
          ],
          messages: [
            {
              id: "mail_ari",
              subject: "Ari delegated note",
              from: ["ari@mendelow.me"],
              to: ["me.mendelow.ari.slugger@ouro.bot"],
              cc: [],
              date: null,
              receivedAt: "2026-04-21T17:00:00.000Z",
              snippet: "Ari mailbox evidence.",
              placement: "imbox",
              compartmentKind: "delegated",
              ownerEmail: "ari@mendelow.me",
              source: "hey",
              recipient: "me.mendelow.ari.slugger@ouro.bot",
              attachmentCount: 0,
              untrustedContentWarning: "untrusted external data",
              provenance: {
                placement: "imbox",
                compartmentKind: "delegated",
                ownerEmail: "ari@mendelow.me",
                source: "hey",
                recipient: "me.mendelow.ari.slugger@ouro.bot",
                mailboxId: "mailbox_slugger",
                grantId: "grant_ari_hey",
                trustReason: "screened-in delegated source",
              },
            },
            {
              id: "mail_maya",
              subject: "Maya delegated note",
              from: ["maya@example.com"],
              to: ["me.example.maya.slugger@ouro.bot"],
              cc: [],
              date: null,
              receivedAt: "2026-04-21T18:00:00.000Z",
              snippet: "Maya mailbox evidence.",
              placement: "imbox",
              compartmentKind: "delegated",
              ownerEmail: "maya@example.com",
              source: "hey",
              recipient: "me.example.maya.slugger@ouro.bot",
              attachmentCount: 0,
              untrustedContentWarning: "untrusted external data",
              provenance: {
                placement: "imbox",
                compartmentKind: "delegated",
                ownerEmail: "maya@example.com",
                source: "hey",
                recipient: "me.example.maya.slugger@ouro.bot",
                mailboxId: "mailbox_slugger",
                grantId: "grant_maya_hey",
                trustReason: "screened-in delegated source",
              },
            },
          ],
          screener: [],
          outbound: [],
          recovery: { discardedCount: 0, quarantineCount: 0, undecryptableCount: 0, missingKeyIds: [] },
          accessLog: [],
          error: null,
        })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const ui = render(
      <MailboxTab
        agentName="slugger"
        onFocusConsumed={() => {}}
        refreshGeneration={0}
      />
    )

    await waitFor(() => expect(ui.container.textContent).toContain("Ari HEY"))
    fireEvent.click(ui.getByRole("button", { name: /Ari HEY/ }))
    expect(ui.container.textContent).toContain("Ari delegated note")
    expect(ui.container.textContent).not.toContain("Maya delegated note")
  })

  it("renders explicit mailbox-role, autonomous send, and delivery audit labels without raw body leakage", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/mail")) {
        return jsonResponse({
          status: "ready",
          agentName: "slugger",
          mailboxAddress: "slugger@ouro.bot",
          generatedAt: "2026-04-23T01:35:00.000Z",
          store: { kind: "file", label: "/tmp/mailroom" },
          folders: [
            { id: "sent", label: "Sent", count: 1 },
          ],
          messages: [],
          screener: [],
          outbound: [{
            id: "draft_acs",
            status: "accepted",
            mailboxRole: "agent-native-mailbox",
            sendAuthority: "agent-native",
            ownerEmail: null,
            source: null,
            from: "slugger@ouro.bot",
            to: ["ari@mendelow.me"],
            cc: [],
            bcc: [],
            subject: "Autonomous provider proof",
            createdAt: "2026-04-23T01:30:00.000Z",
            updatedAt: "2026-04-23T01:32:00.000Z",
            sentAt: null,
            submittedAt: "2026-04-23T01:31:00.000Z",
            acceptedAt: "2026-04-23T01:32:00.000Z",
            deliveredAt: null,
            failedAt: null,
            sendMode: "autonomous",
            provider: "azure-communication-services",
            providerMessageId: "acs-operation-1",
            providerRequestId: "req-1",
            transport: null,
            reason: "policy-approved autonomous native send",
            policyDecision: {
              schemaVersion: 1,
              allowed: true,
              mode: "autonomous",
              code: "allowed",
              reason: "Autonomous native-agent mail policy allowed this send",
              evaluatedAt: "2026-04-23T01:30:00.000Z",
              recipients: ["ari@mendelow.me"],
              fallback: "none",
              policyId: "policy_slugger_native_mail",
              remainingSendsInWindow: 1,
            },
            deliveryEvents: [{
              schemaVersion: 1,
              provider: "azure-communication-services",
              providerEventId: "event-expanded-1",
              providerMessageId: "acs-operation-1",
              outcome: "accepted",
              recipient: "ari@mendelow.me",
              occurredAt: "2026-04-23T01:32:00.000Z",
              receivedAt: "2026-04-23T01:32:01.000Z",
              bodySafeSummary: "ACS delivery report Expanded for ari@mendelow.me",
              providerStatus: "Expanded",
            }],
          }],
          recovery: { discardedCount: 0, quarantineCount: 0, undecryptableCount: 0, missingKeyIds: [] },
          accessLog: [
            {
              id: "access_delegated",
              messageId: "mail_ari",
              threadId: null,
              tool: "mail_thread",
              reason: "read delegated message body",
              mailboxRole: "delegated-human-mailbox",
              compartmentKind: "delegated",
              ownerEmail: "ari@mendelow.me",
              source: "hey",
              accessedAt: "2026-04-23T01:10:00.000Z",
            },
            {
              id: "access_send",
              messageId: null,
              threadId: null,
              tool: "mail_send",
              reason: "policy-approved autonomous native send",
              mailboxRole: "agent-native-mailbox",
              compartmentKind: "native",
              ownerEmail: null,
              source: null,
              accessedAt: "2026-04-23T01:31:00.000Z",
            },
          ],
          error: null,
        })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const ui = render(
      <MailboxTab
        agentName="slugger"
        onFocusConsumed={() => {}}
        refreshGeneration={0}
      />
    )

    await waitFor(() => expect(ui.container.textContent).toContain("Access audit"))
    expect(ui.container.textContent).toContain("delegated human mailbox")
    expect(ui.container.textContent).toContain("ari@mendelow.me / hey")
    expect(ui.container.textContent).toContain("native agent mailbox")

    fireEvent.click(ui.getByRole("button", { name: /Sent/ }))
    expect(ui.container.textContent).toContain("Autonomous provider proof")
    expect(ui.container.textContent).toContain("autonomous")
    expect(ui.container.textContent).toContain("acs-operation-1")
    expect(ui.container.textContent).toContain("ACS delivery report Expanded for ari@mendelow.me")
    expect(ui.container.textContent).not.toContain("Provider raw body leaked")
  })

  it("re-fetches a focused session transcript even if the same focus is re-applied within the same refresh generation", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/sessions")) {
        return jsonResponse({
          totalCount: 1,
          activeCount: 1,
          staleCount: 0,
          items: [{
            friendId: "ari",
            friendName: "Ari",
            channel: "bluebubbles",
            key: "main",
            sessionPath: "/tmp/session.json",
            lastActivityAt: "2026-04-09T17:00:00.000Z",
            activitySource: "event-timeline",
            replyState: "needs-reply",
            messageCount: 2,
            lastUsage: null,
            continuity: null,
            latestUserExcerpt: "hi",
            latestAssistantExcerpt: "hello",
            latestToolCallNames: [],
            estimatedTokens: 12,
          }],
        })
      }
      if (url.endsWith("/sessions/ari/bluebubbles/main")) {
        return jsonResponse({
          friendId: "ari",
          friendName: "Ari",
          channel: "bluebubbles",
          key: "main",
          sessionPath: "/tmp/session.json",
          messageCount: 1,
          lastUsage: null,
          continuity: null,
          messages: [],
        })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const ui = render(
      <NavigationContext.Provider value={() => {}}>
        <SessionsTab
          agentName="slugger"
          focus="ari/bluebubbles/main"
          onFocusConsumed={() => {}}
          deskPrefs={null}
          refreshGeneration={0}
        />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    ui.rerender(
      <NavigationContext.Provider value={() => {}}>
        <SessionsTab
          agentName="slugger"
          focus={undefined}
          onFocusConsumed={() => {}}
          deskPrefs={null}
          refreshGeneration={0}
        />
      </NavigationContext.Provider>
    )

    ui.rerender(
      <NavigationContext.Provider value={() => {}}>
        <SessionsTab
          agentName="slugger"
          focus="ari/bluebubbles/main"
          onFocusConsumed={() => {}}
          deskPrefs={null}
          refreshGeneration={0}
        />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
  })

  it("re-fetches recovery sentinel history when refreshGeneration advances", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/coding")) return jsonResponse({ items: [] })
      if (url.endsWith("/obligations")) return jsonResponse({ openCount: 0, primaryId: null, primarySelectionReason: null, items: [] })
      if (url.endsWith("/self-fix")) return jsonResponse({ active: false, currentStep: null, steps: [] })
      if (url.endsWith("/sentinel")) return jsonResponse(makeSentinelView())
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const view = makeAgentView()

    const ui = render(
      <NavigationContext.Provider value={() => {}}>
        <WorkTab agentName="slugger" view={view} refreshGeneration={0} />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
    expect(fetchMock.mock.calls.map(([input]) => String(input)).some((url) => url.endsWith("/agents/slugger/sentinel"))).toBe(true)
    expect(fetchMock.mock.calls.map(([input]) => String(input)).some((url) => url.includes("/context-loss-gauntlet"))).toBe(false)
    expect(ui.container.textContent).toContain("Recovery Sentinel")
    expect(ui.container.textContent).toContain("Latest")
    expect(ui.container.textContent).toContain("Latest ready")
    expect(ui.container.textContent).toContain("History")
    expect(ui.container.textContent).toContain("outward provider lane is unavailable")
    expect(ui.container.textContent).toContain("outward provider down")
    expect(ui.container.textContent).toContain("latest-ready recovery anchor is usable")
    expect(ui.container.textContent).toContain("mail sense is lagging")
    expect(ui.container.textContent).toContain("session start")
    expect(ui.container.textContent).toContain("finish the visibility layer")
    expect(ui.container.textContent).not.toContain("Context-loss gauntlet")
    expect(ui.container.textContent).not.toContain("score")
    expect(ui.container.textContent).not.toContain("100%")
    expect((ui.container.textContent?.match(/outward provider lane is unavailable/g) ?? []).length).toBe(1)
    expect((ui.container.textContent?.match(/latest-ready recovery anchor is usable/g) ?? []).length).toBe(1)

    ui.rerender(
      <NavigationContext.Provider value={() => {}}>
        <WorkTab agentName="slugger" view={view} refreshGeneration={1} />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(8))
    expect(fetchMock.mock.calls.map(([input]) => String(input)).some((url) => url.includes("/context-loss-gauntlet"))).toBe(false)
  })

  it("clears stale recovery sentinel data on agent switch and shows refresh failures", async () => {
    let rejectCobraSentinel: ((reason?: unknown) => void) | null = null
    let resolveSluggerCoding: ((response: Response) => void) | null = null
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/slugger/coding")) {
        return new Promise<Response>((resolve) => {
          resolveSluggerCoding = resolve
        })
      }
      if (url.includes("/cobra/coding")) return jsonResponse({ items: [] })
      if (url.endsWith("/obligations")) return jsonResponse({ openCount: 0, primaryId: null, primarySelectionReason: null, items: [] })
      if (url.endsWith("/self-fix")) return jsonResponse({ active: false, currentStep: null, steps: [] })
      if (url.includes("/sentinel")) {
        if (url.includes("/slugger/")) return jsonResponse(makeSentinelView())
        if (url.includes("/cobra/")) {
          return new Promise<Response>((_, reject) => {
            rejectCobraSentinel = reject
          })
        }
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const view = makeAgentView()

    const ui = render(
      <NavigationContext.Provider value={() => {}}>
        <WorkTab agentName="slugger" view={view} refreshGeneration={0} />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(ui.container.textContent).toContain("outward provider lane is unavailable"))

    ui.rerender(
      <NavigationContext.Provider value={() => {}}>
        <WorkTab agentName="cobra" view={view} refreshGeneration={1} />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(fetchMock.mock.calls.map(([input]) => String(input)).some((url) => url.endsWith("/agents/cobra/sentinel"))).toBe(true))
    expect(ui.container.textContent).not.toContain("outward provider lane is unavailable")

    await act(async () => {
      resolveSluggerCoding?.(jsonResponse({
        items: [{
          id: "stale-coding",
          runner: "stale-runner",
          status: "running",
          checkpoint: "old agent work",
          taskRef: null,
          workdir: "/tmp/stale-slugger",
          originSession: null,
          obligationId: null,
          scopeFile: null,
          stateFile: null,
          artifactPath: null,
          pid: 31337,
          startedAt: "2026-06-08T11:00:00.000Z",
          lastActivityAt: "2026-06-08T11:30:00.000Z",
          endedAt: null,
          restartCount: 0,
          lastExitCode: null,
          lastSignal: null,
          stdoutTail: "",
          stderrTail: "",
          failure: null,
        }],
      }))
    })
    await flushRefresh()
    expect(ui.container.textContent).not.toContain("stale-runner")

    await act(async () => {
      rejectCobraSentinel?.(new Error("sentinel offline"))
    })

    await waitFor(() => expect(ui.container.textContent).toContain("sentinel offline"))
    expect(ui.container.textContent).toContain("unavailable")
    expect(ui.container.textContent).not.toContain("outward provider lane is unavailable")
  })

  it("re-fetches connections deep data when refreshGeneration advances", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/attention")) return jsonResponse({ queueLength: 0, queueItems: [] })
      if (url.endsWith("/bridges")) return jsonResponse({ totalCount: 0, items: [] })
      if (url.endsWith("/friends")) return jsonResponse({ totalFriends: 0, friends: [] })
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const ui = render(
      <NavigationContext.Provider value={() => {}}>
        <ConnectionsTab agentName="slugger" refreshGeneration={0} />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    ui.rerender(
      <NavigationContext.Provider value={() => {}}>
        <ConnectionsTab agentName="slugger" refreshGeneration={1} />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6))
  })

  it("re-fetches inner habits and loaded transcript on refresh", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/habits")) return jsonResponse({ totalCount: 1, items: [{ name: "heartbeat", cadence: "5m", lastRun: "2026-04-09T17:00:00.000Z", isOverdue: false, status: "active" }] })
      if (url.endsWith("/habit-runs")) return jsonResponse({ totalCount: 0, limit: 20, items: [] })
      if (url.endsWith("/inner-transcript")) return jsonResponse({ friendId: "self", friendName: "self", channel: "inner", key: "inner", sessionPath: "/tmp/inner.json", messageCount: 0, lastUsage: null, continuity: null, messages: [] })
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const view = makeAgentView()

    const ui = render(
      <NavigationContext.Provider value={() => {}}>
        <InnerTab agentName="slugger" view={view} refreshGeneration={0} />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await act(async () => {
      ui.getByText("Load private runtime").click()
      await flushRefresh()
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    ui.rerender(
      <NavigationContext.Provider value={() => {}}>
        <InnerTab agentName="slugger" view={view} refreshGeneration={1} />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6))
  })

  it("renders habit run history without loading habit transcripts", async () => {
    const habitRuns = {
      totalCount: 2,
      limit: 20,
      items: [{
        runId: "run-mail-check-2026-06-11-long-id-for-wrapping",
        habitName: "mail-check",
        trigger: "cron",
        startedAt: "2026-06-11T10:00:00.000Z",
        endedAt: "2026-06-11T10:02:00.000Z",
        outcome: "blocked",
        nextRunAt: "2026-06-11T10:30:00.000Z",
        permissionEnvelope: {
          schemaVersion: 1,
          canMessageOutward: true,
          returnRoutes: [{ kind: "originator", recipient: "ari/cli/session", status: "allowed", friendId: "ari", channel: "cli", key: "session" }],
          deniedTools: ["shell"],
          warnings: ["originator route checked"],
        },
        toolPolicy: {
          requestedTools: null,
          grantedTools: ["send_message", "surface"],
          deniedTools: ["shell"],
          outwardMessagingAllowed: true,
        },
        producedRefs: [{ kind: "arc", locator: "arc/flight-recorder/latest.json" }],
        surfaceAttempts: [{
          recipient: "ari",
          channel: "cli",
          reason: "needed_input",
          result: "queued",
          routeKind: "originator",
          rawStatus: "queued",
        }],
        errorCount: 1,
        errors: ["need reply target"],
        receiptLocator: "arc/flight-recorder/habit-receipts/run-mail-check-2026-06-11-long-id-for-wrapping.json",
        sessionLocator: "state/habit-sessions/run-mail-check-2026-06-11-long-id-for-wrapping/session.json",
        runtimeStateLocator: "state/habits/mail-check.json",
      }, {
        runId: "run-heartbeat",
        habitName: "heartbeat",
        trigger: "poke",
        startedAt: "2026-06-11T09:00:00.000Z",
        endedAt: "2026-06-11T09:01:00.000Z",
        outcome: "surfaced",
        nextRunAt: null,
        permissionEnvelope: { schemaVersion: 1, canMessageOutward: false, returnRoutes: [], deniedTools: ["send_message", "surface"], warnings: [] },
        toolPolicy: { requestedTools: null, grantedTools: [], deniedTools: ["send_message", "surface"], outwardMessagingAllowed: false },
        producedRefs: [],
        surfaceAttempts: [{ recipient: "ari", channel: "cli", reason: "status", result: "failed", error: "offline" }],
        errorCount: 0,
        errors: [],
        receiptLocator: "arc/flight-recorder/habit-receipts/run-heartbeat.json",
        sessionLocator: "state/habit-sessions/run-heartbeat/session.json",
        runtimeStateLocator: "state/habits/heartbeat.json",
      }],
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/habits")) return jsonResponse({ totalCount: 0, activeCount: 0, pausedCount: 0, degradedCount: 0, overdueCount: 0, items: [] })
      if (url.endsWith("/habit-runs")) return jsonResponse(habitRuns)
      if (url.endsWith("/inner-transcript")) return jsonResponse({ transcriptShouldNotLeak: true })
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const view = makeAgentView()

    const ui = render(
      <NavigationContext.Provider value={() => {}}>
        <InnerTab agentName="slugger" view={view} refreshGeneration={0} />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock).toHaveBeenCalledWith("/api/agents/slugger/habit-runs", expect.any(Object))
    expect(ui.getByText("Habit sessions")).toBeTruthy()
    expect(ui.getByText("mail-check")).toBeTruthy()
    expect(ui.getByText("blocked")).toBeTruthy()
    expect(ui.getByText("originator")).toBeTruthy()
    expect(ui.getByText("allowed")).toBeTruthy()
    expect(ui.getByText("ari/cli/session")).toBeTruthy()
    expect(ui.getByText("originator route checked")).toBeTruthy()
    expect(ui.getByText("queued")).toBeTruthy()
    expect(ui.getByText("need reply target")).toBeTruthy()
    expect(ui.getByText("shell")).toBeTruthy()
    expect(ui.getByText("arc/flight-recorder/habit-receipts/run-mail-check-2026-06-11-long-id-for-wrapping.json")).toBeTruthy()
    expect(ui.getByText("failed")).toBeTruthy()
    expect(ui.queryByText("transcriptShouldNotLeak")).toBeNull()

    ui.rerender(
      <NavigationContext.Provider value={() => {}}>
        <InnerTab agentName="slugger" view={view} refreshGeneration={1} />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
  })

  it("does not show an empty habit run ledger while history is loading", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/habits")) return Promise.resolve(jsonResponse({ totalCount: 0, activeCount: 0, pausedCount: 0, degradedCount: 0, overdueCount: 0, items: [] }))
      if (url.endsWith("/habit-runs")) return new Promise<Response>(() => {})
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const view = makeAgentView()

    const ui = render(
      <NavigationContext.Provider value={() => {}}>
        <InnerTab agentName="slugger" view={view} refreshGeneration={0} />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(ui.getByText("Loading runs")).toBeTruthy()
    expect(ui.queryByText("No habit sessions recorded.")).toBeNull()
  })

  it("clears stale habit run rows when refresh cannot reload history", async () => {
    const habitRuns = {
      totalCount: 1,
      limit: 20,
      items: [{
        runId: "run-stale-row",
        habitName: "mail-check",
        trigger: "cron",
        startedAt: "2026-06-11T10:00:00.000Z",
        endedAt: "2026-06-11T10:02:00.000Z",
        outcome: "surfaced",
        nextRunAt: null,
        permissionEnvelope: { schemaVersion: 1, canMessageOutward: true, returnRoutes: [], deniedTools: [], warnings: [] },
        toolPolicy: { requestedTools: null, grantedTools: [], deniedTools: [], outwardMessagingAllowed: true },
        producedRefs: [],
        surfaceAttempts: [],
        errorCount: 0,
        receiptLocator: "arc/flight-recorder/habit-receipts/run-stale-row.json",
        sessionLocator: "state/habit-sessions/run-stale-row/session.json",
        runtimeStateLocator: "state/habits/mail-check.json",
      }],
    }
    let habitRunCalls = 0
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/habits")) return Promise.resolve(jsonResponse({ totalCount: 0, activeCount: 0, pausedCount: 0, degradedCount: 0, overdueCount: 0, items: [] }))
      if (url.endsWith("/habit-runs")) {
        habitRunCalls += 1
        if (habitRunCalls === 1) return Promise.resolve(jsonResponse(habitRuns))
        return Promise.reject(new Error("network down"))
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const view = makeAgentView()
    const ui = render(
      <NavigationContext.Provider value={() => {}}>
        <InnerTab agentName="slugger" view={view} refreshGeneration={0} />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(ui.getByText("mail-check")).toBeTruthy())

    ui.rerender(
      <NavigationContext.Provider value={() => {}}>
        <InnerTab agentName="slugger" view={view} refreshGeneration={1} />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(ui.getByText("Habit sessions unavailable.")).toBeTruthy())
    expect(ui.queryByText("mail-check")).toBeNull()
    expect(ui.queryByText("1 recorded")).toBeNull()
  })

  it("re-fetches notes data when refreshGeneration advances", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/notes")) return jsonResponse({ diaryEntryCount: 0, canonicalNoteCount: 0, recentDiaryEntries: [], recentCanonicalNotes: [] })
      if (url.endsWith("/note-decisions")) return jsonResponse({ totalCount: 0, items: [] })
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const ui = render(<NotesTab agentName="slugger" refreshGeneration={0} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    ui.rerender(<NotesTab agentName="slugger" refreshGeneration={1} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
  })

  it("renders canonical notes in the existing notes tab without removing diary or decisions", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/notes")) {
        return jsonResponse({
          diaryEntryCount: 1,
          canonicalNoteCount: 2,
          recentDiaryEntries: [
            { id: "fact-1", text: "Diary fact still renders.", source: "session", createdAt: "2026-05-14T10:00:00.000Z" },
          ],
          recentCanonicalNotes: [
            {
              filename: "2026-05-14-notes-surface-contract.md",
              title: "Notes surface contract",
              tags: ["mailbox", "archive-removal"],
              preview: "Canonical note preview shown from markdown body.",
              writtenAt: "2026-05-14T17:42:13.000Z",
            },
            {
              filename: "2026-05-13-second-note.md",
              title: "second note",
              tags: [],
              preview: "Older note preview.",
              writtenAt: "2026-05-13T17:42:13.000Z",
            },
          ],
        })
      }
      if (url.endsWith("/note-decisions")) {
        return jsonResponse({
          totalCount: 1,
          items: [
            { timestamp: "2026-05-14T17:00:00.000Z", kind: "note_saved", decision: "saved", reason: "Kept as canonical note.", excerpt: "Canonical note preview" },
          ],
        })
      }
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const ui = render(<NotesTab agentName="slugger" refreshGeneration={0} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    expect(ui.getByRole("button", { name: /Diary \(1\)/ })).toBeTruthy()
    expect(ui.getByRole("button", { name: /Notes \(2\)/ })).toBeTruthy()
    expect(ui.getByRole("button", { name: /Decisions \(1\)/ })).toBeTruthy()
    expect(ui.queryByRole("button", { name: /Journal/i })).toBeNull()

    fireEvent.click(ui.getByRole("button", { name: /Notes \(2\)/ }))

    expect(ui.getByText("Notes surface contract")).toBeTruthy()
    expect(ui.getByText("Canonical note preview shown from markdown body.")).toBeTruthy()
    expect(ui.getByText("mailbox")).toBeTruthy()
    expect(ui.getByText("archive-removal")).toBeTruthy()

    fireEvent.click(ui.getByRole("button", { name: /Diary \(1\)/ }))
    expect(ui.getByText("Diary fact still renders.")).toBeTruthy()
    fireEvent.click(ui.getByRole("button", { name: /Decisions \(1\)/ }))
    expect(ui.getByText("Kept as canonical note.")).toBeTruthy()
  })

  it("renders a clean canonical notes empty state for an empty bundle", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/notes")) {
        return jsonResponse({
          diaryEntryCount: 0,
          canonicalNoteCount: 0,
          recentDiaryEntries: [],
          recentCanonicalNotes: [],
        })
      }
      if (url.endsWith("/note-decisions")) return jsonResponse({ totalCount: 0, items: [] })
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const ui = render(<NotesTab agentName="slugger" refreshGeneration={0} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    fireEvent.click(await ui.findByRole("button", { name: /Notes \(0\)/ }))

    expect(ui.getByText(/No canonical notes yet/i)).toBeTruthy()
  })

  it("re-fetches runtime data when refreshGeneration advances", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/machine/health")) return jsonResponse({ status: "ok", mode: "dev", uptimeSeconds: 60, degradedComponents: [] })
      if (url.endsWith("/machine/logs")) return jsonResponse({ totalLines: 0, entries: [] })
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const view = makeAgentView({
      agent: {
        provider: "none",
        freshness: { status: "fresh", latestActivityAt: null, ageMs: 0 },
      },
    })

    const ui = render(<RuntimeTab agentName="slugger" view={view} refreshGeneration={0} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    ui.rerender(<RuntimeTab agentName="slugger" view={view} refreshGeneration={1} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
  })

  it("renders runtime provider lanes from agent visibility", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/machine/health")) return jsonResponse({ status: "ok", mode: "dev", uptimeSeconds: 60, degradedComponents: [] })
      if (url.endsWith("/machine/logs")) return jsonResponse({ totalLines: 0, entries: [] })
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const view = makeAgentView({
      agent: {
        providers: {
          agentName: "slugger",
          lanes: [
            {
              lane: "outward",
              status: "configured",
              provider: "openai-codex",
              model: "gpt-5.4",
              source: "agent.json",
              readiness: {
                status: "failed",
                checkedAt: "2026-04-14T18:00:00.000Z",
                error: "400 status code",
                attempts: 2,
              },
              credential: { status: "present", source: "vault", revision: "cred_openai" },
              warnings: ["agent.json provider lanes are stale"],
            },
            {
              lane: "inner",
              status: "unconfigured",
              provider: "unconfigured",
              model: "-",
              source: "missing",
              readiness: {
                status: "unknown",
                reason: "agent.json provider lanes are missing",
              },
              credential: {
                status: "missing",
                repairCommand: "ouro use --agent slugger --lane inner --provider minimax --model MiniMax-M2.5",
              },
              repairCommand: "ouro use --agent slugger --lane inner --provider minimax --model MiniMax-M2.5",
              reason: "agent.json provider lanes are missing",
              warnings: [],
            },
          ],
        },
      },
    })

    const ui = render(<RuntimeTab agentName="slugger" view={view} refreshGeneration={0} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    const text = ui.container.textContent ?? ""
    expect(text).toContain("Provider lanes")
    expect(text).toContain("outward")
    expect(text).toContain("openai-codex / gpt-5.4")
    expect(text).toContain("failed: 400 status code")
    expect(text).toContain("attempts: 2")
    expect(text).toContain("credentials: vault")
    expect(text).toContain("revision: cred_openai")
    expect(text).toContain("agent.json provider lanes are stale")
    expect(text).toContain("inner")
    expect(text).toContain("unconfigured")
    expect(text).toContain("repair: ouro use --agent slugger --lane inner --provider minimax --model MiniMax-M2.5")
  })
})
