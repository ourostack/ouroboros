/* v8 ignore file -- type-only commerce authority records */

export type CommerceMandateStatus = "previewed" | "confirmed" | "consumed" | "voided"

export interface CommerceMandateItem {
  name: string
  quantity?: number
  amount?: number
}

export interface CommerceMandateRecord {
  id: string
  status: CommerceMandateStatus
  friendId: string
  merchant: string
  items: CommerceMandateItem[]
  amount: number
  currency: string
  allowedTools?: string[]
  constraints?: Record<string, string>
  reason: string
  digest: string
  createdAt: string
  updatedAt: string
  expiresAt: string
  confirmedAt?: string
  confirmation?: string
  confirmedByMessage?: string
  authorityToken?: string
  consumedAt?: string
  consumedByTool?: string
}

export interface CommerceAccessLogEntry {
  at: string
  checkoutId: string
  action: "preview" | "confirm" | "validate" | "consume" | "read" | "void"
  toolName?: string
  friendId?: string
  ok: boolean
  reason?: string
}
