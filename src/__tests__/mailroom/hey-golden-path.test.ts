import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { provisionMailboxRegistry } from "../../mailroom/core"
import { decryptMessages, FileMailroomStore, ingestRawMailToStore } from "../../mailroom/file-store"
import { importMboxToStore } from "../../mailroom/mbox-import"
import { extractTravelFactsFromMail } from "../../mailroom/travel-extract"
import { cacheRuntimeCredentialConfig, resetRuntimeCredentialConfigCache } from "../../heart/runtime-credentials"
import { resetIdentity, setAgentName } from "../../heart/identity"
import { mailToolDefinitions } from "../../repertoire/tools-mail"
import type { ToolContext } from "../../repertoire/tools-base"

const tempRoots: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-hey-golden-"))
  tempRoots.push(dir)
  return dir
}

function fixtureMbox(): Buffer {
  return fs.readFileSync(path.join(__dirname, "..", "fixtures", "hey-travel-export.mbox"))
}

function rawMail(input: { from: string; to: string; subject: string; body: string }): Buffer {
  return Buffer.from([
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    "",
    input.body,
  ].join("\r\n"))
}

function tool(name: string) {
  const found = mailToolDefinitions.find((definition) => definition.tool.function.name === name)
  if (!found) throw new Error(`missing tool ${name}`)
  return found
}

function familyContext(): ToolContext {
  return {
    signin: async () => undefined,
    context: {
      friend: {
        id: "ari",
        name: "Ari",
        trustLevel: "family",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        totalTokens: 0,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        schemaVersion: 1,
      },
      channel: {
        channel: "cli",
        senseType: "local",
        availableIntegrations: [],
        supportsMarkdown: false,
        supportsStreaming: true,
        supportsRichCards: false,
        maxMessageLength: Infinity,
      },
    },
  }
}

function friendContext(): ToolContext {
  const ctx = familyContext()
  ctx.context!.friend.trustLevel = "friend"
  return ctx
}

afterEach(() => {
  resetIdentity()
  resetRuntimeCredentialConfigCache()
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("HEY MBOX golden path", () => {
  it("imports delegated HEY mail, extracts travel facts, and keeps delegated reads family-only/audited", async () => {
    setAgentName("slugger")
    const storePath = tempDir()
    const { registry, keys } = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    const store = new FileMailroomStore({ rootDir: storePath })

    const imported = await importMboxToStore({
      registry,
      store,
      agentId: "slugger",
      rawMbox: fixtureMbox(),
      ownerEmail: "ari@mendelow.me",
      source: "hey",
      importedAt: new Date("2026-04-21T21:00:00.000Z"),
    })
    expect(imported).toEqual(expect.objectContaining({
      scanned: 2,
      imported: 2,
      duplicates: 0,
    }))

    const delegated = await store.listMessages({ agentId: "slugger", compartmentKind: "delegated", source: "hey" })
    const facts = extractTravelFactsFromMail(decryptMessages(delegated, keys))
    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "flight",
        ownerEmail: "ari@mendelow.me",
        source: "hey",
        fields: expect.objectContaining({
          flightNumber: "EA 432",
          route: "SFO -> LHR",
          confirmationCode: "LDN42A",
        }),
      }),
      expect.objectContaining({
        kind: "lodging",
        fields: expect.objectContaining({
          hotel: "The Agent House London",
          checkIn: "May 15, 2026",
          confirmationCode: "HTL900",
        }),
      }),
    ]))

    cacheRuntimeCredentialConfig("slugger", {
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        storePath,
        privateKeys: keys,
      },
    })

    const delegatedAlias = registry.sourceGrants[0]?.aliasAddress
    expect(delegatedAlias).toBeTruthy()
    for (let index = 0; index < 250; index += 1) {
      await ingestRawMailToStore({
        registry,
        store,
        envelope: { mailFrom: `newsletter-${index}@updates.example.com`, rcptTo: [delegatedAlias!] },
        rawMime: rawMail({
          from: `Updates ${index} <newsletter-${index}@updates.example.com>`,
          to: delegatedAlias!,
          subject: `Fresh unrelated update ${index}`,
          body: `This is unrelated delegated mail ${index}.`,
        }),
        receivedAt: new Date(`2026-04-22T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`),
      })
    }

    await expect(tool("mail_search").handler({
      query: "LHR",
      scope: "delegated",
      source: "hey",
      reason: "update Ari travel plan",
    }, friendContext())).resolves.toContain("delegated human mail requires family trust")

    const search = await tool("mail_search").handler({
      query: "LHR",
      scope: "delegated",
      source: "hey",
      reason: "update Ari travel plan",
    }, familyContext())
    expect(search).toContain("Flight to London confirmed")
    const messageId = /mail_[a-f0-9]+/.exec(String(search))?.[0]
    expect(messageId).toBeTruthy()

    const body = await tool("mail_thread").handler({
      message_id: messageId!,
      reason: "extract travel confirmation for upcoming plan update",
      max_chars: "1200",
    }, familyContext())
    expect(body).toContain("body (untrusted external content):")
    expect(body).toContain("Confirmation code: LDN42A")

    const disjunction = await tool("mail_search").handler({
      query: "missing-token OR LDN42A OR nothing-here",
      scope: "delegated",
      source: "hey",
      reason: "recover travel search with OR terms",
    }, familyContext())
    expect(disjunction).toContain("Flight to London confirmed")

    const commaSeparatedAnchors = await tool("mail_search").handler({
      query: "missing-token, LDN42A, nothing-here",
      scope: "delegated",
      source: "hey",
      reason: "recover travel search with anchor list",
    }, familyContext())
    expect(commaSeparatedAnchors).toContain("Flight to London confirmed")

    const accessLog = await store.listAccessLog("slugger")
    expect(accessLog).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: "mail_search", reason: "update Ari travel plan" }),
      expect.objectContaining({ tool: "mail_search", reason: "recover travel search with OR terms" }),
      expect.objectContaining({ tool: "mail_search", reason: "recover travel search with anchor list" }),
      expect.objectContaining({ tool: "mail_thread", reason: "extract travel confirmation for upcoming plan update" }),
    ]))
  })
})
