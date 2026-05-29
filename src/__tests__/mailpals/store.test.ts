import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { emitNervesEvent } from "../../nerves/runtime"
import {
  createGroup,
  readGroup,
  readGroups,
  writeGroup,
  createMember,
  readMember,
  readGroupMembers,
  readActiveGroupMembers,
  findMemberByFriendId,
  readIssues,
  readGroupIssues,
  readActiveIssue,
  readOpenIssue,
  nextIssueNumber,
  createResponse,
  readIssueResponses,
  readMemberResponses,
  findResponse,
  deleteResponse,
  deleteAllMemberResponses,
  writeIssue,
} from "../../mailpals/store"
import type { MailPalsIssue } from "../../mailpals/types"

let stateRoot: string

beforeEach(() => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mailpals-test-"))
  emitNervesEvent({
    component: "mailpals",
    event: "mailpals.test_setup",
    message: "test state root created",
  })
})

afterEach(() => {
  fs.rmSync(stateRoot, { recursive: true, force: true })
})

describe("store — groups", () => {
  it("creates and reads a group", () => {
    const group = createGroup(stateRoot, {
      title: "Test Group",
      promptsPerIssue: 3,
      promptDay: 0,
      promptTime: "09:00",
      deliveryDay: 4,
      deliveryTime: "09:00",
      timezone: "America/New_York",
      paused: false,
      groupChatId: null,
      memberIds: [],
    })
    expect(group.id).toMatch(/^grp-/)
    expect(group.title).toBe("Test Group")

    const read = readGroup(stateRoot, group.id)
    expect(read).toEqual(group)
  })

  it("reads all groups", () => {
    createGroup(stateRoot, {
      title: "A",
      promptsPerIssue: 3, promptDay: 0, promptTime: "09:00",
      deliveryDay: 4, deliveryTime: "09:00", timezone: "America/New_York",
      paused: false, groupChatId: null, memberIds: [],
    })
    createGroup(stateRoot, {
      title: "B",
      promptsPerIssue: 3, promptDay: 0, promptTime: "09:00",
      deliveryDay: 4, deliveryTime: "09:00", timezone: "America/New_York",
      paused: false, groupChatId: null, memberIds: [],
    })
    expect(readGroups(stateRoot)).toHaveLength(2)
  })

  it("returns null for nonexistent group", () => {
    expect(readGroup(stateRoot, "nope")).toBeNull()
  })

  it("updates a group", () => {
    const group = createGroup(stateRoot, {
      title: "Original",
      promptsPerIssue: 3, promptDay: 0, promptTime: "09:00",
      deliveryDay: 4, deliveryTime: "09:00", timezone: "America/New_York",
      paused: false, groupChatId: null, memberIds: [],
    })
    group.paused = true
    writeGroup(stateRoot, group)
    expect(readGroup(stateRoot, group.id)!.paused).toBe(true)
  })
})

describe("store — members", () => {
  it("creates and reads a member", () => {
    const member = createMember(stateRoot, {
      groupId: "grp-1",
      friendId: "friend-1",
      displayName: "Alice",
      role: "member",
      active: true,
    })
    expect(member.id).toMatch(/^mbr-/)
    expect(readMember(stateRoot, member.id)).toEqual(member)
  })

  it("reads group members", () => {
    createMember(stateRoot, { groupId: "g1", friendId: "f1", displayName: "A", role: "member", active: true })
    createMember(stateRoot, { groupId: "g1", friendId: "f2", displayName: "B", role: "member", active: false })
    createMember(stateRoot, { groupId: "g2", friendId: "f3", displayName: "C", role: "member", active: true })

    expect(readGroupMembers(stateRoot, "g1")).toHaveLength(2)
    expect(readActiveGroupMembers(stateRoot, "g1")).toHaveLength(1)
    expect(readGroupMembers(stateRoot, "g2")).toHaveLength(1)
  })

  it("finds member by friend id", () => {
    createMember(stateRoot, { groupId: "g1", friendId: "f1", displayName: "A", role: "member", active: true })
    createMember(stateRoot, { groupId: "g1", friendId: "f2", displayName: "B", role: "member", active: false })

    expect(findMemberByFriendId(stateRoot, "f1")!.displayName).toBe("A")
    expect(findMemberByFriendId(stateRoot, "f2")).toBeNull() // inactive
    expect(findMemberByFriendId(stateRoot, "f3")).toBeNull() // nonexistent
  })
})

