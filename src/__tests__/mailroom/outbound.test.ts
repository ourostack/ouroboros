import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FileMailroomStore } from "../../mailroom/file-store"
import {
  confirmMailDraftSend,
  createAcsEmailProviderClient,
  createMailDraft,
  listMailOutboundRecords,
  parseAcsEmailDeliveryReportEvent,
  reconcileOutboundDeliveryEvent,
  resolveOutboundTransport,
  type MailOutboundProviderClient,
} from "../../mailroom/outbound"
import {
  reconcileMailDeliveryEvent,
  type MailOutboundDeliveryEvent,
  type MailOutboundRecord,
} from "../../mailroom/core"

const tempRoots: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-mail-outbound-"))
  tempRoots.push(dir)
  return dir
}

function sinkEntries(sinkPath: string): Array<Record<string, unknown>> {
  return fs.readFileSync(sinkPath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("mail outbound confirmed send", () => {
  it("creates a draft, refuses unconfirmed sends, and sends through the local sink after confirmation", async () => {
    const root = tempDir()
    const store = new FileMailroomStore({ rootDir: path.join(root, "mailroom") })
    const sinkPath = path.join(root, "outbound-sink.jsonl")
    const actor = { kind: "agent" as const, agentId: "slugger" }
    const draft = await createMailDraft({
      store,
      agentId: "slugger",
      from: "slugger@ouro.bot",
      to: ["ari@example.com"],
      cc: ["travel@example.com"],
      subject: "Travel check",
      text: "Can you confirm the train time?",
      actor,
      reason: "ask about upcoming travel",
    })

    expect(draft).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^draft_/),
      status: "draft",
      mailboxRole: "agent-native-mailbox",
      sendAuthority: "agent-native",
      ownerEmail: null,
      source: null,
      from: "slugger@ouro.bot",
      to: ["ari@example.com"],
      subject: "Travel check",
    }))

    await expect(confirmMailDraftSend({
      store,
      agentId: "slugger",
      draftId: draft.id,
      transport: { kind: "local-sink", sinkPath },
      confirmation: "",
      actor,
      reason: "missing confirmation proof",
    })).rejects.toThrow("CONFIRM_SEND")
    expect(fs.existsSync(sinkPath)).toBe(false)

    const sent = await confirmMailDraftSend({
      store,
      agentId: "slugger",
      draftId: draft.id,
      transport: { kind: "local-sink", sinkPath },
      confirmation: "CONFIRM_SEND",
      actor,
      reason: "family confirmed send",
    })

    expect(sent).toEqual(expect.objectContaining({
      id: draft.id,
      status: "sent",
      mailboxRole: "agent-native-mailbox",
      sendAuthority: "agent-native",
      ownerEmail: null,
      source: null,
      sentAt: expect.any(String),
      transport: "local-sink",
    }))
    expect(sinkEntries(sinkPath)).toEqual([
      expect.objectContaining({
        draftId: draft.id,
        from: "slugger@ouro.bot",
        to: ["ari@example.com"],
        subject: "Travel check",
        text: "Can you confirm the train time?",
      }),
    ])
    await expect(listMailOutboundRecords(store, "slugger")).resolves.toEqual([
      expect.objectContaining({ id: draft.id, status: "sent" }),
    ])
  })

  it("requires an enabled native-agent policy before autonomous sending can run", async () => {
    const root = tempDir()
    const store = new FileMailroomStore({ rootDir: path.join(root, "mailroom") })
    const draft = await createMailDraft({
      store,
      agentId: "slugger",
      from: "slugger@ouro.bot",
      to: ["ari@example.com"],
      subject: "Nope",
      text: "This should remain unsent.",
      actor: { kind: "agent", agentId: "slugger" },
      reason: "prove autonomous refusal",
    })

    await expect(confirmMailDraftSend({
      store,
      agentId: "slugger",
      draftId: draft.id,
      transport: { kind: "local-sink", sinkPath: path.join(root, "sink.jsonl") },
      confirmation: "CONFIRM_SEND",
      autonomous: true,
      actor: { kind: "agent", agentId: "slugger" },
      reason: "autonomous send attempt",
    })).rejects.toThrow("Autonomous mail sending requires an enabled native-agent policy")
  })

  it("surfaces missing outbound transport as human-required setup", () => {
    expect(() => resolveOutboundTransport({})).toThrow("outbound mail transport is not configured")
    expect(() => resolveOutboundTransport({ outbound: { transport: "local-sink" } }))
      .toThrow("missing sinkPath")
    expect(() => resolveOutboundTransport({ outbound: { transport: "azure-communication-services" } }))
      .toThrow("missing endpoint")
    expect(resolveOutboundTransport({
      outbound: {
        transport: "azure-communication-services",
        endpoint: "https://mail.communication.azure.com",
        senderAddress: "slugger@ouro.bot",
      },
    })).toEqual({
      kind: "azure-communication-services",
      endpoint: "https://mail.communication.azure.com",
      senderAddress: "slugger@ouro.bot",
    })
    expect(resolveOutboundTransport({
      outbound: {
        transport: "azure-communication-services",
        endpoint: "https://mail.communication.azure.com",
        senderAddress: "   ",
      },
    })).toEqual({
      kind: "azure-communication-services",
      endpoint: "https://mail.communication.azure.com",
    })
    expect(() => resolveOutboundTransport({ outbound: { transport: "smtp" } }))
      .toThrow("choose local-sink or azure-communication-services")
  })

  it("keeps ACS credentials as explicit vault item bindings without parsing notes", () => {
    expect(resolveOutboundTransport({
      outbound: {
        transport: "azure-communication-services",
        endpoint: "https://mail.communication.azure.com",
        senderAddress: "slugger@ouro.bot",
        credentialItem: "ops/mail/azure-communication-services/ouro.bot",
        credentialFields: { accessKey: "accessKey", connectionString: "connectionString" },
      },
    })).toEqual({
      kind: "azure-communication-services",
      endpoint: "https://mail.communication.azure.com",
      senderAddress: "slugger@ouro.bot",
      credentialItem: "ops/mail/azure-communication-services/ouro.bot",
      credentialFields: { accessKey: "accessKey", connectionString: "connectionString" },
    })
    expect(resolveOutboundTransport({
      outbound: {
        transport: "azure-communication-services",
        endpoint: "https://mail.communication.azure.com",
        credentialFields: { accessKey: "accessKey" },
      },
    })).toEqual({
      kind: "azure-communication-services",
      endpoint: "https://mail.communication.azure.com",
      credentialFields: { accessKey: "accessKey" },
    })
    expect(resolveOutboundTransport({
      outbound: {
        transport: "azure-communication-services",
        endpoint: "https://mail.communication.azure.com",
        credentialFields: { connectionString: "connectionString" },
      },
    })).toEqual({
      kind: "azure-communication-services",
      endpoint: "https://mail.communication.azure.com",
      credentialFields: { connectionString: "connectionString" },
    })
    expect(resolveOutboundTransport({
      outbound: {
        transport: "azure-communication-services",
        endpoint: "https://mail.communication.azure.com",
        credentialFields: { accessKey: "  ", connectionString: "  " },
      },
    })).toEqual({
      kind: "azure-communication-services",
      endpoint: "https://mail.communication.azure.com",
    })
    expect(() => resolveOutboundTransport({
      outbound: {
        transport: "azure-communication-services",
        endpoint: "https://mail.communication.azure.com",
        credentialItemNoteQuery: "find the Azure email key",
      },
    })).toThrow("outbound provider binding must not infer credentials from vault notes")
    expect(() => resolveOutboundTransport({
      outbound: {
        transport: "azure-communication-services",
        endpoint: "https://mail.communication.azure.com",
        noteQuery: "find the Azure email key",
      },
    })).toThrow("outbound provider binding must not infer credentials from vault notes")
    expect(() => resolveOutboundTransport({
      outbound: {
        transport: "azure-communication-services",
        endpoint: "https://mail.communication.azure.com",
        notes: "the key is somewhere in the vault",
      },
    })).toThrow("outbound provider binding must not infer credentials from vault notes")
  })

  it("covers recipient, missing draft, already-sent, and ACS refusal branches", async () => {
    const root = tempDir()
    const store = new FileMailroomStore({ rootDir: path.join(root, "mailroom") })
    const actor = { kind: "agent" as const, agentId: "slugger" }

    await expect(createMailDraft({
      store,
      agentId: "slugger",
      from: "slugger@ouro.bot",
      to: ["  "],
      subject: "No recipient",
      text: "Nope.",
      actor,
      reason: "recipient validation",
    })).rejects.toThrow("at least one recipient")

    await expect(confirmMailDraftSend({
      store,
      agentId: "slugger",
      draftId: "draft_missing",
      transport: { kind: "local-sink", sinkPath: path.join(root, "sink.jsonl") },
      confirmation: "CONFIRM_SEND",
      actor,
      reason: "missing draft validation",
    })).rejects.toThrow("No draft found")

    const draft = await createMailDraft({
      store,
      agentId: "slugger",
      from: "slugger@ouro.bot",
      to: ["ari@example.com"],
      subject: "ACS proof",
      text: "This should not leave through ACS yet.",
      actor,
      reason: "acs refusal proof",
    })
    await expect(confirmMailDraftSend({
      store,
      agentId: "slugger",
      draftId: draft.id,
      transport: { kind: "azure-communication-services", endpoint: "https://mail.communication.azure.com" },
      confirmation: "CONFIRM_SEND",
      actor,
      reason: "acs not enabled",
    })).rejects.toThrow("Azure Communication Services outbound send is configured but not enabled")

    const sent = await confirmMailDraftSend({
      store,
      agentId: "slugger",
      draftId: draft.id,
      transport: { kind: "local-sink", sinkPath: path.join(root, "sink.jsonl") },
      confirmation: "CONFIRM_SEND",
      actor,
      reason: "send once",
    })
    await expect(confirmMailDraftSend({
      store,
      agentId: "slugger",
      draftId: sent.id,
      transport: { kind: "local-sink", sinkPath: path.join(root, "sink.jsonl") },
      confirmation: "CONFIRM_SEND",
      actor,
      reason: "send twice",
    })).rejects.toThrow("already sent")
  })

  it("submits through ACS without treating provider acceptance as final delivery, then reconciles events idempotently", async () => {
    const root = tempDir()
    const store = new FileMailroomStore({ rootDir: path.join(root, "mailroom") })
    const providerClient: MailOutboundProviderClient = {
      submit: vi.fn(async () => ({
        provider: "azure-communication-services",
        providerMessageId: "acs-operation-1",
        operationLocation: "https://contoso.communication.azure.com/emails/operations/acs-operation-1?api-version=2025-09-01",
        providerRequestId: "req-1",
        submittedAt: "2026-04-23T01:31:00.000Z",
      })),
    }
    const draft = await createMailDraft({
      store,
      agentId: "slugger",
      from: "slugger@ouro.bot",
      to: ["ari@mendelow.me"],
      subject: "Provider submit",
      text: "Provider acceptance is not delivery.",
      actor: { kind: "agent", agentId: "slugger" },
      reason: "acs submit proof",
    })

    const submitted = await confirmMailDraftSend({
      store,
      agentId: "slugger",
      draftId: draft.id,
      transport: { kind: "azure-communication-services", endpoint: "https://contoso.communication.azure.com" },
      confirmation: "CONFIRM_SEND",
      actor: { kind: "agent", agentId: "slugger" },
      reason: "confirmed provider submit",
      providerClient,
      now: () => new Date("2026-04-23T01:31:00.000Z"),
    })

    expect(providerClient.submit).toHaveBeenCalledWith(expect.objectContaining({
      draft: expect.objectContaining({ id: draft.id, from: "slugger@ouro.bot", to: ["ari@mendelow.me"] }),
      transport: expect.objectContaining({ kind: "azure-communication-services" }),
    }))
    expect(submitted).toEqual(expect.objectContaining({
      status: "submitted",
      provider: "azure-communication-services",
      providerMessageId: "acs-operation-1",
      submittedAt: "2026-04-23T01:31:00.000Z",
      deliveryEvents: [],
    }))
    expect(submitted).not.toHaveProperty("deliveredAt")

    const event = parseAcsEmailDeliveryReportEvent({
      id: "event-delivered-1",
      eventType: "Microsoft.Communication.EmailDeliveryReportReceived",
      eventTime: "2026-04-23T01:35:00.000Z",
      data: {
        sender: "slugger@ouro.bot",
        recipient: "ari@mendelow.me",
        messageId: "acs-operation-1",
        status: "Delivered",
        deliveryStatusDetails: { statusMessage: "250 2.0.0 accepted" },
        deliveryAttemptTimeStamp: "2026-04-23T01:34:59.000Z",
      },
    })

    const delivered = await reconcileOutboundDeliveryEvent({ store, agentId: "slugger", event })
    expect(delivered).toEqual(expect.objectContaining({
      id: draft.id,
      status: "delivered",
      deliveredAt: "2026-04-23T01:34:59.000Z",
    }))
    expect(delivered.deliveryEvents).toHaveLength(1)

    const duplicate = await reconcileOutboundDeliveryEvent({ store, agentId: "slugger", event })
    expect(duplicate.deliveryEvents).toHaveLength(1)
  })

  it("maps all ACS delivery outcomes and rejects mismatched delivery events", () => {
    const statuses: Array<[string, MailOutboundDeliveryEvent["outcome"]]> = [
      ["Delivered", "delivered"],
      ["Suppressed", "suppressed"],
      ["Bounced", "bounced"],
      ["Quarantined", "quarantined"],
      ["FilteredSpam", "spam-filtered"],
      ["Expanded", "accepted"],
      ["Failed", "failed"],
    ]

    for (const [status, outcome] of statuses) {
      expect(parseAcsEmailDeliveryReportEvent({
        id: `event-${status}`,
        eventType: "Microsoft.Communication.EmailDeliveryReportReceived",
        eventTime: "2026-04-23T01:35:00.000Z",
        data: {
          recipient: "ARI@MENDELOW.ME",
          messageId: "acs-operation-1",
          status,
        },
      })).toEqual(expect.objectContaining({
        providerEventId: `event-${status}`,
        providerMessageId: "acs-operation-1",
        outcome,
        recipient: "ari@mendelow.me",
        occurredAt: "2026-04-23T01:35:00.000Z",
        receivedAt: "2026-04-23T01:35:00.000Z",
      }))
    }

    expect(() => parseAcsEmailDeliveryReportEvent({
      id: "event-missing-type",
      data: { messageId: "acs-operation-1", status: "Delivered" },
    })).toThrow("unsupported ACS event type: unknown")
    expect(() => parseAcsEmailDeliveryReportEvent({
      id: "event-wrong-type",
      eventType: "Microsoft.Communication.EmailEngagementTrackingReportReceived",
      data: { messageId: "acs-operation-1", status: "Delivered" },
    })).toThrow("unsupported ACS event type")
    expect(() => parseAcsEmailDeliveryReportEvent({
      eventType: "Microsoft.Communication.EmailDeliveryReportReceived",
      data: { messageId: "acs-operation-1", status: "Delivered" },
    })).toThrow("ACS delivery event is missing id")
    expect(() => parseAcsEmailDeliveryReportEvent([]))
      .toThrow("ACS delivery event is missing id")
    expect(() => parseAcsEmailDeliveryReportEvent({
      id: "event-missing-message",
      eventType: "Microsoft.Communication.EmailDeliveryReportReceived",
      data: { status: "Delivered" },
    })).toThrow("ACS delivery event is missing messageId")
    expect(() => parseAcsEmailDeliveryReportEvent({
      id: "event-array-data",
      eventType: "Microsoft.Communication.EmailDeliveryReportReceived",
      data: [],
    })).toThrow("ACS delivery event is missing messageId")
    expect(() => parseAcsEmailDeliveryReportEvent({
      id: "event-unknown-status",
      eventType: "Microsoft.Communication.EmailDeliveryReportReceived",
      data: { messageId: "acs-operation-1", status: "Mystery" },
    })).toThrow("unsupported ACS delivery status")
    expect(() => parseAcsEmailDeliveryReportEvent({
      id: "event-empty-status",
      eventType: "Microsoft.Communication.EmailDeliveryReportReceived",
      data: { messageId: "acs-operation-1", status: "" },
    })).toThrow("unsupported ACS delivery status: unknown")
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-04-23T01:36:00.000Z"))
    try {
      expect(parseAcsEmailDeliveryReportEvent({
        id: "event-no-recipient",
        eventType: "Microsoft.Communication.EmailDeliveryReportReceived",
        data: { messageId: "acs-operation-1", status: "Delivered" },
      })).toEqual(expect.objectContaining({
        providerEventId: "event-no-recipient",
        occurredAt: "2026-04-23T01:36:00.000Z",
        receivedAt: "2026-04-23T01:36:00.000Z",
        bodySafeSummary: "ACS delivery report Delivered for unknown recipient",
      }))
    } finally {
      vi.useRealTimers()
    }

    const outbound: MailOutboundRecord = {
      schemaVersion: 1,
      id: "draft_1",
      agentId: "slugger",
      status: "submitted",
      mailboxRole: "agent-native-mailbox",
      sendAuthority: "agent-native",
      ownerEmail: null,
      source: null,
      from: "slugger@ouro.bot",
      to: ["ari@mendelow.me"],
      cc: [],
      bcc: [],
      subject: "Provider status",
      text: "Track every provider outcome.",
      actor: { kind: "agent", agentId: "slugger" },
      reason: "delivery evidence",
      createdAt: "2026-04-23T01:30:00.000Z",
      updatedAt: "2026-04-23T01:31:00.000Z",
      provider: "azure-communication-services",
      providerMessageId: "acs-operation-1",
      submittedAt: "2026-04-23T01:31:00.000Z",
    }
    const acceptedEvent: MailOutboundDeliveryEvent = {
      schemaVersion: 1,
      provider: "azure-communication-services",
      providerEventId: "event-accepted",
      providerMessageId: "acs-operation-1",
      outcome: "accepted",
      occurredAt: "2026-04-23T01:32:00.000Z",
      receivedAt: "2026-04-23T01:32:01.000Z",
      bodySafeSummary: "ACS delivery report Expanded for unknown recipient",
      providerStatus: "Expanded",
    }
    const accepted = reconcileMailDeliveryEvent({ outbound, event: acceptedEvent })
    expect(accepted).toEqual(expect.objectContaining({
      status: "accepted",
      acceptedAt: "2026-04-23T01:32:00.000Z",
      deliveryEvents: [acceptedEvent],
    }))

    const bouncedEvent: MailOutboundDeliveryEvent = {
      ...acceptedEvent,
      providerEventId: "event-bounced",
      outcome: "bounced",
      occurredAt: "2026-04-23T01:33:00.000Z",
      providerStatus: "Bounced",
    }
    const bounced = reconcileMailDeliveryEvent({ outbound: accepted, event: bouncedEvent })
    expect(bounced).toEqual(expect.objectContaining({
      status: "bounced",
      failedAt: "2026-04-23T01:33:00.000Z",
    }))
    expect(bounced.deliveryEvents).toHaveLength(2)

    expect(() => reconcileMailDeliveryEvent({
      outbound,
      event: { ...acceptedEvent, providerMessageId: "different-operation" },
    })).toThrow("delivery event providerMessageId does not match outbound record")
  })

  it("signs ACS REST sends through the provider client without leaking the access key", async () => {
    const accessKey = Buffer.from("acs-secret-key").toString("base64")
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
      id: "acs-operation-1",
      status: "Running",
    }), {
      status: 202,
      headers: {
        "operation-location": "https://contoso.communication.azure.com/emails/operations/acs-operation-1?api-version=2025-09-01",
        "x-ms-request-id": "req-1",
      },
    }))
    const client = createAcsEmailProviderClient({
      endpoint: "https://contoso.communication.azure.com",
      accessKey,
      fetch: fetchImpl,
      now: () => new Date("2026-04-23T01:31:00.000Z"),
    })

    const result = await client.submit({
      draft: {
        schemaVersion: 1,
        id: "draft_1",
        agentId: "slugger",
        status: "submitted",
        mailboxRole: "agent-native-mailbox",
        sendAuthority: "agent-native",
        ownerEmail: null,
        source: null,
        from: "slugger@ouro.bot",
        to: ["ari@mendelow.me"],
        cc: ["ops@example.com"],
        bcc: [],
        subject: "ACS REST proof",
        text: "Hello from the provider client.",
        actor: { kind: "agent", agentId: "slugger" },
        reason: "prove ACS signing",
        createdAt: "2026-04-23T01:30:00.000Z",
        updatedAt: "2026-04-23T01:30:00.000Z",
      },
      transport: {
        kind: "azure-communication-services",
        endpoint: "https://contoso.communication.azure.com",
        senderAddress: "slugger@ouro.bot",
      },
      submittedAt: "2026-04-23T01:31:00.000Z",
    })

    expect(result).toEqual({
      provider: "azure-communication-services",
      providerMessageId: "acs-operation-1",
      operationLocation: "https://contoso.communication.azure.com/emails/operations/acs-operation-1?api-version=2025-09-01",
      providerRequestId: "req-1",
      submittedAt: "2026-04-23T01:31:00.000Z",
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://contoso.communication.azure.com/emails:send?api-version=2025-09-01",
      expect.objectContaining({ method: "POST" }),
    )
    const init = fetchImpl.mock.calls[0]![1]
    const headers = new Headers(init.headers)
    expect(headers.get("x-ms-date")).toBe("Thu, 23 Apr 2026 01:31:00 GMT")
    expect(headers.get("x-ms-content-sha256")).toBeTruthy()
    expect(headers.get("authorization")).toMatch(/^HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=/)
    expect(String(init.body)).toContain("\"senderAddress\":\"slugger@ouro.bot\"")
    expect(String(init.body)).toContain("\"plainText\":\"Hello from the provider client.\"")
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain(accessKey)
  })

  it("handles ACS REST provider edge cases without leaking provider secrets", async () => {
    const accessKey = Buffer.from("acs-secret-key").toString("base64")
    const draft: MailOutboundRecord = {
      schemaVersion: 1,
      id: "draft_1",
      agentId: "slugger",
      status: "submitted",
      mailboxRole: "agent-native-mailbox",
      sendAuthority: "agent-native",
      ownerEmail: null,
      source: null,
      from: "slugger@ouro.bot",
      to: ["ari@mendelow.me"],
      cc: [],
      bcc: [],
      subject: "ACS REST edge proof",
      text: "Exercise provider edge paths.",
      actor: { kind: "agent", agentId: "slugger" },
      reason: "prove ACS edge behavior",
      createdAt: "2026-04-23T01:30:00.000Z",
      updatedAt: "2026-04-23T01:30:00.000Z",
    }
    const submitInput = {
      draft,
      transport: {
        kind: "azure-communication-services" as const,
        endpoint: "https://contoso.communication.azure.com",
      },
      submittedAt: "2026-04-23T01:31:00.000Z",
    }

    const fromOperationLocation = createAcsEmailProviderClient({
      endpoint: "https://contoso.communication.azure.com/",
      accessKey,
      fetch: vi.fn(async () => new Response(JSON.stringify({ status: "Running" }), {
        status: 202,
        headers: {
          "operation-location": "https://contoso.communication.azure.com/emails/operations/acs-operation-from-location?api-version=2025-09-01",
        },
      })),
      now: () => new Date("2026-04-23T01:31:00.000Z"),
    })
    await expect(fromOperationLocation.submit(submitInput)).resolves.toEqual({
      provider: "azure-communication-services",
      providerMessageId: "acs-operation-from-location",
      operationLocation: "https://contoso.communication.azure.com/emails/operations/acs-operation-from-location?api-version=2025-09-01",
      submittedAt: "2026-04-23T01:31:00.000Z",
    })

    const idOnly = createAcsEmailProviderClient({
      endpoint: "https://contoso.communication.azure.com",
      accessKey,
      fetch: vi.fn(async () => new Response(JSON.stringify({ id: "acs-operation-id-only", status: "Running" }), {
        status: 202,
      })),
      now: () => new Date("2026-04-23T01:31:00.000Z"),
    })
    await expect(idOnly.submit(submitInput)).resolves.toEqual({
      provider: "azure-communication-services",
      providerMessageId: "acs-operation-id-only",
      submittedAt: "2026-04-23T01:31:00.000Z",
    })

    const originalFetch = globalThis.fetch
    const fetchDefault = vi.fn(async () => new Response(JSON.stringify({ id: "acs-operation-defaults", status: "Running" }), {
      status: 202,
    }))
    vi.stubGlobal("fetch", fetchDefault)
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-04-23T01:37:00.000Z"))
    try {
      const defaultFetchAndClock = createAcsEmailProviderClient({
        endpoint: "https://contoso.communication.azure.com",
        accessKey,
      })
      await expect(defaultFetchAndClock.submit(submitInput)).resolves.toEqual({
        provider: "azure-communication-services",
        providerMessageId: "acs-operation-defaults",
        submittedAt: "2026-04-23T01:31:00.000Z",
      })
      const headers = new Headers(fetchDefault.mock.calls[0]![1].headers)
      expect(headers.get("x-ms-date")).toBe("Thu, 23 Apr 2026 01:37:00 GMT")
    } finally {
      vi.useRealTimers()
      vi.stubGlobal("fetch", originalFetch)
    }

    const providerError = createAcsEmailProviderClient({
      endpoint: "https://contoso.communication.azure.com",
      accessKey,
      fetch: vi.fn(async () => new Response(JSON.stringify({ error: { message: "sender domain is not verified" } }), {
        status: 400,
      })),
      now: () => new Date("2026-04-23T01:31:00.000Z"),
    })
    await expect(providerError.submit(submitInput)).rejects.toThrow("sender domain is not verified")

    const httpError = createAcsEmailProviderClient({
      endpoint: "https://contoso.communication.azure.com",
      accessKey,
      fetch: vi.fn(async () => new Response("not json", { status: 503 })),
      now: () => new Date("2026-04-23T01:31:00.000Z"),
    })
    await expect(httpError.submit(submitInput)).rejects.toThrow("HTTP 503")

    const missingOperationId = createAcsEmailProviderClient({
      endpoint: "https://contoso.communication.azure.com",
      accessKey,
      fetch: vi.fn(async () => new Response(JSON.stringify({ status: "Running" }), {
        status: 202,
        headers: {
          "operation-location": "https://contoso.communication.azure.com/emails/not-an-operation",
        },
      })),
      now: () => new Date("2026-04-23T01:31:00.000Z"),
    })
    await expect(missingOperationId.submit(submitInput)).rejects.toThrow("ACS outbound send did not return an operation id")

    const missingOperationLocation = createAcsEmailProviderClient({
      endpoint: "https://contoso.communication.azure.com",
      accessKey,
      fetch: vi.fn(async () => new Response(JSON.stringify({ status: "Running" }), { status: 202 })),
      now: () => new Date("2026-04-23T01:31:00.000Z"),
    })
    await expect(missingOperationLocation.submit(submitInput)).rejects.toThrow("ACS outbound send did not return an operation id")
  })

  it("persists minimal provider submissions and reports missing outbound delivery records", async () => {
    const root = tempDir()
    const store = new FileMailroomStore({ rootDir: path.join(root, "mailroom") })
    const providerClient: MailOutboundProviderClient = {
      submit: vi.fn(async () => ({
        provider: "azure-communication-services",
        providerMessageId: "acs-operation-minimal",
      })),
    }
    const draft = await createMailDraft({
      store,
      agentId: "slugger",
      from: "slugger@ouro.bot",
      to: ["ari@mendelow.me"],
      subject: "Minimal provider submit",
      text: "Provider metadata is sometimes sparse.",
      actor: { kind: "agent", agentId: "slugger" },
      reason: "provider sparse metadata proof",
      now: () => new Date("2026-04-23T01:30:00.000Z"),
    })

    const submitted = await confirmMailDraftSend({
      store,
      agentId: "slugger",
      draftId: draft.id,
      transport: { kind: "azure-communication-services", endpoint: "https://contoso.communication.azure.com" },
      confirmation: "CONFIRM_SEND",
      actor: { kind: "agent", agentId: "slugger" },
      reason: "confirmed provider submit",
      providerClient,
      now: () => new Date("2026-04-23T01:31:00.000Z"),
    })

    expect(submitted).toEqual(expect.objectContaining({
      status: "submitted",
      provider: "azure-communication-services",
      providerMessageId: "acs-operation-minimal",
      submittedAt: "2026-04-23T01:31:00.000Z",
      transport: "azure-communication-services",
    }))
    expect(submitted).not.toHaveProperty("operationLocation")
    expect(submitted).not.toHaveProperty("providerRequestId")

    await expect(reconcileOutboundDeliveryEvent({
      store,
      agentId: "slugger",
      event: {
        schemaVersion: 1,
        provider: "azure-communication-services",
        providerEventId: "event-missing-outbound",
        providerMessageId: "missing-operation",
        outcome: "delivered",
        occurredAt: "2026-04-23T01:32:00.000Z",
        receivedAt: "2026-04-23T01:32:01.000Z",
        bodySafeSummary: "ACS delivery report Delivered for unknown recipient",
        providerStatus: "Delivered",
      },
    })).rejects.toThrow("No outbound record found for provider message missing-operation")
  })
})
