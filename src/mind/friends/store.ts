// Friend store abstraction.
// All friend persistence goes through FriendStore -- no friend module imports `fs` directly.

import type { FriendRecord } from "./types"

// Domain-specific store for friend records.
// Implementations store unified friend records.
export interface FriendStore {
  get(id: string): Promise<FriendRecord | null>
  put(id: string, record: FriendRecord): Promise<void>
  delete(id: string): Promise<void>
  findByExternalId(provider: string, externalId: string, tenantId?: string): Promise<FriendRecord | null>
  hasAnyFriends?(): Promise<boolean>
  listAll?(): Promise<FriendRecord[]>
}
