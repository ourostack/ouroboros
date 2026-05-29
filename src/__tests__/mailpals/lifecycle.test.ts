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
  readIssue,
  readMemberResponses,
  readOpenIssue,
  readActiveIssue,
  readGroup,
  writeGroup,
  writeResponse,
} from "../../mailpals/store"
import {
  createNextIssue,
  openIssue,
  recordAnswer,
  recordPhoto,
  recordVoiceNote,
  handleRedo,
  handleEdit,
  compileAndDeliver,
  skipIssue,
  pauseGroup,
  resumeGroup,
  getStatus,
  sendReminder,
  parseTime,
  parseDay,
  getMailPalsContext,
} from "../../mailpals/lifecycle"
import { compileIssue, compiledIssueToMessages } from "../../mailpals/delivery"
import type { MailPalsIssue, MailPalsResponse } from "../../mailpals/types"

let stateRoot: string

function makeGroup(overrides: Partial<Parameters<typeof createGroup>[1]> = {}) {
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
    ...overrides,
  })
}

function makeMember(groupId: string, name: string, role: "member" | "admin" = "member") {
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

function makeOpenIssue(groupId: string, memberIds: string[]) {
  const now = new Date()
  const iss: MailPalsIssue = {
    id: `iss-${Date.now()}`,
    groupId,
    number: 1,
    prompts: ["What made you laugh?", "What are you grateful for?", "What's on your mind?"],
    status: "open",
    openAt: new Date(now.getTime() - 3600000).toISOString(),
    deliverAt: new Date(now.getTime() + 3 * 86400000).toISOString(),
    sentAt: null,
    createdAt: now.toISOString(),
  }
  writeIssue(stateRoot, iss)
  for (const mid of memberIds) {
    createResponse(stateRoot, {
      issueId: iss.id, memberId: mid, promptIndex: 0,
      contentText: null, contentAudioPath: null, transcript: null,
      compiledText: null, photoWall: [], checkItOut: null, respondedAt: null,
    })
  }
  return iss
}

const deps = () => ({ stateRoot, now: () => new Date() })

beforeEach(() => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mailpals-test-"))
  emitNervesEvent({ component: "mailpals", event: "mailpals.test_setup", message: "test" })
})

