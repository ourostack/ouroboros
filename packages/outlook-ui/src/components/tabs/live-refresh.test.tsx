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
import type { OutlookAgentView, OutlookTranscriptMessage } from "../../contracts"

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

type AgentViewOverrides = {
  agent?: Partial<OutlookAgentView["agent"]>
  work?: {
    tasks?: Partial<OutlookAgentView["work"]["tasks"]>
    obligations?: Partial<OutlookAgentView["work"]["obligations"]>
    sessions?: Partial<OutlookAgentView["work"]["sessions"]>
    coding?: Partial<OutlookAgentView["work"]["coding"]>
    bridges?: string[]
  }
  inner?: OutlookAgentView["inner"]
  activity?: Partial<OutlookAgentView["activity"]>
}

function makeAgentView(overrides: AgentViewOverrides = {}): OutlookAgentView {
  const base: OutlookAgentView = {
    productName: "Ouro Outlook",
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
    inner: { mode: "summary", status: "idle", summary: null, hasPending: false },
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

function transcriptMessage(sequence: number, role: "user" | "assistant", content: string): OutlookTranscriptMessage {
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

function transcriptPayload(messages: OutlookTranscriptMessage[]) {
  return {
    friendId: "ari",
    friendName: "Ari",
    channel: "bluebubbles",
    key: "main",
    sessionPath: "/tmp/session.json",
    messageCount: messages.length,
    lastUsage: null,
    continuity: null,
    messages,
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("Outlook deep-tab live refresh", () => {
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
    const panel = ui.getByTestId("session-transcript-scroll")
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
    const panel = ui.getByTestId("session-transcript-scroll")
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
    expect(panel.scrollTop).toBe(1200)
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
            subject: "Outlook proof",
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
            subject: "Outlook proof",
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
            access: { tool: "outlook_mail_message", reason: "outlook read-only message body", accessedAt: "2026-04-21T17:00:00.000Z" },
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
    expect(ui.container.textContent).toContain("Outlook proof")
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

  it("re-fetches work deep data when refreshGeneration advances", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/coding")) return jsonResponse({ items: [] })
      if (url.endsWith("/obligations")) return jsonResponse({ openCount: 0, primaryId: null, primarySelectionReason: null, items: [] })
      if (url.endsWith("/self-fix")) return jsonResponse({ active: false, currentStep: null, steps: [] })
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const view = makeAgentView()

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

    const view = makeAgentView()

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

  it("re-fetches notes data when refreshGeneration advances", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/notes")) return jsonResponse({ diaryEntryCount: 0, journalEntryCount: 0, recentDiaryEntries: [], recentJournalEntries: [] })
      if (url.endsWith("/note-decisions")) return jsonResponse({ totalCount: 0, items: [] })
      throw new Error(`unexpected url: ${url}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const ui = render(<NotesTab agentName="slugger" refreshGeneration={0} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    ui.rerender(<NotesTab agentName="slugger" refreshGeneration={1} />)
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
              source: "local",
              readiness: {
                status: "failed",
                checkedAt: "2026-04-14T18:00:00.000Z",
                error: "400 status code",
                attempts: 2,
              },
              credential: { status: "present", source: "vault", revision: "cred_openai" },
              warnings: ["state/providers.json is stale"],
            },
            {
              lane: "inner",
              status: "unconfigured",
              provider: "unconfigured",
              model: "-",
              source: "missing",
              readiness: {
                status: "unknown",
                reason: "state/providers.json is missing",
              },
              credential: {
                status: "missing",
                repairCommand: "ouro use --agent slugger --lane inner --provider minimax --model MiniMax-M2.5",
              },
              repairCommand: "ouro use --agent slugger --lane inner --provider minimax --model MiniMax-M2.5",
              reason: "state/providers.json is missing",
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
    expect(text).toContain("state/providers.json is stale")
    expect(text).toContain("inner")
    expect(text).toContain("unconfigured")
    expect(text).toContain("repair: ouro use --agent slugger --lane inner --provider minimax --model MiniMax-M2.5")
  })
})
