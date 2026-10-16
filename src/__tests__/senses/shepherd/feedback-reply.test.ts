import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import Database from "better-sqlite3"
import { feedbackStorePath, openFeedbackStore, type FeedbackInput } from "../../../senses/shepherd/feedback-store"
import { resolveFeedbackReply, FeedbackReplyRefusal } from "../../../senses/shepherd/feedback-reply"

const first = "feedback:11111111-1111-4111-8111-111111111111"
const second = "feedback:22222222-2222-4222-8222-222222222222"
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-teams-reply-"))
  console.info(`created private test root: ${root}`)
  const store = openFeedbackStore(feedbackStorePath(root))
  const input = (id: string): FeedbackInput => ({
    id, actorId: "owner", agent: "orchid", bodyHash: "a".repeat(64), createdAt: "2026-10-15T19:00:00Z",
    source: { id: "33333333-3333-4333-8333-333333333333", host: "cmux", label: "Historic coding session",
      tty: "/dev/ttys001", cwd: "/original", task: "original task" },
    packet: { feedback: `Original feedback ${id}`, context: "Untrusted caller evidence",
      screen: "Original screen", previousReturn: null },
    recipient: { friendId: "owner", aadObjectId: "aad-owner", tenantId: "tenant" }, receipt: "Received.",
  })
  for (const [id, messageId] of [[first, "sent-a"], [second, "sent-b"],
    ["feedback:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "sent-uppercase"]]) {
    store.submit(input(id))
    store.claimReview(id, "owner", "reviewer")
    store.completeReview(id, "owner", "reviewer", `Question for ${messageId}?`)
    store.claimDelivery(id, "owner", "sender")
    store.completeDelivery(id, "owner", "sender", { state: "sent", conversationId: "private-chat", messageId })
  }
  store.submit(input("feedback:44444444-4444-4444-8444-444444444444"))
  store.close()
  return { agentRoot: root, friendId: "owner", conversationId: "private-chat", text: "Only this session, please." }
}

describe("feedback reply selection", () => {
  // Missing or latest-item binding would attach the wrong private source/question.
  it("binds the exact archived outgoing quote rather than latest/pending feedback", () => {
    const input = fixture()
    const reply = resolveFeedbackReply({ ...input, replyToId: "sent-a" })
    expect(reply?.source).toMatchObject({ id: "33333333-3333-4333-8333-333333333333", cwd: "/original" })
    expect(Object.isFrozen(reply?.source)).toBe(true)
    expect(reply?.context).toContain("Question for sent-a?")
    expect(reply?.context).toContain("Original screen")
    expect(reply?.context).toContain("no recorded judgment")
    expect(reply?.context).not.toContain("Question for sent-b?")
  })

  it("selects a full explicit ID in its actual delivered conversation", () => {
    const input = fixture()
    expect(resolveFeedbackReply({ ...input, text: `${second}: just this one` })?.context).toContain("Question for sent-b?")
    expect(resolveFeedbackReply({ ...input, replyToId: "sent-a", text: `${first} yes` })?.context).toContain("Question for sent-a?")
  })

  it("preserves the exact case of UUIDs accepted and frozen by submission custody", () => {
    const input = fixture()
    expect(resolveFeedbackReply({ ...input, text: "feedback:AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" })?.context)
      .toContain("Question for sent-uppercase?")
  })

  it.each([
    { text: "feedback:00000000-0000-4000-8000-000000000000" },
    { text: "feedback:short" },
    { text: `${first} ${second}` },
    { text: second, replyToId: "sent-a" },
    { text: first, friendId: "stranger" },
    { text: first, conversationId: "other-chat" },
    { text: "feedback:44444444-4444-4444-8444-444444444444" },
  ])("refuses unbound or conflicting explicit selection without disclosing contents: %j", (change) => {
    const input = fixture()
    try {
      resolveFeedbackReply({ ...input, ...change })
      expect.fail("must refuse")
    } catch (error) {
      expect(error).toBeInstanceOf(FeedbackReplyRefusal)
      expect((error as Error).message).not.toMatch(/Original|Question|owner|private-chat|33333333|\/original/)
    }
  })

  it("leaves ordinary quotes and bare messages normal, even with several records", () => {
    const input = fixture()
    expect(resolveFeedbackReply({ ...input, replyToId: "ordinary-message" })).toBeNull()
    expect(resolveFeedbackReply(input)).toBeNull()
  })

  // A scoped miss must not confuse another actor/chat's archived receipt with
  // an ordinary quote and let private-feedback steering reach the model.
  it.each([
    { friendId: "other-actor" },
    { conversationId: "other-chat" },
  ])("refuses known archived quotes outside their actor/chat binding: %j", (change) => {
    const input = fixture()
    expect(() => resolveFeedbackReply({ ...input, ...change, replyToId: "sent-a" }))
      .toThrow(FeedbackReplyRefusal)
  })

  it("never creates a queue for ordinary traffic and refuses absent explicit feedback", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-teams-absent-"))
    console.info(`created private test root: ${root}`)
    const input = { agentRoot: root, friendId: "owner", conversationId: "chat", text: "hello", replyToId: "ordinary" }
    expect(resolveFeedbackReply(input)).toBeNull()
    expect(fs.readdirSync(root)).toEqual([])
    expect(() => resolveFeedbackReply({ ...input, text: first })).toThrow(FeedbackReplyRefusal)
    expect(fs.readdirSync(root)).toEqual([])
  })

  it("fails closed on a malformed queue for a quoted selection", () => {
    const input = fixture()
    fs.writeFileSync(feedbackStorePath(input.agentRoot), "corrupt database")
    expect(() => resolveFeedbackReply({ ...input, replyToId: "sent-a" })).toThrow(FeedbackReplyRefusal)
  })

  it("refuses quote-index drift instead of importing a record outside its frozen actual delivery", () => {
    const input = fixture()
    const db = new Database(feedbackStorePath(input.agentRoot))
    db.prepare("UPDATE feedback SET conversation=? WHERE id=?").run("other-chat", first)
    db.close()
    expect(() => resolveFeedbackReply({ ...input, conversationId: "other-chat", replyToId: "sent-a" }))
      .toThrow(FeedbackReplyRefusal)
  })
})
