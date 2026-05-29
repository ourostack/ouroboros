import { generateTimestampId } from "../arc/json-store"
import { emitNervesEvent } from "../nerves/runtime"
import {
  createResponse,
  deleteAllMemberResponses,
  findMemberByFriendId,
  findResponse,
  nextIssueNumber,
  readActiveGroupMembers,
  readGroup,
  readIssue,
  readIssueResponses,
  readMember,
  readMemberResponses,
  readOpenIssue,
  writeIssue,
  writeGroup,
  writeResponse,
  readActiveIssue,
} from "./store"
import { selectPrompts } from "./prompts"
import { compileIssue } from "./delivery"
import type { MailPalsIssue, MailPalsResponse } from "./types"

export interface LifecycleDeps {
  stateRoot: string
  now?: () => Date
}

export function createNextIssue(deps: LifecycleDeps, groupId: string): MailPalsIssue | null {
  const { stateRoot } = deps
  const now = (deps.now ?? (() => new Date()))()
  const group = readGroup(stateRoot, groupId)
  if (!group) throw new Error(`Group ${groupId} not found`)
  if (group.paused) {
    emitNervesEvent({
      component: "mailpals",
      event: "mailpals.create_issue_skipped",
      message: `group ${groupId} is paused`,
    })
    return null
  }

  const prompts = selectPrompts(group.promptsPerIssue)
  if (prompts.length === 0) throw new Error("No prompts available")

  const number = nextIssueNumber(stateRoot, groupId)
  const openAt = calculateNextDatetime(group.promptDay, group.promptTime, group.timezone, now)
  let deliverAt = calculateNextDatetime(group.deliveryDay, group.deliveryTime, group.timezone, now)
  if (deliverAt.getTime() <= openAt.getTime()) {
    deliverAt = new Date(deliverAt.getTime() + 7 * 24 * 60 * 60 * 1000)
  }

  const issue: MailPalsIssue = {
    id: generateTimestampId("iss"),
    groupId,
    number,
    prompts,
    status: "pending",
    openAt: openAt.toISOString(),
    deliverAt: deliverAt.toISOString(),
    sentAt: null,
    createdAt: now.toISOString(),
  }
  writeIssue(stateRoot, issue)

  emitNervesEvent({
    component: "mailpals",
    event: "mailpals.issue_created",
    message: `created issue #${number} for group ${groupId}`,
    meta: { issueId: issue.id, number, groupId },
  })
  return issue
}

export interface OpenIssueResult {
  memberMessages: Array<{ memberId: string; friendId: string; text: string }>
}

export function openIssue(deps: LifecycleDeps, issueId: string, issue?: MailPalsIssue): OpenIssueResult {
  const { stateRoot } = deps
  const iss = issue ?? readIssue(stateRoot, issueId)
  if (!iss) throw new Error(`Issue ${issueId} not found`)

  iss.status = "open"
  writeIssue(stateRoot, iss)

  const group = readGroup(stateRoot, iss.groupId)
  if (!group) throw new Error(`Group ${iss.groupId} not found`)

  const activeMembers = readActiveGroupMembers(stateRoot, iss.groupId)
  if (activeMembers.length === 0) {
    emitNervesEvent({
      component: "mailpals",
      event: "mailpals.open_issue_no_members",
      message: `group ${iss.groupId} has no active members`,
    })
    return { memberMessages: [] }
  }

  const prompts = iss.prompts
  const total = prompts.length
  const firstPrompt = prompts[0] ?? "no prompt"

  const deliverDate = new Date(iss.deliverAt)
  const deadline = formatDeadline(deliverDate, group.timezone)

  const messages: OpenIssueResult["memberMessages"] = []

  for (const member of activeMembers) {
    createResponse(stateRoot, {
      issueId: iss.id,
      memberId: member.id,
      promptIndex: 0,
      contentText: null,
      contentAudioPath: null,
      transcript: null,
      compiledText: null,
      photoWall: [],
      checkItOut: null,
      respondedAt: null,
    })

    const text =
      `mailpals #${iss.number} for ${group.title} is open. ` +
      `${total} questions, one at a time. ` +
      `text or voice note — respond by ${deadline}.\n\n` +
      `1/${total}: ${firstPrompt}\n\n` +
      `(you can attach photos anytime)`

    messages.push({ memberId: member.id, friendId: member.friendId, text })
  }

  emitNervesEvent({
    component: "mailpals",
    event: "mailpals.issue_opened",
    message: `opened issue #${iss.number}, DMed ${activeMembers.length} members`,
    meta: { issueId: iss.id, memberCount: activeMembers.length },
  })

  return { memberMessages: messages }
}

