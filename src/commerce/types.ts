export type CommerceMandateStatus = "previewed" | "confirmed" | "voided"

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
  reason: string
  digest: string
  createdAt: string
  updatedAt: string
  expiresAt: string
  confirmedAt?: string
  confirmation?: string
  authorityToken?: string
}

export interface CommerceAccessLogEntry {
  at: string
  checkoutId: string
  action: "preview" | "confirm" | "validate" | "read" | "void"
  toolName?: string
  friendId?: string
  ok: boolean
  reason?: string
}

