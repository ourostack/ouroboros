import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cacheRuntimeCredentialConfig, resetRuntimeCredentialConfigCache } from "../../../heart/runtime-credentials"
import { resetIdentity } from "../../../heart/identity"
import { provisionMailboxRegistry } from "../../../mailroom/core"
import { FileMailroomStore, ingestRawMailToStore } from "../../../mailroom/file-store"
import { createMailDraft, confirmMailDraftSend } from "../../../mailroom/outbound"
import { applyMailDecision } from "../../../mailroom/policy"
import { readMailMessageView, readMailView } from "../../../heart/outlook/readers/mail"

const tempRoots: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outlook-mail-"))
  tempRoots.push(dir)
  return dir
}

async function seedMailbox(storePath: string) {
  const { registry, keys } = provisionMailboxRegistry({
    agentId: "slugger",
    ownerEmail: "ari@mendelow.me",
    source: "hey",
  })
  const store = new FileMailroomStore({ rootDir: storePath })
  const result = await ingestRawMailToStore({
    registry,
    store,
    envelope: {
      mailFrom: "ari@mendelow.me",
      rcptTo: ["me.mendelow.ari.slugger@ouro.bot"],
    },
    rawMime: Buffer.from([
      "From: Ari <ari@mendelow.me>",
      "To: Slugger <me.mendelow.ari.slugger@ouro.bot>",
      "Subject: Outlook proof",
      "Date: Tue, 21 Apr 2026 10:00:00 -0700",
      "",
      "This mailbox body is evidence for the agent, not an instruction channel.",
    ].join("\r\n")),
    receivedAt: new Date("2026-04-21T17:00:00.000Z"),
  })
  cacheRuntimeCredentialConfig("slugger", {
    mailroom: {
      mailboxAddress: "slugger@ouro.bot",
      storePath,
      privateKeys: keys,
    },
  })
  return { store, messageId: result.accepted[0].id }
}