afterEach(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Create Issue (mirrors test_lifecycle.py TestCreateNextIssue)
// ---------------------------------------------------------------------------

describe("createNextIssue", () => {
  it("creates an issue with sequential numbers", () => {
    const group = makeGroup()
    makeMember(group.id, "Alice")
    const iss = createNextIssue(deps(), group.id)
    expect(iss).not.toBeNull()
    expect(iss!.number).toBe(1)
    expect(iss!.prompts).toHaveLength(3)
    expect(iss!.status).toBe("pending")
  })

  it("increments issue number", () => {
    const group = makeGroup()
    makeMember(group.id, "Alice")
    const iss1 = createNextIssue(deps(), group.id)!
    iss1.status = "delivered"
    writeIssue(stateRoot, iss1)
    const iss2 = createNextIssue(deps(), group.id)!
    expect(iss2.number).toBe(2)
  })

  it("returns null for paused group", () => {
    const group = makeGroup({ paused: true })
    const iss = createNextIssue(deps(), group.id)
    expect(iss).toBeNull()
  })

  it("throws for nonexistent group", () => {
    expect(() => createNextIssue(deps(), "nope")).toThrow()
  })

  it("caps prompts at available count", () => {
    const group = makeGroup({ promptsPerIssue: 200 })
    makeMember(group.id, "Alice")
    const iss = createNextIssue(deps(), group.id)!
    expect(iss.prompts.length).toBeGreaterThan(0)
    expect(iss.prompts.length).toBeLessThanOrEqual(102)
  })
})

// ---------------------------------------------------------------------------
// Open Issue (mirrors test_lifecycle.py TestOpenIssue)
// ---------------------------------------------------------------------------

describe("openIssue", () => {
  it("opens issue and creates response records", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const bob = makeMember(group.id, "Bob")
    const iss = createNextIssue(deps(), group.id)!
    const result = openIssue(deps(), iss.id, iss)

    expect(readIssue(stateRoot, iss.id)!.status).toBe("open")
    expect(result.memberMessages).toHaveLength(2)
    expect(result.memberMessages[0].text).toContain("mailpals #")
    expect(result.memberMessages[0].text).toContain("1/3:")
    expect(result.memberMessages[0].text).toContain("(you can attach photos anytime)")
  })

  it("handles zero active members", () => {
    const group = makeGroup()
    const iss = createNextIssue(deps(), group.id)!
    const result = openIssue(deps(), iss.id, iss)
    expect(result.memberMessages).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// DM Flow — Happy Path (mirrors test_router.py TestHappyPath)
// ---------------------------------------------------------------------------

describe("recordAnswer — happy path", () => {
  it("walks through 3 prompts sequentially", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])

    const r1 = recordAnswer(deps(), iss.id, alice.id, "answer 1")
    expect(r1.nextMessage).toContain("2/3:")

    const r2 = recordAnswer(deps(), iss.id, alice.id, "answer 2")
    expect(r2.nextMessage).toContain("3/3:")

    const r3 = recordAnswer(deps(), iss.id, alice.id, "answer 3")
    expect(r3.nextMessage).toContain("You're all set")
  })
})

describe("recordAnswer — post-completion", () => {
  it("stores extra text as Check It Out", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])

    recordAnswer(deps(), iss.id, alice.id, "a1")
    recordAnswer(deps(), iss.id, alice.id, "a2")
    recordAnswer(deps(), iss.id, alice.id, "a3")

    const r = recordAnswer(deps(), iss.id, alice.id, "extra link")
    expect(r.nextMessage).toBe("received")

    const responses = readMemberResponses(stateRoot, iss.id, alice.id)
    const withCheckItOut = responses.find((r) => r.checkItOut !== null)
    expect(withCheckItOut).toBeDefined()
    expect(withCheckItOut!.checkItOut).toBe("extra link")
  })

  it("appends multiple Check It Out texts", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])

    recordAnswer(deps(), iss.id, alice.id, "a1")
    recordAnswer(deps(), iss.id, alice.id, "a2")
    recordAnswer(deps(), iss.id, alice.id, "a3")
    recordAnswer(deps(), iss.id, alice.id, "link 1")
    recordAnswer(deps(), iss.id, alice.id, "link 2")

    const responses = readMemberResponses(stateRoot, iss.id, alice.id)
    const withCheckItOut = responses.find((r) => r.checkItOut !== null)
    expect(withCheckItOut!.checkItOut).toContain("link 1")
    expect(withCheckItOut!.checkItOut).toContain("link 2")
  })
})

// ---------------------------------------------------------------------------
// Photos (mirrors test_router.py TestPhotosDuringPrompt, TestPostCompletion)
// ---------------------------------------------------------------------------

describe("recordPhoto", () => {
  it("attaches photo silently during unanswered prompt", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])

    const r = recordPhoto(deps(), iss.id, alice.id, "/photos/pic.jpg")
    expect(r.nextMessage).toBeNull()

    const responses = readMemberResponses(stateRoot, iss.id, alice.id)
    expect(responses[0].photoWall).toContain("/photos/pic.jpg")
    expect(responses[0].respondedAt).toBeNull()
  })

  it("adds to Photo Wall after completion", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])

    recordAnswer(deps(), iss.id, alice.id, "a1")
    recordAnswer(deps(), iss.id, alice.id, "a2")
    recordAnswer(deps(), iss.id, alice.id, "a3")

    const r = recordPhoto(deps(), iss.id, alice.id, "/photos/extra.jpg")
    expect(r.nextMessage).toBe("received")
  })

  it("multiple photos on same prompt", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])

    recordPhoto(deps(), iss.id, alice.id, "/p1.jpg")
    recordPhoto(deps(), iss.id, alice.id, "/p2.jpg")

    const responses = readMemberResponses(stateRoot, iss.id, alice.id)
    expect(responses[0].photoWall).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Voice Notes (mirrors test_router.py TestVoiceNote)
