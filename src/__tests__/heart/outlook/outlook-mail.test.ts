import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
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
})
