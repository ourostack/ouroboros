import { describe, expect, it } from "vitest"
import type { DecryptedMailMessage } from "../../mailroom/core"
import { reconstructThread } from "../../mailroom/thread"

function fakeMessage(input: {
  id: string
  receivedAt: string
  messageId?: string
  inReplyTo?: string
  references?: string[]
  subject?: string
}): DecryptedMailMessage {
  return {
    schemaVersion: 1,
    id: input.id,
    agentId: "slugger",
    mailboxId: "mb_native",
    compartmentKind: "native",
    compartmentId: "native",
    recipient: "slugger@ouro.bot",
    envelope: { mailFrom: "friend@example.com", rcptTo: ["slugger@ouro.bot"] },
    placement: "imbox",
    trustReason: "test",
    rawObject: `raw/${input.id}.json`,
    rawSha256: "0".repeat(64),
    rawSize: 0,
    privateEnvelope: { algorithm: "RSA-OAEP-SHA256+A256GCM", keyId: "k", wrappedKey: "", iv: "", authTag: "", ciphertext: "" },
    ingest: { schemaVersion: 1, kind: "smtp" },
    receivedAt: input.receivedAt,
    private: {
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
      ...(input.references ? { references: input.references } : {}),
      from: ["friend@example.com"],
      to: ["slugger@ouro.bot"],
      cc: [],
      subject: input.subject ?? "(test)",
      text: "",
      snippet: "",
      attachments: [],
      untrustedContentWarning: "",
    },
  }
}

describe("reconstructThread", () => {
  it("walks ancestors and descendants from a mid-thread seed", () => {
    const root = fakeMessage({ id: "id_root", receivedAt: "2026-04-21T08:00:00Z", messageId: "<root@x>" })
    const reply1 = fakeMessage({
      id: "id_r1",
      receivedAt: "2026-04-21T09:00:00Z",
      messageId: "<r1@x>",
      inReplyTo: "<root@x>",
      references: ["<root@x>"],
    })
    const reply2 = fakeMessage({
      id: "id_r2",
      receivedAt: "2026-04-21T10:00:00Z",
      messageId: "<r2@x>",
      inReplyTo: "<r1@x>",
      references: ["<root@x>", "<r1@x>"],
    })
    const reply3 = fakeMessage({
      id: "id_r3",
      receivedAt: "2026-04-21T11:00:00Z",
      messageId: "<r3@x>",
      inReplyTo: "<r2@x>",
      references: ["<root@x>", "<r1@x>", "<r2@x>"],
    })
    const unrelated = fakeMessage({ id: "id_other", receivedAt: "2026-04-21T09:30:00Z", messageId: "<other@x>" })

    const thread = reconstructThread("id_r2", [unrelated, reply3, reply1, root, reply2])
    expect(thread.rootMessageId).toBe("<root@x>")
    expect(thread.members.map((member) => member.message.id)).toEqual(["id_root", "id_r1", "id_r2", "id_r3"])
    expect(thread.members.map((member) => member.depth)).toEqual([0, 1, 2, 3])
  })

  it("returns just the seed when no thread relationships exist in the pool", () => {
    const standalone = fakeMessage({ id: "id_x", receivedAt: "2026-04-21T08:00:00Z" })
    const other = fakeMessage({ id: "id_y", receivedAt: "2026-04-21T09:00:00Z" })
    const thread = reconstructThread("id_x", [standalone, other])
    expect(thread.members).toHaveLength(1)
    expect(thread.members[0]!.message.id).toBe("id_x")
    expect(thread.members[0]!.depth).toBe(0)
  })

  it("returns empty when seed is not in pool", () => {
    const root = fakeMessage({ id: "id_root", receivedAt: "2026-04-21T08:00:00Z" })
    const thread = reconstructThread("id_missing", [root])
    expect(thread).toEqual({ rootMessageId: undefined, members: [] })
  })

  it("resolves seed by RFC822 messageId when storage id does not match", () => {
    const root = fakeMessage({ id: "id_root", receivedAt: "2026-04-21T08:00:00Z", messageId: "<root@x>" })
    const reply = fakeMessage({ id: "id_reply", receivedAt: "2026-04-21T09:00:00Z", messageId: "<reply@x>", inReplyTo: "<root@x>", references: ["<root@x>"] })
    const thread = reconstructThread("<reply@x>", [root, reply])
    expect(thread.members.map((member) => member.message.id)).toEqual(["id_root", "id_reply"])
  })

  it("uses References when In-Reply-To is missing — common in threaded replies via list mailers", () => {
    const root = fakeMessage({ id: "id_root", receivedAt: "2026-04-21T08:00:00Z", messageId: "<root@x>" })
    const child = fakeMessage({ id: "id_child", receivedAt: "2026-04-21T09:00:00Z", messageId: "<child@x>", references: ["<root@x>"] })
    const thread = reconstructThread("id_root", [root, child])
    expect(thread.members.map((member) => member.message.id)).toEqual(["id_root", "id_child"])
  })

  it("does not pull in unrelated messages that share no ancestors", () => {
    const root = fakeMessage({ id: "id_root", receivedAt: "2026-04-21T08:00:00Z", messageId: "<root@x>" })
    const reply = fakeMessage({ id: "id_reply", receivedAt: "2026-04-21T09:00:00Z", messageId: "<reply@x>", inReplyTo: "<root@x>" })
    const stranger = fakeMessage({ id: "id_stranger", receivedAt: "2026-04-21T09:30:00Z", messageId: "<stranger@x>", inReplyTo: "<no-such-parent@x>" })
    const thread = reconstructThread("id_root", [root, reply, stranger])
    expect(thread.members.map((member) => member.message.id)).toEqual(["id_root", "id_reply"])
  })

  it("ignores empty/whitespace header values defensively", () => {
    const root = fakeMessage({ id: "id_root", receivedAt: "2026-04-21T08:00:00Z", messageId: "<root@x>" })
    const reply = fakeMessage({ id: "id_reply", receivedAt: "2026-04-21T09:00:00Z", messageId: "<reply@x>", inReplyTo: "  ", references: ["", "<root@x>"] })
    const thread = reconstructThread("id_reply", [root, reply])
    expect(thread.members.map((member) => member.message.id)).toEqual(["id_root", "id_reply"])
  })
})
