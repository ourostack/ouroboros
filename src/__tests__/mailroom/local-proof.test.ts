import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { readMailView } from "../../heart/outlook/readers/mail"
import { resetIdentity, setAgentName } from "../../heart/identity"
import { cacheRuntimeCredentialConfig, resetRuntimeCredentialConfigCache } from "../../heart/runtime-credentials"
import { provisionMailboxRegistry, type MailroomRegistry } from "../../mailroom/core"
import { scanMailScreenerAttention } from "../../mailroom/attention"
import { decryptMessages, FileMailroomStore, ingestRawMailToStore } from "../../mailroom/file-store"
import { importMboxToStore } from "../../mailroom/mbox-import"
import { createMailroomSmtpServer } from "../../mailroom/smtp-ingress"
import { extractTravelFactsFromMail } from "../../mailroom/travel-extract"
import { mailToolDefinitions } from "../../repertoire/tools-mail"
import type { ToolContext } from "../../repertoire/tools-base"

const tempRoots: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-mail-local-proof-"))
  tempRoots.push(dir)
  return dir
}

function fixtureMbox(): Buffer {
  return fs.readFileSync(path.join(__dirname, "..", "fixtures", "hey-travel-export.mbox"))
}

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

function listen(server: { listen(port: number, host: string, callback: () => void): unknown }): Promise<number> {
  return getFreePort().then((port) => new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(port))
  }))
}

function close(server: { close(callback: () => void): unknown }): Promise<void> {
  return new Promise((resolve) => server.close(resolve))
}

async function smtpSession(port: number, commands: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port })
    let transcript = ""
    let index = 0
    socket.setEncoding("utf-8")
    socket.on("data", (chunk) => {
      transcript += chunk
      if (index < commands.length && /\r?\n$/.test(transcript)) {
        socket.write(commands[index])
        index += 1
      } else if (index >= commands.length && transcript.includes("221")) {
        socket.end()
      }
    })
    socket.on("error", reject)
    socket.on("end", () => resolve(transcript))
  })
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