// ---------------------------------------------------------------------------

describe("recordVoiceNote", () => {
  it("advances prompt on voice note", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])

    const r = recordVoiceNote(deps(), iss.id, alice.id, "/audio/note.caf", "transcribed text")
    expect(r.nextMessage).toContain("2/3:")

    const responses = readMemberResponses(stateRoot, iss.id, alice.id)
    const answered = responses.find((r) => r.respondedAt !== null)
    expect(answered!.contentAudioPath).toBe("/audio/note.caf")
    expect(answered!.transcript).toBe("transcribed text")
    expect(answered!.contentText).toBe("transcribed text")
  })

  it("returns received after completion", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])

    recordAnswer(deps(), iss.id, alice.id, "a1")
    recordAnswer(deps(), iss.id, alice.id, "a2")
    recordAnswer(deps(), iss.id, alice.id, "a3")

    const r = recordVoiceNote(deps(), iss.id, alice.id, "/audio/extra.caf")
    expect(r.nextMessage).toBe("received")
  })
})

// ---------------------------------------------------------------------------
// Redo (mirrors test_router.py TestRedo)
// ---------------------------------------------------------------------------

describe("handleRedo", () => {
  it("wipes all responses and restarts from prompt 1", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])

    recordAnswer(deps(), iss.id, alice.id, "a1")
    recordAnswer(deps(), iss.id, alice.id, "a2")

    const r = handleRedo(deps(), iss.id, alice.id)
    expect(r.nextMessage).toContain("wiped it. fresh start")
    expect(r.nextMessage).toContain("1/3:")

    const responses = readMemberResponses(stateRoot, iss.id, alice.id)
    expect(responses).toHaveLength(1)
    expect(responses[0].promptIndex).toBe(0)
    expect(responses[0].respondedAt).toBeNull()
  })

  it("wipes extras too", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])

    recordAnswer(deps(), iss.id, alice.id, "a1")
    recordAnswer(deps(), iss.id, alice.id, "a2")
    recordAnswer(deps(), iss.id, alice.id, "a3")
    recordAnswer(deps(), iss.id, alice.id, "extra")

    handleRedo(deps(), iss.id, alice.id)
    const responses = readMemberResponses(stateRoot, iss.id, alice.id)
    expect(responses).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Edit (mirrors test_router.py TestEdit)
// ---------------------------------------------------------------------------

describe("handleEdit", () => {
  it("re-sends the specified prompt", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])

    recordAnswer(deps(), iss.id, alice.id, "a1")

    const r = handleEdit(deps(), iss.id, alice.id, 1)
    expect(r.nextMessage).toContain("1/3:")
  })

  it("rejects invalid prompt number", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])

    const r = handleEdit(deps(), iss.id, alice.id, 99)
    expect(r.nextMessage).toBe("there are only 3 prompts")
  })

  it("rejects edit 0", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])

    const r = handleEdit(deps(), iss.id, alice.id, 0)
    expect(r.nextMessage).toBe("there are only 3 prompts")
  })

  it("clears response and allows re-answer", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])

    recordAnswer(deps(), iss.id, alice.id, "original")
    handleEdit(deps(), iss.id, alice.id, 1)

    const responses = readMemberResponses(stateRoot, iss.id, alice.id)
    const edited = responses.find((r) => r.promptIndex === 0)
    expect(edited!.respondedAt).toBeNull()
    expect(edited!.contentText).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Empty text (mirrors test_router.py TestEmptyText)
// ---------------------------------------------------------------------------

describe("recordAnswer — empty text", () => {
  it("ignores empty string", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])

    const r = recordAnswer(deps(), iss.id, alice.id, "")
    expect(r.nextMessage).toBeNull()
  })

  it("ignores whitespace-only", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])

    const r = recordAnswer(deps(), iss.id, alice.id, "   ")
    expect(r.nextMessage).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Multi-member (mirrors test_router.py TestMultiMember)
