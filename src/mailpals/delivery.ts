import { readActiveGroupMembers, readIssueResponses, readGroup, readMember } from "./store"
import type { MailPalsIssue, MailPalsResponse, CompiledIssue } from "./types"

export function compileIssue(stateRoot: string, issue: MailPalsIssue): CompiledIssue {
  const group = readGroup(stateRoot, issue.groupId)
  if (!group) throw new Error(`Group ${issue.groupId} not found`)

  const activeMembers = readActiveGroupMembers(stateRoot, issue.groupId)
  const activeMemberMap = new Map(activeMembers.map((m) => [m.id, m]))
  const responses = readIssueResponses(stateRoot, issue.id)
  const totalPrompts = issue.prompts.length

  // Group responses by member
  const memberResponses = new Map<string, MailPalsResponse[]>()
  for (const r of responses) {
    const list = memberResponses.get(r.memberId) ?? []
    list.push(r)
    memberResponses.set(r.memberId, list)
  }

  // Who participated (answered at least one prompt)
  const respondedMemberIds = new Set<string>()
  for (const [mid, resps] of memberResponses) {
    if (resps.some((r) => r.respondedAt !== null)) {
      respondedMemberIds.add(mid)
    }
  }

  const inCount = respondedMemberIds.size
  const totalMembers = activeMemberMap.size

  const participation = buildParticipationLine(inCount, totalMembers, respondedMemberIds, activeMemberMap)

  // Build delivery sections
  const sections = issue.prompts.map((promptText, idx) => {
    const items = Array.from(respondedMemberIds)
      .map((mid) => {
        const member = activeMemberMap.get(mid) ?? readMember(stateRoot, mid)
        if (!member) return null
        const resps = memberResponses.get(mid) ?? []
        const resp = resps.find((r) => r.promptIndex === idx && r.respondedAt !== null)
        if (!resp || (!resp.compiledText && resp.photoWall.length === 0)) return null

        return {
          nameLabel: member.displayName.toUpperCase(),
          isVoice: Boolean(resp.contentAudioPath),
          compiledText: resp.compiledText,
          photos: resp.promptIndex < totalPrompts ? resp.photoWall : [],
          audioPath: resp.contentAudioPath,
        }
      })
      .filter(Boolean) as CompiledIssue["sections"][0]["items"]

    return { prompt: promptText, promptNum: idx + 1, items }
  })

  const photoWallResult: CompiledIssue["photoWallItems"] = []
  const checkItOutResult: CompiledIssue["checkItOutItems"] = []

  for (const mid of respondedMemberIds) {
    const member = activeMemberMap.get(mid) ?? readMember(stateRoot, mid)
    if (!member) continue
    const resps = memberResponses.get(mid) ?? []
    const answered = resps.filter((r) => r.respondedAt !== null)

    // Check It Out
    for (const r of answered) {
      if (r.checkItOut) {
        checkItOutResult.push({
          nameLabel: member.displayName.toUpperCase(),
          compiledText: r.checkItOut,
        })
        break
      }
    }
  }

  // Zero-response admin message
  let zeroResponseAdminMessage: string | null = null
  let adminMemberId: string | null = null
  if (inCount === 0) {
    const admin = activeMembers.find((m) => m.role === "admin")
    if (admin) {
      zeroResponseAdminMessage =
        "nobody responded this time. want to try a different day? " +
        'DM me "prompts [day] [time]" to switch, or "pause" to take a break.'
      adminMemberId = admin.id
    }
  }

  return {
    issueNumber: issue.number,
    participation,
    sections,
    photoWallItems: photoWallResult,
    checkItOutItems: checkItOutResult,
    zeroResponseAdminMessage,
    adminMemberId,
  }
}

function buildParticipationLine(
  inCount: number,
  totalMembers: number,
  respondedMemberIds: Set<string>,
  activeMemberMap: Map<string, { displayName: string }>,
): string {
  if (inCount === totalMembers && totalMembers > 0) {
    return "everyone responded"
  }
  if (inCount === 0) {
    return "nobody responded — maybe next week"
  }
  if (inCount === 1) {
    const responder = Array.from(respondedMemberIds)
      .map((mid) => activeMemberMap.get(mid))
      .filter(Boolean)[0]
    return `${inCount}/${totalMembers} this time — ${responder?.displayName.toLowerCase()} came through`
  }
  const names = Array.from(respondedMemberIds)
    .map((mid) => activeMemberMap.get(mid)?.displayName.toLowerCase())
    .filter(Boolean)
    .join(", ")
  return `${inCount}/${totalMembers} this time — ${names}`
}

export function compiledIssueToMessages(compiled: CompiledIssue): Array<{ text: string; attachments?: string[] }> {
  const messages: Array<{ text: string; attachments?: string[] }> = []

  messages.push({ text: `mailpals #${compiled.issueNumber}` })
  messages.push({ text: compiled.participation })

  for (const section of compiled.sections) {
    messages.push({ text: `${section.promptNum}/${compiled.sections.length}: ${section.prompt}` })

    for (const item of section.items) {
      let text: string
      if (item.isVoice && item.compiledText !== null) {
        text = `${item.nameLabel}\n\u{1F399}️ from a voice note\n\n${item.compiledText}`
      } else if (item.compiledText) {
        text = `${item.nameLabel}\n${item.compiledText}`
      } else if (item.photos.length > 0) {
        text = item.nameLabel
      } else {
        continue
      }

      const attachments: string[] = []
      for (const photo of item.photos) {
        attachments.push(photo)
      }
      if (item.isVoice && item.audioPath) {
        attachments.push(item.audioPath)
      }

      messages.push({ text, attachments: attachments.length > 0 ? attachments : undefined })
    }
  }

  if (compiled.photoWallItems.length > 0) {
    messages.push({ text: "photo wall" })
    for (const item of compiled.photoWallItems) {
      const text = item.compiledText ? `${item.nameLabel}\n${item.compiledText}` : item.nameLabel
      messages.push({ text, attachments: item.photos.length > 0 ? item.photos : undefined })
    }
  }

  if (compiled.checkItOutItems.length > 0) {
    messages.push({ text: "check it out" })
    for (const item of compiled.checkItOutItems) {
      messages.push({ text: `${item.nameLabel}\n${item.compiledText}` })
    }
  }

  return messages
}
