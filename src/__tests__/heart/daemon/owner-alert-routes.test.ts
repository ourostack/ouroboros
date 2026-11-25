import { describe, expect, it, vi } from "vitest"
import type { FriendRecord } from "@ouro.bot/friends"

import {
  createOwnerAlertMailSender,
  createOwnerAlertTelegramSender,
  ownerAlertRoutes,
  resolveOwnerAlertAddress,
  type OwnerAlertRouteDeps,
} from "../../../heart/daemon/owner-alert-routes"
import type { MailroomReaderResolution } from "../../../mailroom/reader"
import type { MailroomRegistry } from "../../../mailroom/core"

type ReadyMailroom = Extract<MailroomReaderResolution, { ok: true }>

const message = { noticeId: "owner-channel-outage:slugger:bluebubbles:t:down", subject: "Slugger: iMessage has been down for 16 min", text: "Slugger can't reach you on iMessage." }

function friend(id: string, trustLevel: FriendRecord["trustLevel"], ids: Array<[string, string]>): FriendRecord {
  return { id, name: id, trustLevel, externalIds: ids.map(([provider, externalId]) => ({ provider, externalId, linkedAt: "2026-01-01T00:00:00.000Z" })) } as unknown as FriendRecord
}

const owner = friend("owner", "family", [["local", "testuser"], ["email-address", "Owner@Example.test"], ["imessage-handle", "+15550000000"]])
const relative = friend("relative", "family", [["email-address", "relative@example.test"]])

function mailroom(overrides: Partial<ReadyMailroom["config"]> = {}): ReadyMailroom {
  return {
    ok: true,
    agentName: "slugger",
    config: { mailboxAddress: "slugger@agents.example.test", privateKeys: {}, ...overrides },
    store: {} as ReadyMailroom["store"],
    storeKind: "file",
    storeLabel: "fake",
  }
}

function registry(grants: Array<{ ownerEmail: string; enabled: boolean }>): MailroomRegistry {
  return {
    schemaVersion: 1,
    domain: "example.test",
    mailboxes: [],
    sourceGrants: grants.map((grant, index) => ({ grantId: `g${index}`, agentId: "slugger", source: "hey", aliasAddress: "a@example.test", keyId: "k", publicKeyPem: "p", defaultPlacement: "imbox", ...grant })),
  } as MailroomRegistry
}

function deps(overrides: OwnerAlertRouteDeps = {}): OwnerAlertRouteDeps & { createDraft: ReturnType<typeof vi.fn>; confirmSend: ReturnType<typeof vi.fn> } {
  return {
    listFriends: async () => [relative, owner],
    ownerUsername: () => "testuser",
    resolveMailroom: async () => mailroom(),
    readRegistry: async () => registry([]),
    resolveTransport: () => ({ kind: "local-sink", sinkPath: "/dev/null" }),
    providerClient: async () => undefined,
    ...overrides,
    createDraft: vi.fn(async () => ({ id: "draft_1" })),
    confirmSend: vi.fn(async () => ({ id: "draft_1", status: "sent" })),
  } as never
}

describe("resolveOwnerAlertAddress", () => {
  it("uses the machine owner's own email-address id, never a relative's", async () => {
    await expect(resolveOwnerAlertAddress("/bundle", mailroom().config, deps())).resolves.toBe("owner@example.test")
  })

  it("falls back to the owner of an enabled delegated mail source", async () => {
    const d = deps({
      listFriends: async () => [friend("owner", "family", [["local", "testuser"]]), relative],
      readRegistry: async () => registry([{ ownerEmail: "off@example.test", enabled: false }, { ownerEmail: "Ari@Hey.example", enabled: true }]),
    })
    await expect(resolveOwnerAlertAddress("/bundle", mailroom().config, d)).resolves.toBe("ari@hey.example")
  })

  it("is null when neither names an address, and survives unreadable friends and registry", async () => {
    await expect(resolveOwnerAlertAddress("/bundle", mailroom().config, deps({
      listFriends: async () => { throw "no friends dir" },
      readRegistry: async () => { throw new Error("no registry") },
    }))).resolves.toBeNull()
    await expect(resolveOwnerAlertAddress("/bundle", mailroom().config, deps({
      listFriends: async () => [friend("odd", "family", [])].map((record) => ({ ...record, externalIds: undefined }) as unknown as FriendRecord),
      ownerUsername: () => null,
      readRegistry: async () => ({ ...registry([]), sourceGrants: undefined }) as unknown as MailroomRegistry,
    }))).resolves.toBeNull()
  })
})

describe("createOwnerAlertMailSender", () => {
  it("drafts from the native mailbox to the owner and sends it as a recorded system send", async () => {
    const d = deps()
    await createOwnerAlertMailSender("slugger", "/bundle", d)(message)
    expect(d.createDraft).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "slugger",
      from: "slugger@agents.example.test",
      to: ["owner@example.test"],
      subject: message.subject,
      text: message.text,
      actor: { kind: "system", agentId: "slugger" },
      reason: `harness owner-channel outage notice ${message.noticeId}`,
    }))
    expect(d.confirmSend).toHaveBeenCalledWith(expect.objectContaining({ draftId: "draft_1", confirmation: "CONFIRM_SEND", autonomous: false }))
  })

  it("refuses when mail is unavailable, the kill switch is on, or no owner address is known", async () => {
    await expect(createOwnerAlertMailSender("slugger", "/bundle", deps({
      resolveMailroom: async () => ({ ok: false, agentName: "slugger", reason: "auth-required", error: "vault locked" }),
    }))(message)).rejects.toThrow("mail is not available: vault locked")
    await expect(createOwnerAlertMailSender("slugger", "/bundle", deps({
      resolveMailroom: async () => mailroom({ autonomousSendPolicy: { killSwitch: true } as never }),
    }))(message)).rejects.toThrow("kill switch")
    const none = deps({ listFriends: async () => [] })
    await expect(createOwnerAlertMailSender("slugger", "/bundle", none)(message)).rejects.toThrow("no owner mail address")
    expect(none.createDraft).not.toHaveBeenCalled()
  })

  it("passes a send failure up so the watcher tries the next route", async () => {
    const d = deps()
    d.confirmSend.mockRejectedValueOnce(new Error("ACS down"))
    await expect(createOwnerAlertMailSender("slugger", "/bundle", d)(message)).rejects.toThrow("ACS down")
  })
})

describe("createOwnerAlertTelegramSender", () => {
  it("sends the text as the agent's Telegram owner notice under the alert's id", async () => {
    const sendTelegram = vi.fn(async () => undefined)
    await createOwnerAlertTelegramSender("slugger", { sendTelegram })(message)
    expect(sendTelegram).toHaveBeenCalledWith("slugger", expect.objectContaining({ noticeId: message.noticeId, text: message.text }))
  })
})

describe("ownerAlertRoutes", () => {
  it("offers Telegram and mail from the daemon", () => {
    expect(Object.keys(ownerAlertRoutes("slugger", "/bundle", deps())).sort()).toEqual(["mail", "telegram"])
  })
})