export interface RecordAnswerResult {
  nextMessage: string | null
  friendId: string
}

export function recordAnswer(
  deps: LifecycleDeps,
  issueId: string,
  memberId: string,
  text: string,
): RecordAnswerResult {
  const { stateRoot } = deps
  const now = (deps.now ?? (() => new Date()))()
  const iss = readIssue(stateRoot, issueId) as MailPalsIssue | null
  if (!iss) throw new Error(`Issue ${issueId} not found`)

  const member = readMember(stateRoot, memberId)
  if (!member) throw new Error(`Member ${memberId} not found`)

  const total = iss.prompts.length
  const responses = readMemberResponses(stateRoot, issueId, memberId)

  const unanswered = responses
    .filter((r) => r.respondedAt === null && r.promptIndex < total)
    .sort((a, b) => a.promptIndex - b.promptIndex)[0]

  if (unanswered) {
    if (!text.trim()) return { nextMessage: null, friendId: member.friendId }
    unanswered.contentText = text
    unanswered.respondedAt = now.toISOString()
    writeResponse(stateRoot, unanswered)
    const next = advanceOrFinish(stateRoot, iss, memberId, total, iss.prompts)
    return { nextMessage: next, friendId: member.friendId }
  }

  // All prompts answered — extra text goes to Check It Out
  const existing = responses.find((r) => r.checkItOut !== null)
  if (existing) {
    const prev = existing.checkItOut ?? ""
    existing.checkItOut = prev ? `${prev}\n\n${text}` : text
    if (!existing.respondedAt) existing.respondedAt = now.toISOString()
    writeResponse(stateRoot, existing)
  } else {
    const highest = responses.sort((a, b) => b.promptIndex - a.promptIndex)[0]
    if (highest) {
      highest.checkItOut = text
      if (!highest.respondedAt) highest.respondedAt = now.toISOString()
      writeResponse(stateRoot, highest)
    }
  }

  return { nextMessage: "received", friendId: member.friendId }
}

export function recordPhoto(
  deps: LifecycleDeps,
  issueId: string,
  memberId: string,
  photoPath: string,
): RecordAnswerResult {
  const { stateRoot } = deps
  const iss = readIssue(stateRoot, issueId) as MailPalsIssue | null
  if (!iss) throw new Error(`Issue ${issueId} not found`)

  const member = readMember(stateRoot, memberId)
  if (!member) throw new Error(`Member ${memberId} not found`)

  const total = iss.prompts.length
  const responses = readMemberResponses(stateRoot, issueId, memberId)

  const unanswered = responses
    .filter((r) => r.respondedAt === null && r.promptIndex < total)
    .sort((a, b) => a.promptIndex - b.promptIndex)[0]

  if (unanswered) {
    unanswered.photoWall = [...unanswered.photoWall, photoPath]
    writeResponse(stateRoot, unanswered)
    return { nextMessage: null, friendId: member.friendId }
  }

  const answered = responses
    .filter((r) => r.respondedAt !== null)
    .sort((a, b) => b.promptIndex - a.promptIndex)[0]

  if (answered) {
    answered.photoWall = [...answered.photoWall, photoPath]
    writeResponse(stateRoot, answered)
  }

  return { nextMessage: "received", friendId: member.friendId }
}

export function recordVoiceNote(
  deps: LifecycleDeps,
  issueId: string,
  memberId: string,
  audioPath: string,
  transcript?: string,
): RecordAnswerResult {
  const { stateRoot } = deps
  const now = (deps.now ?? (() => new Date()))()
  const iss = readIssue(stateRoot, issueId) as MailPalsIssue | null
  if (!iss) throw new Error(`Issue ${issueId} not found`)

  const member = readMember(stateRoot, memberId)
  if (!member) throw new Error(`Member ${memberId} not found`)

  const total = iss.prompts.length
  const responses = readMemberResponses(stateRoot, issueId, memberId)

  const unanswered = responses
    .filter((r) => r.respondedAt === null && r.promptIndex < total)
    .sort((a, b) => a.promptIndex - b.promptIndex)[0]

  if (unanswered) {
    unanswered.contentAudioPath = audioPath
    unanswered.respondedAt = now.toISOString()
    if (transcript) {
      unanswered.transcript = transcript
      unanswered.contentText = transcript
    }
    writeResponse(stateRoot, unanswered)
    const next = advanceOrFinish(stateRoot, iss, memberId, total, iss.prompts)
    return { nextMessage: next, friendId: member.friendId }
  }

  return { nextMessage: "received", friendId: member.friendId }
}