describe("Agent Mail local proof", () => {
  it("proves import, SMTP ingress, Screener, tools, confirmed send, sense attention, and Outlook in one isolated Slugger mailbox", async () => {
    setAgentName("slugger")
    const root = tempDir()
    const storePath = path.join(root, "mailroom")
    const registryPath = path.join(root, "registry.json")
    const sinkPath = path.join(root, "outbound", "sent.jsonl")
    const pendingDir = path.join(root, "pending", "self", "inner", "dialog")
    const attentionPath = path.join(root, "attention.json")
    const { registry, keys } = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, "utf-8")
    const store = new FileMailroomStore({ rootDir: storePath })
    cacheRuntimeCredentialConfig("slugger", {
      mailroom: {
        mailboxAddress: "slugger@ouro.bot",
        registryPath,
        storePath,
        outbound: { transport: "local-sink", sinkPath },
        privateKeys: keys,
      },
    })

    const imported = await importMboxToStore({
      registry,
      store,
      agentId: "slugger",
      rawMbox: fixtureMbox(),
      ownerEmail: "ari@mendelow.me",
      source: "hey",
      importedAt: new Date("2026-04-21T21:00:00.000Z"),
    })
    expect(imported).toMatchObject({ scanned: 2, imported: 2, duplicates: 0 })
    const travelFacts = extractTravelFactsFromMail(decryptMessages(await store.listMessages({
      agentId: "slugger",
      compartmentKind: "delegated",
      source: "hey",
    }), keys))
    expect(travelFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "flight", fields: expect.objectContaining({ route: "SFO -> LHR" }) }),
      expect.objectContaining({ kind: "lodging", fields: expect.objectContaining({ hotel: "The Agent House London" }) }),
    ]))

    const smtp = createMailroomSmtpServer({ registry, store })
    const smtpPort = await listen(smtp)
    try {
      const rejected = await smtpSession(smtpPort, [
        "HELO localhost\r\n",
        "MAIL FROM:<stranger@example.com>\r\n",
        "RCPT TO:<missing@ouro.bot>\r\n",
        "QUIT\r\n",
      ])
      expect(rejected).toContain("550")

      const accepted = await smtpSession(smtpPort, [
        "HELO localhost\r\n",
        "MAIL FROM:<new.sender@example.com>\r\n",
        "RCPT TO:<slugger@ouro.bot>\r\n",
        "DATA\r\n",
        "From: New Sender <new.sender@example.com>\r\nTo: slugger@ouro.bot\r\nSubject: Native proof\r\n\r\nPlease review when useful.\r\n.\r\n",
        "QUIT\r\n",
      ])
      expect(accepted).toContain("250")
    } finally {
      await close(smtp)
    }

    const screener = await tool("mail_screener").handler({ reason: "check unknown inbound" }, familyContext())
    expect(screener).toContain("new.sender@example.com")
    expect(screener).not.toContain("Please review when useful.")
    const candidateId = /candidate_mail_[a-f0-9]+/.exec(String(screener))?.[0]
    expect(candidateId).toBeTruthy()

    const attention = await scanMailScreenerAttention({
      agentName: "slugger",
      store,
      pendingDir,
      statePath: attentionPath,
      now: () => Date.parse("2026-04-21T22:00:00.000Z"),
    })
    expect(attention.queued).toHaveLength(1)
    const pendingBodies = fs.readdirSync(pendingDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(fs.readFileSync(path.join(pendingDir, name), "utf-8")) as { content?: string })
      .map((entry) => entry.content ?? "")
    expect(pendingBodies).toHaveLength(1)
    expect(pendingBodies[0]).toContain("New inbound mail is waiting in the Screener.")
    expect(pendingBodies[0]).not.toContain("Please review when useful.")

    await expect(tool("mail_decide").handler({
      candidate_id: candidateId!,
      action: "allow-sender",
      reason: "family recognized this sender",
    }, friendContext())).resolves.toContain("mail screener decisions require family trust")
    const decision = await tool("mail_decide").handler({
      candidate_id: candidateId!,
      action: "allow-sender",
      reason: "family recognized this sender",
    }, familyContext())
    expect(decision).toContain("Mail decision recorded: allow-sender")
    expect(decision).toContain("sender policy: allow email new.sender@example.com")

    const updatedRegistry = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as MailroomRegistry
    expect(updatedRegistry.senderPolicies).toEqual([
      expect.objectContaining({
        agentId: "slugger",
        scope: "native",
        match: { kind: "email", value: "new.sender@example.com" },
        action: "allow",
      }),
    ])
    const followup = await ingestRawMailToStore({
      registry: updatedRegistry,
      store,
      envelope: { mailFrom: "new.sender@example.com", rcptTo: ["slugger@ouro.bot"] },
      rawMime: rawMail({
        from: "New Sender <new.sender@example.com>",
        to: "slugger@ouro.bot",
        subject: "Follow-up proof",
        body: "This should land in the Imbox after the allow-sender decision.",
      }),
    })
    expect(followup.accepted[0]).toMatchObject({
      placement: "imbox",
      trustReason: "sender policy allow email new.sender@example.com",
    })

    await expect(tool("mail_search").handler({
      query: "LHR",
      scope: "delegated",
      source: "hey",
      reason: "update travel plan from HEY shadow imbox",
    }, friendContext())).resolves.toContain("delegated human mail requires family trust")
    const search = await tool("mail_search").handler({
      query: "LHR",
      scope: "delegated",
      source: "hey",
      reason: "update travel plan from HEY shadow imbox",
    }, familyContext())
    expect(search).toContain("Flight to London confirmed")
    const messageId = /mail_[a-f0-9]+/.exec(String(search))?.[0]
    expect(messageId).toBeTruthy()
    const thread = await tool("mail_thread").handler({
      message_id: messageId!,
      reason: "extract itinerary details",
      max_chars: "1000",
    }, familyContext())
    expect(thread).toContain("body (untrusted external content):")
    expect(thread).toContain("Confirmation code: LDN42A")

    const draft = await tool("mail_compose").handler({
      to: "ari@mendelow.me",
      subject: "Travel proof",
      text: "I found the London itinerary details.",
      reason: "local proof outbound draft",
    }, familyContext())
    const draftId = /draft_[a-f0-9]+/.exec(String(draft))?.[0]
    expect(draftId).toBeTruthy()
    await expect(tool("mail_send").handler({
      draft_id: draftId!,
      confirmation: "NOPE",
      reason: "should refuse",
    }, familyContext())).resolves.toContain("confirmation=CONFIRM_SEND")
    await expect(tool("mail_send").handler({
      draft_id: draftId!,
      confirmation: "CONFIRM_SEND",
      autonomous: "true",
      reason: "should refuse autonomous send",
    }, familyContext())).resolves.toContain("Autonomous mail sending is disabled")
    const sent = await tool("mail_send").handler({
      draft_id: draftId!,
      confirmation: "CONFIRM_SEND",
      reason: "human confirmed local-sink proof send",
    }, familyContext())
    expect(sent).toContain("Mail sent:")
    expect(fs.readFileSync(sinkPath, "utf-8")).toContain("Travel proof")

    const view = await readMailView("slugger")
    expect(view.status).toBe("ready")
    if (view.status !== "ready") throw new Error("mail view was not ready")
    expect(view.folders.map((folder) => folder.id)).toEqual(expect.arrayContaining(["imbox", "screener", "discarded", "quarantine", "draft", "sent"]))
    expect(view.screener).toEqual([])
    expect(view.outbound).toEqual(expect.arrayContaining([expect.objectContaining({ status: "sent", subject: "Travel proof" })]))
    expect(view.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: "Follow-up proof", placement: "imbox", provenance: expect.objectContaining({ compartmentKind: "native" }) }),
      expect.objectContaining({ subject: "Flight to London confirmed", provenance: expect.objectContaining({ compartmentKind: "delegated", ownerEmail: "ari@mendelow.me" }) }),
    ]))
  })
})