// ---------------------------------------------------------------------------

describe("multi-member", () => {
  it("two members answer independently", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const bob = makeMember(group.id, "Bob")
    const iss = makeOpenIssue(group.id, [alice.id, bob.id])

    const r1 = recordAnswer(deps(), iss.id, alice.id, "alice-1")
    expect(r1.nextMessage).toContain("2/3:")

    const r2 = recordAnswer(deps(), iss.id, bob.id, "bob-1")
    expect(r2.nextMessage).toContain("2/3:")
  })
})

// ---------------------------------------------------------------------------
// Compile and Deliver (mirrors test_lifecycle.py TestCompileAndDeliver)
// ---------------------------------------------------------------------------

describe("compileAndDeliver", () => {
  it("compiles and sets status to delivered", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice", "admin")
    const bob = makeMember(group.id, "Bob")
    const iss = makeOpenIssue(group.id, [alice.id, bob.id])

    recordAnswer(deps(), iss.id, alice.id, "a1")
    recordAnswer(deps(), iss.id, alice.id, "a2")
    recordAnswer(deps(), iss.id, alice.id, "a3")
    recordAnswer(deps(), iss.id, bob.id, "b1")
    recordAnswer(deps(), iss.id, bob.id, "b2")
    recordAnswer(deps(), iss.id, bob.id, "b3")

    const result = compileAndDeliver(deps(), iss.id)
    expect(readIssue(stateRoot, iss.id)!.status).toBe("delivered")
    expect(result.compiled.participation).toBe("everyone responded")
    expect(result.compiled.sections).toHaveLength(3)
  })

  it("includes voice note label in delivery", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])

    recordVoiceNote(deps(), iss.id, alice.id, "/audio/1.caf", "I laughed at a cat")
    recordAnswer(deps(), iss.id, alice.id, "grateful for sunshine")
    recordAnswer(deps(), iss.id, alice.id, "thinking about dinner")

    const result = compileAndDeliver(deps(), iss.id)
    const messages = compiledIssueToMessages(result.compiled)
    const voiceMsg = messages.find((m) => m.text.includes("voice note"))
    expect(voiceMsg).toBeDefined()
    expect(voiceMsg!.text).toContain("ALICE")
  })

  it("shows participation line for partial response", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const bob = makeMember(group.id, "Bob")
    const iss = makeOpenIssue(group.id, [alice.id, bob.id])

    recordAnswer(deps(), iss.id, alice.id, "a1")
    recordAnswer(deps(), iss.id, alice.id, "a2")
    recordAnswer(deps(), iss.id, alice.id, "a3")
    // Bob doesn't answer

    const result = compileAndDeliver(deps(), iss.id)
    expect(result.compiled.participation).toContain("1/2")
    expect(result.compiled.participation).toContain("alice came through")
  })

  it("handles zero responses", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice", "admin")
    const iss = makeOpenIssue(group.id, [alice.id])

    const result = compileAndDeliver(deps(), iss.id)
    expect(result.compiled.participation).toBe("nobody responded — maybe next week")
    expect(result.compiled.zeroResponseAdminMessage).toBeDefined()
    expect(result.compiled.zeroResponseAdminMessage).toContain("nobody responded")
  })

  it("includes check it out in delivery", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])

    recordAnswer(deps(), iss.id, alice.id, "a1")
    recordAnswer(deps(), iss.id, alice.id, "a2")
    recordAnswer(deps(), iss.id, alice.id, "a3")
    recordAnswer(deps(), iss.id, alice.id, "check this link")

    const result = compileAndDeliver(deps(), iss.id)
    expect(result.compiled.checkItOutItems).toHaveLength(1)
    expect(result.compiled.checkItOutItems[0].compiledText).toBe("check this link")
  })
})

