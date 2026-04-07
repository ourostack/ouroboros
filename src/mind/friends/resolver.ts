// FriendResolver -- resolves external identity into a FriendRecord + channel capabilities.
// Created per-request (per-incoming-message), per-friend.
// Replaces the old ContextResolver: no authority checker, no separate memory resolution.

import { randomUUID } from "crypto"
import type { FriendStore } from "./store"
import type { IdentityProvider, FriendRecord, ResolvedContext, ExternalId } from "./types"
import { getChannelCapabilities } from "./channel"
import { emitNervesEvent } from "../../nerves/runtime"

export interface FriendResolverParams {
  provider: IdentityProvider
  externalId: string
  tenantId?: string
  displayName: string
  channel: string
}

const CURRENT_SCHEMA_VERSION = 1

export class FriendResolver {
  private readonly store: FriendStore
  private readonly params: FriendResolverParams

  constructor(store: FriendStore, params: FriendResolverParams) {
    this.store = store
    this.params = params
  }

  async resolve(): Promise<ResolvedContext> {
    const friend = await this.resolveOrCreate()
    const channel = getChannelCapabilities(this.params.channel)
    return { friend, channel }
  }

  private async resolveOrCreate(): Promise<FriendRecord> {
    // Try to find existing friend by external ID
    let existing: FriendRecord | null = null
    try {
      existing = await this.store.findByExternalId(
        this.params.provider,
        this.params.externalId,
        this.params.tenantId,
      )
    } catch {
      // Store search failure -- fall through to create new (D16)
    }

    if (existing) return existing

    // Migration: local provider previously used "${username}@${hostname}" format.
    // If no exact match, try finding a friend with old-format external ID.
    /* v8 ignore start -- one-time migration: hostname→username format, tested manually @preserve */
    if (this.params.provider === "local" && !this.params.externalId.includes("@")) {
      try {
        const all = typeof this.store.listAll === "function" ? await this.store.listAll() : []
        const migrationMatch = all.find((f) =>
          f.externalIds.some(
            (eid) => eid.provider === "local" && eid.externalId.startsWith(this.params.externalId + "@"),
          ),
        )
        if (migrationMatch) {
          // Link the new external ID format to the existing friend
          const now = new Date().toISOString()
          migrationMatch.externalIds.push({
            provider: this.params.provider,
            externalId: this.params.externalId,
            linkedAt: now,
          })
          migrationMatch.updatedAt = now
          try {
            await this.store.put(migrationMatch.id, migrationMatch)
          } catch {
            // best-effort persist
          }
          emitNervesEvent({
            component: "friends",
            event: "friends.local_id_migrated",
            message: `migrated local friend identity from hostname format to username-only`,
            meta: { friendId: migrationMatch.id, newExternalId: this.params.externalId },
          })
          return migrationMatch
        }
      } catch {
        // fall through to create new
      }
    }
    /* v8 ignore stop */

    // First encounter -- create new FriendRecord
    const now = new Date().toISOString()
    const externalId: ExternalId = {
      provider: this.params.provider,
      externalId: this.params.externalId,
      linkedAt: now,
      ...(this.params.tenantId !== undefined ? { tenantId: this.params.tenantId } : {}),
    }

    const tenantMemberships: string[] =
      this.params.tenantId ? [this.params.tenantId] : []

    let hasAnyFriends = false
    try {
      if (typeof this.store.hasAnyFriends === "function") {
        hasAnyFriends = await this.store.hasAnyFriends()
      }
    } catch {
      hasAnyFriends = false
    }

    const isFirstImprint = !hasAnyFriends

    const friend: FriendRecord = {
      id: randomUUID(),
      name: this.params.displayName,
      role: isFirstImprint ? "primary" : "stranger",
      trustLevel: isFirstImprint ? "family" : "stranger",
      connections: [],
      externalIds: [externalId],
      tenantMemberships,
      toolPreferences: {},
      notes: this.params.displayName !== "Unknown" ? { name: { value: this.params.displayName, savedAt: now } } : {},
      totalTokens: 0,
      createdAt: now,
      updatedAt: now,
      schemaVersion: CURRENT_SCHEMA_VERSION,
    }

    // Persist -- log and continue on failure (D16)
    try {
      await this.store.put(friend.id, friend)
    } catch (err) {
      emitNervesEvent({
        level: "error",
        event: "friends.persist_error",
        component: "friends",
        message: "failed to persist friend record",
        meta: { reason: err instanceof Error ? err.message : String(err) },
      })
    }

    return friend
  }
}
