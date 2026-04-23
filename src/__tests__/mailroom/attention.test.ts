import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { provisionMailboxRegistry } from "../../mailroom/core"
import { buildSenderPolicy } from "../../mailroom/policy"
import { FileMailroomStore, ingestRawMailToStore, type MailroomStore } from "../../mailroom/file-store"
import { scanMailScreenerAttention } from "../../mailroom/attention"

const tempRoots: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-mail-attention-"))
  tempRoots.push(dir)
  return dir
}

function pendingBodies(pendingDir: string): string[] {
  return fs.readdirSync(pendingDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(pendingDir, name), "utf-8")) as { content?: string })
    .map((entry) => entry.content ?? "")
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("mail screener attention", () => {
  it("uses default state/pending paths and renders plain sender emails cleanly", async () => {
    const root = tempDir()
    const originalHome = process.env.HOME
    process.env.HOME = root
    try {
      const storePath = path.join(root, "mailroom")
      const { registry } = provisionMailboxRegistry({ agentId: "slugger" })
      const store = new FileMailroomStore({ rootDir: storePath })
      await ingestRawMailToStore({
        registry,
        store,
        envelope: {
          mailFrom: "plain@example.com",
          rcptTo: ["slugger@ouro.bot"],
        },
        rawMime: Buffer.from([
          "From: plain@example.com",
          "To: slugger@ouro.bot",
          "Subject: Plain sender",
          "",
          "Still private.",
        ].join("\r\n")),
      })

      const result = await scanMailScreenerAttention({
        agentName: "slugger",
        store,
        now: () => 1_777_000_001_000,
      })

      expect(result.queued).toHaveLength(1)
      const defaultPendingDir = path.join(root, "AgentBundles", "slugger.ouro", "state", "pending", "self", "inner", "dialog")
      const defaultStatePath = path.join(root, "AgentBundles", "slugger.ouro", "state", "senses", "mail", "attention.json")
      expect(fs.existsSync(defaultStatePath)).toBe(true)
      expect(pendingBodies(defaultPendingDir)[0]).toContain("sender: plain@example.com")
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
    }
  })

  it("queues each new screener candidate for inner attention without exposing the mail body", async () => {
    const root = tempDir()
    const storePath = path.join(root, "mailroom")
    const pendingDir = path.join(root, "pending", "self", "inner", "dialog")
    const statePath = path.join(root, "senses", "mail", "attention.json")
    const { registry } = provisionMailboxRegistry({ agentId: "slugger" })
    const store = new FileMailroomStore({ rootDir: storePath })
    await ingestRawMailToStore({
      registry,
      store,
      envelope: {
        mailFrom: "unknown@example.com",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: Buffer.from([
        "From: Unknown Sender <unknown@example.com>",
        "To: Slugger <slugger@ouro.bot>",
        "Subject: Screen me",
        "",
        "BODY SHOULD NOT LEAK INTO ATTENTION.",
      ].join("\r\n")),
      receivedAt: new Date("2026-04-21T20:00:00.000Z"),
    })

    const first = await scanMailScreenerAttention({
      agentName: "slugger",
      store,
      pendingDir,
      statePath,
      now: () => 1_777_000_000_000,
    })

    expect(first.queued).toHaveLength(1)
    expect(first.queued[0]).toEqual(expect.objectContaining({
      senderEmail: "unknown@example.com",
      recipient: "slugger@ouro.bot",
      placement: "screener",
    }))
    const bodies = pendingBodies(pendingDir)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain("Mail Screener")
    expect(bodies[0]).toContain("unknown@example.com")
    expect(bodies[0]).toContain("candidate_mail_")
    expect(bodies[0]).toContain("mail_screener")
    expect(bodies[0]).not.toContain("BODY SHOULD NOT LEAK")

    const second = await scanMailScreenerAttention({
      agentName: "slugger",
      store,
      pendingDir,
      statePath,
      now: () => 1_777_000_000_500,
    })
    expect(second.queued).toEqual([])
    expect(pendingBodies(pendingDir)).toHaveLength(1)
  })

  it("queues unknown native mail for Screener while known sender policy goes quietly to Imbox", async () => {
    const root = tempDir()
    const storePath = path.join(root, "mailroom")
    const pendingDir = path.join(root, "pending", "self", "inner", "dialog")
    const statePath = path.join(root, "senses", "mail", "attention.json")
    const ensured = provisionMailboxRegistry({ agentId: "slugger" })
    const registry = {
      ...ensured.registry,
      senderPolicies: [
        buildSenderPolicy({
          agentId: "slugger",
          scope: "native",
          match: { kind: "email", value: "known@example.com" },
          action: "allow",
          actor: { kind: "human", trustLevel: "family" },
          reason: "Ari screened this sender in",
          now: new Date("2026-04-22T00:00:00.000Z"),
        }),
      ],
    }
    const store = new FileMailroomStore({ rootDir: storePath })
    const unknown = await ingestRawMailToStore({
      registry,
      store,
      envelope: {
        mailFrom: "unknown@example.com",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: Buffer.from([
        "From: unknown@example.com",
        "To: slugger@ouro.bot",
        "Subject: Needs screening",
        "",
        "Screen this body, but do not leak it.",
      ].join("\r\n")),
      receivedAt: new Date("2026-04-21T20:00:00.000Z"),
    })
    const known = await ingestRawMailToStore({
      registry,
      store,
      envelope: {
        mailFrom: "known@example.com",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: Buffer.from([
        "From: known@example.com",
        "To: slugger@ouro.bot",
        "Subject: Already screened in",
        "",
        "Quietly file this.",
      ].join("\r\n")),
      receivedAt: new Date("2026-04-21T20:01:00.000Z"),
    })

    expect(unknown.accepted[0]?.placement).toBe("screener")
    expect(known.accepted[0]?.placement).toBe("imbox")

    const result = await scanMailScreenerAttention({
      agentName: "slugger",
      store,
      pendingDir,
      statePath,
      now: () => 1_777_000_000_000,
    })

    expect(result.queued).toEqual([
      expect.objectContaining({
        senderEmail: "unknown@example.com",
        mailboxRole: "agent-native-mailbox",
        compartmentKind: "native",
      }),
    ])
    expect(pendingBodies(pendingDir).join("\n")).not.toContain("Quietly file this")
  })

  it("does not resurface resolved screener candidates", async () => {
    const root = tempDir()
    const storePath = path.join(root, "mailroom")
    const pendingDir = path.join(root, "pending", "self", "inner", "dialog")
    const statePath = path.join(root, "senses", "mail", "attention.json")
    const { registry } = provisionMailboxRegistry({ agentId: "slugger" })
    const store = new FileMailroomStore({ rootDir: storePath })
    await ingestRawMailToStore({
      registry,
      store,
      envelope: {
        mailFrom: "discarded@example.com",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: Buffer.from([
        "From: Discarded <discarded@example.com>",
        "To: Slugger <slugger@ouro.bot>",
        "Subject: Already decided",
        "",
        "not relevant",
      ].join("\r\n")),
    })
    const [candidate] = await store.listScreenerCandidates({ agentId: "slugger", status: "pending" })
    await store.updateScreenerCandidate({
      ...candidate!,
      status: "discarded",
      resolvedByDecisionId: "decision_1",
    })

    const result = await scanMailScreenerAttention({
      agentName: "slugger",
      store,
      pendingDir,
      statePath,
      now: () => 1_777_000_000_000,
    })

    expect(result.queued).toEqual([])
    expect(fs.existsSync(pendingDir)).toBe(false)
  })

  it("renders delegated display names and tolerates partial attention state", async () => {
    const root = tempDir()
    const pendingDir = path.join(root, "pending", "self", "inner", "dialog")
    const statePath = path.join(root, "senses", "mail", "attention.json")
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, JSON.stringify({
      notifiedCandidateIds: "legacy-corrupt",
      updatedAt: 123,
    }), "utf-8")
    const store = {
      listScreenerCandidates: async () => [
        {
          schemaVersion: 1,
          id: "candidate_mail_later",
          agentId: "slugger",
          mailboxId: "mailbox_slugger",
          messageId: "mail_later",
          senderEmail: "later@example.com",
          senderDisplay: "Later Sender",
          recipient: "slugger@ouro.bot",
          placement: "screener",
          status: "pending",
          trustReason: "native test",
          firstSeenAt: "2026-04-21T21:00:00.000Z",
          lastSeenAt: "2026-04-21T21:00:00.000Z",
          messageCount: 1,
        },
        {
          schemaVersion: 1,
          id: "candidate_mail_display",
          agentId: "slugger",
          mailboxId: "mailbox_slugger",
          messageId: "mail_display",
          senderEmail: "travel@example.com",
          senderDisplay: "Travel Desk",
          recipient: "me.mendelow.ari.slugger@ouro.bot",
          source: "hey",
          ownerEmail: "ari@mendelow.me",
          placement: "screener",
          status: "pending",
          trustReason: "delegated test",
          firstSeenAt: "2026-04-21T20:00:00.000Z",
          lastSeenAt: "2026-04-21T20:00:00.000Z",
          messageCount: 1,
        },
      ],
    } as unknown as MailroomStore

    const result = await scanMailScreenerAttention({
      agentName: "slugger",
      store,
      pendingDir,
      statePath,
      limit: 1,
    })

    expect(result.queued).toHaveLength(2)
    expect(result.queued.map((entry) => entry.candidateId)).toEqual(["candidate_mail_display", "candidate_mail_later"])
    expect(result.queued[0]).toEqual(expect.objectContaining({
      mailboxRole: "delegated-human-mailbox",
      compartmentKind: "delegated",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    }))
    expect(result.queued[1]).toEqual(expect.objectContaining({
      mailboxRole: "agent-native-mailbox",
      compartmentKind: "native",
      ownerEmail: null,
      source: null,
    }))
    expect(result.state.notifiedCandidateIds).toEqual(["candidate_mail_display", "candidate_mail_later"])
    const bodies = pendingBodies(pendingDir).join("\n\n")
    expect(bodies).toContain("sender: Travel Desk <travel@example.com>")
    expect(bodies).toContain("delegated owner: ari@mendelow.me")
    expect(bodies).toContain("source: hey")
  })
})
