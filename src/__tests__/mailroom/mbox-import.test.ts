import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { provisionMailboxRegistry } from "../../mailroom/core"
import { decryptMessages, FileMailroomStore } from "../../mailroom/file-store"
import { resetMailSearchCacheForTests } from "../../mailroom/search-cache"
import { cacheMatchingMailSearchDocumentsFromMboxFile, importMboxFileToStore, importMboxToStore, splitMboxMessages } from "../../mailroom/mbox-import"

const tempRoots: string[] = []
const originalHome = process.env.HOME

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-mail-mbox-"))
  tempRoots.push(dir)
  return dir
}

function sampleMbox(): Buffer {
  return Buffer.from([
    "From sender@example.com Mon Jan 01 00:00:00 2024",
    "From: Sender <sender@example.com>",
    "To: Ari <ari@mendelow.me>",
    "Subject: First exported message",
    "",
    "Hello from the export.",
    "From second@example.com Tue Jan 02 00:00:00 2024",
    "From: Second <second@example.com>",
    "To: Ari <ari@mendelow.me>",
    "Subject: Second exported message",
    "",
    "A second message.",
    "",
  ].join("\n"), "utf-8")
}

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  resetMailSearchCacheForTests()
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("mailroom mbox import", () => {
  it("splits MBOX exports into raw messages", () => {
    const messages = splitMboxMessages(sampleMbox())
    expect(messages).toHaveLength(2)
    expect(messages[0].toString("utf-8")).toContain("First exported message")
    expect(messages[1].toString("utf-8")).toContain("Second exported message")
    expect(splitMboxMessages(Buffer.from("Subject: Single\r\n\r\nBody"))).toHaveLength(1)
    expect(splitMboxMessages(Buffer.from("   \n"))).toHaveLength(0)
  })

  it("imports MBOX messages into a delegated source grant and dedupes repeats", async () => {
    const { registry, keys } = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    const store = new FileMailroomStore({ rootDir: tempDir() })

    const first = await importMboxToStore({
      registry,
      store,
      agentId: "slugger",
      rawMbox: sampleMbox(),
      ownerEmail: "ari@mendelow.me",
      source: "hey",
      importedAt: new Date("2024-01-03T00:00:00Z"),
    })
    expect(first.scanned).toBe(2)
    expect(first.imported).toBe(2)
    expect(first.duplicates).toBe(0)
    expect(first.sourceGrant.aliasAddress).toBe("me.mendelow.ari.slugger@ouro.bot")

    const listed = await store.listMessages({ agentId: "slugger", compartmentKind: "delegated", source: "hey" })
    const decrypted = decryptMessages(listed, keys)
    expect(decrypted.map((message) => message.private.subject).sort()).toEqual([
      "First exported message",
      "Second exported message",
    ])
    expect(decrypted.every((message) => message.placement === "imbox")).toBe(true)
    expect(decrypted.every((message) => message.ownerEmail === "ari@mendelow.me")).toBe(true)

    const second = await importMboxToStore({
      registry,
      store,
      agentId: "slugger",
      rawMbox: sampleMbox(),
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    expect(second.imported).toBe(0)
    expect(second.duplicates).toBe(2)

    const withoutFrom = await importMboxToStore({
      registry,
      store,
      agentId: "slugger",
      rawMbox: Buffer.from([
        "From no-header@example.com Wed Jan 03 00:00:00 2024",
        "To: Ari <ari@mendelow.me>",
        "Subject: No From header",
        "",
        "Exported message without an RFC From header.",
      ].join("\n")),
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    expect(withoutFrom.imported).toBe(1)
    expect(withoutFrom.messages[0].envelope.mailFrom).toBe("")
  })

  it("streams MBOX files into a delegated source grant without loading the whole archive into memory", async () => {
    const { registry, keys } = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    const store = new FileMailroomStore({ rootDir: tempDir() })
    const mboxPath = path.join(tempDir(), "hey-export.mbox")
    fs.writeFileSync(mboxPath, sampleMbox())

    const imported = await importMboxFileToStore({
      registry,
      store,
      agentId: "slugger",
      filePath: mboxPath,
      ownerEmail: "ari@mendelow.me",
      source: "hey",
      importedAt: new Date("2024-01-03T00:00:00Z"),
    })

    expect(imported).toEqual(expect.objectContaining({
      scanned: 2,
      imported: 2,
      duplicates: 0,
      sourceFreshThrough: null,
    }))
    expect(imported.messages).toEqual([])
    const decrypted = decryptMessages(await store.listMessages({ agentId: "slugger", compartmentKind: "delegated", source: "hey" }), keys)
    expect(decrypted.map((message) => message.private.subject).sort()).toEqual([
      "First exported message",
      "Second exported message",
    ])
  })

  it("caches matching delegated search documents from an MBOX file in newest-first order", async () => {
    process.env.HOME = tempDir()
    const { registry } = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    const mboxPath = path.join(tempDir(), "hey-export-search-cache.mbox")
    fs.writeFileSync(mboxPath, [
      "From first@example.com Thu Apr 04 09:00:00 2026",
      "From: First <first@example.com>",
      "To: Ari <ari@mendelow.me>",
      "Subject: Basel update A",
      "Date: Thu, 04 Apr 2026 09:00:00 -0700",
      "",
      "Travel update A for Basel.",
      "From second@example.com Fri Apr 05 10:00:00 2026",
      "From: Second <second@example.com>",
      "To: Ari <ari@mendelow.me>",
      "Subject: Basel update B",
      "Date: Fri, 05 Apr 2026 10:00:00 -0700",
      "",
      "Travel update B for Basel.",
      "",
    ].join("\n"), "utf-8")

    const cached = await cacheMatchingMailSearchDocumentsFromMboxFile({
      registry,
      agentId: "slugger",
      filePath: mboxPath,
      ownerEmail: "ari@mendelow.me",
      source: "hey",
      queryTerms: ["travel update"],
      limit: 5,
    })

    expect(cached).toHaveLength(2)
    expect(cached.map((entry) => entry.subject)).toEqual([
      "Basel update B",
      "Basel update A",
    ])
  })

  it("finds a later exact booking hit without materializing earlier noise messages", async () => {
    process.env.HOME = tempDir()
    const { registry } = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    const mboxPath = path.join(tempDir(), "hey-export-late-booking-hit.mbox")
    fs.writeFileSync(mboxPath, [
      "From noise@example.com Thu Apr 04 09:00:00 2026",
      "From: Noise <noise@example.com>",
      "To: Ari <ari@mendelow.me>",
      "Subject: Noise before the real hit",
      "Date: Thu, 04 Apr 2026 09:00:00 -0700",
      "",
      `This is a large unrelated message ${"x".repeat(50_000)}.`,
      "From aerlingus@example.com Fri Apr 05 10:00:00 2026",
      "From: Aer Lingus <support@aerlingus.com>",
      "To: Ari <ari@mendelow.me>",
      "Subject: Aer Lingus Confirmation - Booking Ref: 24LEBB",
      "Date: Fri, 05 Apr 2026 10:00:00 -0700",
      "",
      "Booking Reference: 24LEBB",
      "",
    ].join("\n"), "utf-8")

    const cached = await cacheMatchingMailSearchDocumentsFromMboxFile({
      registry,
      agentId: "slugger",
      filePath: mboxPath,
      ownerEmail: "ari@mendelow.me",
      source: "hey",
      queryTerms: ["24lebb"],
      limit: 5,
    })

    expect(cached).toHaveLength(1)
    expect(cached[0]).toEqual(expect.objectContaining({
      subject: "Aer Lingus Confirmation - Booking Ref: 24LEBB",
      source: "hey",
      ownerEmail: "ari@mendelow.me",
    }))
  })

  it("returns early when archive-search terms are empty or limit is zero", async () => {
    process.env.HOME = tempDir()
    const { registry } = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    const mboxPath = path.join(tempDir(), "hey-export-empty-search.mbox")
    fs.writeFileSync(mboxPath, [
      "From first@example.com Thu Apr 04 09:00:00 2026",
      "From: First <first@example.com>",
      "To: Ari <ari@mendelow.me>",
      "Subject: Basel update A",
      "",
      "Travel update A for Basel.",
      "",
    ].join("\n"), "utf-8")

    await expect(cacheMatchingMailSearchDocumentsFromMboxFile({
      registry,
      agentId: "slugger",
      filePath: mboxPath,
      ownerEmail: "ari@mendelow.me",
      source: "hey",
      queryTerms: [],
      limit: 5,
    })).resolves.toEqual([])

    await expect(cacheMatchingMailSearchDocumentsFromMboxFile({
      registry,
      agentId: "slugger",
      filePath: mboxPath,
      ownerEmail: "ari@mendelow.me",
      source: "hey",
      queryTerms: ["basel"],
      limit: 0,
    })).resolves.toEqual([])
  })

  it("filters out raw archive prefilter false positives that do not survive parsed search text", async () => {
    process.env.HOME = tempDir()
    const { registry } = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    const mboxPath = path.join(tempDir(), "hey-export-prefilter-false-positive.mbox")
    fs.writeFileSync(mboxPath, [
      "From trace@example.com Thu Apr 04 09:00:00 2026",
      "From: Trace <trace@example.com>",
      "To: Ari <ari@mendelow.me>",
      "Subject: Basel update",
      "X-Trace: 24LEBB",
      "",
      "This body never mentions the booking code.",
      "",
    ].join("\n"), "utf-8")

    await expect(cacheMatchingMailSearchDocumentsFromMboxFile({
      registry,
      agentId: "slugger",
      filePath: mboxPath,
      ownerEmail: "ari@mendelow.me",
      source: "hey",
      queryTerms: ["24lebb"],
      limit: 5,
    })).resolves.toEqual([])
  })

  it("parses folded plain From headers while streaming file-backed MBOX imports", async () => {
    const { registry } = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    const store = new FileMailroomStore({ rootDir: tempDir() })
    const mboxPath = path.join(tempDir(), "hey-export-folded.mbox")
    fs.writeFileSync(mboxPath, [
      "From folded@example.com Thu Apr 04 09:00:00 2026",
      "From: Folded Sender",
      " plain.sender@example.com",
      "To: Ari <ari@mendelow.me>",
      "Subject: Folded sender header",
      "Date: Thu, 04 Apr 2026 09:00:00 -0700",
      "",
      "A folded sender message.",
      "",
    ].join("\n"))

    const imported = await importMboxFileToStore({
      registry,
      store,
      agentId: "slugger",
      filePath: mboxPath,
      ownerEmail: "ari@mendelow.me",
      source: "hey",
      importedAt: new Date("2026-04-04T17:00:00Z"),
    })

    expect(imported).toEqual(expect.objectContaining({
      scanned: 1,
      imported: 1,
      duplicates: 0,
      sourceFreshThrough: "2026-04-04T16:00:00.000Z",
    }))
    expect(await store.listMessages({ agentId: "slugger", compartmentKind: "delegated", source: "hey" })).toEqual([
      expect.objectContaining({
        envelope: expect.objectContaining({
          mailFrom: "plain.sender@example.com",
        }),
      }),
    ])
  })

  it("streams chunked CRLF archives and preserves a final message without a trailing newline", async () => {
    const { registry, keys } = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    const store = new FileMailroomStore({ rootDir: tempDir() })
    const mboxPath = path.join(tempDir(), "hey-export-crlf-large.mbox")
    const longSubject = `Chunked ${"A".repeat(70_000)}`
    fs.writeFileSync(mboxPath, [
      "From first@example.com Thu Apr 04 09:00:00 2026\r\n",
      "From: First <first@example.com>\r\n",
      "To: Ari <ari@mendelow.me>\r\n",
      `Subject: ${longSubject}\r\n`,
      "Date: Thu, 04 Apr 2026 09:00:00 -0700\r\n",
      "\r\n",
      "First body line.\r\n",
      "From second@example.com Fri Apr 05 10:00:00 2026\r\n",
      "From: Second <second@example.com>\r\n",
      "To: Ari <ari@mendelow.me>\r\n",
      "Subject: Final without newline\r\n",
      "Date: Fri, 05 Apr 2026 10:00:00 -0700\r\n",
      "\r\n",
      "Final body without trailing newline",
    ].join(""), "utf-8")

    const imported = await importMboxFileToStore({
      registry,
      store,
      agentId: "slugger",
      filePath: mboxPath,
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })

    expect(imported).toEqual(expect.objectContaining({
      scanned: 2,
      imported: 2,
      duplicates: 0,
      sourceFreshThrough: "2026-04-05T17:00:00.000Z",
    }))
    const decrypted = decryptMessages(await store.listMessages({ agentId: "slugger", compartmentKind: "delegated", source: "hey" }), keys)
    expect(decrypted.map((message) => message.private.subject).sort()).toEqual([
      "Final without newline",
      longSubject,
    ].sort())
  })

  it("ignores a dangling EOF separator and flushes the preceding message exactly once", async () => {
    const { registry, keys } = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    const store = new FileMailroomStore({ rootDir: tempDir() })
    const mboxPath = path.join(tempDir(), "hey-export-dangling-separator.mbox")
    fs.writeFileSync(mboxPath, [
      "From first@example.com Thu Apr 04 09:00:00 2026\n",
      "From: First <first@example.com>\n",
      "To: Ari <ari@mendelow.me>\n",
      "Subject: Before dangling separator\n",
      "Date: Thu, 04 Apr 2026 09:00:00 -0700\n",
      "\n",
      "Body before dangling separator.\n",
      "From dangling@example.com Fri Apr 05 10:00:00 2026",
    ].join(""), "utf-8")

    const imported = await importMboxFileToStore({
      registry,
      store,
      agentId: "slugger",
      filePath: mboxPath,
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })

    expect(imported).toEqual(expect.objectContaining({
      scanned: 1,
      imported: 1,
      duplicates: 0,
      sourceFreshThrough: "2026-04-04T16:00:00.000Z",
    }))
    const decrypted = decryptMessages(await store.listMessages({ agentId: "slugger", compartmentKind: "delegated", source: "hey" }), keys)
    expect(decrypted.map((message) => message.private.subject)).toEqual(["Before dangling separator"])
  })

  it("treats a separator-only archive tail as empty", async () => {
    const { registry } = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    const store = new FileMailroomStore({ rootDir: tempDir() })
    const mboxPath = path.join(tempDir(), "hey-export-separator-only.mbox")
    fs.writeFileSync(mboxPath, "From dangling@example.com Fri Apr 05 10:00:00 2026", "utf-8")

    const imported = await importMboxFileToStore({
      registry,
      store,
      agentId: "slugger",
      filePath: mboxPath,
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })

    expect(imported).toEqual(expect.objectContaining({
      scanned: 0,
      imported: 0,
      duplicates: 0,
      sourceFreshThrough: null,
      messages: [],
    }))
    expect(await store.listMessages({ agentId: "slugger", compartmentKind: "delegated", source: "hey" })).toEqual([])
  })

  it("handles body-only and header-only edge cases without inventing sender or date metadata", async () => {
    const { registry, keys } = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    const store = new FileMailroomStore({ rootDir: tempDir() })

    const bodyOnly = await importMboxToStore({
      registry,
      store,
      agentId: "slugger",
      rawMbox: Buffer.from([
        "From body-only@example.com Sat Apr 06 11:00:00 2026",
        "",
        "",
        "Body only payload",
      ].join("\n"), "utf-8"),
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    expect(bodyOnly).toEqual(expect.objectContaining({
      scanned: 1,
      imported: 1,
      duplicates: 0,
      sourceFreshThrough: null,
    }))

    const headerOnly = await importMboxToStore({
      registry,
      store,
      agentId: "slugger",
      rawMbox: Buffer.from([
        "From header-only@example.com Sun Apr 07 12:00:00 2026",
        "From: Name Only",
        "To: Ari <ari@mendelow.me>",
        "Subject: Header-only message",
        "Date: definitely not a date",
      ].join("\n"), "utf-8"),
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    expect(headerOnly).toEqual(expect.objectContaining({
      scanned: 1,
      imported: 1,
      duplicates: 0,
      sourceFreshThrough: null,
    }))

    const decrypted = decryptMessages(await store.listMessages({ agentId: "slugger", compartmentKind: "delegated", source: "hey", limit: 10 }), keys)
    const bodyOnlyMessage = decrypted.find((message) => message.id === bodyOnly.messages[0]?.id)
    const headerOnlyMessage = decrypted.find((message) => message.id === headerOnly.messages[0]?.id)
    expect(bodyOnlyMessage?.envelope.mailFrom).toBe("")
    expect(headerOnlyMessage?.envelope.mailFrom).toBe("")
    expect(headerOnlyMessage?.private.subject).toBe("Header-only message")
    expect(headerOnlyMessage?.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(headerOnly.messages[0]?.receivedAt).toBeDefined()
  })

  it("records HEY archive freshness/provenance and keeps historical imports out of attention", async () => {
    const { registry, keys } = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    registry.sourceGrants[0]!.defaultPlacement = "screener"
    const store = new FileMailroomStore({ rootDir: tempDir() })
    const imported = await importMboxToStore({
      registry,
      store,
      agentId: "slugger",
      rawMbox: Buffer.from([
        "From older@example.com Mon Apr 01 08:00:00 2026",
        "From: Older <older@example.com>",
        "To: Ari <ari@mendelow.me>",
        "Subject: Older exported message",
        "Date: Wed, 01 Apr 2026 08:00:00 -0700",
        "",
        "Historical body one.",
        "From newer@example.com Tue Apr 02 09:00:00 2026",
        "From: Newer <newer@example.com>",
        "To: Ari <ari@mendelow.me>",
        "Subject: Newer exported message",
        "Date: Thu, 02 Apr 2026 09:00:00 -0700",
        "",
        "Historical body two.",
        "",
      ].join("\n"), "utf-8"),
      ownerEmail: "ari@mendelow.me",
      source: "hey",
      importedAt: new Date("2026-04-22T21:00:00.000Z"),
    })

    expect(imported).toEqual(expect.objectContaining({
      scanned: 2,
      imported: 2,
      duplicates: 0,
      sourceFreshThrough: "2026-04-02T16:00:00.000Z",
    }))
    expect(await store.listScreenerCandidates({ agentId: "slugger", status: "pending" })).toHaveLength(0)

    const listed = await store.listMessages({ agentId: "slugger", compartmentKind: "delegated", source: "hey", limit: 10 })
    const decrypted = decryptMessages(listed, keys)
    expect(decrypted.map((message) => message.receivedAt).sort()).toEqual([
      "2026-04-01T15:00:00.000Z",
      "2026-04-02T16:00:00.000Z",
    ])
    expect(decrypted.every((message) => message.ingest.kind === "mbox-import")).toBe(true)
    expect(decrypted.every((message) => message.ingest.importedAt === "2026-04-22T21:00:00.000Z")).toBe(true)
    expect(decrypted.every((message) => message.ingest.sourceFreshThrough === "2026-04-02T16:00:00.000Z")).toBe(true)
    expect(decrypted.every((message) => message.ingest.attentionSuppressed === true)).toBe(true)
    expect(decrypted.every((message) => message.placement === "screener")).toBe(true)
  })

  it("requires an unambiguous enabled source grant", async () => {
    const { registry } = provisionMailboxRegistry({ agentId: "slugger" })
    const store = new FileMailroomStore({ rootDir: tempDir() })
    await expect(importMboxToStore({
      registry,
      store,
      agentId: "slugger",
      rawMbox: sampleMbox(),
      source: "hey",
    })).rejects.toThrow("No enabled Mailroom source grant")
    await expect(importMboxToStore({
      registry,
      store,
      agentId: "slugger",
      rawMbox: sampleMbox(),
    })).rejects.toThrow("No enabled Mailroom source grant")

    const provisioned = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    provisioned.registry.sourceGrants.push({
      ...provisioned.registry.sourceGrants[0],
      grantId: "grant_disabled",
      enabled: false,
    })
    provisioned.registry.sourceGrants.push({
      ...provisioned.registry.sourceGrants[0],
      grantId: "grant_other_agent",
      agentId: "other",
    })
    await expect(importMboxToStore({
      registry: provisioned.registry,
      store,
      agentId: "slugger",
      ownerEmail: "someone@example.com",
      rawMbox: sampleMbox(),
    })).rejects.toThrow("No enabled Mailroom source grant")
    await expect(importMboxToStore({
      registry: provisioned.registry,
      store,
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "other",
      rawMbox: sampleMbox(),
    })).rejects.toThrow("No enabled Mailroom source grant")

    provisioned.registry.sourceGrants.push({
      ...provisioned.registry.sourceGrants[0],
      grantId: "grant_slugger_fastmail",
      source: "fastmail",
      aliasAddress: "me.mendelow.ari.fastmail.slugger@ouro.bot",
    })
    await expect(importMboxToStore({
      registry: provisioned.registry,
      store,
      agentId: "slugger",
      rawMbox: sampleMbox(),
    })).rejects.toThrow("Multiple source grants")
  })
})
