import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { provisionMailboxRegistry } from "../../mailroom/core"
import { decryptMessages, FileMailroomStore } from "../../mailroom/file-store"
import { importMboxToStore, splitMboxMessages } from "../../mailroom/mbox-import"

const tempRoots: string[] = []

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
  })
})