describe("compiledIssueToMessages", () => {
  it("produces correct message sequence", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const bob = makeMember(group.id, "Bob")
    const iss = makeOpenIssue(group.id, [alice.id, bob.id])

    recordAnswer(deps(), iss.id, alice.id, "a1")
    recordAnswer(deps(), iss.id, alice.id, "a2")
    recordAnswer(deps(), iss.id, alice.id, "a3")
    recordAnswer(deps(), iss.id, bob.id, "b1")
    recordAnswer(deps(), iss.id, bob.id, "b2")
    recordAnswer(deps(), iss.id, bob.id, "b3")

    const result = compileAndDeliver(deps(), iss.id)
    const messages = compiledIssueToMessages(result.compiled)

    expect(messages[0].text).toBe("mailpals #1")
    expect(messages[1].text).toBe("everyone responded")
    expect(messages[2].text).toContain("1/3:")
  })
})

// ---------------------------------------------------------------------------
// Reminders (mirrors test_lifecycle.py TestSendReminder)
// ---------------------------------------------------------------------------

describe("sendReminder", () => {
  it("sends private reminder to non-responders", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const bob = makeMember(group.id, "Bob")
    const iss = makeOpenIssue(group.id, [alice.id, bob.id])

    recordAnswer(deps(), iss.id, alice.id, "a1")
    // Bob hasn't answered

    const result = sendReminder(deps(), iss.id, "private")
    expect(result.privateMessages).toHaveLength(1)
    expect(result.privateMessages[0].friendId).toBe(bob.friendId)
    expect(result.privateMessages[0].text).toContain("waiting on you")
  })

  it("sends public reminder to group", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const bob = makeMember(group.id, "Bob")
    const iss = makeOpenIssue(group.id, [alice.id, bob.id])

    recordAnswer(deps(), iss.id, alice.id, "a1")

    const result = sendReminder(deps(), iss.id, "public")
    expect(result.publicMessage).not.toBeNull()
    expect(result.publicMessage!.text).toContain("1 of 2 in")
    expect(result.publicMessage!.text).toContain("bob")
  })

  it("skips when everyone responded", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])

    recordAnswer(deps(), iss.id, alice.id, "a1")

    const result = sendReminder(deps(), iss.id, "private")
    expect(result.privateMessages).toHaveLength(0)
  })

  it("skips for non-open issue", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])
    iss.status = "delivered"
    writeIssue(stateRoot, iss)

    const result = sendReminder(deps(), iss.id, "private")
    expect(result.privateMessages).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Admin commands (mirrors test_onboarding.py TestAdminCommands)
// ---------------------------------------------------------------------------

describe("admin commands", () => {
  it("pause — returns already paused when paused", () => {
    const group = makeGroup({ paused: true })
    expect(pauseGroup(deps(), group.id)).toBe("already paused")
  })

  it("pause — pauses group", () => {
    const group = makeGroup()
    const result = pauseGroup(deps(), group.id)
    expect(result).toContain("paused")
    expect(readGroup(stateRoot, group.id)!.paused).toBe(true)
  })

  it("resume — returns not paused when not paused", () => {
    const group = makeGroup()
    expect(resumeGroup(deps(), group.id)).toBe("not paused")
  })

  it("resume — resumes and schedules next issue", () => {
    const group = makeGroup({ paused: true })
    makeMember(group.id, "Alice")
    const result = resumeGroup(deps(), group.id)
    expect(result).toContain("resumed")
    expect(readGroup(stateRoot, group.id)!.paused).toBe(false)
  })

  it("skip — returns nothing when no active issue", () => {
    const group = makeGroup()
    expect(skipIssue(deps(), group.id)).toBe("nothing to skip")
  })

  it("skip — skips the active issue", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])
    const result = skipIssue(deps(), group.id)
    expect(result).toContain("skipped")
    expect(readIssue(stateRoot, iss.id)!.status).toBe("skipped")
  })

  it("status — shows group info", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const result = getStatus(deps(), group.id)
    expect(result).toContain("Test Group")
    expect(result).toContain("alice")
    expect(result).toContain("monday")
  })

  it("status — shows paused", () => {
    const group = makeGroup({ paused: true })
    const result = getStatus(deps(), group.id)
    expect(result).toContain("[paused]")
  })
})

