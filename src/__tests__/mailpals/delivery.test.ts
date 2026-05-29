import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { emitNervesEvent } from "../../nerves/runtime"
import {
  createGroup,
  createMember,
  writeIssue,
  createResponse,
  readGroup,
  writeGroup,
} from "../../mailpals/store"
import { compileIssue, compiledIssueToMessages } from "../../mailpals/delivery"
import type { MailPalsIssue, MailPalsResponse } from "../../mailpals/types"

let stateRoot: string

beforeEach(() => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mailpals-test-"))
  emitNervesEvent({ component: "mailpals", event: "mailpals.test_setup", message: "delivery test" })
})

afterEach(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

function makeGroup() {
  return createGroup(stateRoot, {
    title: "Test Group",
    promptsPerIssue: 3,
    promptDay: 0,
    promptTime: "09:00",
    deliveryDay: 4,
    deliveryTime: "09:00",
    timezone: "America/New_York",
    paused: false,
    groupChatId: "group-chat-1",
    memberIds: [],
  })
}

function addMember(groupId: string, name: string, role: "member" | "admin" = "member") {
  const m = createMember(stateRoot, {
    groupId,
    friendId: `friend-${name.toLowerCase()}`,
    displayName: name,
    role,
    active: true,
  })
  const g = readGroup(stateRoot, groupId)!
  g.memberIds = [...g.memberIds, m.id]
  writeGroup(stateRoot, g)
  return m
}

function makeIssue(groupId: string): MailPalsIssue {
  const now = new Date()
  const iss: MailPalsIssue = {
    id: `iss-${Date.now()}`,
    groupId,
    number: 1,
    prompts: ["What made you laugh?", "What are you grateful for?", "What's on your mind?"],
    status: "delivered",
    openAt: new Date(now.getTime() - 3600000).toISOString(),
    deliverAt: new Date(now.getTime() + 3 * 86400000).toISOString(),
    sentAt: now.toISOString(),
    createdAt: now.toISOString(),
  }
  writeIssue(stateRoot, iss)
  return iss
}

describe("compileIssue — message sequence", () => {
  it("produces header, participation, then sections", () => {
    const group = makeGroup()
    const alice = addMember(group.id, "Alice")
    const iss = makeIssue(group.id)

    createResponse(stateRoot, {
      issueId: iss.id, memberId: alice.id, promptIndex: 0,
      contentText: "laughed at a cat", contentAudioPath: null, transcript: null,
      compiledText: "laughed at a cat", photoWall: [], checkItOut: null,
      respondedAt: new Date().toISOString(),
    })
    createResponse(stateRoot, {
      issueId: iss.id, memberId: alice.id, promptIndex: 1,
      contentText: "sunshine", contentAudioPath: null, transcript: null,
      compiledText: "sunshine", photoWall: [], checkItOut: null,
      respondedAt: new Date().toISOString(),
    })
    createResponse(stateRoot, {
      issueId: iss.id, memberId: alice.id, promptIndex: 2,
      contentText: "dinner", contentAudioPath: null, transcript: null,
      compiledText: "dinner", photoWall: [], checkItOut: null,
      respondedAt: new Date().toISOString(),
    })

    const compiled = compileIssue(stateRoot, iss)
    const msgs = compiledIssueToMessages(compiled)

    expect(msgs[0].text).toBe("mailpals #1")
    expect(msgs[1].text).toBe("everyone responded")
    expect(msgs[2].text).toBe("1/3: What made you laugh?")
    expect(msgs[3].text).toBe("ALICE\nlaughed at a cat")
    expect(msgs[4].text).toBe("2/3: What are you grateful for?")
    expect(msgs[5].text).toBe("ALICE\nsunshine")
    expect(msgs[6].text).toBe("3/3: What's on your mind?")
    expect(msgs[7].text).toBe("ALICE\ndinner")
  })

  it("includes voice note emoji label", () => {
    const group = makeGroup()
    const alice = addMember(group.id, "Alice")
    const iss = makeIssue(group.id)

    createResponse(stateRoot, {
      issueId: iss.id, memberId: alice.id, promptIndex: 0,
      contentText: "transcribed", contentAudioPath: "/audio/note.caf", transcript: "transcribed",
      compiledText: "transcribed", photoWall: [], checkItOut: null,
      respondedAt: new Date().toISOString(),
    })

    const compiled = compileIssue(stateRoot, iss)
    const msgs = compiledIssueToMessages(compiled)
    const voiceMsg = msgs.find((m) => m.text.includes("voice note"))
    expect(voiceMsg).toBeDefined()
    expect(voiceMsg!.text).toContain("ALICE")
    expect(voiceMsg!.attachments).toContain("/audio/note.caf")
  })

  it("handles photo-only response (no text)", () => {
    const group = makeGroup()
    const alice = addMember(group.id, "Alice")
    const iss = makeIssue(group.id)

    createResponse(stateRoot, {
      issueId: iss.id, memberId: alice.id, promptIndex: 0,
      contentText: null, contentAudioPath: null, transcript: null,
      compiledText: "", photoWall: ["/photos/pic.jpg"], checkItOut: null,
      respondedAt: new Date().toISOString(),
    })

    const compiled = compileIssue(stateRoot, iss)
    const msgs = compiledIssueToMessages(compiled)
    const photoMsg = msgs.find((m) => m.text === "ALICE")
    expect(photoMsg).toBeDefined()
    expect(photoMsg!.attachments).toContain("/photos/pic.jpg")
  })

  it("includes check it out section", () => {
    const group = makeGroup()
    const alice = addMember(group.id, "Alice")
    const iss = makeIssue(group.id)

    createResponse(stateRoot, {
      issueId: iss.id, memberId: alice.id, promptIndex: 0,
      contentText: "answer", contentAudioPath: null, transcript: null,
      compiledText: "answer", photoWall: [], checkItOut: "cool article link",
      respondedAt: new Date().toISOString(),
    })

    const compiled = compileIssue(stateRoot, iss)
    expect(compiled.checkItOutItems).toHaveLength(1)
    expect(compiled.checkItOutItems[0].compiledText).toBe("cool article link")

    const msgs = compiledIssueToMessages(compiled)
    const cioHeader = msgs.find((m) => m.text === "check it out")
    expect(cioHeader).toBeDefined()
  })

  it("two respondents — shows both names", () => {
    const group = makeGroup()
    const alice = addMember(group.id, "Alice")
    const bob = addMember(group.id, "Bob")
    const iss = makeIssue(group.id)

    for (const mid of [alice.id, bob.id]) {
      createResponse(stateRoot, {
        issueId: iss.id, memberId: mid, promptIndex: 0,
        contentText: "answer", contentAudioPath: null, transcript: null,
        compiledText: "answer", photoWall: [], checkItOut: null,
        respondedAt: new Date().toISOString(),
      })
    }

    const compiled = compileIssue(stateRoot, iss)
    expect(compiled.participation).toBe("everyone responded")
  })

  it("single responder — came through message", () => {
    const group = makeGroup()
    const alice = addMember(group.id, "Alice")
    const bob = addMember(group.id, "Bob")
    const iss = makeIssue(group.id)

    createResponse(stateRoot, {
      issueId: iss.id, memberId: alice.id, promptIndex: 0,
      contentText: "answer", contentAudioPath: null, transcript: null,
      compiledText: "answer", photoWall: [], checkItOut: null,
      respondedAt: new Date().toISOString(),
    })
    createResponse(stateRoot, {
      issueId: iss.id, memberId: bob.id, promptIndex: 0,
      contentText: null, contentAudioPath: null, transcript: null,
      compiledText: null, photoWall: [], checkItOut: null,
      respondedAt: null,
    })

    const compiled = compileIssue(stateRoot, iss)
    expect(compiled.participation).toContain("1/2")
    expect(compiled.participation).toContain("alice came through")
  })

  it("nobody responded — with admin DM", () => {
    const group = makeGroup()
    const alice = addMember(group.id, "Alice", "admin")
    const iss = makeIssue(group.id)

    createResponse(stateRoot, {
      issueId: iss.id, memberId: alice.id, promptIndex: 0,
      contentText: null, contentAudioPath: null, transcript: null,
      compiledText: null, photoWall: [], checkItOut: null,
      respondedAt: null,
    })

    const compiled = compileIssue(stateRoot, iss)
    expect(compiled.participation).toBe("nobody responded — maybe next week")
    expect(compiled.zeroResponseAdminMessage).toContain("nobody responded")
    expect(compiled.adminMemberId).toBe(alice.id)
  })

  it("empty display name doesn't crash", () => {
    const group = makeGroup()
    const m = createMember(stateRoot, {
      groupId: group.id,
      friendId: "f1",
      displayName: "",
      role: "member",
      active: true,
    })
    const g = readGroup(stateRoot, group.id)!
    g.memberIds = [...g.memberIds, m.id]
    writeGroup(stateRoot, g)
    const iss = makeIssue(group.id)

    createResponse(stateRoot, {
      issueId: iss.id, memberId: m.id, promptIndex: 0,
      contentText: "answer", contentAudioPath: null, transcript: null,
      compiledText: "answer", photoWall: [], checkItOut: null,
      respondedAt: new Date().toISOString(),
    })

    const compiled = compileIssue(stateRoot, iss)
    expect(compiled.participation).toBe("everyone responded")
  })
})