export function handleRedo(deps: LifecycleDeps, issueId: string, memberId: string): RecordAnswerResult {
  const { stateRoot } = deps
  const iss = readIssue(stateRoot, issueId) as MailPalsIssue | null
  if (!iss) throw new Error(`Issue ${issueId} not found`)

  const member = readMember(stateRoot, memberId)
  if (!member) throw new Error(`Member ${memberId} not found`)

  deleteAllMemberResponses(stateRoot, issueId, memberId)
  createResponse(stateRoot, {
    issueId,
    memberId,
    promptIndex: 0,
    contentText: null,
    contentAudioPath: null,
    transcript: null,
    compiledText: null,
    photoWall: [],
    checkItOut: null,
    respondedAt: null,
  })

  const total = iss.prompts.length
  const firstPrompt = iss.prompts[0] ?? "no prompt"
  const text = `wiped it. fresh start\n\n1/${total}: ${firstPrompt}\n\n(you can attach photos anytime)`
  return { nextMessage: text, friendId: member.friendId }
}

export function handleEdit(
  deps: LifecycleDeps,
  issueId: string,
  memberId: string,
  promptNum: number,
): RecordAnswerResult {
  const { stateRoot } = deps
  const iss = readIssue(stateRoot, issueId) as MailPalsIssue | null
  if (!iss) throw new Error(`Issue ${issueId} not found`)

  const member = readMember(stateRoot, memberId)
  if (!member) throw new Error(`Member ${memberId} not found`)

  const total = iss.prompts.length
  const idx = promptNum - 1

  if (idx < 0 || idx >= total) {
    return { nextMessage: `there are only ${total} prompts`, friendId: member.friendId }
  }

  const existing = findResponse(stateRoot, issueId, memberId, idx)
  if (existing) {
    existing.contentText = null
    existing.contentAudioPath = null
    existing.transcript = null
    existing.compiledText = null
    existing.photoWall = []
    existing.checkItOut = null
    existing.respondedAt = null
    writeResponse(stateRoot, existing)
  } else {
    createResponse(stateRoot, {
      issueId,
      memberId,
      promptIndex: idx,
      contentText: null,
      contentAudioPath: null,
      transcript: null,
      compiledText: null,
      photoWall: [],
      checkItOut: null,
      respondedAt: null,
    })
  }

  return { nextMessage: `${idx + 1}/${total}: ${iss.prompts[idx]}`, friendId: member.friendId }
}

export interface CompileAndDeliverResult {
  compiled: ReturnType<typeof compileIssue>
  groupChatId: string | null
}

export function compileAndDeliver(deps: LifecycleDeps, issueId: string): CompileAndDeliverResult {
  const { stateRoot } = deps
  const now = (deps.now ?? (() => new Date()))()
  const iss = readIssue(stateRoot, issueId) as MailPalsIssue | null
  if (!iss) throw new Error(`Issue ${issueId} not found`)

  iss.status = "compiling"
  writeIssue(stateRoot, iss)

  const responses = readIssueResponses(stateRoot, issueId) as MailPalsResponse[]
  for (const r of responses) {
    if (r.respondedAt !== null) {
      r.compiledText = r.contentText ?? (r.photoWall.length > 0 ? "" : null)
      writeResponse(stateRoot, r)
    }
  }

  iss.status = "delivered"
  iss.sentAt = now.toISOString()
  writeIssue(stateRoot, iss)

  const group = readGroup(stateRoot, iss.groupId)
  if (!group) throw new Error(`Group ${iss.groupId} not found`)

  const compiled = compileIssue(stateRoot, iss)

  emitNervesEvent({
    component: "mailpals",
    event: "mailpals.issue_delivered",
    message: `delivered issue #${iss.number}`,
    meta: { issueId: iss.id, number: iss.number },
  })

  return { compiled, groupChatId: group.groupChatId }
}