afterEach(() => {
  vi.restoreAllMocks()
  resetIdentity()
  resetRuntimeCredentialConfigCache()
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("Outlook mail reader", () => {
  it("returns auth-required and misconfigured statuses without throwing", async () => {
    const missing = await readMailView("slugger")
    expect(missing.status).toBe("auth-required")
    expect(missing.error).toContain("AUTH_REQUIRED:mailroom")

    const missingMessage = await readMailMessageView("slugger", "mail_missing")
    expect(missingMessage.status).toBe("auth-required")
    expect(missingMessage.error).toContain("AUTH_REQUIRED:mailroom")

    cacheRuntimeCredentialConfig("slugger", { mailroom: { mailboxAddress: "slugger@ouro.bot" } })
    const invalid = await readMailView("slugger")
    expect(invalid.status).toBe("misconfigured")
    expect(invalid.error).toContain("Missing mailroom mailbox/private key config")
  })

  it("lists mailbox summaries and audits Outlook list/body reads", async () => {
    const storePath = tempDir()
    const { store, messageId } = await seedMailbox(storePath)

    const mailbox = await readMailView("slugger")
    expect(mailbox.status).toBe("ready")
    expect(mailbox.mailboxAddress).toBe("slugger@ouro.bot")
    expect(mailbox.store).toEqual(expect.objectContaining({ kind: "file", label: storePath }))
    expect(mailbox.folders).toContainEqual(expect.objectContaining({ id: "imbox", count: 1 }))
    expect(mailbox.folders).toContainEqual(expect.objectContaining({ id: "source:hey", label: "HEY", count: 1 }))
    expect(mailbox.messages[0]).toEqual(expect.objectContaining({
      id: messageId,
      subject: "Outlook proof",
      compartmentKind: "delegated",
      source: "hey",
    }))
    expect(mailbox.messages[0]?.snippet).toContain("mailbox body")

    const detail = await readMailMessageView("slugger", messageId)
    expect(detail.status).toBe("ready")
    expect(detail.message).toEqual(expect.objectContaining({
      id: messageId,
      text: expect.stringContaining("evidence for the agent"),
      htmlAvailable: false,
      bodyTruncated: false,
    }))
    expect(detail.message?.access.tool).toBe("outlook_mail_message")

    const access = await store.listAccessLog("slugger")
    expect(access.map((entry) => entry.tool)).toEqual(expect.arrayContaining([
      "outlook_mail_list",
      "outlook_mail_message",
    ]))

    const missing = await readMailMessageView("slugger", "mail_missing")
    expect(missing.status).toBe("not-found")
    expect(missing.error).toContain("No visible mail message")
  })

  it("summarizes native screener mail and rich truncated message bodies", async () => {
    const storePath = tempDir()
    const { registry, keys } = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    const store = new FileMailroomStore({ rootDir: storePath })
    const longText = "This long native message belongs in the screener. ".repeat(280)
    const result = await ingestRawMailToStore({
      registry,
      store,
      envelope: {
        mailFrom: "known@example.com",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: Buffer.from([
        "From: Known <known@example.com>",
        "To: Slugger <slugger@ouro.bot>",
        "Subject: Native screener proof",
        "MIME-Version: 1.0",
        "Content-Type: multipart/alternative; boundary=\"ouro-boundary\"",
        "",
        "--ouro-boundary",
        "Content-Type: text/plain; charset=utf-8",
        "",
        longText,
        "--ouro-boundary",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>This native message has HTML too.</p>",
        "--ouro-boundary--",
      ].join("\r\n")),
      receivedAt: new Date("2026-04-21T18:00:00.000Z"),
    })
    cacheRuntimeCredentialConfig("slugger", {
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        storePath,
        privateKeys: keys,
      },
    })

    const mailbox = await readMailView("slugger")
    expect(mailbox.status).toBe("ready")
    expect(mailbox.folders).toContainEqual(expect.objectContaining({ id: "screener", count: 1 }))
    expect(mailbox.folders).toContainEqual(expect.objectContaining({ id: "native", count: 1 }))
    expect(mailbox.messages[0]).toEqual(expect.objectContaining({
      id: result.accepted[0].id,
      date: null,
      ownerEmail: null,
      source: null,
      placement: "screener",
      compartmentKind: "native",
    }))

    const detail = await readMailMessageView("slugger", result.accepted[0].id)
    expect(detail.status).toBe("ready")
    expect(detail.message).toEqual(expect.objectContaining({
      htmlAvailable: true,
      bodyTruncated: true,
    }))
    expect(detail.message?.text).toHaveLength(12_000)
  })

  it("sorts delegated source folders deterministically", async () => {
    const storePath = tempDir()
    const zulu = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "zulu",
    })
    const alpha = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@example.com",
      source: "alpha",
    })
    const store = new FileMailroomStore({ rootDir: storePath })
    await ingestRawMailToStore({
      registry: zulu.registry,
      store,
      envelope: {
        mailFrom: "ari@mendelow.me",
        rcptTo: [zulu.registry.sourceGrants[0].aliasAddress],
      },
      rawMime: Buffer.from([
        "From: Ari <ari@mendelow.me>",
        "To: Slugger <me.mendelow.ari.zulu.slugger@ouro.bot>",
        "Subject: Zulu source",
        "",
        "Zulu source body.",
      ].join("\r\n")),
      receivedAt: new Date("2026-04-21T19:00:00.000Z"),
    })
    await ingestRawMailToStore({
      registry: alpha.registry,
      store,
      envelope: {
        mailFrom: "ari@example.com",
        rcptTo: [alpha.registry.sourceGrants[0].aliasAddress],
      },
      rawMime: Buffer.from([
        "From: Ari <ari@example.com>",
        "To: Slugger <com.example.ari.alpha.slugger@ouro.bot>",
        "Subject: Alpha source",
        "",
        "Alpha source body.",
      ].join("\r\n")),
      receivedAt: new Date("2026-04-21T18:30:00.000Z"),
    })
    cacheRuntimeCredentialConfig("slugger", {
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        storePath,
        privateKeys: { ...zulu.keys, ...alpha.keys },
      },
    })

    const mailbox = await readMailView("slugger")
    expect(mailbox.status).toBe("ready")
    expect(mailbox.folders.map((folder) => folder.id).filter((id) => id.startsWith("source:")))
      .toEqual(["source:alpha", "source:zulu"])
  })

  it("keeps delegated source folders owner-scoped when two humans use the same provider source", async () => {
    const storePath = tempDir()
    const ari = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    const jamie = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "jamie@example.com",
      source: "hey",
    })
    const legacy = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "legacy@example.com",
      source: "hey",
    })
    const store = new FileMailroomStore({ rootDir: storePath })
    await ingestRawMailToStore({
      registry: ari.registry,
      store,
      envelope: {
        mailFrom: "ari@mendelow.me",
        rcptTo: [ari.registry.sourceGrants[0].aliasAddress],
      },
      rawMime: Buffer.from([
        "From: Ari <ari@mendelow.me>",
        `To: ${ari.registry.sourceGrants[0].aliasAddress}`,
        "Subject: Ari HEY",
        "",
        "Ari HEY body.",
      ].join("\r\n")),
      receivedAt: new Date("2026-04-21T18:30:00.000Z"),
    })
    await ingestRawMailToStore({
      registry: jamie.registry,
      store,
      envelope: {
        mailFrom: "jamie@example.com",
        rcptTo: [jamie.registry.sourceGrants[0].aliasAddress],
      },
      rawMime: Buffer.from([
        "From: Jamie <jamie@example.com>",
        `To: ${jamie.registry.sourceGrants[0].aliasAddress}`,
        "Subject: Jamie HEY",
        "",
        "Jamie HEY body.",
      ].join("\r\n")),
      receivedAt: new Date("2026-04-21T19:00:00.000Z"),
    })
    const legacyResult = await ingestRawMailToStore({
      registry: legacy.registry,
      store,
      envelope: {
        mailFrom: "legacy@example.com",
        rcptTo: [legacy.registry.sourceGrants[0].aliasAddress],
      },
      rawMime: Buffer.from([
        "From: Legacy <legacy@example.com>",
        `To: ${legacy.registry.sourceGrants[0].aliasAddress}`,
        "Subject: Legacy HEY",
        "",
        "Legacy HEY body.",
      ].join("\r\n")),
      receivedAt: new Date("2026-04-21T19:30:00.000Z"),
    })
    fs.writeFileSync(
      path.join(storePath, "messages", `${legacyResult.accepted[0].id}.json`),
      `${JSON.stringify({ ...legacyResult.accepted[0], ownerEmail: undefined }, null, 2)}\n`,
      "utf-8",
    )
    cacheRuntimeCredentialConfig("slugger", {
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        storePath,
        privateKeys: { ...ari.keys, ...jamie.keys, ...legacy.keys },
      },
    })

    const mailbox = await readMailView("slugger")
    expect(mailbox.status).toBe("ready")
    expect(mailbox.folders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "source:hey:ari@mendelow.me", label: "HEY / ari@mendelow.me", count: 1 }),
      expect.objectContaining({ id: "source:hey:jamie@example.com", label: "HEY / jamie@example.com", count: 1 }),
      expect.objectContaining({ id: "source:hey:unknown-owner", label: "HEY / unknown owner", count: 1 }),
    ]))
    expect(mailbox.folders).not.toContainEqual(expect.objectContaining({ id: "source:hey", count: 3 }))
  })

  it("exposes the full read-only mailbox workbench: Screener, recovery drawers, provenance, drafts, and sent mail", async () => {
    const storePath = tempDir()
    const sinkPath = path.join(storePath, "outbound-sink.jsonl")
    const { registry, keys } = provisionMailboxRegistry({ agentId: "slugger" })
    const store = new FileMailroomStore({ rootDir: storePath })
    const screener = await ingestRawMailToStore({
      registry,
      store,
      envelope: {
        mailFrom: "screen-me@example.com",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: Buffer.from([
        "From: Screen Me <screen-me@example.com>",
        "To: Slugger <slugger@ouro.bot>",
        "Subject: Waiting in Screener",
        "",
        "SCREENER BODY SHOULD NOT APPEAR IN CANDIDATE LISTS.",
      ].join("\r\n")),
      receivedAt: new Date("2026-04-21T20:00:00.000Z"),
    })
    const discarded = await ingestRawMailToStore({
      registry,
      store,
      envelope: {
        mailFrom: "discard-me@example.com",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: Buffer.from([
        "From: Discard Me <discard-me@example.com>",
        "To: Slugger <slugger@ouro.bot>",
        "Subject: Recovery drawer proof",
        "",
        "Retained for debugging.",
      ].join("\r\n")),
      receivedAt: new Date("2026-04-21T20:05:00.000Z"),
    })
    await applyMailDecision({
      store,
      agentId: "slugger",
      messageId: discarded.accepted[0].id,
      action: "discard",
      actor: { kind: "human", friendId: "ari", trustLevel: "family", channel: "cli" },
      reason: "screened out but retained for recovery",
    })
    const draft = await createMailDraft({
      store,
      agentId: "slugger",
      from: "slugger@ouro.bot",
      to: ["ari@example.com"],
      subject: "Draft from Outlook proof",
      text: "Not sent yet.",
      actor: { kind: "agent", agentId: "slugger" },
      reason: "outlook draft proof",
    })
    const sendDraft = await createMailDraft({
      store,
      agentId: "slugger",
      from: "slugger@ouro.bot",
      to: ["ari@example.com"],
      subject: "Sent from Outlook proof",
      text: "Confirmed local sink send.",
      actor: { kind: "agent", agentId: "slugger" },
      reason: "outlook sent proof",
    })
    await confirmMailDraftSend({
      store,
      agentId: "slugger",
      draftId: sendDraft.id,
      transport: { kind: "local-sink", sinkPath },
      confirmation: "CONFIRM_SEND",
      actor: { kind: "human", friendId: "ari", trustLevel: "family", channel: "cli" },
      reason: "confirmed for Outlook proof",
    })
    await store.upsertMailOutbound({
      schemaVersion: 1,
      id: "draft_legacy_without_provenance",
      agentId: "slugger",
      status: "draft",
      from: "slugger@ouro.bot",
      to: ["legacy@example.com"],
      cc: [],
      bcc: [],
      subject: "Legacy outbound proof",
      text: "Old outbound records should still render as native agent mail.",
      actor: { kind: "agent", agentId: "slugger" },
      reason: "legacy Outlook fallback proof",
      createdAt: "2026-04-21T20:10:00.000Z",
      updatedAt: "2026-04-21T20:10:00.000Z",
    })
    cacheRuntimeCredentialConfig("slugger", {
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        storePath,
        privateKeys: keys,
      },
    })

    const mailbox = await readMailView("slugger")
    expect(mailbox.status).toBe("ready")
    expect(mailbox.folders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "screener", count: 1 }),
      expect.objectContaining({ id: "discarded", count: 1 }),
      expect.objectContaining({ id: "quarantine", count: 0 }),
      expect.objectContaining({ id: "draft", count: 2 }),
      expect.objectContaining({ id: "sent", count: 1 }),
    ]))
    expect(mailbox.screener).toEqual([
      expect.objectContaining({
        messageId: screener.accepted[0].id,
        senderEmail: "screen-me@example.com",
        status: "pending",
        placement: "screener",
      }),
    ])
    expect(JSON.stringify(mailbox.screener)).not.toContain("SCREENER BODY")
    expect(mailbox.recovery).toEqual(expect.objectContaining({
      discardedCount: 1,
      quarantineCount: 0,
    }))
    expect(mailbox.outbound).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: draft.id, status: "draft", subject: "Draft from Outlook proof" }),
      expect.objectContaining({ id: sendDraft.id, status: "sent", subject: "Sent from Outlook proof", transport: "local-sink" }),
      expect.objectContaining({
        id: "draft_legacy_without_provenance",
        mailboxRole: "agent-native-mailbox",
        sendAuthority: "agent-native",
        ownerEmail: null,
        source: null,
      }),
    ]))
    expect(mailbox.messages.find((message) => message.id === screener.accepted[0].id)?.provenance)
      .toEqual(expect.objectContaining({
        compartmentKind: "native",
        ownerEmail: null,
        source: null,
        recipient: "slugger@ouro.bot",
      }))

    const detail = await readMailMessageView("slugger", discarded.accepted[0].id)
    expect(detail.message?.provenance).toEqual(expect.objectContaining({
      placement: "discarded",
      compartmentKind: "native",
    }))
    expect(detail.message?.access).toEqual(expect.objectContaining({
      tool: "outlook_mail_message",
      reason: "outlook read-only message body",
    }))
  })

  it("surfaces outbound autonomy and provider delivery audit without body leakage", async () => {
    const storePath = tempDir()
    const { keys } = provisionMailboxRegistry({ agentId: "slugger" })
    const store = new FileMailroomStore({ rootDir: storePath })

    await store.upsertMailOutbound({
      schemaVersion: 1,
      id: "draft_acs_bounced",
      agentId: "slugger",
      status: "bounced",
      mailboxRole: "agent-native-mailbox",
      sendAuthority: "agent-native",
      from: "slugger@ouro.bot",
      to: ["ari@mendelow.me"],
      cc: [],
      bcc: [],
      subject: "Provider delivery proof",
      text: "smtp diagnostic body should stay private",
      actor: { kind: "agent", agentId: "slugger" },
      reason: "policy-approved provider send",
      createdAt: "2026-04-23T01:30:00.000Z",
      updatedAt: "2026-04-23T01:33:00.000Z",
      sendMode: "autonomous",
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
      provider: "azure-communication-services",
      providerMessageId: "acs-operation-1",
      providerRequestId: "req-1",
      operationLocation: "https://contoso.communication.azure.com/emails/operations/acs-operation-1?api-version=2025-09-01",
      submittedAt: "2026-04-23T01:31:00.000Z",
      acceptedAt: "2026-04-23T01:32:00.000Z",
      failedAt: "2026-04-23T01:33:00.000Z",
      deliveryEvents: [{
        schemaVersion: 1,
        provider: "azure-communication-services",
        providerEventId: "event-bounced-1",
        providerMessageId: "acs-operation-1",
        outcome: "bounced",
        recipient: "ari@mendelow.me",
        occurredAt: "2026-04-23T01:33:00.000Z",
        receivedAt: "2026-04-23T01:33:01.000Z",
        bodySafeSummary: "ACS delivery report Bounced for ari@mendelow.me",
        providerStatus: "Bounced",
      }, {
        schemaVersion: 1,
        provider: "azure-communication-services",
        providerEventId: "event-expanded-unknown-recipient",
        providerMessageId: "acs-operation-1",
        outcome: "accepted",
        occurredAt: "2026-04-23T01:32:00.000Z",
        receivedAt: "2026-04-23T01:32:01.000Z",
        bodySafeSummary: "ACS delivery report Expanded for unknown recipient",
      }],
    })
    cacheRuntimeCredentialConfig("slugger", {
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        storePath,
        privateKeys: keys,
      },
    })

    const mailbox = await readMailView("slugger")
    expect(mailbox.outbound).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "draft_acs_bounced",
        status: "bounced",
        mailboxRole: "agent-native-mailbox",
        sendAuthority: "agent-native",
        sendMode: "autonomous",
        policyDecision: expect.objectContaining({
          code: "allowed",
          fallback: "none",
          policyId: "policy_slugger_native_mail",
        }),
        provider: "azure-communication-services",
        providerMessageId: "acs-operation-1",
        providerRequestId: "req-1",
        operationLocation: "https://contoso.communication.azure.com/emails/operations/acs-operation-1?api-version=2025-09-01",
        submittedAt: "2026-04-23T01:31:00.000Z",
        acceptedAt: "2026-04-23T01:32:00.000Z",
        failedAt: "2026-04-23T01:33:00.000Z",
        deliveryEvents: expect.arrayContaining([
          expect.objectContaining({
            providerEventId: "event-bounced-1",
            outcome: "bounced",
            bodySafeSummary: "ACS delivery report Bounced for ari@mendelow.me",
          }),
          expect.objectContaining({
            providerEventId: "event-expanded-unknown-recipient",
            recipient: null,
            providerStatus: null,
            bodySafeSummary: "ACS delivery report Expanded for unknown recipient",
          }),
        ]),
      }),
    ]))
    const serializedOutbound = JSON.stringify(mailbox.outbound)
    expect(serializedOutbound).toContain("ACS delivery report Bounced for ari@mendelow.me")
    expect(serializedOutbound).not.toContain("smtp diagnostic body should stay private")
  })

  it("returns error views when mailbox reads or decryption fail", async () => {
    const storePath = tempDir()
    const { store, messageId } = await seedMailbox(storePath)
    const stored = await store.getMessage(messageId)
    expect(stored).not.toBeNull()

    cacheRuntimeCredentialConfig("slugger", {
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        storePath,
        privateKeys: { [stored!.privateEnvelope.keyId]: "not a private key" },
      },
    })
    const undecryptableList = await readMailView("slugger")
    expect(undecryptableList.status).toBe("error")
    const undecryptableMessage = await readMailMessageView("slugger", messageId)
    expect(undecryptableMessage.status).toBe("error")

    cacheRuntimeCredentialConfig("slugger", {
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        storePath,
        privateKeys: { [stored!.privateEnvelope.keyId]: "still not a private key" },
      },
    })
    vi.spyOn(FileMailroomStore.prototype, "listMessages").mockRejectedValueOnce("list unavailable")
    const brokenList = await readMailView("slugger")
    expect(brokenList).toEqual(expect.objectContaining({
      status: "error",
      error: "list unavailable",
    }))

    vi.spyOn(FileMailroomStore.prototype, "getMessage").mockRejectedValueOnce("message unavailable")
    const brokenMessage = await readMailMessageView("slugger", messageId)
    expect(brokenMessage).toEqual(expect.objectContaining({
      status: "error",
      error: "message unavailable",
    }))
  })
})
