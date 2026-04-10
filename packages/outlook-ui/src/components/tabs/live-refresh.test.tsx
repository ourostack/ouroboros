import { act } from "react"
import { render, waitFor, cleanup } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NavigationContext } from "../../navigation"
import { OverviewTab } from "./overview"
import { SessionsTab } from "./sessions"
import { WorkTab } from "./work"
import { ConnectionsTab } from "./connections"
import { InnerTab } from "./inner"
import { MemoryTab } from "./memory"
import { RuntimeTab } from "./runtime"

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

async function flushRefresh(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("Outlook deep-tab live refresh", () => {
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

    const view = {
      agent: {
        agentName: "slugger",
        degraded: { status: "healthy", issues: [] },
        attention: { level: "idle", label: "steady" },
        senses: [],
      },
      work: {
        tasks: { liveCount: 0, blockedCount: 0 },
        obligations: { openCount: 0 },
        sessions: { liveCount: 0 },
        coding: { activeCount: 0, blockedCount: 0 },
        bridges: [],
      },
      inner: { status: "idle", hasPending: false },
      activity: { freshness: { status: "fresh" }, recent: [] },
    } satisfies Record<string, unknown>

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

  it("re-fetches work deep data when refreshGeneration advances", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/coding")) return jsonResponse({ items: [] })
      if (url.endsWith("/obligations")) return jsonResponse({ openCount: 0, primaryId: null, primarySelectionReason: null, items: [] })
      if (url.endsWith("/self-fix")) return jsonResponse({ active: false, currentStep: null, steps: [] })
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const view = { work: { obligations: { openCount: 0, items: [] }, tasks: { liveCount: 0, blockedCount: 0, liveTaskNames: [], actionRequired: [] } } }

    const ui = render(
      <NavigationContext.Provider value={() => {}}>
        <WorkTab agentName="slugger" view={view} refreshGeneration={0} />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    ui.rerender(
      <NavigationContext.Provider value={() => {}}>
        <WorkTab agentName="slugger" view={view} refreshGeneration={1} />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6))
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
      if (url.endsWith("/inner-transcript")) return jsonResponse({ friendId: "self", friendName: "self", channel: "inner", key: "inner", sessionPath: "/tmp/inner.json", messageCount: 0, lastUsage: null, continuity: null, messages: [] })
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const view = { inner: { status: "idle", hasPending: false } }

    const ui = render(
      <NavigationContext.Provider value={() => {}}>
        <InnerTab agentName="slugger" view={view} refreshGeneration={0} />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await act(async () => {
      ui.getByText("Load inner dialog").click()
      await flushRefresh()
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    ui.rerender(
      <NavigationContext.Provider value={() => {}}>
        <InnerTab agentName="slugger" view={view} refreshGeneration={1} />
      </NavigationContext.Provider>
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
  })

  it("re-fetches memory data when refreshGeneration advances", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/memory")) return jsonResponse({ diaryEntryCount: 0, journalEntryCount: 0, recentDiaryEntries: [], recentJournalEntries: [] })
      if (url.endsWith("/memory-decisions")) return jsonResponse({ totalCount: 0, items: [] })
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const ui = render(<MemoryTab agentName="slugger" refreshGeneration={0} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    ui.rerender(<MemoryTab agentName="slugger" refreshGeneration={1} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
  })

  it("re-fetches runtime data when refreshGeneration advances", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/machine/health")) return jsonResponse({ status: "ok", mode: "dev", uptimeSeconds: 60, degradedComponents: [] })
      if (url.endsWith("/machine/logs")) return jsonResponse({ totalLines: 0, entries: [] })
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const view = { agent: { degraded: { status: "healthy", issues: [] }, freshness: { status: "fresh", ageMs: 0 }, provider: "none", enabled: true } }

    const ui = render(<RuntimeTab agentName="slugger" view={view} refreshGeneration={0} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    ui.rerender(<RuntimeTab agentName="slugger" view={view} refreshGeneration={1} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4))
  })
})
