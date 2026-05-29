export type IssueStatus = "pending" | "open" | "compiling" | "delivered" | "skipped"
export type MemberRole = "member" | "admin"

export interface MailPalsGroup {
  id: string
  title: string
  promptsPerIssue: number
  promptDay: number // 0=Mon..6=Sun
  promptTime: string // "HH:MM" 24h
  deliveryDay: number
  deliveryTime: string
  timezone: string
  paused: boolean
  groupChatId: string | null // BlueBubbles group chat GUID or equivalent
  memberIds: string[]
  createdAt: string // ISO
}

export interface MailPalsMember {
  id: string
  groupId: string
  friendId: string // maps to harness FriendRecord.id
  displayName: string
  role: MemberRole
  active: boolean
  joinedAt: string
}

export interface MailPalsIssue {
  id: string
  groupId: string
  number: number
  prompts: string[]
  status: IssueStatus
  openAt: string // ISO
  deliverAt: string // ISO
  sentAt: string | null
  createdAt: string
}

export interface MailPalsResponse {
  id: string
  issueId: string
  memberId: string
  promptIndex: number
  contentText: string | null
  contentAudioPath: string | null
  transcript: string | null
  compiledText: string | null
  photoWall: string[] // photo paths for Photo Wall (replaces prompt_index=total trick)
  checkItOut: string | null // extra text (replaces prompt_index=total+1 trick)
  respondedAt: string | null // ISO, null = not yet answered
  createdAt: string
}

export interface DeliveryMessage {
  text: string
  attachments?: string[]
}

export interface DeliverySection {
  prompt: string
  promptNum: number
  items: DeliveryItem[]
}

export interface DeliveryItem {
  nameLabel: string
  isVoice: boolean
  compiledText: string | null
  photos: string[]
  audioPath: string | null
}

export interface CompiledIssue {
  issueNumber: number
  participation: string
  sections: DeliverySection[]
  photoWallItems: Array<{ nameLabel: string; compiledText: string | null; photos: string[] }>
  checkItOutItems: Array<{ nameLabel: string; compiledText: string }>
  zeroResponseAdminMessage: string | null
  adminMemberId: string | null
}