export function skipIssue(deps: LifecycleDeps, groupId: string): string {
  const { stateRoot } = deps
  const issue = readActiveIssue(stateRoot, groupId)
  if (!issue) return "nothing to skip"

  issue.status = "skipped"
  writeIssue(stateRoot, issue)
  return "skipped. next issue scheduled"
}

export function pauseGroup(deps: LifecycleDeps, groupId: string): string {
  const { stateRoot } = deps
  const group = readGroup(stateRoot, groupId)
  if (!group) throw new Error(`Group ${groupId} not found`)
  if (group.paused) return "already paused"
  group.paused = true
  writeGroup(stateRoot, group)
  return "paused. text \"resume\" when you're ready"
}

export function resumeGroup(deps: LifecycleDeps, groupId: string): string {
  const { stateRoot } = deps
  const group = readGroup(stateRoot, groupId)
  if (!group) throw new Error(`Group ${groupId} not found`)
  if (!group.paused) return "not paused"
  group.paused = false
  writeGroup(stateRoot, group)
  createNextIssue(deps, groupId)
  return "resumed. next issue scheduled"
}

export function getStatus(deps: LifecycleDeps, groupId: string): string {
  const { stateRoot } = deps
  const group = readGroup(stateRoot, groupId)
  if (!group) throw new Error(`Group ${groupId} not found`)

  const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
  const activeMembers = readActiveGroupMembers(stateRoot, groupId)
  const names = activeMembers.map((m) => m.displayName.toLowerCase()).join(", ")
  let status = `"${group.title}" — ${activeMembers.length} members: ${names}`
  status += `\nprompts: ${days[group.promptDay]} ${group.promptTime}`
  status += `\ndelivery: ${days[group.deliveryDay]} ${group.deliveryTime}`
  if (group.paused) status += "\n[paused]"
  return status
}

// Reminder messages
export interface ReminderResult {
  privateMessages: Array<{ memberId: string; friendId: string; text: string }>
  publicMessage: { groupChatId: string; text: string } | null
}

export function sendReminder(deps: LifecycleDeps, issueId: string, reminderType: "private" | "public"): ReminderResult {
  const { stateRoot } = deps
  const iss = readIssue(stateRoot, issueId) as MailPalsIssue | null
  if (!iss) throw new Error(`Issue ${issueId} not found`)

  if (iss.status !== "open") {
    return { privateMessages: [], publicMessage: null }
  }

  const group = readGroup(stateRoot, iss.groupId)
  if (!group) throw new Error(`Group ${iss.groupId} not found`)

  const activeMembers = readActiveGroupMembers(stateRoot, iss.groupId)
  const responses = readIssueResponses(stateRoot, issueId) as MailPalsResponse[]

  const respondedMemberIds = new Set<string>()
  for (const r of responses) {
    if (r.respondedAt !== null) respondedMemberIds.add(r.memberId)
  }

  const nonResponders = activeMembers.filter((m) => !respondedMemberIds.has(m.id))
  if (nonResponders.length === 0) {
    return { privateMessages: [], publicMessage: null }
  }

  if (reminderType === "private") {
    return {
      privateMessages: nonResponders.map((m) => ({
        memberId: m.id,
        friendId: m.friendId,
        text: "hey — everyone's waiting on you. even a quick voice note counts",
      })),
      publicMessage: null,
    }
  }

  const names = nonResponders.map((m) => m.displayName.toLowerCase()).join(", ")
  const text = `${respondedMemberIds.size} of ${activeMembers.length} in. waiting on ${names}.`
  return {
    privateMessages: [],
    publicMessage: group.groupChatId ? { groupChatId: group.groupChatId, text } : null,
  }
}

// Per-turn context for slugger
export function getMailPalsContext(stateRoot: string, friendId: string): string | null {
  const member = findMemberByFriendId(stateRoot, friendId)
  if (!member) return null

  const issue = readOpenIssue(stateRoot, member.groupId)
  if (!issue) return null

  const responses = readMemberResponses(stateRoot, issue.id, member.id)
  const total = issue.prompts.length

  const unanswered = responses
    .filter((r: MailPalsResponse) => r.respondedAt === null && r.promptIndex < total)
    .sort((a: MailPalsResponse, b: MailPalsResponse) => a.promptIndex - b.promptIndex)[0]

  if (unanswered) {
    return `owes ${unanswered.promptIndex + 1}/${total}: ${issue.prompts[unanswered.promptIndex]}`
  }

  const answeredCount = responses.filter((r: MailPalsResponse) => r.respondedAt !== null && r.promptIndex < total).length
  if (answeredCount < total) {
    const nextIdx = answeredCount
    return `owes ${nextIdx + 1}/${total}: ${issue.prompts[nextIdx]}`
  }

  return null
}

