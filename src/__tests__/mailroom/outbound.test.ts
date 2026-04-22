import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { FileMailroomStore } from "../../mailroom/file-store"
import {
  confirmMailDraftSend,
  createMailDraft,
  listMailOutboundRecords,
  resolveOutboundTransport,
} from "../../mailroom/outbound"

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

  it("refuses autonomous sending even when the transport is configured", async () => {
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
    })).rejects.toThrow("Autonomous mail sending is disabled")
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
})