describe("store — issues", () => {
  it("tracks issue numbers per group", () => {
    expect(nextIssueNumber(stateRoot, "g1")).toBe(1)
    const iss: MailPalsIssue = {
      id: "iss-1", groupId: "g1", number: 1, prompts: ["p1"],
      status: "delivered", openAt: "", deliverAt: "", sentAt: null, createdAt: "",
    }
    writeIssue(stateRoot, iss)
    expect(nextIssueNumber(stateRoot, "g1")).toBe(2)
  })

  it("reads active and open issues", () => {
    const open: MailPalsIssue = {
      id: "iss-1", groupId: "g1", number: 1, prompts: ["p1"],
      status: "open", openAt: "", deliverAt: "", sentAt: null, createdAt: "2024-01-01",
    }
    const delivered: MailPalsIssue = {
      id: "iss-2", groupId: "g1", number: 2, prompts: ["p2"],
      status: "delivered", openAt: "", deliverAt: "", sentAt: null, createdAt: "2024-01-02",
    }
    writeIssue(stateRoot, open)
    writeIssue(stateRoot, delivered)

    expect(readActiveIssue(stateRoot, "g1")!.id).toBe("iss-1")
    expect(readOpenIssue(stateRoot, "g1")!.id).toBe("iss-1")
    expect(readGroupIssues(stateRoot, "g1")).toHaveLength(2)
  })
})

describe("store — responses", () => {
  it("creates and reads responses", () => {
    const resp = createResponse(stateRoot, {
      issueId: "iss-1",
      memberId: "mbr-1",
      promptIndex: 0,
      contentText: null,
      contentAudioPath: null,
      transcript: null,
      compiledText: null,
      photoWall: [],
      checkItOut: null,
      respondedAt: null,
    })
    expect(resp.id).toMatch(/^rsp-/)
    expect(readIssueResponses(stateRoot, "iss-1")).toHaveLength(1)
    expect(readMemberResponses(stateRoot, "iss-1", "mbr-1")).toHaveLength(1)
  })

  it("finds response by prompt index", () => {
    createResponse(stateRoot, {
      issueId: "iss-1", memberId: "mbr-1", promptIndex: 0,
      contentText: null, contentAudioPath: null, transcript: null,
      compiledText: null, photoWall: [], checkItOut: null, respondedAt: null,
    })
    createResponse(stateRoot, {
      issueId: "iss-1", memberId: "mbr-1", promptIndex: 1,
      contentText: null, contentAudioPath: null, transcript: null,
      compiledText: null, photoWall: [], checkItOut: null, respondedAt: null,
    })

    expect(findResponse(stateRoot, "iss-1", "mbr-1", 0)).not.toBeNull()
    expect(findResponse(stateRoot, "iss-1", "mbr-1", 1)).not.toBeNull()
    expect(findResponse(stateRoot, "iss-1", "mbr-1", 2)).toBeNull()
  })

  it("deletes a response", () => {
    const resp = createResponse(stateRoot, {
      issueId: "iss-1", memberId: "mbr-1", promptIndex: 0,
      contentText: null, contentAudioPath: null, transcript: null,
      compiledText: null, photoWall: [], checkItOut: null, respondedAt: null,
    })
    deleteResponse(stateRoot, resp.id)
    expect(readIssueResponses(stateRoot, "iss-1")).toHaveLength(0)
  })

  it("deletes all member responses", () => {
    createResponse(stateRoot, {
      issueId: "iss-1", memberId: "mbr-1", promptIndex: 0,
      contentText: null, contentAudioPath: null, transcript: null,
      compiledText: null, photoWall: [], checkItOut: null, respondedAt: null,
    })
    createResponse(stateRoot, {
      issueId: "iss-1", memberId: "mbr-1", promptIndex: 1,
      contentText: null, contentAudioPath: null, transcript: null,
      compiledText: null, photoWall: [], checkItOut: null, respondedAt: null,
    })
    createResponse(stateRoot, {
      issueId: "iss-1", memberId: "mbr-2", promptIndex: 0,
      contentText: null, contentAudioPath: null, transcript: null,
      compiledText: null, photoWall: [], checkItOut: null, respondedAt: null,
    })

    deleteAllMemberResponses(stateRoot, "iss-1", "mbr-1")
    expect(readMemberResponses(stateRoot, "iss-1", "mbr-1")).toHaveLength(0)
    expect(readMemberResponses(stateRoot, "iss-1", "mbr-2")).toHaveLength(1)
  })
})