// Internal helpers

function advanceOrFinish(
  stateRoot: string,
  issue: MailPalsIssue,
  memberId: string,
  total: number,
  prompts: string[],
): string {
  const responses = readMemberResponses(stateRoot, issue.id, memberId)
  const responseMap = new Map(responses.map((r) => [r.promptIndex, r]))

  for (const r of responses) {
    if (r.promptIndex < total && r.respondedAt === null) {
      return `${r.promptIndex + 1}/${total}: ${prompts[r.promptIndex]}`
    }
  }

  for (let i = 0; i < total; i++) {
    if (!responseMap.has(i)) {
      createResponse(stateRoot, {
        issueId: issue.id,
        memberId,
        promptIndex: i,
        contentText: null,
        contentAudioPath: null,
        transcript: null,
        compiledText: null,
        photoWall: [],
        checkItOut: null,
        respondedAt: null,
      })
      return `${i + 1}/${total}: ${prompts[i]}`
    }
  }

  return "You're all set. photos, articles, or extra thoughts are welcome anytime before delivery"
}

export function calculateNextDatetime(dayOfWeek: number, timeStr: string, tz: string, now: Date): Date {
  const [hour, minute] = timeStr.split(":").map(Number)
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })

  const parts = formatter.formatToParts(now)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const nowDay = new Date(get("year"), get("month") - 1, get("day")).getDay()
  // Convert JS Sunday=0..Saturday=6 to Python Monday=0..Sunday=6
  const nowDayPython = (nowDay + 6) % 7

  let daysAhead = (dayOfWeek - nowDayPython + 7) % 7
  const target = new Date(now)
  target.setDate(target.getDate() + daysAhead)

  // Set target time in the timezone
  const targetFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
  })
  const targetParts = targetFormatter.formatToParts(target)
  const tGet = (type: string) => Number(targetParts.find((p) => p.type === type)?.value ?? 0)

  // Build a date string in the target timezone and parse it
  const dateStr = `${tGet("year")}-${String(tGet("month")).padStart(2, "0")}-${String(tGet("day")).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`

  // Use a rough UTC offset calculation
  const tempDate = new Date(dateStr + "Z")
  const offsetMs = tempDate.getTime() - new Date(formatter.format(tempDate).replace(",", "")).getTime()
  const result = new Date(tempDate.getTime() + offsetMs)

  if (result.getTime() <= now.getTime()) {
    result.setDate(result.getDate() + 7)
  }

  return result
}

export function formatDeadline(date: Date, tz: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
  return formatter.format(date).toLowerCase()
}

const DAY_MAP: Record<string, number> = {
  monday: 0, mon: 0,
  tuesday: 1, tue: 1, tues: 1,
  wednesday: 2, wed: 2,
  thursday: 3, thu: 3, thurs: 3,
  friday: 4, fri: 4,
  saturday: 5, sat: 5,
  sunday: 6, sun: 6,
}

export function parseDay(dayStr: string): number | null {
  return DAY_MAP[dayStr.toLowerCase()] ?? null
}

export function parseTime(timeStr: string): string | null {
  const s = timeStr.toLowerCase().trim()
  try {
    if (s.includes(":") && !s.endsWith("am") && !s.endsWith("pm")) {
      const [h, m] = s.split(":").map(Number)
      if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
      }
      return null
    }

    const isPm = s.endsWith("pm")
    const isAm = s.endsWith("am")
    const raw = s.replace(/[apm\s]/g, "")

    let h: number, m: number
    if (raw.includes(":")) {
      ;[h, m] = raw.split(":").map(Number)
    } else {
      h = Number(raw)
      m = 0
    }

    if (isPm && h !== 12) h += 12
    else if (isAm && h === 12) h = 0

    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
    }
  } catch {
    // Fall through
  }
  return null
}
