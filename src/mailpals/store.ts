import * as fs from "fs"
import * as path from "path"
import { generateTimestampId, readJsonDir, readJsonFile, writeJsonFile } from "../arc/json-store"
import type { MailPalsGroup, MailPalsMember, MailPalsIssue, MailPalsResponse } from "./types"

function groupsDir(stateRoot: string): string {
  return path.join(stateRoot, "groups")
}

function membersDir(stateRoot: string): string {
  return path.join(stateRoot, "members")
}

function issuesDir(stateRoot: string): string {
  return path.join(stateRoot, "issues")
}

function responsesDir(stateRoot: string): string {
  return path.join(stateRoot, "responses")
}

// Groups
export function readGroups(stateRoot: string): MailPalsGroup[] {
  return readJsonDir<MailPalsGroup>(groupsDir(stateRoot))
}

export function readGroup(stateRoot: string, id: string): MailPalsGroup | null {
  return readJsonFile<MailPalsGroup>(groupsDir(stateRoot), id)
}

export function writeGroup(stateRoot: string, group: MailPalsGroup): void {
  writeJsonFile(groupsDir(stateRoot), group.id, group)
}

export function createGroup(stateRoot: string, input: Omit<MailPalsGroup, "id" | "createdAt">): MailPalsGroup {
  const group: MailPalsGroup = {
    ...input,
    id: generateTimestampId("grp"),
    createdAt: new Date().toISOString(),
  }
  writeGroup(stateRoot, group)
  return group
}

// Members
export function readMembers(stateRoot: string): MailPalsMember[] {
  return readJsonDir<MailPalsMember>(membersDir(stateRoot))
}

export function readMember(stateRoot: string, id: string): MailPalsMember | null {
  return readJsonFile<MailPalsMember>(membersDir(stateRoot), id)
}

export function writeMember(stateRoot: string, member: MailPalsMember): void {
  writeJsonFile(membersDir(stateRoot), member.id, member)
}

export function createMember(stateRoot: string, input: Omit<MailPalsMember, "id" | "joinedAt">): MailPalsMember {
  const member: MailPalsMember = {
    ...input,
    id: generateTimestampId("mbr"),
    joinedAt: new Date().toISOString(),
  }
  writeMember(stateRoot, member)
  return member
}

export function readGroupMembers(stateRoot: string, groupId: string): MailPalsMember[] {
  return readMembers(stateRoot).filter((m) => m.groupId === groupId)
}

export function readActiveGroupMembers(stateRoot: string, groupId: string): MailPalsMember[] {
  return readGroupMembers(stateRoot, groupId).filter((m) => m.active)
}

export function findMemberByFriendId(stateRoot: string, friendId: string): MailPalsMember | null {
  return readMembers(stateRoot).find((m) => m.friendId === friendId && m.active) ?? null
}

// Issues
export function readIssues(stateRoot: string): MailPalsIssue[] {
  return readJsonDir<MailPalsIssue>(issuesDir(stateRoot))
}

export function readIssue(stateRoot: string, id: string): MailPalsIssue | null {
  return readJsonFile<MailPalsIssue>(issuesDir(stateRoot), id)
}

export function writeIssue(stateRoot: string, issue: MailPalsIssue): void {
  writeJsonFile(issuesDir(stateRoot), issue.id, issue)
}

export function readGroupIssues(stateRoot: string, groupId: string): MailPalsIssue[] {
  return readIssues(stateRoot).filter((i) => i.groupId === groupId)
}

export function readActiveIssue(stateRoot: string, groupId: string): MailPalsIssue | null {
  return readGroupIssues(stateRoot, groupId)
    .filter((i) => i.status === "open" || i.status === "pending")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
}

export function readOpenIssue(stateRoot: string, groupId: string): MailPalsIssue | null {
  return readGroupIssues(stateRoot, groupId)
    .filter((i) => i.status === "open")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
}

export function nextIssueNumber(stateRoot: string, groupId: string): number {
  const issues = readGroupIssues(stateRoot, groupId)
  if (issues.length === 0) return 1
  return Math.max(...issues.map((i) => i.number)) + 1
}

// Responses
export function readResponses(stateRoot: string): MailPalsResponse[] {
  return readJsonDir<MailPalsResponse>(responsesDir(stateRoot))
}

export function readResponse(stateRoot: string, id: string): MailPalsResponse | null {
  return readJsonFile<MailPalsResponse>(responsesDir(stateRoot), id)
}

export function writeResponse(stateRoot: string, response: MailPalsResponse): void {
  writeJsonFile(responsesDir(stateRoot), response.id, response)
}

export function readIssueResponses(stateRoot: string, issueId: string): MailPalsResponse[] {
  return readResponses(stateRoot).filter((r) => r.issueId === issueId)
}

export function readMemberResponses(stateRoot: string, issueId: string, memberId: string): MailPalsResponse[] {
  return readIssueResponses(stateRoot, issueId).filter((r) => r.memberId === memberId)
}

export function findResponse(stateRoot: string, issueId: string, memberId: string, promptIndex: number): MailPalsResponse | null {
  return readMemberResponses(stateRoot, issueId, memberId).find((r) => r.promptIndex === promptIndex) ?? null
}

export function createResponse(stateRoot: string, input: Omit<MailPalsResponse, "id" | "createdAt">): MailPalsResponse {
  const response: MailPalsResponse = {
    ...input,
    id: generateTimestampId("rsp"),
    createdAt: new Date().toISOString(),
  }
  writeResponse(stateRoot, response)
  return response
}

export function deleteResponse(stateRoot: string, id: string): void {
  const dir = responsesDir(stateRoot)
  const filePath = path.join(dir, `${id}.json`)
  try {
    fs.unlinkSync(filePath)
  } catch {
    // Already deleted or never existed
  }
}

export function deleteAllMemberResponses(stateRoot: string, issueId: string, memberId: string): void {
  const responses = readMemberResponses(stateRoot, issueId, memberId)
  for (const r of responses) {
    deleteResponse(stateRoot, r.id)
  }
}
