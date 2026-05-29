import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { emitNervesEvent } from "../../nerves/runtime"
import {
  createGroup,
  createMember,
  readGroup,
  readIssue,
  writeGroup,
} from "../../mailpals/store"
import {
  createNextIssue,
  openIssue,
  recordAnswer,
  recordPhoto,
  recordVoiceNote,
  compileAndDeliver,
  parseTime,
} from "../../mailpals/lifecycle"
import { compiledIssueToMessages } from "../../mailpals/delivery"

let stateRoot: string

beforeEach(() => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mailpals-dryrun-"))
  emitNervesEvent({ component: "mailpals", event: "mailpals.test_dryrun", message: "dry run test" })
})

afterEach(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

describe("full loop dry-run: open → collect → deliver", () => {
  it("produces the correct compiled issue format", () => {
    // 1. Create group with 2 members
    const group = createGroup(stateRoot, {
      title: "Family Group",
      promptsPerIssue: 3,
      promptDay: 0,
      promptTime: "09:00",
      deliveryDay: 4,
      deliveryTime: "18:00",
      timezone: "America/New_York",
      paused: false,
      groupChatId: "iMessage;+;group123",
      memberIds: [],
    })
    const alice = createMember(stateRoot, {
      groupId: group.id,
      friendId: "friend-alice",
      displayName: "Alice",
      role: "admin",
      active: true,
    })
    const bob = createMember(stateRoot, {
      groupId: group.id,
      friendId: "friend-bob",
      displayName: "Bob",
      role: "member",
      active: true,
    })
    const g = readGroup(stateRoot, group.id)!
    g.memberIds = [alice.id, bob.id]
    writeGroup(stateRoot, g)

    const deps = { stateRoot }

    // 2. Create and open issue
    const issue = createNextIssue(deps, group.id)!
    expect(issue.number).toBe(1)
    expect(issue.prompts).toHaveLength(3)

    const openResult = openIssue(deps, issue.id, issue)
    expect(openResult.memberMessages).toHaveLength(2)
    expect(openResult.memberMessages[0].text).toContain("mailpals #1")
    expect(openResult.memberMessages[0].text).toContain("1/3:")

    // 3. Alice answers all 3 prompts + sends a check-it-out extra
    const a1 = recordAnswer(deps, issue.id, alice.id, "Laughed at my dog's new haircut")
    expect(a1.nextMessage).toContain("2/3:")

    const a2 = recordAnswer(deps, issue.id, alice.id, "Grateful for my family")
    expect(a2.nextMessage).toContain("3/3:")

    const a3 = recordAnswer(deps, issue.id, alice.id, "Thinking about vacation plans")
    expect(a3.nextMessage).toContain("You're all set")

    const extra = recordAnswer(deps, issue.id, alice.id, "Check out this article about travel")
    expect(extra.nextMessage).toBe("received")

    // 4. Bob answers with a voice note, then text, then a photo
    const b1 = recordVoiceNote(deps, issue.id, bob.id, "/audio/bob-laugh.caf", "My kids said the funniest thing")
    expect(b1.nextMessage).toContain("2/3:")

    const b2 = recordAnswer(deps, issue.id, bob.id, "Grateful for good weather")
    expect(b2.nextMessage).toContain("3/3:")

    recordPhoto(deps, issue.id, bob.id, "/photos/sunset.jpg")
    const b3 = recordAnswer(deps, issue.id, bob.id, "Planning a garden project")
    expect(b3.nextMessage).toContain("You're all set")

    // 5. Compile and deliver
    const result = compileAndDeliver(deps, issue.id)
    expect(readIssue(stateRoot, issue.id)!.status).toBe("delivered")
    expect(result.groupChatId).toBe("iMessage;+;group123")

    const compiled = result.compiled
    expect(compiled.issueNumber).toBe(1)
    expect(compiled.participation).toBe("everyone responded")
    expect(compiled.sections).toHaveLength(3)

    // Check message sequence
    const messages = compiledIssueToMessages(compiled)
    expect(messages[0].text).toBe("mailpals #1")
    expect(messages[1].text).toBe("everyone responded")

    // Verify prompt sections exist
    const promptHeaders = messages.filter((m) => m.text.match(/^\d+\/3:/))
    expect(promptHeaders).toHaveLength(3)

    // Verify Alice's text answer appears
    const aliceAnswer = messages.find((m) => m.text.includes("ALICE") && m.text.includes("Laughed at my dog"))
    expect(aliceAnswer).toBeDefined()

    // Verify Bob's voice note appears with emoji
    const bobVoice = messages.find((m) => m.text.includes("BOB") && m.text.includes("voice note"))
    expect(bobVoice).toBeDefined()
    expect(bobVoice!.text).toContain("My kids said the funniest thing")

    // Verify Check It Out section
    expect(compiled.checkItOutItems).toHaveLength(1)
    expect(compiled.checkItOutItems[0].compiledText).toBe("Check out this article about travel")

    // Verify no admin zero-response message (everyone responded)
    expect(compiled.zeroResponseAdminMessage).toBeNull()
  })
})

describe("edge cases", () => {
  it("parseTime rejects invalid 24h time", () => {
    expect(parseTime("25:00")).toBeNull()
    expect(parseTime("12:99")).toBeNull()
  })

  it("parseTime with colon and am/pm", () => {
    expect(parseTime("9:30am")).toBe("09:30")
  })
})