// ---------------------------------------------------------------------------
// Time parsing (mirrors test_onboarding.py TestParseTime)
// ---------------------------------------------------------------------------

describe("parseTime", () => {
  it("parses 10am", () => expect(parseTime("10am")).toBe("10:00"))
  it("parses 9:30pm", () => expect(parseTime("9:30pm")).toBe("21:30"))
  it("parses 14:00", () => expect(parseTime("14:00")).toBe("14:00"))
  it("parses 12pm", () => expect(parseTime("12pm")).toBe("12:00"))
  it("parses 12am", () => expect(parseTime("12am")).toBe("00:00"))
  it("returns null for garbage", () => expect(parseTime("nope")).toBeNull())
})

describe("parseDay", () => {
  it("parses full day names", () => {
    expect(parseDay("monday")).toBe(0)
    expect(parseDay("friday")).toBe(4)
    expect(parseDay("sunday")).toBe(6)
  })

  it("parses abbreviations", () => {
    expect(parseDay("mon")).toBe(0)
    expect(parseDay("wed")).toBe(2)
    expect(parseDay("fri")).toBe(4)
  })

  it("returns null for invalid", () => {
    expect(parseDay("nope")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Per-turn context (the linchpin seam)
// ---------------------------------------------------------------------------

describe("getMailPalsContext", () => {
  it("returns owes prompt when member has unanswered", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])

    const ctx = getMailPalsContext(stateRoot, alice.friendId)
    expect(ctx).toContain("owes 1/3:")
  })

  it("returns null when all prompts answered", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])

    recordAnswer(deps(), iss.id, alice.id, "a1")
    recordAnswer(deps(), iss.id, alice.id, "a2")
    recordAnswer(deps(), iss.id, alice.id, "a3")

    const ctx = getMailPalsContext(stateRoot, alice.friendId)
    expect(ctx).toBeNull()
  })

  it("returns null for unknown friend", () => {
    expect(getMailPalsContext(stateRoot, "nobody")).toBeNull()
  })

  it("advances context as prompts are answered", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])

    expect(getMailPalsContext(stateRoot, alice.friendId)).toContain("owes 1/3:")
    recordAnswer(deps(), iss.id, alice.id, "a1")
    expect(getMailPalsContext(stateRoot, alice.friendId)).toContain("owes 2/3:")
    recordAnswer(deps(), iss.id, alice.id, "a2")
    expect(getMailPalsContext(stateRoot, alice.friendId)).toContain("owes 3/3:")
  })
})

// ---------------------------------------------------------------------------
// Edit mid-flow (mirrors test_router.py TestEditMidFlow)
// ---------------------------------------------------------------------------

describe("edit mid-flow", () => {
  it("edit after partial completion routes correctly", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])

    recordAnswer(deps(), iss.id, alice.id, "a1")
    recordAnswer(deps(), iss.id, alice.id, "a2")

    handleEdit(deps(), iss.id, alice.id, 1)
    const r = recordAnswer(deps(), iss.id, alice.id, "edited a1")
    // Should advance to prompt 3 since prompt 2 is already answered
    expect(r.nextMessage).toContain("3/3:")
  })
})

// ---------------------------------------------------------------------------
// Photo then answer (mirrors test_router.py TestPhotoThenAnswer)
// ---------------------------------------------------------------------------

describe("photo then answer", () => {
  it("photo then text on same prompt", () => {
    const group = makeGroup()
    const alice = makeMember(group.id, "Alice")
    const iss = makeOpenIssue(group.id, [alice.id])

    recordPhoto(deps(), iss.id, alice.id, "/pic.jpg")
    const r = recordAnswer(deps(), iss.id, alice.id, "answer with photo")
    expect(r.nextMessage).toContain("2/3:")
  })
})
