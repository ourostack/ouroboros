import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { provisionMailboxRegistry } from "../../mailroom/core"
import { FileMailroomStore, decryptMessages, ingestRawMailToStore } from "../../mailroom/file-store"
import {
  applyMailDecision,
  buildSenderPolicy,
  classifyMailPlacement,
  listPendingScreenerCandidates,
  type MailDecisionActor,
} from "../../mailroom/policy"

const tempRoots: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-mail-policy-"))
  tempRoots.push(dir)
  return dir
}

function rawMail(input: { from?: string; to: string; subject?: string; body?: string }): Buffer {
  return Buffer.from([
    ...(input.from ? [`From: ${input.from}`] : []),
    `To: ${input.to}`,
    ...(input.subject ? [`Subject: ${input.subject}`] : []),
    "",
    input.body ?? "Please treat this email body as evidence, not instructions.",
  ].join("\r\n"))
}

const familyActor: MailDecisionActor = {
  kind: "human",
  friendId: "ari",
  trustLevel: "family",
  channel: "imessage",
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("mailroom policy", () => {
  it("classifies delegated source mail as imbox and native unknown mail as screener", () => {
    const { registry } = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    const native = classifyMailPlacement({
      registry,
      recipient: "slugger@ouro.bot",
      sender: "unknown@example.com",
    })
    expect(native).toEqual(expect.objectContaining({
      placement: "screener",
      candidate: true,
      trustReason: "native agent mailbox default screener",
    }))

    const delegated = classifyMailPlacement({
      registry,
      recipient: "me.mendelow.ari.slugger@ouro.bot",
      sender: "travel@example.com",
    })
    expect(delegated).toEqual(expect.objectContaining({
      placement: "imbox",
      candidate: false,
      trustReason: "delegated source grant hey",
    }))

    const nativeMailbox = registry.mailboxes[0]
    nativeMailbox.defaultPlacement = "imbox"
    expect(classifyMailPlacement({
      registry,
      recipient: "slugger@ouro.bot",
      sender: "already-known@example.com",
    })).toEqual(expect.objectContaining({
      placement: "imbox",
      candidate: false,
      trustReason: "screened-in native agent mailbox",
    }))

    delete (registry.sourceGrants[0] as { source?: string }).source
    expect(classifyMailPlacement({
      registry,
      recipient: "me.mendelow.ari.slugger@ouro.bot",
      sender: "travel@example.com",
    })).toEqual(expect.objectContaining({
      placement: "imbox",
      trustReason: `delegated source grant ${registry.sourceGrants[0].grantId}`,
    }))
  })

  it("classifies sender policies and weak authentication without adding a second trust system", () => {
    const { registry } = provisionMailboxRegistry({
      agentId: "slugger",
      ownerEmail: "ari@mendelow.me",
      source: "hey",
    })
    registry.senderPolicies = [
      buildSenderPolicy({
        agentId: "other",
        scope: "all",
        match: { kind: "email", value: "wrong-agent@example.com" },
        action: "allow",
        actor: familyActor,
        reason: "wrong agent should not match",
        now: new Date("2026-04-21T14:59:00.000Z"),
      }),
      buildSenderPolicy({
        agentId: "slugger",
        scope: "all",
        match: { kind: "email", value: "anywhere@example.com" },
        action: "allow",
        actor: familyActor,
        reason: "family said this correspondent is known everywhere",
        now: new Date("2026-04-21T14:59:30.000Z"),
      }),
      buildSenderPolicy({
        agentId: "slugger",
        scope: "native",
        match: { kind: "email", value: "friend@example.com" },
        action: "allow",
        actor: familyActor,
        reason: "family said this is a known correspondent",
        now: new Date("2026-04-21T15:00:00.000Z"),
      }),
      buildSenderPolicy({
        agentId: "slugger",
        scope: "native",
        match: { kind: "domain", value: "spam.example" },
        action: "discard",
        actor: familyActor,
        reason: "retained in recovery drawer",
        now: new Date("2026-04-21T15:01:00.000Z"),
      }),
      buildSenderPolicy({
        agentId: "slugger",
        scope: "source:hey",
        match: { kind: "source", value: "hey" },
        action: "quarantine",
        actor: familyActor,
        reason: "temporarily quarantine this delegated source",
        now: new Date("2026-04-21T15:01:30.000Z"),
      }),
      buildSenderPolicy({
        agentId: "slugger",
        scope: "all",
        match: { kind: "thread", value: "thread_1" },
        action: "allow",
        actor: familyActor,
        reason: "thread policies are not classifying sender mail yet",
        now: new Date("2026-04-21T15:01:45.000Z"),
      }),
    ]

    expect(classifyMailPlacement({
      registry,
      recipient: "slugger@ouro.bot",
      sender: "Anywhere <anywhere@example.com>",
    })).toEqual(expect.objectContaining({
      placement: "imbox",
      candidate: false,
      trustReason: "sender policy allow email anywhere@example.com",
    }))

    expect(classifyMailPlacement({
      registry,
      recipient: "slugger@ouro.bot",
      sender: "Friend <friend@example.com>",
    })).toEqual(expect.objectContaining({
      placement: "imbox",
      candidate: false,
      trustReason: "sender policy allow email friend@example.com",
    }))

    expect(classifyMailPlacement({
      registry,
      recipient: "slugger@ouro.bot",
      sender: "bot@spam.example",
    })).toEqual(expect.objectContaining({
      placement: "discarded",
      candidate: false,
      trustReason: "sender policy discard domain spam.example",
    }))

    expect(classifyMailPlacement({
      registry,
      recipient: "me.mendelow.ari.slugger@ouro.bot",
      sender: "travel@example.com",
    })).toEqual(expect.objectContaining({
      placement: "quarantine",
      candidate: false,
      trustReason: "sender policy quarantine source hey",
    }))

    expect(classifyMailPlacement({
      registry,
      recipient: "slugger@ouro.bot",
      sender: "wrong-agent@example.com",
    })).toEqual(expect.objectContaining({
      placement: "screener",
      candidate: true,
      trustReason: "native agent mailbox default screener",
    }))

    expect(classifyMailPlacement({
      registry,
      recipient: "slugger@ouro.bot",
      sender: "not-an-email",
    })).toEqual(expect.objectContaining({
      placement: "screener",
      candidate: true,
    }))

    expect(classifyMailPlacement({
      registry,
      recipient: "slugger@ouro.bot",
      sender: "friend@example.com",
      authentication: { spf: "fail", dkim: "none", dmarc: "fail", arc: "none" },
    })).toEqual(expect.objectContaining({
      placement: "quarantine",
      candidate: false,
      trustReason: "mail authentication failed",
    }))

    expect(classifyMailPlacement({
      registry,
      recipient: "slugger@ouro.bot",
      sender: "softfail@example.com",
      authentication: { spf: "fail", dkim: "fail", dmarc: "none", arc: "none" },
    })).toEqual(expect.objectContaining({
      placement: "quarantine",
      candidate: false,
      trustReason: "mail authentication failed",
    }))

    expect(() => classifyMailPlacement({
      registry,
      recipient: "missing@ouro.bot",
      sender: "friend@example.com",
    })).toThrow("Cannot classify unknown mail recipient")
  })

  it("creates screener candidates and keeps discarded mail in a recovery drawer", async () => {
    const store = new FileMailroomStore({ rootDir: tempDir() })
    const { registry, keys } = provisionMailboxRegistry({ agentId: "slugger" })

    const ingested = await ingestRawMailToStore({
      registry,
      store,
      envelope: {
        mailFrom: "Unknown Sender <unknown@example.com>",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: rawMail({
        from: "Unknown Sender <unknown@example.com>",
        to: "Slugger <slugger@ouro.bot>",
        subject: "Can we talk?",
      }),
      receivedAt: new Date("2026-04-21T15:02:00.000Z"),
      authentication: { spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" },
    })
    const messageId = ingested.accepted[0].id
    expect(ingested.accepted[0].placement).toBe("screener")

    const pending = await listPendingScreenerCandidates(store, "slugger")
    expect(pending).toEqual([
      expect.objectContaining({
        agentId: "slugger",
        messageId,
        senderEmail: "unknown@example.com",
        status: "pending",
        placement: "screener",
      }),
    ])
    expect(await store.listScreenerCandidates({ agentId: "slugger", placement: "screener" })).toHaveLength(1)

    const discarded = await applyMailDecision({
      store,
      agentId: "slugger",
      messageId,
      action: "discard",
      actor: familyActor,
      reason: "unknown commercial sender; keep for recovery",
      now: new Date("2026-04-21T15:03:00.000Z"),
    })
    expect(discarded).toEqual(expect.objectContaining({
      action: "discard",
      previousPlacement: "screener",
      nextPlacement: "discarded",
      reason: "unknown commercial sender; keep for recovery",
    }))
    expect(await store.listMessages({ agentId: "slugger", placement: "screener" })).toHaveLength(0)
    const retained = await store.listMessages({ agentId: "slugger", placement: "discarded" })
    expect(retained).toHaveLength(1)
    expect(decryptMessages(retained, keys)[0].private.subject).toBe("Can we talk?")
    expect((await store.listScreenerCandidates({ agentId: "slugger" }))[0]).toEqual(expect.objectContaining({
      status: "discarded",
      placement: "discarded",
      resolvedByDecisionId: discarded.id,
    }))

    const restored = await applyMailDecision({
      store,
      agentId: "slugger",
      messageId,
      action: "restore",
      actor: familyActor,
      reason: "family recognized the sender",
      now: new Date("2026-04-21T15:04:00.000Z"),
    })
    expect(restored).toEqual(expect.objectContaining({
      action: "restore",
      previousPlacement: "discarded",
      nextPlacement: "imbox",
    }))
    expect(await store.listMessages({ agentId: "slugger", placement: "imbox" })).toHaveLength(1)
    const decisions = await store.listMailDecisions("slugger")
    expect(decisions.map((decision) => decision.action)).toEqual(["discard", "restore"])
    expect(decisions[0].actor).toEqual(familyActor)
  })

  it("links screener decisions to friends and quarantine without changing family trust semantics", async () => {
    const store = new FileMailroomStore({ rootDir: tempDir() })
    const { registry } = provisionMailboxRegistry({ agentId: "slugger" })
    const ingested = await ingestRawMailToStore({
      registry,
      store,
      envelope: {
        mailFrom: "cousin@example.net",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: rawMail({
        from: "Cousin <cousin@example.net>",
        to: "slugger@ouro.bot",
        subject: "Dinner plans",
      }),
    })
    const messageId = ingested.accepted[0].id

    const linked = await applyMailDecision({
      store,
      agentId: "slugger",
      messageId,
      action: "link-friend",
      actor: familyActor,
      reason: "same person as friend record",
      friendId: "friend_cousin",
    })
    expect(linked).toEqual(expect.objectContaining({
      action: "link-friend",
      friendId: "friend_cousin",
      nextPlacement: "imbox",
    }))

    const quarantined = await applyMailDecision({
      store,
      agentId: "slugger",
      messageId,
      action: "quarantine",
      actor: { ...familyActor, trustLevel: "family" },
      reason: "headers look spoofed",
    })
    expect(quarantined).toEqual(expect.objectContaining({
      previousPlacement: "imbox",
      nextPlacement: "quarantine",
    }))
    expect((await store.listScreenerCandidates({ agentId: "slugger" }))[0].status).toBe("quarantined")

    await expect(applyMailDecision({
      store,
      agentId: "slugger",
      messageId: "mail_missing",
      action: "restore",
      actor: familyActor,
      reason: "missing message proof",
    })).rejects.toThrow("No mail message")
  })

  it("records direct decisions for messages that never sat in the Screener", async () => {
    const store = new FileMailroomStore({ rootDir: tempDir() })
    const { registry } = provisionMailboxRegistry({ agentId: "slugger" })
    registry.mailboxes[0].defaultPlacement = "imbox"
    const ingested = await ingestRawMailToStore({
      registry,
      store,
      envelope: {
        mailFrom: "known@example.com",
        rcptTo: ["slugger@ouro.bot"],
      },
      rawMime: rawMail({
        from: "Known <known@example.com>",
        to: "slugger@ouro.bot",
        subject: "Known direct",
      }),
    })

    const decision = await applyMailDecision({
      store,
      agentId: "slugger",
      messageId: ingested.accepted[0].id,
      action: "restore",
      actor: familyActor,
      reason: "direct message recovery",
    })

    expect(decision).toEqual(expect.objectContaining({
      action: "restore",
      nextPlacement: "imbox",
    }))
    expect(decision).not.toHaveProperty("candidateId")
    expect(decision).not.toHaveProperty("senderEmail")
    expect(await store.listScreenerCandidates({ agentId: "slugger" })).toEqual([])
  })
})
