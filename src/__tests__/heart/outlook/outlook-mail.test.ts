import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cacheRuntimeCredentialConfig, resetRuntimeCredentialConfigCache } from "../../../heart/runtime-credentials"
import { resetIdentity } from "../../../heart/identity"
import { provisionMailboxRegistry } from "../../../mailroom/core"
import { FileMailroomStore, ingestRawMailToStore } from "../../../mailroom/file-store"
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
